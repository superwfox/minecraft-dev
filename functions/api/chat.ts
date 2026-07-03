// Cloudflare Pages Function: POST /api/chat
// 对前端仍是非流式 JSON 响应({ content });内部改用「流式消费上游 + 空闲超时」，
// 避免 pro+thinking 的长时间静默把 Worker 挂死拿不到返回。

import { accumulateCost } from "../_lib/quota";
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

    const payload: any = {model, messages: body.messages, stream: true, stream_options: {include_usage: true}};
    if (tier === "pro") {
        payload.reasoning_effort = "high";
        payload.thinking = {type: "enabled"};
    }
    if (body.response_format) payload.response_format = body.response_format;

    // 空闲超时:连续这么久没字节才 abort（掐真正断死的连接；长思考只要在流就不误杀）。
    const CHAT_IDLE_MS = 120000;
    const ctrl = new AbortController();
    let idle: any;
    const arm = () => { clearTimeout(idle); idle = setTimeout(() => ctrl.abort(), CHAT_IDLE_MS); };
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

    // 内部消费流:累积 content(忽略 reasoning) + 末尾 usage
    let content = "";
    let usage: any;
    try {
        const reader = resp.body!.getReader();
        const decoder = new TextDecoder();
        let buffer = "";
        while (true) {
            const { done, value } = await reader.read();
            if (done) break;
            arm();
            buffer += decoder.decode(value, { stream: true });
            const lines = buffer.split("\n");
            buffer = lines.pop() ?? "";
            for (const line of lines) {
                const t = line.trim();
                if (!t.startsWith("data:")) continue;
                const p = t.slice(5).trim();
                if (p === "[DONE]") continue;
                try {
                    const chunk = JSON.parse(p);
                    const delta = chunk.choices?.[0]?.delta?.content;
                    if (delta) content += delta;
                    if (chunk.usage) usage = chunk.usage;
                } catch { /* skip */ }
            }
        }
    } finally {
        clearTimeout(idle);
    }

    if (!llm.byok && uid && taskId && usage) {
        // 不阻塞响应：waitUntil 后台累积
        context.waitUntil(accumulateCost(context.env.TASKS, uid, taskId, model, usage).then(async (cost) => {
            // 回写 state.totalCost / consumedQuota，方便前端展示
            const raw = await context.env.TASKS.get(taskId);
            if (!raw) return;
            try {
                const st = JSON.parse(raw);
                st.totalCost = cost.total;
                st.consumedQuota = cost.consumed;
                if (cost.outOfQuota) st.quotaExhausted = true;
                await context.env.TASKS.put(taskId, JSON.stringify(st), { expirationTtl: 3600 });
            } catch { /* ignore */ }
        }));
    }
    return new Response(JSON.stringify({content}), {
        headers: {"Content-Type": "application/json"},
    });
};
