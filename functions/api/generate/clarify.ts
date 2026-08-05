import { plannerClarifyPrompt, skillClarifyContext } from "../../_lib/prompts";
import { accumulateCost, type UsageBreakdown } from "../../_lib/quota";
import { resolveLLM } from "../../_lib/llm";
import { getOwnedTask, markTaskQuotaExhausted, putTaskState } from "../../_lib/taskStore";

const DEEPSEEK_URL = "https://api.deepseek.com/v1/chat/completions";
const CLARIFY_MODEL = "deepseek-v4-pro";
const MAX_CLARIFY_ROUNDS = 5;
const CLARIFY_TIMEOUT_MS = 180000; // 非流式总时长上限（pro+thinking 可思考较久）

interface Env {
    DEEPSEEK_API_KEY: string;
    TASKS: KVNamespace;
}

function stripFences(raw: string): string {
    return raw.replace(/^```[\w]*\n?/, "").replace(/\n?```\s*$/, "").trim();
}

function sseEvent(encoder: TextEncoder, data: any): Uint8Array {
    return encoder.encode(`data: ${JSON.stringify(data)}\n\n`);
}

async function callReasoner(
    url: string, key: string, model: string, system: string, user: string,
): Promise<{ content: string; usage?: UsageBreakdown }> {
    // 【非流式】CF 免费版单请求仅 ~10ms CPU。流式逐 chunk decode + JSON.parse（推理响应块数很多）会超
    // CPU 被硬杀 → 澄清「多次无响应」。改为非流式，只做 1 次 resp.json()。代价：失去逐字流。
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), CLARIFY_TIMEOUT_MS);
    try {
        const resp = await fetch(url, {
            method: "POST",
            headers: { "Content-Type": "application/json", Authorization: `Bearer ${key}` },
            body: JSON.stringify({
                model,
                reasoning_effort: "high",
                thinking: { type: "enabled" },
                messages: [{ role: "system", content: system }, { role: "user", content: user }],
            }),
            signal: ctrl.signal,
        });
        if (!resp.ok) throw new Error(await resp.text());
        const data = await resp.json() as any;
        return { content: data.choices?.[0]?.message?.content ?? "", usage: data.usage };
    } finally {
        clearTimeout(timer);
    }
}

export const onRequestPost: PagesFunction<Env> = async (context) => {
    const uid: string = (context.data as any)?.uid || "";
    const body = await context.request.json() as any;
    const llm = await resolveLLM(context);
    if (!llm.apiKey) return new Response("API key not configured", { status: 500 });

    const taskId = body.taskId as string;
    const answers = body.answers as Record<string, string | string[]> | undefined;
    const extraPrompt = body.extraPrompt as string | undefined;

    const raw = await getOwnedTask(context.env, taskId, uid);
    if (!raw) return new Response("Task not found", { status: 404 });
    const state = JSON.parse(raw);
    state.uid = uid;

    if (state.quotaExhausted) {
        return new Response(JSON.stringify({ error: "本月额度已用尽", code: "QUOTA_EXHAUSTED" }), {
            status: 402, headers: { "Content-Type": "application/json" },
        });
    }

    // 将上一轮的 answers 回填到最后一轮的 todos
    if (answers && state.clarifyRounds.length > 0) {
        state.clarifyRounds[state.clarifyRounds.length - 1].answers = answers;
    }

    // 用户补充描述后，追加到原始需求
    if (extraPrompt && extraPrompt.trim()) {
        state.userPrompt = `${state.userPrompt}\n\n补充说明：${extraPrompt.trim()}`;
    }

    const { readable, writable } = new TransformStream<Uint8Array>();
    const encoder = new TextEncoder();
    const writer = writable.getWriter();

    const process = (async () => {
        // 心跳:从发请求到推理首 token 之间那段是静默的(CF→DS 链路慢时尤甚),每 12s 写个
        // heartbeat 维持 SSE 有字节,避免被 CF 因长静默切断 → 前端收不到 result → 误判「无响应」。
        const heartbeat = setInterval(() => {
            writer.write(sseEvent(encoder, { type: "heartbeat", t: Date.now() })).catch(() => { });
        }, 12000);
        try {
            // 超过最大轮次，强制 done
            if (state.clarifyRounds.length >= MAX_CLARIFY_ROUNDS) {
                state.clarifyDone = true;
                state.logs.push(`● 澄清轮次达到上限 ${MAX_CLARIFY_ROUNDS}，强制结束`);
                await putTaskState(context.env, taskId, state, 3600, uid);
                await writer.write(sseEvent(encoder, { type: "result", done: true, todos: [] }));
                await writer.write(encoder.encode("data: [DONE]\n\n"));
                await writer.close();
                return;
            }

            await writer.write(sseEvent(encoder, {
                type: "phase", phase: "clarifying", round: state.clarifyRounds.length + 1,
            }));

            const skillCtx = state.skills?.length ? skillClarifyContext(state.skills) : "";
            const { system, user } = plannerClarifyPrompt(
                state.userPrompt, state.coreType, state.version, state.clarifyRounds, skillCtx,
            );
            const callRes = await callReasoner(llm.url, llm.apiKey, llm.modelFor("pro"), system, user);
            const content = callRes.content;
            if (!llm.byok && uid && callRes.usage) {
                const cost = await accumulateCost(context.env, uid, taskId, llm.modelFor("pro"), callRes.usage);
                state.totalCost = cost.total;
                state.consumedQuota = cost.consumed;
                if (cost.outOfQuota) {
                    state.quotaExhausted = true;
                    await markTaskQuotaExhausted(context.env, taskId, uid);
                }
            }

            let parsed: { done?: boolean; todos?: any[]; needMoreInput?: boolean; hint?: string };
            try {
                parsed = JSON.parse(stripFences(content));
            } catch {
                await writer.write(sseEvent(encoder, {
                    type: "log", msg: "× 澄清阶段解析失败，强制进入规划",
                }));
                state.clarifyDone = true;
                await putTaskState(context.env, taskId, state, 3600, uid);
                await writer.write(sseEvent(encoder, { type: "result", done: true, todos: [] }));
                await writer.write(encoder.encode("data: [DONE]\n\n"));
                await writer.close();
                return;
            }

            if (parsed.needMoreInput) {
                state.logs.push(`! 需求过于模糊，请求用户补充`);
                await putTaskState(context.env, taskId, state, 3600, uid);
                await writer.write(sseEvent(encoder, {
                    type: "result", needMoreInput: true, hint: parsed.hint || "请补充更具体的功能描述",
                }));
                await writer.write(encoder.encode("data: [DONE]\n\n"));
                return;
            }

            const todos = Array.isArray(parsed.todos) ? parsed.todos : [];
            const done = parsed.done === true || todos.length === 0;

            if (!done) {
                state.clarifyRounds.push({ todos, answers: {} });
                state.logs.push(`▸ 澄清第 ${state.clarifyRounds.length} 轮：${todos.length} 项待确认`);
            } else {
                state.clarifyDone = true;
                state.logs.push(`● 澄清完成，共 ${state.clarifyRounds.length} 轮`);
            }

            await putTaskState(context.env, taskId, state, 3600, uid);

            await writer.write(sseEvent(encoder, { type: "result", done, todos }));
            await writer.write(encoder.encode("data: [DONE]\n\n"));
        } catch (e: any) {
            const msg = e?.name === "AbortError" ? "与模型服务连接超时" : (e?.message || String(e));
            try {
                await writer.write(sseEvent(encoder, { type: "log", msg: `× 澄清错误: ${msg}` }));
                // 关键:出错也发一个带 error 的 result,前端据此重试,而非拿到 null 直接判「无响应」硬失败
                await writer.write(sseEvent(encoder, { type: "result", error: msg }));
                await writer.write(encoder.encode("data: [DONE]\n\n"));
            } catch { /* writer 可能已被 abort/关闭 */ }
        } finally {
            clearInterval(heartbeat);
            await writer.close();
        }
    })();

    context.waitUntil(process);

    return new Response(readable, {
        headers: {
            "Content-Type": "text/event-stream",
            "Cache-Control": "no-cache",
            "Connection": "keep-alive",
        },
    });
};
