// Cloudflare Pages Function: POST /api/generate
// 占位：后续用于"调大模型生成 Java 项目代码"

interface Env {
    DEEPSEEK_API_KEY: string;
}

export const onRequestPost: PagesFunction<Env> = async () => {
    return new Response("Not Implemented", { status: 501 });
};
