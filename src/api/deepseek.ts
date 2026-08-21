import {
    fetchWithByokFallback,
    handleDeepSeekAccessFailure,
    handleDeepSeekAccessResponse,
    hasDeepSeekKey,
    openDeepSeekKeyModal,
} from "../logic/byok";
import { responseError } from "./apiError";
import { MINECRAFT_VERSION_ENUM } from "../logic/minecraftVersions";
import {
    normalizeFormattedPrompt,
    normalizePrecheckPayload,
} from "../logic/promptFormatting";
import type {PrecheckResult} from "../logic/promptFormatting";

export type ChatMsg = {
    role: string;
    content: string;
};

export type StreamHandle = {
    stop: () => void;
    done: Promise<void>;
};

export type StreamCallbacks = {
    onThinking?: (chunk: string) => void;
    onOutput?: (chunk: string) => void;
};

type StreamListener = StreamCallbacks | ((chunk: string) => void);

const INFO_PRESET =
    "请根据用户输入判断需求返回json，若内容无关则plainText。 键值对如下： " +
    "\"coreType\" : {\"PAPER\",\"BUKKIT\",\"SPIGOT\",\"FORGE\",\"FABRIC\",\"其他\",\"null\"} ," +
    `\"version\" : {${MINECRAFT_VERSION_ENUM}} ,` +
    "\"title\" : String ," +
    "\"rawPrompt\" : String ";

const TODO_PRESET =
    "将需求转换为json数组，若内容无关则直接输出plainText而非json。用于表示实现步骤每个元素包含以下键值对，对于不同的事件 需要写在不同的step当中： " +
    "\"step\" : int ," +
    "\"content\" : String #如果使用该键值 则无需判断后续元素 直接返回 ," +
    "\"function\" : String #没有请填null ," +
    "\"params\" : String[] #没有请填null ," +
    "\"event\" : String #没有请填null";

async function requestCompletion(
    platformUrl: "/api/chat" | "/api/stream",
    messages: ChatMsg[],
    options: { reasoning?: boolean; stream?: boolean; signal?: AbortSignal } = {},
): Promise<{ response: Response; direct: boolean }> {
    const direct = hasDeepSeekKey();
    const init: RequestInit = {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
            model: options.reasoning ? "deepseek-v4-pro" : "deepseek-v4-flash",
            messages,
            ...(options.stream ? { stream: true } : {}),
        }),
        signal: options.signal,
    };

    const response = await fetchWithByokFallback(platformUrl, init);
    return { response, direct };
}

async function throwResponseError(response: Response, direct: boolean): Promise<never> {
    const accessFailure = await handleDeepSeekAccessResponse(response, { allowBare401: direct });
    const raw = await response.clone().text().catch(() => "");
    let message = raw;
    try {
        const parsed = JSON.parse(raw);
        message = parsed?.error?.message ?? parsed?.message ?? raw;
    } catch { /* use the response body as-is */ }

    if (accessFailure) {
        const error = new Error(accessFailure.message);
        (error as any).code = accessFailure.code;
        (error as any).status = accessFailure.status;
        (error as any).noRetry = true;
        (error as any).terminal = true;
        throw error;
    }
    if (response.status === 401) {
        const error = new Error(direct ? "DeepSeek API Key 无效，请重新填写" : "登录已过期，请重新登录");
        (error as any).code = direct ? "LLM_AUTH_FAILED" : "AUTH_REQUIRED";
        (error as any).status = response.status;
        (error as any).noRetry = true;
        throw error;
    }
    if (response.status === 402) {
        if (direct) {
            openDeepSeekKeyModal(
                "billing",
                "当前 DeepSeek 账户余额不足。请前往 DeepSeek 平台充值，或清除 Key 后改用踏海充值额度。",
            );
            const error = new Error("DeepSeek 账户余额不足，请前往 DeepSeek 平台充值");
            (error as any).code = "INSUFFICIENT_QUOTA";
            (error as any).status = response.status;
            (error as any).noRetry = true;
            throw error;
        }
        openDeepSeekKeyModal("missing", "充值额度已用尽，请填写 DeepSeek API Key 后重试。");
        const error = new Error("可用额度不足，请充值或填写 DeepSeek API Key");
        (error as any).code = "QUOTA_REQUIRED";
        (error as any).status = response.status;
        (error as any).noRetry = true;
        throw error;
    }
    throw await responseError(
        response,
        message || `DeepSeek 请求失败（${response.status}）`,
    );
}

async function askDeepSeek(prompt: string, preset: string, signal?: AbortSignal): Promise<string> {
    const messages = [
        { role: "system", content: preset },
        { role: "user", content: prompt },
    ];
    const { response, direct } = await requestCompletion("/api/chat", messages, {signal});
    if (!response.ok) await throwResponseError(response, direct);
    const data = await response.json() as any;
    return data.content ?? data.choices?.[0]?.message?.content ?? "";
}

export function getInfo(prompt: string) {
    return askDeepSeek(prompt, INFO_PRESET);
}

export function getTodoList(prompt: string) {
    return askDeepSeek(prompt, TODO_PRESET);
}

function normalizeStreamCallbacks(listener?: StreamListener): StreamCallbacks {
    if (typeof listener === "function") return { onOutput: listener };
    return listener || {};
}

function streamChunk(json: any): { thinking: string; output: string } {
    if (json?.type === "thinking" || json?.type === "reasoning") {
        return { thinking: typeof json.content === "string" ? json.content : "", output: "" };
    }
    if (json?.type === "output" || json?.type === "delta") {
        return { thinking: "", output: typeof json.content === "string" ? json.content : "" };
    }

    const delta = json?.choices?.[0]?.delta;
    return {
        thinking: delta?.reasoning_content
            ?? delta?.reasoning
            ?? delta?.thinking_content
            ?? delta?.thinking
            ?? "",
        output: typeof delta?.content === "string" ? delta.content : "",
    };
}

function streamFailure(payload: any): Error | null {
    const resultError = payload?.type === "result" ? payload.error : undefined;
    const raw = payload?.type === "error" ? (payload.error ?? payload.message) : (resultError ?? payload?.error);
    if (!raw) return null;
    const message = typeof raw === "string"
        ? raw
        : (typeof raw?.message === "string" ? raw.message : "流式请求失败");
    const error = new Error(message);
    (error as any).code = payload?.code ?? raw?.code ?? "";
    (error as any).status = Number(payload?.status ?? raw?.status) || 0;
    (error as any).retryAfter = Number(payload?.retryAfter ?? raw?.retryAfter) || 0;
    return error;
}

async function consumeSSE(
    response: Response,
    listener?: StreamListener,
    direct = false,
): Promise<{ thinking: string; output: string }> {
    if (!response.body) throw new Error("No stream body");
    const callbacks = normalizeStreamCallbacks(listener);
    const reader = response.body.getReader();
    const decoder = new TextDecoder();
    let buffer = "";
    let thinking = "";
    let output = "";
    let finished = false;

    try {
        while (!finished) {
            const { value, done } = await reader.read();
            if (done) break;
            buffer += decoder.decode(value, { stream: true });
            const lines = buffer.split("\n");
            buffer = lines.pop() ?? "";
            for (const line of lines) {
                const trimmed = line.trim();
                if (!trimmed.startsWith("data:")) continue;
                const payload = trimmed.slice(5).trim();
                if (payload === "[DONE]") {
                    finished = true;
                    break;
                }
                let parsed: any;
                try {
                    parsed = JSON.parse(payload);
                } catch {
                    throw new Error("流式响应包含无法解析的数据");
                }
                const failure = streamFailure(parsed);
                if (failure) {
                    const accessFailure = handleDeepSeekAccessFailure(
                        (failure as any).status,
                        (failure as any).code,
                        { allowBare401: direct },
                    );
                    if (accessFailure) {
                        failure.message = accessFailure.message;
                        (failure as any).code = accessFailure.code;
                        (failure as any).status = accessFailure.status;
                        (failure as any).noRetry = true;
                        (failure as any).terminal = true;
                    } else if ((failure as any).status === 402) {
                        if (direct) {
                            openDeepSeekKeyModal(
                                "billing",
                                "当前 DeepSeek 账户余额不足。请前往 DeepSeek 平台充值，或清除 Key 后改用踏海充值额度。",
                            );
                            failure.message = "DeepSeek 账户余额不足，请前往 DeepSeek 平台充值";
                        } else {
                            openDeepSeekKeyModal("missing", "充值额度已用尽，请填写 DeepSeek API Key 后重试。");
                            failure.message = "可用额度不足，请充值或填写 DeepSeek API Key";
                        }
                        (failure as any).code = direct ? "INSUFFICIENT_QUOTA" : "QUOTA_REQUIRED";
                        (failure as any).noRetry = true;
                        (failure as any).terminal = true;
                    }
                    throw failure;
                }
                const chunk = streamChunk(parsed);
                if (chunk.thinking) {
                    thinking += chunk.thinking;
                    callbacks.onThinking?.(chunk.thinking);
                }
                if (chunk.output) {
                    output += chunk.output;
                    callbacks.onOutput?.(chunk.output);
                }
            }
        }
        if (!finished) {
            const error = new Error("流式连接提前结束，请重试");
            (error as any).code = "STREAM_TRUNCATED";
            (error as any).retryable = true;
            throw error;
        }
    } finally {
        await reader.cancel().catch(() => {});
        reader.releaseLock();
    }

    return { thinking, output };
}

async function streamAsk(prompt: string, preset: string, listener?: StreamListener, signal?: AbortSignal): Promise<string> {
    const messages = [
        { role: "system", content: preset },
        { role: "user", content: prompt },
    ];
    const { response, direct } = await requestCompletion("/api/stream", messages, { stream: true, signal });
    if (!response.ok) await throwResponseError(response, direct);
    return (await consumeSSE(response, listener, direct)).output;
}

export function streamGetInfo(prompt: string, listener: StreamListener, signal?: AbortSignal) {
    return streamAsk(prompt, INFO_PRESET, listener, signal);
}

export function streamGetTodoList(prompt: string, onDelta: (chunk: string) => void) {
    return streamAsk(prompt, TODO_PRESET, onDelta);
}

const PRECHECK_PRESET = `你是一个 Minecraft 插件需求入口检查器，只判断是否已经能识别至少一个核心功能或玩法目标并进入规划阶段。你不是需求审计器，不负责枚举可选功能、工程边界或实现细节。
判定原则：
- 能识别“玩家或系统在什么场景做什么、得到什么结果”时，直接 complete=true；不要求用户把所有细节写全。
- 权限、通知文本、配置、持久化、首次或每次触发、防刷、断线重连、服务器重启、背包已满、插件加载时已在线玩家、常规失败处理等未说明细节，均由后续模型采用自然、轻量且安全的默认实现，不得因此要求用户补充。
- 标题、章节以及正文中的“未提及”“待确认”提示，不得覆盖已经明确的核心目标；只有用户明确表示核心产品行为取决于某个答案时，才把它视为阻断项。
- 只有完全无法识别核心功能，或存在没有自然默认值且会导致互不兼容产品行为的关键矛盾时，才 complete=false。
- 示例：“玩家进入服务器时发放 1 颗钻石，插件运行于 Paper 26.2”已经完整，必须返回 {"complete":true}，不得追问反馈、防刷、重连、背包或已在线玩家。
只输出 JSON，不要任何其他内容：
完整 → {"complete": true}；
不完整 → {"complete": false, "heading": "还需要补充", "items": [{"topic": "简短主题", "detail": "真正阻止识别核心需求的具体问题"}]}。
items 只能包含 1-3 个互不重复且确实阻断规划的问题，不得为凑数量添加问题；topic 简短明确且不带序号，detail 每项只写一个具体问题。`;

export async function precheckPrompt(
    prompt: string,
    listener?: StreamListener,
    signal?: AbortSignal,
): Promise<PrecheckResult> {
    const messages = [
        { role: "system", content: PRECHECK_PRESET },
        { role: "user", content: prompt },
    ];
    const { response, direct } = await requestCompletion("/api/stream", messages, {
        stream: true,
        signal,
    });
    if (!response.ok) await throwResponseError(response, direct);
    const raw = (await consumeSSE(response, listener, direct)).output.trim();
    const cleaned = raw.replace(/^```[\w]*\n?/, "").replace(/\n?```\s*$/, "").trim();
    try {
        const normalized = normalizePrecheckPayload(JSON.parse(cleaned));
        if (!normalized) throw new Error("缺少 complete 字段");
        return normalized;
    } catch {
        throw new Error("需求完整性检查返回格式无效，请重试");
    }
}

export async function formatUserPrompt(prompt: string, signal?: AbortSignal): Promise<string> {
    const direct = hasDeepSeekKey();
    const response = await fetchWithByokFallback("/api/chat", {
        method: "POST",
        headers: {"Content-Type": "application/json"},
        body: JSON.stringify({purpose: "format_prompt", input: prompt}),
        signal,
    });
    if (!response.ok) await throwResponseError(response, direct);
    const data = await response.json() as {markdown?: unknown};
    const formatted = normalizeFormattedPrompt(
        typeof data.markdown === "string" ? data.markdown : "",
    );
    if (!formatted) throw new Error("格式化结果为空");
    return formatted;
}

export function consistChat(
    history: ChatMsg[],
    prompt: string,
    onDelta: (textChunk: string) => void,
    onDone: () => void,
    onThinking?: (textChunk: string) => void,
): StreamHandle {
    const controller = new AbortController();
    const messages: ChatMsg[] = [...history, { role: "user", content: prompt }];

    const done = (async () => {
        const { response, direct } = await requestCompletion("/api/stream", messages, {
            stream: true,
            signal: controller.signal,
        });

        if (!response.ok) await throwResponseError(response, direct);
        await consumeSSE(response, { onThinking, onOutput: onDelta }, direct);
        onDone();
    })();

    return { stop: () => controller.abort(), done };
}
