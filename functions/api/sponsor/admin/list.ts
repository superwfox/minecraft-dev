// GET /api/sponsor/admin/list → 站长查看全部待审记录

import { verifySession, getSessionCookie } from "../../../_lib/session";
import { isAdmin, listPending } from "../../../_lib/sponsor";

interface Env {
    SESSION_SECRET: string;
    TASKS: KVNamespace;
    ADMIN_UID: string;
}

function json(obj: any, status = 200): Response {
    return new Response(JSON.stringify(obj), { status, headers: { "Content-Type": "application/json" } });
}

export const onRequestGet: PagesFunction<Env> = async (context) => {
    const session = await verifySession(getSessionCookie(context.request), context.env.SESSION_SECRET);
    if (!isAdmin(session?.uid, context.env)) return json({ ok: false, reason: "无权限" }, 403);

    const items = await listPending(context.env.TASKS);
    return json({ ok: true, items });
};
