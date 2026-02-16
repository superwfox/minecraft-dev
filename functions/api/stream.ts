// Cloudflare Pages Function: POST /api/stream
// 流式请求，SSE 透传 DeepSeek 的 stream 响应

const DEEPSEEK_URL = "https://api.deepseek.com/v1/chat/completions";

interface Env {
    DEEPSEEK_API_KEY: string;
}

export const onRequestPost: PagesFunction<Env> = async (context) => {
    const body = await context.request.json() as any;
    const key = context.env.DEEPSEEK_API_KEY;

    if (!key) return new Response("API key not configured", {status: 500});

    const resp = await fetch(DEEPSEEK_URL, {
        method: "POST",
        headers: {
            "Content-Type": "application/json",
            "Authorization": "Bearer " + key,
        },
        body: JSON.stringify({model: body.model || "deepseek-chat", messages: body.messages, stream: true}),
    });

    if (!resp.ok) return new Response(await resp.text(), {status: resp.status});

    // 直接透传 SSE 流
    return new Response(resp.body, {
        headers: {
            "Content-Type": "text/event-stream",
            "Cache-Control": "no-cache",
        },
    });
};
