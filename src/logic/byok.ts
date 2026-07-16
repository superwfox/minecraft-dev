// BYOK（自带 key）：银牌+ 用户可外接自己的 GLM key，支持通用 / Coding Plan 端点。
// Key 有效时 LLM 调用走用户额度；两个端点均鉴权失败时自动改走平台额度。
// 仅前端存储 + 每次请求带头；后端 _lib/llm.ts 再做银牌门校验。

import { reactive } from "vue";

const STORAGE_KEY = "tahai-byok";
const STANDARD_ENDPOINT = "standard";
const CODING_ENDPOINT = "coding";

type ByokEndpoint = typeof STANDARD_ENDPOINT | typeof CODING_ENDPOINT;

export interface ByokState {
    enabled: boolean;
    provider: string; // 目前只有 "glm"
    key: string;
    endpoint: ByokEndpoint;
}

function load(): ByokState {
    try {
        const raw = localStorage.getItem(STORAGE_KEY);
        if (raw) {
            const o = JSON.parse(raw);
            return {
                enabled: !!o.enabled,
                provider: o.provider || "glm",
                key: o.key || "",
                endpoint: o.endpoint === CODING_ENDPOINT ? CODING_ENDPOINT : STANDARD_ENDPOINT,
            };
        }
    } catch { /* ignore */ }
    return { enabled: false, provider: "glm", key: "", endpoint: STANDARD_ENDPOINT };
}

export const byok = reactive<ByokState>(load());

export const byokNotice = reactive({
    visible: false,
    message: "",
});

let noticeTimer: number | undefined;

function showByokNotice(message: string) {
    byokNotice.message = message;
    byokNotice.visible = true;
    if (noticeTimer !== undefined) window.clearTimeout(noticeTimer);
    noticeTimer = window.setTimeout(() => {
        byokNotice.visible = false;
        noticeTimer = undefined;
    }, 7000);
}

export function dismissByokNotice() {
    byokNotice.visible = false;
    if (noticeTimer !== undefined) window.clearTimeout(noticeTimer);
    noticeTimer = undefined;
}

export function saveByok() {
    try {
        localStorage.setItem(STORAGE_KEY, JSON.stringify({
            enabled: byok.enabled,
            provider: byok.provider,
            key: byok.key,
            endpoint: byok.endpoint,
        }));
    } catch { /* ignore */ }
}

/** 启用且有 key 时，返回要附加到 LLM 请求上的 BYOK 头；否则空对象 */
export function byokHeaders(): Record<string, string> {
    if (byok.enabled && byok.key.trim()) {
        return {
            "X-LLM-Provider": byok.provider,
            "X-LLM-Key": byok.key.trim(),
            "X-LLM-Endpoint": byok.endpoint,
        };
    }
    return {};
}

type AuthFailure = "session" | "byok" | null;

async function classifyAuthFailure(response: Response): Promise<AuthFailure> {
    if (response.status !== 401) return null;

    const body = await response.clone().text().catch(() => "");
    // /api/_middleware 的登录过期不能被当成 GLM Key 失效。
    if (/AUTH_REQUIRED|请先登录/.test(body)) return "session";
    return "byok";
}

function requestWithHeaders(url: string, init: RequestInit, headers: Headers) {
    return fetch(url, { ...init, headers });
}

/**
 * BYOK 统一请求入口：
 * 1. 先使用已记住的 GLM 端点（旧数据默认通用端点）；
 * 2. 通用端点鉴权 401 时，改用 Coding Plan 专属端点重试一次；
 * 3. Coding Plan 仍鉴权失败时，停用该 Key，去掉 BYOK 请求头并用平台额度重试。
 */
export async function fetchWithByokFallback(url: string, init: RequestInit = {}): Promise<Response> {
    const sentKey = byok.enabled ? byok.key.trim() : "";
    if (!sentKey) return fetch(url, init);

    const initialEndpoint = byok.endpoint;
    const initialHeaders = new Headers(init.headers);
    for (const [name, value] of Object.entries(byokHeaders())) initialHeaders.set(name, value);

    const response = await requestWithHeaders(url, init, initialHeaders);
    if (await classifyAuthFailure(response) !== "byok") return response;

    if (initialEndpoint !== CODING_ENDPOINT) {
        const codingHeaders = new Headers(initialHeaders);
        codingHeaders.set("X-LLM-Endpoint", CODING_ENDPOINT);
        const codingResponse = await requestWithHeaders(url, init, codingHeaders);
        const codingFailure = await classifyAuthFailure(codingResponse);

        if (codingFailure !== "byok") {
            if (codingFailure === null && byok.enabled && byok.key.trim() === sentKey) {
                byok.endpoint = CODING_ENDPOINT;
                saveByok();
                showByokNotice("GLM Key 已自动切换至 Coding Plan 专属端点。");
            }
            return codingResponse;
        }
    }

    if (byok.enabled && byok.key.trim() === sentKey) {
        byok.enabled = false;
        byok.endpoint = STANDARD_ENDPOINT;
        saveByok();
        showByokNotice("GLM Key 在通用及 Coding Plan 端点均无效，已切换至平台额度；本次及后续请求将继续消耗额度。");
    }

    const fallbackHeaders = new Headers(init.headers);
    fallbackHeaders.delete("X-LLM-Provider");
    fallbackHeaders.delete("X-LLM-Key");
    fallbackHeaders.delete("X-LLM-Endpoint");
    return requestWithHeaders(url, init, fallbackHeaders);
}
