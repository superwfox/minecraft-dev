// 统一闸门（作用于所有 /api/* 请求）：
//   1) IP 限流（贵端点）
//   2) 强制登录（生成 / 聊天 / 流式）
//   3) 新建任务（plan mode-1）时校验并扣 1 件额度
//
// 注意：仅在「新建任务」扣费，同一 taskId 的后续生成/修复/重建不重复扣。

import { verifySession, getSessionCookie } from "../_lib/session";
import { getQuota, consume, ipAllow } from "../_lib/quota";

interface Env {
    SESSION_SECRET: string;
    TASKS: KVNamespace;
}

// 需要登录的（贵）端点
function needsAuth(path: string): boolean {
    return path.startsWith("/api/generate/") || path === "/api/chat" || path === "/api/stream";
}

// 需要 IP 限流的端点（避开 IDE 高频的 /api/maven/jar 与 /api/voice-auth）
function needsIpLimit(path: string): boolean {
    return needsAuth(path) || path === "/api/sponsor/request" || path === "/api/auth/callback";
}

function json(obj: any, status: number): Response {
    return new Response(JSON.stringify(obj), { status, headers: { "Content-Type": "application/json" } });
}

export const onRequest: PagesFunction<Env> = async (context) => {
    const { request, env } = context;
    const path = new URL(request.url).pathname;

    // 1) IP 限流（KV 兜底；生产建议叠加 Cloudflare WAF Rate Limiting）
    if (needsIpLimit(path)) {
        const ip = request.headers.get("CF-Connecting-IP") || "0.0.0.0";
        if (!(await ipAllow(env.TASKS, ip))) {
            return json({ error: "请求过于频繁，请稍后再试" }, 429);
        }
    }

    // 2) 登录闸门 + 额度
    if (needsAuth(path)) {
        const session = await verifySession(getSessionCookie(request), env.SESSION_SECRET);
        if (!session) {
            return json({ error: "请先登录", code: "AUTH_REQUIRED" }, 401);
        }
        // 透传 uid 给下游 handler（按金额扣费、build 限额都需要）
        (context.data as any).uid = session.uid;

        // 仅在「新建任务」(plan mode-1，body 无 taskId) 时校验并扣额度
        if (path === "/api/generate/plan") {
            let body: any = {};
            try { body = await request.clone().json(); } catch { /* ignore */ }
            if (!body.taskId) {
                const q = await getQuota(env.TASKS, session.uid);
                if (q.remaining <= 0) {
                    return json({ error: "本月额度已用尽", code: "QUOTA_EXHAUSTED" }, 402);
                }
                // 先校验额度，仅在任务创建成功后才扣费（避免瞬时失败 + 前端重试重复扣）
                const res = await context.next();
                if (res.ok) await consume(env.TASKS, session.uid);
                return res;
            }
        }
    }

    return context.next();
};
