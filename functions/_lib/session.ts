// 自签会话：HMAC-SHA256 签名的 cookie，无需数据库。
// cookie 值格式： base64url(payloadJson).base64url(hmac)

export interface Session {
    uid: string;
    login: string;
    exp: number;
}

export const COOKIE_NAME = "tahai_sess";
const TTL_SEC = 30 * 24 * 3600; // 30 天

function b64urlEncode(bytes: Uint8Array): string {
    let bin = "";
    for (const b of bytes) bin += String.fromCharCode(b);
    return btoa(bin).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

function b64urlDecode(s: string): Uint8Array {
    s = s.replace(/-/g, "+").replace(/_/g, "/");
    while (s.length % 4) s += "=";
    const bin = atob(s);
    const out = new Uint8Array(bin.length);
    for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
    return out;
}

async function hmac(secret: string, msg: string): Promise<Uint8Array> {
    const key = await crypto.subtle.importKey(
        "raw", new TextEncoder().encode(secret),
        { name: "HMAC", hash: "SHA-256" }, false, ["sign"],
    );
    const sig = await crypto.subtle.sign("HMAC", key, new TextEncoder().encode(msg));
    return new Uint8Array(sig);
}

export async function signSession(payload: { uid: string; login: string }, secret: string): Promise<string> {
    const data: Session = {
        uid: payload.uid,
        login: payload.login,
        exp: Math.floor(Date.now() / 1000) + TTL_SEC,
    };
    const body = b64urlEncode(new TextEncoder().encode(JSON.stringify(data)));
    const sig = b64urlEncode(await hmac(secret, body));
    return `${body}.${sig}`;
}

export async function verifySession(token: string | null, secret: string): Promise<Session | null> {
    if (!token) return null;
    const dot = token.lastIndexOf(".");
    if (dot < 0) return null;
    const body = token.slice(0, dot);
    const sig = token.slice(dot + 1);
    const expected = b64urlEncode(await hmac(secret, body));
    // 等长常量比较
    if (sig.length !== expected.length) return null;
    let diff = 0;
    for (let i = 0; i < sig.length; i++) diff |= sig.charCodeAt(i) ^ expected.charCodeAt(i);
    if (diff !== 0) return null;
    try {
        const data = JSON.parse(new TextDecoder().decode(b64urlDecode(body))) as Session;
        if (!data.uid || !data.exp || data.exp < Math.floor(Date.now() / 1000)) return null;
        return data;
    } catch {
        return null;
    }
}

export function parseCookies(header: string | null): Record<string, string> {
    const out: Record<string, string> = {};
    if (!header) return out;
    for (const part of header.split(";")) {
        const idx = part.indexOf("=");
        if (idx < 0) continue;
        out[part.slice(0, idx).trim()] = part.slice(idx + 1).trim();
    }
    return out;
}

export function getSessionCookie(request: Request): string | null {
    return parseCookies(request.headers.get("Cookie"))[COOKIE_NAME] ?? null;
}

export function sessionSetCookie(token: string): string {
    return `${COOKIE_NAME}=${token}; Path=/; HttpOnly; Secure; SameSite=Lax; Max-Age=${TTL_SEC}`;
}

export function sessionClearCookie(): string {
    return `${COOKIE_NAME}=; Path=/; HttpOnly; Secure; SameSite=Lax; Max-Age=0`;
}
