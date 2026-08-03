// Cloudflare Pages Function: POST /api/chat
// 非流式：向上游发非流式请求，只做 1 次 resp.json()。CF 免费版单请求 CPU 极有限，
// 流式逐 chunk 解析会超 CPU 被硬杀，故所有 LLM 调用统一走非流式。

import { accumulateCost } from "../_lib/quota";
import { resolveLLM, tierFromModel } from "../_lib/llm";
import { getOwnedTask, markTaskQuotaExhausted } from "../_lib/taskStore";

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
    const uid: string = (context.data as any)?.uid || "";

    // 带 taskId 的调用必须命中当前用户的任务，避免越权读取状态或错误归集费用。
    if (taskId) {
        const stateRaw = await getOwnedTask(context.env, taskId, uid);
        if (!stateRaw) return new Response("Task not found", { status: 404 });
        try {
            const st = JSON.parse(stateRaw);
            if (st.quotaExhausted) {
                return new Response(JSON.stringify({ error: "本月额度已用尽", code: "QUOTA_EXHAUSTED" }), {
                    status: 402, headers: { "Content-Type": "application/json" },
                });
            }
        } catch { /* ignore */ }
    }

    // 【非流式】CF 免费版单请求仅 ~10ms CPU。流式逐 chunk decode + JSON.parse 会超 CPU 被硬杀。
    // 只做 1 次 resp.json()——precheck/getInfo 等本就要完整 JSON，非流式最省 CPU。
    const payload: any = {model, messages: body.messages};
    if (tier === "pro") {
        payload.reasoning_effort = "high";
        payload.thinking = {type: "enabled"};
    }
    if (body.response_format) payload.response_format = body.response_format;

    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), 180000);
    let data: any;
    try {
        const resp = await fetch(llm.url, {
            method: "POST",
            headers: {
                "Content-Type": "application/json",
                "Authorization": "Bearer " + llm.apiKey,
            },
            body: JSON.stringify(payload),
            signal: ctrl.signal,
        });
        if (!resp.ok) { clearTimeout(timer); return new Response(await resp.text(), {status: resp.status}); }
        data = await resp.json();
    } catch {
        clearTimeout(timer);
        return new Response(JSON.stringify({ error: "与模型服务连接失败或超时" }), {
            status: 504, headers: { "Content-Type": "application/json" },
        });
    }
    clearTimeout(timer);

    const content = data.choices?.[0]?.message?.content ?? "";
    const usage = data.usage;

    if (!llm.byok && uid && taskId && usage) {
        // 不阻塞响应：waitUntil 后台累积
        context.waitUntil(accumulateCost(context.env, uid, taskId, model, usage).then(async (cost) => {
            if (cost.outOfQuota) await markTaskQuotaExhausted(context.env, taskId, uid);
        }).catch((error) => console.warn("chat cost accumulation failed", error)));
    }
    return new Response(JSON.stringify({content}), {
        headers: {"Content-Type": "application/json"},
    });
};
