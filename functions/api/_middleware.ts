// 统一闸门（作用于所有 /api/* 请求）：
//   1) IP 限流（贵端点）
//   2) 强制登录（生成 / 聊天 / 流式）
//   3) 新建任务（plan mode-1）时校验并扣 1 件额度
//
// 注意：仅在「新建任务」扣费，同一 taskId 的后续生成/修复/重建不重复扣。

import { verifySession, getSessionCookie } from "../_lib/session";
import { getQuota, consume, ipAllow } from "../_lib/quota";
import { TaskStoreUnavailableError } from "../_lib/taskStore";

interface Env {
    SESSION_SECRET: string;
    TASKS: KVNamespace;
    /** 可选的 Cloudflare Rate Limiting binding；未配置时仅昂贵写端点回退 KV。 */
    API_RATE_LIMITER?: {
        limit(options: { key: string }): Promise<{ success: boolean }>;
    };
    /** 使用域名级 WAF Rate Limiting 时设为 true，关闭 KV 限流兜底。 */
    EDGE_RATE_LIMITING?: string;
}

// 需要登录的（贵）端点
function needsAuth(path: string): boolean {
    return path.startsWith("/api/generate/")
        || path.startsWith("/api/learning/")
        || path === "/api/chat"
        || path === "/api/stream"
        || path === "/api/skills/submit";
}

// 需要软限流的端点（Rate Limiting binding 不产生 TASKS KV 读写）。
function needsRateLimit(path: string): boolean {
    return needsAuth(path) || path === "/api/sponsor/request" || path === "/api/auth/callback";
}

// 未配置 binding 时只保护真正会触发 LLM / GitHub 写操作的端点。
// status / verify / download 等轮询、只读端点不再为限流固定消耗一读一写。
function needsKvFallbackLimit(path: string): boolean {
    return path === "/api/chat"
        || path === "/api/stream"
        || path === "/api/skills/submit"
        || path === "/api/sponsor/request"
        || path === "/api/auth/callback"
        || path === "/api/learning/start"
        || path === "/api/learning/step"
        || ["plan", "clarify", "grade", "bucket", "file", "fix", "build"]
            .some(name => path === `/api/generate/${name}`);
}

function json(obj: any, status: number): Response {
    return new Response(JSON.stringify(obj), { status, headers: { "Content-Type": "application/json" } });
}

export const onRequest: PagesFunction<Env> = async (context) => {
    const { request, env } = context;
    const path = new URL(request.url).pathname;
    let session: any = null;
    const next = async (): Promise<Response> => {
        try {
            return await context.next();
        } catch (error) {
            if (error instanceof TaskStoreUnavailableError) {
                return json({
                    error: "任务状态存储暂不可用，请稍后重试",
                    code: "TASK_STORE_UNAVAILABLE",
                    reasonCode: "storage_unavailable",
                }, 503);
            }
            throw error;
        }
    };

    // 1) 登录闸门：先验证会话，避免未登录请求先消耗 KV 限流计数。
    if (needsAuth(path)) {
        session = await verifySession(getSessionCookie(request), env.SESSION_SECRET);
        if (!session) {
            return json({ error: "请先登录", code: "AUTH_REQUIRED" }, 401);
        }
        // 透传 uid / login 给下游 handler（扣费/限额需要 uid；skill 上传 PR @mention 需要 login）
        (context.data as any).uid = session.uid;
        (context.data as any).login = session.login;
    }

    // 2) 优先使用 Cloudflare 原生 Rate Limiting binding；缺失时仅昂贵端点回退 KV。
    if (needsRateLimit(path)) {
        const ip = request.headers.get("CF-Connecting-IP") || "0.0.0.0";
        const limiterKey = session?.uid ? `user:${session.uid}` : `ip:${ip}`;
        const edgeLimiterEnabled = /^(1|true|yes)$/i.test(env.EDGE_RATE_LIMITING || "");
        let allowed = true;
        if (env.API_RATE_LIMITER) {
            try {
                allowed = (await env.API_RATE_LIMITER.limit({ key: limiterKey })).success;
            } catch {
                if (!edgeLimiterEnabled && needsKvFallbackLimit(path)) allowed = await ipAllow(env.TASKS, ip, path);
            }
        } else if (!edgeLimiterEnabled && needsKvFallbackLimit(path)) {
            allowed = await ipAllow(env.TASKS, ip, path);
        }
        if (!allowed) return json({ error: "请求过于频繁，请稍后再试" }, 429);
    }

    // 3) 新建任务额度：仅在 task 创建成功后扣 1 件。
    if (session && path === "/api/generate/plan") {
        // 仅在「新建任务」(plan mode-1，body 无 taskId) 时校验并扣额度
        let body: any = {};
        try { body = await request.clone().json(); } catch { /* ignore */ }
        if (!body.taskId) {
            const q = await getQuota(env.TASKS, session.uid);
            if (q.remaining <= 0) {
                return json({ error: "本月额度已用尽", code: "QUOTA_EXHAUSTED" }, 402);
            }
            // 先校验额度，仅在任务创建成功后才扣费（避免瞬时失败 + 前端重试重复扣）
            const res = await next();
            if (res.ok) await consume(env.TASKS, session.uid);
            return res;
        }
    }

    return next();
};
