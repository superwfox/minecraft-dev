// Cloudflare Pages Function: POST /api/chat
// 非流式请求，转发到 DeepSeek

const DEEPSEEK_URL = "https://api.deepseek.com/v1/chat/completions";

interface Env {
    DEEPSEEK_API_KEY: string;
}

export const onRequestPost: PagesFunction<Env> = async (context) => {
    const body = await context.request.json() as any;
    const key = context.env.DEEPSEEK_API_KEY;

    if (!key) return new Response("API key not configured", {status: 500});

    const model = body.model || "deepseek-v4-flash";
    const payload: any = {model, messages: body.messages};
    if (model.includes("pro")) {
        payload.reasoning_effort = "high";
        payload.thinking = {type: "enabled"};
    }
    if (body.response_format) payload.response_format = body.response_format;

    const resp = await fetch(DEEPSEEK_URL, {
        method: "POST",
        headers: {
            "Content-Type": "application/json",
            "Authorization": "Bearer " + key,
        },
        body: JSON.stringify(payload),
    });

    if (!resp.ok) return new Response(await resp.text(), {status: resp.status});

    const data = await resp.json() as any;
    return new Response(JSON.stringify({content: data.choices[0].message.content}), {
        headers: {"Content-Type": "application/json"},
    });
};
