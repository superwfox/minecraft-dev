// LLM provider 适配层：解析本次请求该用哪家模型。
//
// BYOK（自带 key）：请求头 X-LLM-Provider: glm + X-LLM-Key: <用户的 GLM key>，
// X-LLM-Endpoint: coding 时改用 Coding Plan 专属端点，其他值走通用端点。
// 且用户为「银牌+」（totalRecharged ≥ 25）才生效。生效时：
//   - 用用户的 GLM key + GLM 端点；
//   - byok=true → 调用方据此跳过计费/额度（accumulateCost / consume）。
// 否则回退到共享 DeepSeek key（原行为）。
//
// GLM 与 DeepSeek 均为 OpenAI 兼容 chat/completions，所以请求体与 SSE 解析可复用，
// 这里只切换 { url, key, 模型名 }。

import { getTier } from "./quota";

export type LLMTier = "pro" | "flash";

const DEEPSEEK_URL = "https://api.deepseek.com/v1/chat/completions";
const GLM_URL = "https://open.bigmodel.cn/api/paas/v4/chat/completions";
const GLM_CODING_URL = "https://open.bigmodel.cn/api/coding/paas/v4/chat/completions";

const DEEPSEEK_MODELS: Record<LLMTier, string> = {
    pro: "deepseek-v4-pro",
    flash: "deepseek-v4-flash",
};
// GLM 两档（用户自带 key；如果某账号没有这些型号，改这里即可）。
// 当前统一用最新的 glm-5.2（智谱默认旗舰）；如需给 flash 档换更省的型号，改 flash 这行即可。
const GLM_MODELS: Record<LLMTier, string> = {
    pro: "glm-5.2",
    flash: "glm-5.2",
};

export interface LLMProvider {
    providerId: "deepseek" | "glm";
    url: string;
    apiKey: string;
    byok: boolean;                       // true=用户自带 key，调用方跳过计费
    learningCacheRead: boolean;
    canAutoLearn: boolean;
    modelFor(tier: LLMTier): string;
}

interface Env {
    DEEPSEEK_API_KEY: string;
    DEEPSEEK_RESPONSES_WEB_SEARCH?: string;
    TASKS: KVNamespace;
}

/** 把 chat/stream 等 body 里的模型字符串归一化成档位（含 pro 关键字即 pro） */
export function tierFromModel(model: string | undefined): LLMTier {
    return model && /pro|reason/i.test(model) ? "pro" : "flash";
}

export async function resolveLLM(context: { request: Request; env: Env; data: any }): Promise<LLMProvider> {
    const provider = (context.request.headers.get("X-LLM-Provider") || "").trim().toLowerCase();
    const userKey = (context.request.headers.get("X-LLM-Key") || "").trim();
    const endpoint = (context.request.headers.get("X-LLM-Endpoint") || "").trim().toLowerCase();

    if (provider === "glm" && userKey) {
        // 后端校验：仅银牌+（totalRecharged≥25）可用 BYOK，防止前端绕过白嫖该特性
        const uid: string | undefined = context.data?.uid;
        if (uid) {
            try {
                const tier = await getTier(context.env.TASKS, uid);
                if (tier !== "none") {
                    return {
                        providerId: "glm",
                        url: endpoint === "coding" ? GLM_CODING_URL : GLM_URL,
                        apiKey: userKey,
                        byok: true,
                        learningCacheRead: true,
                        canAutoLearn: false,
                        modelFor: (t) => GLM_MODELS[t],
                    };
                }
            } catch { /* 校验异常 → 退回共享 */ }
        }
    }

    return {
        providerId: "deepseek",
        url: DEEPSEEK_URL,
        apiKey: context.env.DEEPSEEK_API_KEY,
        byok: false,
        learningCacheRead: true,
        canAutoLearn: /^(1|true|yes)$/i.test(context.env.DEEPSEEK_RESPONSES_WEB_SEARCH || ""),
        modelFor: (t) => DEEPSEEK_MODELS[t],
    };
}
