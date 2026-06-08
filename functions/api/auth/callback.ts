// GET /api/auth/callback → 校验 state、用 code 换 token、取 GitHub 用户、签发会话 cookie、跳回前端

import { signSession, sessionSetCookie, parseCookies } from "../../_lib/session";

interface Env {
    GITHUB_OAUTH_CLIENT_ID: string;
    GITHUB_OAUTH_CLIENT_SECRET: string;
    SESSION_SECRET: string;
}

export const onRequestGet: PagesFunction<Env> = async (context) => {
    const url = new URL(context.request.url);
    const code = url.searchParams.get("code");
    const state = url.searchParams.get("state");
    const cookies = parseCookies(context.request.headers.get("Cookie"));

    if (!code || !state || state !== cookies.oauth_state) {
        return new Response("OAuth state 校验失败", { status: 400 });
    }

    // 1) code → access_token
    const tokenResp = await fetch("https://github.com/login/oauth/access_token", {
        method: "POST",
        headers: { "Content-Type": "application/json", Accept: "application/json" },
        body: JSON.stringify({
            client_id: context.env.GITHUB_OAUTH_CLIENT_ID,
            client_secret: context.env.GITHUB_OAUTH_CLIENT_SECRET,
            code,
            redirect_uri: `${url.origin}/api/auth/callback`,
        }),
    });
    const tokenData = await tokenResp.json() as any;
    const accessToken = tokenData.access_token;
    if (!accessToken) return new Response("OAuth 换取 token 失败", { status: 401 });

    // 2) 取用户
    const userResp = await fetch("https://api.github.com/user", {
        headers: {
            Authorization: `Bearer ${accessToken}`,
            "User-Agent": "tahai",
            Accept: "application/vnd.github+json",
        },
    });
    if (!userResp.ok) return new Response("获取 GitHub 用户失败", { status: 401 });
    const ghUser = await userResp.json() as any;

    // 3) 签发会话
    const token = await signSession(
        { uid: `gh_${ghUser.id}`, login: ghUser.login },
        context.env.SESSION_SECRET,
    );

    const returnTo = cookies.oauth_return ? decodeURIComponent(cookies.oauth_return) : "/";
    const headers = new Headers({ Location: returnTo.startsWith("/") ? returnTo : "/" });
    headers.append("Set-Cookie", sessionSetCookie(token));
    headers.append("Set-Cookie", "oauth_state=; Path=/; Max-Age=0");
    headers.append("Set-Cookie", "oauth_return=; Path=/; Max-Age=0");
    return new Response(null, { status: 302, headers });
};
