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
    const setupAction = url.searchParams.get("setup_action");     // GitHub App 安装回跳标记
    const installationId = url.searchParams.get("installation_id");
    const cookies = parseCookies(context.request.headers.get("Cookie"));

    // GitHub App「安装流」回跳：用户首次登录会先被引导安装 App，安装完成后 GitHub
    // 把他带回这里，但只带 installation_id / setup_action，没有 code / state。
    // 这时不是错误——App 已装好，直接弹回 /api/auth/login 重新发起一次正常的用户授权，
    // 这次就会带回 code + state。
    if (!code && (setupAction || installationId)) {
        const returnTo = cookies.oauth_return ? decodeURIComponent(cookies.oauth_return) : "/";
        const loginUrl = `${url.origin}/api/auth/login?return_to=${encodeURIComponent(returnTo.startsWith("/") ? returnTo : "/")}`;
        return new Response(null, { status: 302, headers: { Location: loginUrl } });
    }

    // 拆开三种失败，便于定位（线上日志 / 用户截图能直接区分原因）
    if (!code) {
        return new Response("登录失败：回调缺少授权码 code", { status: 400 });
    }
    if (!state) {
        return new Response("登录失败：回调缺少 state 参数", { status: 400 });
    }
    if (state !== cookies.oauth_state) {
        // cookie 没回来 / 对不上：多半是从非规范域名发起登录（cookie 按 host 隔离），
        // 或在 GitHub 授权页停留过久导致 state cookie 过期。
        return new Response(
            "登录失败：state 与会话不匹配（可能从其它域名发起或已超时）。请回到 https://tahai.xyz 重新登录。",
            { status: 400 },
        );
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
