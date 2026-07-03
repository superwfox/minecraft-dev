import { graderPrompt, skillClarifyContext } from "../../_lib/prompts";
import { enforceLevelFloor, type ScoreVector, type Level } from "../../_lib/complexity";
import { accumulateCost, type UsageBreakdown } from "../../_lib/quota";
import { resolveLLM } from "../../_lib/llm";

const DEEPSEEK_URL = "https://api.deepseek.com/v1/chat/completions";
const GRADE_MODEL = "deepseek-v4-pro";
const GRADE_IDLE_MS = 120000; // 空闲超时:连续这么久没字节才 abort（推理在持续吐 reasoning，慢但活着不会误杀）

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

async function callReasonerStream(
    url: string, key: string, model: string, system: string, user: string,
    writer: WritableStreamDefaultWriter<Uint8Array>, encoder: TextEncoder,
): Promise<{ content: string; usage?: UsageBreakdown }> {
    // 空闲超时:每收到一块数据就续命(arm),只掐真正断死的连接，不误杀慢而活着的长思考。
    const ctrl = new AbortController();
    let idle: any;
    const arm = () => { clearTimeout(idle); idle = setTimeout(() => ctrl.abort(), GRADE_IDLE_MS); };
    arm();
    try {
        const resp = await fetch(url, {
            method: "POST",
            headers: { "Content-Type": "application/json", Authorization: `Bearer ${key}` },
            body: JSON.stringify({
                model,
                stream: true,
                stream_options: { include_usage: true },
                reasoning_effort: "high",
                thinking: { type: "enabled" },
                messages: [{ role: "system", content: system }, { role: "user", content: user }],
            }),
            signal: ctrl.signal,
        });
        if (!resp.ok) throw new Error(await resp.text());

        const reader = resp.body!.getReader();
        const decoder = new TextDecoder();
        let buffer = "";
        let content = "";
        let usage: UsageBreakdown | undefined;

        while (true) {
            const { done, value } = await reader.read();
            if (done) break;
            arm();
            buffer += decoder.decode(value, { stream: true });
            const lines = buffer.split("\n");
            buffer = lines.pop()!;

            for (const line of lines) {
                const trimmed = line.trim();
                if (!trimmed.startsWith("data:")) continue;
                const payload = trimmed.slice(5).trim();
                if (payload === "[DONE]") continue;
                try {
                    const chunk = JSON.parse(payload);
                    if (chunk.usage) usage = chunk.usage;
                    const delta = chunk.choices?.[0]?.delta;
                    if (!delta) continue;
                    if (delta.reasoning_content) {
                        await writer.write(sseEvent(encoder, { type: "reasoning", content: delta.reasoning_content }));
                    }
                    if (delta.content) {
                        content += delta.content;
                        await writer.write(sseEvent(encoder, { type: "delta", content: delta.content }));
                    }
                } catch { /* skip */ }
            }
        }
        return { content, usage };
    } finally {
        clearTimeout(idle);
    }
}

export const onRequestPost: PagesFunction<Env> = async (context) => {
    const body = await context.request.json() as any;
    const llm = await resolveLLM(context);
    if (!llm.apiKey) return new Response("API key not configured", { status: 500 });

    const taskId = body.taskId as string;
    const correction = body.correction as string | undefined;

    const raw = await context.env.TASKS.get(taskId);
    if (!raw) return new Response("Task not found", { status: 404 });
    const state = JSON.parse(raw);

    if (state.quotaExhausted) {
        return new Response(JSON.stringify({ error: "本月额度已用尽", code: "QUOTA_EXHAUSTED" }), {
            status: 402, headers: { "Content-Type": "application/json" },
        });
    }
    if (!state.clarifyDone) {
        return new Response(JSON.stringify({ error: "澄清阶段尚未完成" }), {
            status: 400, headers: { "Content-Type": "application/json" },
        });
    }

    const uid: string | undefined = (context.data as any)?.uid;

    const { readable, writable } = new TransformStream<Uint8Array>();
    const encoder = new TextEncoder();
    const writer = writable.getWriter();

    const process = (async () => {
        // 心跳:推理首 token 前那段静默期每 12s 写一个,避免被 CF 因长静默切断连接 → 前端收不到 result。
        const heartbeat = setInterval(() => {
            writer.write(sseEvent(encoder, { type: "heartbeat", t: Date.now() })).catch(() => { });
        }, 12000);
        try {
            await writer.write(sseEvent(encoder, { type: "phase", phase: "grading" }));

            const skillCtx = state.skills?.length ? skillClarifyContext(state.skills) : "";
            const { system, user } = graderPrompt(state.userPrompt, state.coreType, state.version, state.clarifyRounds, correction, skillCtx);
            const callRes = await callReasonerStream(llm.url, llm.apiKey, llm.modelFor("pro"), system, user, writer, encoder);

            if (!llm.byok && uid && callRes.usage) {
                const cost = await accumulateCost(context.env.TASKS, uid, taskId, llm.modelFor("pro"), callRes.usage);
                state.totalCost = cost.total;
                state.consumedQuota = cost.consumed;
                if (cost.outOfQuota) state.quotaExhausted = true;
            }

            let parsed: any;
            try {
                parsed = JSON.parse(stripFences(callRes.content));
            } catch {
                // 分级解析失败：兜底当直接级走原路径，避免卡死（仍受现有 plannerPrompt 极简约束）
                state.grade = { vector: null, level: "直接", level_reason: "分级解析失败，按直接级处理", paths: [], gateRequired: false, chosenPathId: null };
                state.logs.push("× 分级解析失败，按直接级继续");
                await context.env.TASKS.put(taskId, JSON.stringify(state), { expirationTtl: 3600 });
                await writer.write(sseEvent(encoder, { type: "result", direct: true, level: "直接" }));
                await writer.write(encoder.encode("data: [DONE]\n\n"));
                return;
            }

            const vector = (parsed.vector ?? {}) as ScoreVector;
            const level: Level = enforceLevelFloor(parsed.level, vector); // 代码侧强制下限
            const paths = Array.isArray(parsed.paths) ? parsed.paths : [];
            // 模型判直接但被硬规则顶上来、却没给 paths 时：跳过门，直接进 plan（plan 仍按 vector 注入轴要求）
            const gateRequired = level !== "直接" && paths.length > 0;

            state.grade = {
                vector,
                level,
                level_reason: parsed.level_reason || "",
                paths,
                gateRequired,
                chosenPathId: null,
            };
            state.logs.push(`复杂度分级：${level}${parsed.level_reason ? "（" + parsed.level_reason + "）" : ""}`);
            await context.env.TASKS.put(taskId, JSON.stringify(state), { expirationTtl: 3600 });

            await writer.write(sseEvent(encoder, gateRequired
                ? { type: "result", direct: false, level, paths }
                : { type: "result", direct: true, level }));
            await writer.write(encoder.encode("data: [DONE]\n\n"));
        } catch (e: any) {
            // 出错兜底：重置 grade 为非门控并落库（避免上一轮 gateRequired 残留导致 plan 误判 400），按直接级继续
            state.grade = { vector: null, level: "直接", level_reason: "分级异常，按直接级处理", paths: [], gateRequired: false, chosenPathId: null };
            try { await context.env.TASKS.put(taskId, JSON.stringify(state), { expirationTtl: 3600 }); } catch { /* ignore */ }
            await writer.write(sseEvent(encoder, { type: "log", msg: `× 分级错误: ${e.message}` }));
            await writer.write(sseEvent(encoder, { type: "result", direct: true, level: "直接" }));
            await writer.write(encoder.encode("data: [DONE]\n\n"));
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
