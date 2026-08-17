import { computed, reactive, ref } from "vue";

const STORAGE_KEY = "tahai-deepseek-key";
const CREDENTIAL_ID_STORAGE_KEY = "tahai-deepseek-key-id";
const DEEPSEEK_CHAT_COMPLETIONS_URL = "https://api.deepseek.com/v1/chat/completions";

export type DeepSeekKeyModalReason = "welcome" | "missing" | "invalid" | "billing" | "manage";

export type DeepSeekAccessFailure = {
    code: "LLM_AUTH_FAILED" | "DEEPSEEK_KEY_REQUIRED";
    status: 401 | 428;
    message: string;
};

function createCredentialId(): string {
    return crypto.randomUUID();
}

function loadCredential(): { key: string; credentialId: string } {
    try {
        const key = localStorage.getItem(STORAGE_KEY)?.trim() ?? "";
        if (!key) return { key: "", credentialId: "" };

        let credentialId = localStorage.getItem(CREDENTIAL_ID_STORAGE_KEY)?.trim() ?? "";
        if (!credentialId) {
            credentialId = createCredentialId();
            try { localStorage.setItem(CREDENTIAL_ID_STORAGE_KEY, credentialId); } catch { /* in-memory fallback */ }
        }
        return { key, credentialId };
    } catch {
        return { key: "", credentialId: "" };
    }
}

const loadedCredential = loadCredential();
export const deepSeekKeyState = reactive({
    key: loadedCredential.key,
    credentialId: loadedCredential.credentialId,
});

export function hasDeepSeekKey(): boolean {
    return deepSeekKeyState.key.length > 0;
}

export const deepSeekKeyConfigured = computed(() => hasDeepSeekKey());
export const deepSeekKeyLastFour = computed(() => deepSeekKeyState.key.slice(-4));
export const showDeepSeekKeyModal = ref(false);
export const deepSeekKeyModalState = reactive<{
    reason: DeepSeekKeyModalReason;
    message: string;
}>({
    reason: "manage",
    message: "",
});

let initialPromptShown = false;

export function openDeepSeekKeyModal(
    reason: DeepSeekKeyModalReason = "manage",
    message = "",
): void {
    deepSeekKeyModalState.reason = reason;
    deepSeekKeyModalState.message = message;
    showDeepSeekKeyModal.value = true;
}

export function closeDeepSeekKeyModal(): void {
    showDeepSeekKeyModal.value = false;
}

/** 每次应用加载只提示一次；用户仍可选择继续使用充值额度。 */
export function promptForDeepSeekKey(): void {
    if (initialPromptShown || hasDeepSeekKey()) return;
    initialPromptShown = true;
    openDeepSeekKeyModal("welcome");
}

export function saveDeepSeekKey(rawKey: string): void {
    const key = rawKey.trim();
    if (!key) throw new Error("请输入 DeepSeek API Key");
    const credentialId = createCredentialId();

    try {
        localStorage.setItem(STORAGE_KEY, key);
        localStorage.setItem(CREDENTIAL_ID_STORAGE_KEY, credentialId);
    } catch {
        throw new Error("浏览器无法保存 Key，请检查隐私或存储设置");
    }

    deepSeekKeyState.key = key;
    deepSeekKeyState.credentialId = credentialId;
}

export function clearDeepSeekKey(): void {
    try {
        localStorage.removeItem(STORAGE_KEY);
        localStorage.removeItem(CREDENTIAL_ID_STORAGE_KEY);
    } catch {
        throw new Error("浏览器无法清除 Key，请检查隐私或存储设置");
    }

    deepSeekKeyState.key = "";
    deepSeekKeyState.credentialId = "";
}

export class DeepSeekKeyRequiredError extends Error {
    readonly code = "DEEPSEEK_KEY_REQUIRED";

    constructor() {
        super("请先配置 DeepSeek API Key");
        this.name = "DeepSeekKeyRequiredError";
    }
}

/** 返回当前 Key；缺失时打开配置弹窗并抛出不含敏感信息的错误。 */
export function requireKey(): string {
    const key = deepSeekKeyState.key.trim();
    if (key) return key;

    openDeepSeekKeyModal("missing");
    throw new DeepSeekKeyRequiredError();
}

export function handleDeepSeekAccessFailure(
    status: unknown,
    code: unknown,
    options: { allowBare401?: boolean } = {},
): DeepSeekAccessFailure | null {
    const httpStatus = Number(status) || 0;
    const errorCode = typeof code === "string" ? code : "";

    if (errorCode === "DEEPSEEK_KEY_REQUIRED" || httpStatus === 428) {
        const message = "当前任务需要 DeepSeek API Key，请重新配置后重试";
        openDeepSeekKeyModal(
            "missing",
            "该任务由 DeepSeek Key 创建，继续处理前请重新配置 Key。",
        );
        return { code: "DEEPSEEK_KEY_REQUIRED", status: 428, message };
    }

    if (errorCode === "LLM_AUTH_FAILED"
        || (httpStatus === 401 && options.allowBare401 === true)) {
        const message = "DeepSeek API Key 无效，请重新填写";
        openDeepSeekKeyModal("invalid", "DeepSeek 拒绝了当前 Key，请检查后重新保存。");
        return { code: "LLM_AUTH_FAILED", status: 401, message };
    }

    return null;
}

export async function handleDeepSeekAccessResponse(
    response: Response,
    options: { allowBare401?: boolean } = {},
): Promise<DeepSeekAccessFailure | null> {
    if (response.status !== 401 && response.status !== 428) return null;

    const raw = await response.clone().text().catch(() => "");
    if (response.status === 401 && /AUTH_REQUIRED|请先登录/.test(raw)) return null;

    let code = "";
    try {
        const payload = JSON.parse(raw);
        code = typeof payload?.code === "string"
            ? payload.code
            : (typeof payload?.error?.code === "string" ? payload.error.code : "");
    } catch { /* plain-text response */ }

    return handleDeepSeekAccessFailure(response.status, code, options);
}

/** 供浏览器直连 DeepSeek 的请求层使用。 */
export function deepSeekHeaders(): Record<string, string> {
    return {
        Authorization: `Bearer ${requireKey()}`,
        "Content-Type": "application/json",
    };
}

/**
 * 浏览器直连 DeepSeek。401 会原样交给调用方，同时提示用户检查 Key，
 * 不会回退到平台额度。
 */
export async function deepSeekRequest(init: RequestInit): Promise<Response> {
    const headers = new Headers(init.headers);
    const directHeaders = deepSeekHeaders();
    headers.set("Authorization", directHeaders.Authorization);
    if (!headers.has("Content-Type")) headers.set("Content-Type", directHeaders["Content-Type"]);

    const response = await fetch(DEEPSEEK_CHAT_COMPLETIONS_URL, { ...init, headers });
    await handleDeepSeekAccessResponse(response, { allowBare401: true });
    return response;
}

/** 已配置 Key 时，向现有服务端生成端点附加 DeepSeek BYOK 头。 */
export function byokHeaders(): Record<string, string> {
    const key = deepSeekKeyState.key.trim();
    if (!key) return {};
    return {
        "X-LLM-Provider": "deepseek",
        "X-LLM-Key": key,
        "X-LLM-Credential-Id": deepSeekKeyState.credentialId,
    };
}

/**
 * 保留现有调用签名：无 Key 时使用充值额度；有 Key 时使用 DeepSeek BYOK。
 * Key 鉴权失败不再静默重试平台额度，避免意外扣减充值额度。
 */
export async function fetchWithByokFallback(url: string, init: RequestInit = {}): Promise<Response> {
    const extraHeaders = byokHeaders();
    if (!extraHeaders["X-LLM-Key"]) return fetch(url, init);

    const headers = new Headers(init.headers);
    for (const [name, value] of Object.entries(extraHeaders)) headers.set(name, value);

    const response = await fetch(url, { ...init, headers });
    await handleDeepSeekAccessResponse(response, { allowBare401: true });
    return response;
}
