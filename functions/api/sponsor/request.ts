// POST /api/sponsor/request → 选档位，生成/复用备注码并登记待审
// body: { tier: "t25" | "t50" }

import { verifySession, getSessionCookie } from "../../_lib/session";
import { tierAmount, normalizeAmount, upsertPending } from "../../_lib/sponsor";

interface Env {
    SESSION_SECRET: string;
    TASKS: KVNamespace;
}

function json(obj: any, status = 200): Response {
    return new Response(JSON.stringify(obj), { status, headers: { "Content-Type": "application/json" } });
}

export const onRequestPost: PagesFunction<Env> = async (context) => {
    const session = await verifySession(getSessionCookie(context.request), context.env.SESSION_SECRET);
    if (!session) return json({ ok: false, reason: "请先登录" }, 401);

    let body: any = {};
    try { body = await context.request.json(); } catch { /* ignore */ }
    // 自定义金额优先；否则按档位
    const amount = body.amount !== undefined ? normalizeAmount(body.amount) : tierAmount(String(body.tier || ""));
    if (!amount) return json({ ok: false, reason: "金额无效（最低 1 元，取整）" }, 400);

    const rec = await upsertPending(context.env.TASKS, session.uid, session.login, amount);
    return json({ ok: true, code: rec.code, amount: rec.amount });
};
