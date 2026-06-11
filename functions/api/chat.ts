// Cloudflare Pages Function: POST /api/chat
// 非流式请求，转发到 DeepSeek

import { accumulateCost } from "../_lib/quota";

const DEEPSEEK_URL = "https://api.deepseek.com/v1/chat/completions";

interface Env {
    DEEPSEEK_API_KEY: string;
    TASKS: KVNamespace;
}

export const onRequestPost: PagesFunction<Env> = async (context) => {
    const body = await context.request.json() as any;
    const key = context.env.DEEPSEEK_API_KEY;

    if (!key) return new Response("API key not configured", {status: 500});

    const model = body.model || "deepseek-v4-flash";
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

    const payload: any = {model, messages: body.messages};
    if (model.includes("pro")) {
        payload.reasoning_effort = "high";
        payload.thinking = {type: "enabled"};
    }
    if (body.response_format) payload.response_format = body.response_format;

    const resp = await fetch(DEEPSEEK_URL, {
        method: "POST",
        headers: {
            "Content-Type": "application/json",
            "Authorization": "Bearer " + key,
        },
        body: JSON.stringify(payload),
    });

    if (!resp.ok) return new Response(await resp.text(), {status: resp.status});

    const data = await resp.json() as any;
    if (uid && taskId && data.usage) {
        // 不阻塞响应：waitUntil 后台累积
        context.waitUntil(accumulateCost(context.env.TASKS, uid, taskId, model, data.usage).then(async (cost) => {
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
    return new Response(JSON.stringify({content: data.choices[0].message.content}), {
        headers: {"Content-Type": "application/json"},
    });
};
