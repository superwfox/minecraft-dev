// LLM provider 适配层：解析本次请求该用哪家模型。
//
// BYOK（自带 key）：请求头 X-LLM-Provider + X-LLM-Key 指定本次请求的提供方与 key。
//   - DeepSeek BYOK 对所有登录用户开放；
//   - GLM BYOK 仍要求银牌+，X-LLM-Endpoint: coding 时使用 Coding Plan 专属端点；
//   - byok=true 时调用方跳过平台额度检查与计费。
// 未提供有效 BYOK 配置时回退到共享 DeepSeek key。
//
// GLM 与 DeepSeek 均为 OpenAI 兼容 chat/completions，所以请求体与 SSE 解析可复用，
// 这里只切换 { url, key, 模型名 }。

import { getTier } from "./quota";

export type LLMTier = "pro" | "flash";
export type TaskBillingProvider = "deepseek_byok" | "platform";

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
    credentialId: string;                // 非敏感的浏览器凭证版本 ID；绝不由 key 派生
    learningCacheRead: boolean;
    canAutoLearn: boolean;
    modelFor(tier: LLMTier): string;
}

interface TaskBillingState {
    billingProvider?: unknown;
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

/** 供中间件和任务恢复入口使用；与 resolveLLM 的 DeepSeek BYOK 判定保持一致。 */
export function isDeepSeekByokRequest(request: Request): boolean {
    const provider = (request.headers.get("X-LLM-Provider") || "").trim().toLowerCase();
    const userKey = (request.headers.get("X-LLM-Key") || "").trim();
    return provider === "deepseek" && !!userKey;
}

function credentialIdFromRequest(request: Request): string {
    const value = (request.headers.get("X-LLM-Credential-Id") || "").trim();
    return /^[A-Za-z0-9_-]{1,80}$/.test(value) ? value : "";
}

export function taskBillingProviderFor(llm: LLMProvider): TaskBillingProvider {
    return llm.providerId === "deepseek" && llm.byok ? "deepseek_byok" : "platform";
}

export function deepSeekKeyRequiredResponse(): Response {
    return new Response(JSON.stringify({
        error: "该任务使用用户自己的 DeepSeek Key，请重新填写后继续",
        code: "DEEPSEEK_KEY_REQUIRED",
    }), {
        status: 428,
        headers: { "Content-Type": "application/json" },
    });
}

function sharedDeepSeekProvider(env: Env): LLMProvider {
    return {
        providerId: "deepseek",
        url: DEEPSEEK_URL,
        apiKey: env.DEEPSEEK_API_KEY,
        byok: false,
        credentialId: "",
        learningCacheRead: true,
        canAutoLearn: /^(1|true|yes)$/i.test(env.DEEPSEEK_RESPONSES_WEB_SEARCH || ""),
        modelFor: (t) => DEEPSEEK_MODELS[t],
    };
}

export async function resolveLLM(context: { request: Request; env: Env; data: any }): Promise<LLMProvider> {
    const provider = (context.request.headers.get("X-LLM-Provider") || "").trim().toLowerCase();
    const userKey = (context.request.headers.get("X-LLM-Key") || "").trim();
    const endpoint = (context.request.headers.get("X-LLM-Endpoint") || "").trim().toLowerCase();

    if (provider === "deepseek" && userKey) {
        return {
            providerId: "deepseek",
            url: DEEPSEEK_URL,
            apiKey: userKey,
            byok: true,
            credentialId: credentialIdFromRequest(context.request),
            learningCacheRead: true,
            canAutoLearn: /^(1|true|yes)$/i.test(context.env.DEEPSEEK_RESPONSES_WEB_SEARCH || ""),
            modelFor: (t) => DEEPSEEK_MODELS[t],
        };
    }

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
                        credentialId: credentialIdFromRequest(context.request),
                        learningCacheRead: true,
                        canAutoLearn: false,
                        modelFor: (t) => GLM_MODELS[t],
                    };
                }
            } catch { /* 校验异常 → 退回共享 */ }
        }
    }

    return sharedDeepSeekProvider(context.env);
}

/**
 * DeepSeek BYOK 创建的任务单向固定为 BYOK，缺 key 时返回 null。
 * platform 与没有 billingProvider 的旧任务继续按本次请求解析，允许在已预扣首件后改用 BYOK。
 */
export async function resolveTaskLLM(
    context: { request: Request; env: Env; data: any },
    state: TaskBillingState,
): Promise<LLMProvider | null> {
    if (state.billingProvider === "deepseek_byok") {
        if (!isDeepSeekByokRequest(context.request)) return null;
        return resolveLLM(context);
    }
    return resolveLLM(context);
}
