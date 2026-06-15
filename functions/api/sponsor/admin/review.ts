// POST /api/sponsor/admin/review → 站长一键通过 / 驳回待审记录
// body: { code: string, action: "approve" | "reject" }

import { verifySession, getSessionCookie } from "../../../_lib/session";
import { isAdmin, getPending, deletePending } from "../../../_lib/sponsor";
import { redeem } from "../../../_lib/quota";

interface Env {
    SESSION_SECRET: string;
    TASKS: KVNamespace;
    ADMIN_UID: string;
}

function json(obj: any, status = 200): Response {
    return new Response(JSON.stringify(obj), { status, headers: { "Content-Type": "application/json" } });
}

export const onRequestPost: PagesFunction<Env> = async (context) => {
    const session = await verifySession(getSessionCookie(context.request), context.env.SESSION_SECRET);
    if (!isAdmin(session?.uid, context.env)) return json({ ok: false, reason: "无权限" }, 403);

    let code = "", action = "";
    try {
        const b = await context.request.json() as any;
        code = String(b.code || "");
        action = String(b.action || "");
    } catch { /* ignore */ }

    const p = await getPending(context.env.TASKS, code);
    if (!p) return json({ ok: false, reason: "待审记录不存在或已处理" }, 404);

    if (action === "approve") {
        // 以备注码作为去重 key 发额度（redeem 内部 order:<code> 标记防重复）
        const r = await redeem(context.env.TASKS, p.uid, p.code, p.amount);
        await deletePending(context.env.TASKS, p.code, p.uid);
        return json({ ok: r.ok, reason: r.reason, added: r.added, login: p.login, amount: p.amount });
    }
    if (action === "reject") {
        await deletePending(context.env.TASKS, p.code, p.uid);
        return json({ ok: true, rejected: true });
    }
    return json({ ok: false, reason: "未知操作" }, 400);
};
