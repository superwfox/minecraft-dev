// Cloudflare Pages Function: POST /api/stream
// 流式请求，SSE 透传 DeepSeek 的 stream 响应。
// 改造点：在透传的同时解析末尾 chunk 的 usage 字段，累积到 taskCost:<taskId>。

import { accumulateCost, type UsageBreakdown } from "../_lib/quota";
import { resolveLLM, tierFromModel } from "../_lib/llm";

interface Env {
    DEEPSEEK_API_KEY: string;
    TASKS: KVNamespace;
}

export const onRequestPost: PagesFunction<Env> = async (context) => {
    const body = await context.request.json() as any;
    const llm = await resolveLLM(context);
    if (!llm.apiKey) return new Response("API key not configured", {status: 500});

    const tier = tierFromModel(body.model);
    const model = llm.modelFor(tier);
    const taskId: string | undefined = body.taskId;
    const uid: string | undefined = (context.data as any)?.uid;

    // 任务级额度耗尽时直接拒绝
    if (taskId) {
        const stateRaw = await context.env.TASKS.get(taskId);
        if (stateRaw) {
            try {
                const st = JSON.parse(stateRaw);
                if (st.quotaExhausted) {
                    return new Response(JSON.stringify({ error: "本月额度已用尽", code: "QUOTA_EXHAUSTED" }), {
                        status: 402, headers: { "Content-Type": "application/json" },
                    });
                }
            } catch { /* ignore */ }
        }
    }

    const payload: any = {
        model,
        messages: body.messages,
        stream: true,
        stream_options: { include_usage: true },
    };
    if (tier === "pro") {
        payload.reasoning_effort = "high";
        payload.thinking = {type: "enabled"};
    }

    // 空闲超时:连续 IDLE_MS 无字节才 abort（掐真正断死的连接；长思考只要还在流就不误杀）。
    const IDLE_MS = 120000;
    const ctrl = new AbortController();
    let idle: any;
    const arm = () => { clearTimeout(idle); idle = setTimeout(() => ctrl.abort(), IDLE_MS); };
    arm();

    let resp: Response;
    try {
        resp = await fetch(llm.url, {
            method: "POST",
            headers: {
                "Content-Type": "application/json",
                "Authorization": "Bearer " + llm.apiKey,
            },
            body: JSON.stringify(payload),
            signal: ctrl.signal,
        });
    } catch {
        clearTimeout(idle);
        return new Response(JSON.stringify({ error: "与模型服务连接失败或超时" }), {
            status: 504, headers: { "Content-Type": "application/json" },
        });
    }

    if (!resp.ok) { clearTimeout(idle); return new Response(await resp.text(), {status: resp.status}); }
    if (!resp.body) { clearTimeout(idle); return new Response("Empty response", {status: 502}); }

    // 用 TransformStream 包一层：原样 forward 给前端，同时本端解析 usage
    const upstream = resp.body;
    const { readable, writable } = new TransformStream<Uint8Array>();
    const writer = writable.getWriter();
    const encoder = new TextEncoder();
    const decoder = new TextDecoder();

    const pump = (async () => {
        const reader = upstream.getReader();
        let buffer = "";
        let usage: UsageBreakdown | undefined;
        try {
            while (true) {
                const { value, done } = await reader.read();
                if (done) break;
                arm(); // 收到上游字节就续命
                // 原样转发给前端
                await writer.write(value);
                // 本端解析 SSE 找 usage
                buffer += decoder.decode(value, { stream: true });
                const lines = buffer.split("\n");
                buffer = lines.pop() ?? "";
                for (const line of lines) {
                    const t = line.trim();
                    if (!t.startsWith("data:")) continue;
                    const payloadStr = t.slice(5).trim();
                    if (payloadStr === "[DONE]") continue;
                    try {
                        const chunk = JSON.parse(payloadStr);
                        if (chunk.usage) usage = chunk.usage;
                    } catch { /* skip */ }
                }
            }
        } catch { /* upstream broken, end anyway */ }
        finally {
            clearTimeout(idle);
            try { await writer.close(); } catch { /* already closed */ }
        }

        // 流结束后累积成本（BYOK 自带 key 时跳过）
        if (!llm.byok && uid && taskId && usage) {
            try {
                const cost = await accumulateCost(context.env.TASKS, uid, taskId, model, usage);
                // taskCost 已持久化正常成本；只有额度耗尽才需要改任务状态。
                if (!cost.outOfQuota) return;
                const raw = await context.env.TASKS.get(taskId);
                if (raw) {
                    const st = JSON.parse(raw);
                    st.totalCost = cost.total;
                    st.consumedQuota = cost.consumed;
                    st.quotaExhausted = true;
                    await context.env.TASKS.put(taskId, JSON.stringify(st), { expirationTtl: 3600 });
                }
            } catch { /* ignore */ }
        }
    })();

    context.waitUntil(pump);

    return new Response(readable, {
        headers: {
            "Content-Type": "text/event-stream",
            "Cache-Control": "no-cache",
        },
    });
};
