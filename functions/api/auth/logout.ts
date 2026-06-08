// POST /api/auth/logout → 清除会话 cookie

import { sessionClearCookie } from "../../_lib/session";

export const onRequestPost: PagesFunction = async () => {
    return new Response(JSON.stringify({ ok: true }), {
        headers: { "Content-Type": "application/json", "Set-Cookie": sessionClearCookie() },
    });
};
