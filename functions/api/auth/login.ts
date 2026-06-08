// GET /api/auth/login → 跳转 GitHub OAuth authorize（带 state 防 CSRF）

interface Env {
    GITHUB_OAUTH_CLIENT_ID: string;
}

export const onRequestGet: PagesFunction<Env> = async (context) => {
    const clientId = context.env.GITHUB_OAUTH_CLIENT_ID;
    if (!clientId) return new Response("OAuth 未配置", { status: 500 });

    const url = new URL(context.request.url);
    const state = crypto.randomUUID();
    const returnToRaw = url.searchParams.get("return_to") || "/";
    const returnTo = returnToRaw.startsWith("/") ? returnToRaw : "/"; // 只允许站内相对路径

    const authorize = new URL("https://github.com/login/oauth/authorize");
    authorize.searchParams.set("client_id", clientId);
    authorize.searchParams.set("redirect_uri", `${url.origin}/api/auth/callback`);
    authorize.searchParams.set("scope", "read:user");
    authorize.searchParams.set("state", state);

    const headers = new Headers({ Location: authorize.toString() });
    headers.append("Set-Cookie", `oauth_state=${state}; Path=/; HttpOnly; Secure; SameSite=Lax; Max-Age=600`);
    headers.append("Set-Cookie", `oauth_return=${encodeURIComponent(returnTo)}; Path=/; HttpOnly; Secure; SameSite=Lax; Max-Age=600`);
    return new Response(null, { status: 302, headers });
};
