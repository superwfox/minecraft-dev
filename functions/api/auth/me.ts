// GET /api/auth/me → 返回当前登录用户 + 额度信息（未登录返回 user:null）

import { verifySession, getSessionCookie } from "../../_lib/session";
import { getQuota } from "../../_lib/quota";

interface Env {
    SESSION_SECRET: string;
    TASKS: KVNamespace;
}

export const onRequestGet: PagesFunction<Env> = async (context) => {
    const session = await verifySession(getSessionCookie(context.request), context.env.SESSION_SECRET);
    if (!session) {
        return new Response(JSON.stringify({ user: null }), {
            headers: { "Content-Type": "application/json", "Cache-Control": "no-store" },
        });
    }
    const quota = await getQuota(context.env.TASKS, session.uid);
    const name = typeof session.name === "string" ? session.name.trim() : "";
    return new Response(JSON.stringify({ user: { id: session.uid, login: session.login, name }, quota }), {
        headers: { "Content-Type": "application/json", "Cache-Control": "no-store" },
    });
};
