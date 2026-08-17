interface Env {
    XF_APPID: string;
    XF_API_KEY: string;
    XF_API_SECRET: string;
}

const IAT_HOST = "iat-api.xfyun.cn";
const IAT_PATH = "/v2/iat";

function toBase64(data: Uint8Array): string {
    let binary = "";
    for (const b of data) binary += String.fromCharCode(b);
    return btoa(binary);
}

async function hmacSha256Base64(key: string, message: string): Promise<string> {
    const enc = new TextEncoder();
    const cryptoKey = await crypto.subtle.importKey(
        "raw", enc.encode(key), { name: "HMAC", hash: "SHA-256" }, false, ["sign"],
    );
    const sig = await crypto.subtle.sign("HMAC", cryptoKey, enc.encode(message));
    return toBase64(new Uint8Array(sig));
}

export const onRequestGet: PagesFunction<Env> = async (context) => {
    const appId = (context.env.XF_APPID || "").trim();
    const apiKey = (context.env.XF_API_KEY || "").trim();
    const apiSecret = (context.env.XF_API_SECRET || "").trim();
    if (!apiKey || !apiSecret || !appId) {
        return new Response("XF credentials not configured", { status: 500 });
    }

    const LF = String.fromCharCode(10);
    const date = new Date().toUTCString();
    const signatureOrigin = "host: " + IAT_HOST + LF + "date: " + date + LF + "GET " + IAT_PATH + " HTTP/1.1";
    const signature = await hmacSha256Base64(apiSecret, signatureOrigin);
    const authOrigin = 'api_key="' + apiKey + '", algorithm="hmac-sha256", headers="host date request-line", signature="' + signature + '"';
    const authorization = btoa(authOrigin);

    const url =
        "wss://" + IAT_HOST + IAT_PATH +
        "?authorization=" + encodeURIComponent(authorization) +
        "&date=" + encodeURIComponent(date) +
        "&host=" + encodeURIComponent(IAT_HOST);

    return new Response(JSON.stringify({ url, appId }), {
        headers: { "Content-Type": "application/json", "Cache-Control": "no-store" },
    });
};
