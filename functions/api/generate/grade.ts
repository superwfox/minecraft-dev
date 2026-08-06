import { graderPrompt, skillClarifyContext } from "../../_lib/prompts";
import { enforceLevelFloor, type ScoreVector, type Level } from "../../_lib/complexity";
import { accumulateCost, type UsageBreakdown } from "../../_lib/quota";
import { resolveLLM } from "../../_lib/llm";
import { assessKnowledgeNeeds, filterPlannerKnowledgeNeeds } from "../../_lib/learning/assessment";
import { getOwnedTask, markTaskQuotaExhausted, putTaskState } from "../../_lib/taskStore";

const DEEPSEEK_URL = "https://api.deepseek.com/v1/chat/completions";
const GRADE_MODEL = "deepseek-v4-pro";
const GRADE_TIMEOUT_MS = 180000; // 非流式总时长上限（pro+thinking 可思考较久）

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
    // 【非流式】CF 免费版单请求仅 ~10ms CPU。流式逐 chunk decode + JSON.parse 会超 CPU 被硬杀。
    // 改为非流式，只做 1 次 resp.json()。代价：失去逐字思考流（由前端跑马灯动画缓解等待）。
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), GRADE_TIMEOUT_MS);
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
    const body = await context.request.json() as any;
    const llm = await resolveLLM(context);
    if (!llm.apiKey) return new Response("API key not configured", { status: 500 });

    const taskId = body.taskId as string;
    const correction = body.correction as string | undefined;
    const uid: string = (context.data as any)?.uid || "";

    const raw = await getOwnedTask(context.env, taskId, uid);
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
            const callRes = await callReasoner(llm.url, llm.apiKey, llm.modelFor("pro"), system, user);

            if (!llm.byok && uid && callRes.usage) {
                const cost = await accumulateCost(context.env, uid, taskId, llm.modelFor("pro"), callRes.usage);
                state.totalCost = cost.total;
                state.consumedQuota = cost.consumed;
                if (cost.outOfQuota) {
                    state.quotaExhausted = true;
                    await markTaskQuotaExhausted(context.env, taskId, uid);
                }
            }

            let parsed: any;
            try {
                parsed = JSON.parse(stripFences(callRes.content));
            } catch {
                // 分级解析失败：兜底当直接级走原路径，避免卡死（仍受现有 plannerPrompt 极简约束）
                state.grade = { vector: null, level: "直接", level_reason: "分级解析失败，按直接级处理", paths: [], gateRequired: false, chosenPathId: null, knowledgeNeeds: [], learningRequired: false, learningNeedCount: 0 };
                state.knowledgeNeeds = [];
                state.logs.push("× 分级解析失败，按直接级继续");
                await putTaskState(context.env, taskId, state, 3600, uid);
                await writer.write(sseEvent(encoder, {
                    type: "result",
                    direct: true,
                    level: "直接",
                    learningRequired: false,
                    learningNeedCount: 0,
                }));
                await writer.write(encoder.encode("data: [DONE]\n\n"));
                return;
            }

            const seenPathIds = new Set<string>();
            const paths = (Array.isArray(parsed.paths) ? parsed.paths : []).filter((path: any) => {
                if (seenPathIds.size >= 3) return false;
                const id = typeof path?.id === "string" ? path.id.trim() : "";
                if (!/^[A-Za-z0-9_-]{1,80}$/.test(id) || seenPathIds.has(id)) return false;
                path.id = id;
                seenPathIds.add(id);
                return true;
            });
            const assessment = assessKnowledgeNeeds(parsed.knowledgeNeeds, {
                coreType: state.coreType,
                mcVersion: state.version,
                allowedPathIds: [...seenPathIds],
            });
            const vector = (parsed.vector ?? {}) as ScoreVector;
            const plannerAssessment = filterPlannerKnowledgeNeeds(assessment.accepted, {
                userPrompt: state.userPrompt,
                externalDeps: Array.isArray(vector.external_deps) ? vector.external_deps : [],
            });
            const knowledgeNeeds = plannerAssessment.accepted;
            const learningRequired = knowledgeNeeds.length > 0;
            const level: Level = enforceLevelFloor(parsed.level, vector); // 代码侧强制下限
            // 模型判直接但被硬规则顶上来、却没给 paths 时：跳过门，直接进 plan（plan 仍按 vector 注入轴要求）
            const gateRequired = level !== "直接" && paths.length > 0;

            state.grade = {
                vector,
                level,
                level_reason: parsed.level_reason || "",
                paths,
                gateRequired,
                chosenPathId: null,
                knowledgeNeeds,
                learningRequired,
                learningNeedCount: knowledgeNeeds.length,
            };
            state.knowledgeNeeds = knowledgeNeeds;
            state.logs.push(`复杂度分级：${level}${parsed.level_reason ? "（" + parsed.level_reason + "）" : ""}`);
            const rejectedNeedCount = assessment.rejected.length + plannerAssessment.rejected.length;
            if (rejectedNeedCount) {
                state.logs.push(`▸ 已忽略 ${rejectedNeedCount} 个不符合学习边界的知识候选`);
            }
            await putTaskState(context.env, taskId, state, 3600, uid);

            const learningResult = {
                learningRequired,
                learningNeedCount: knowledgeNeeds.length,
            };
            await writer.write(sseEvent(encoder, gateRequired
                ? { type: "result", direct: false, level, paths, ...learningResult }
                : { type: "result", direct: true, level, ...learningResult }));
            await writer.write(encoder.encode("data: [DONE]\n\n"));
        } catch (e: any) {
            // 出错兜底：重置 grade 为非门控并落库（避免上一轮 gateRequired 残留导致 plan 误判 400），按直接级继续
            state.grade = { vector: null, level: "直接", level_reason: "分级异常，按直接级处理", paths: [], gateRequired: false, chosenPathId: null, knowledgeNeeds: [], learningRequired: false, learningNeedCount: 0 };
            state.knowledgeNeeds = [];
            try { await putTaskState(context.env, taskId, state, 3600, uid); } catch { /* ignore */ }
            await writer.write(sseEvent(encoder, { type: "log", msg: `× 分级错误: ${e.message}` }));
            await writer.write(sseEvent(encoder, {
                type: "result",
                direct: true,
                level: "直接",
                learningRequired: false,
                learningNeedCount: 0,
            }));
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
