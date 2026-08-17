import type { UsageBreakdown } from "./quota";

export interface OpenAIStreamResult {
    content: string;
    thinking: string;
    usage?: UsageBreakdown;
}

export interface OpenAIStreamCallbacks {
    onActivity?: () => void;
    onThinking?: (content: string) => void | Promise<void>;
    onOutput?: (content: string) => void | Promise<void>;
    requireUsage?: boolean;
}

export class OpenAIUpstreamHttpError extends Error {
    public readonly code: "LLM_AUTH_FAILED" | "LLM_HTTP_ERROR";

    constructor(
        public readonly status: number,
        message: string,
    ) {
        super(message);
        this.name = "OpenAIUpstreamHttpError";
        this.code = status === 401 ? "LLM_AUTH_FAILED" : "LLM_HTTP_ERROR";
    }
}

export class OpenAIStreamProtocolError extends Error {
    constructor(
        public readonly code: "STREAM_TRUNCATED" | "STREAM_USAGE_MISSING" | "STREAM_INVALID_EVENT",
        message: string,
    ) {
        super(message);
        this.name = "OpenAIStreamProtocolError";
    }
}

function upstreamErrorMessage(raw: string, status: number): string {
    if (status === 401) return "模型服务拒绝了当前 API Key";

    const trimmed = raw.trim();
    if (!trimmed) return `模型服务返回 HTTP ${status}`;
    try {
        const parsed = JSON.parse(trimmed) as any;
        const message = parsed?.error?.message ?? parsed?.message ?? parsed?.error;
        if (typeof message === "string" && message.trim()) return message.trim().slice(0, 1000);
    } catch { /* preserve the plain-text response below */ }
    return trimmed.slice(0, 1000);
}

/** Preserve upstream HTTP status across an outer SSE response. */
export async function assertOpenAIResponse(response: Response): Promise<void> {
    if (response.ok) return;
    const raw = await response.text().catch(() => "");
    throw new OpenAIUpstreamHttpError(response.status, upstreamErrorMessage(raw, response.status));
}

function textContent(value: unknown): string {
    if (typeof value === "string") return value;
    if (value && typeof value === "object" && !Array.isArray(value)) {
        const part = value as { text?: unknown; content?: unknown };
        if (typeof part.text === "string") return part.text;
        if (typeof part.content === "string") return part.content;
        return "";
    }
    if (!Array.isArray(value)) return "";
    return value.map((part: any) => {
        if (typeof part === "string") return part;
        if (typeof part?.text === "string") return part.text;
        if (typeof part?.content === "string") return part.content;
        return "";
    }).join("");
}

function streamThinking(delta: any): string {
    return textContent(
        delta?.reasoning_content
        ?? delta?.reasoning
        ?? delta?.thinking_content
        ?? delta?.thinking,
    );
}

function streamOutput(delta: any): string {
    return textContent(delta?.content);
}

/** Consume an OpenAI-compatible chat/completions SSE response. */
export async function consumeOpenAIChatStream(
    response: Response,
    callbacks: OpenAIStreamCallbacks = {},
): Promise<OpenAIStreamResult> {
    await assertOpenAIResponse(response);
    if (!response.body) throw new Error("Model service returned an empty stream");

    const reader = response.body.getReader();
    const decoder = new TextDecoder();
    let buffer = "";
    let content = "";
    let thinking = "";
    let usage: UsageBreakdown | undefined;
    let upstreamDone = false;

    const consumeEvent = async (eventText: string): Promise<void> => {
        const payload = eventText
            .split(/\r?\n/)
            .map(line => line.trimStart())
            .filter(line => line.startsWith("data:"))
            .map(line => line.slice(5).trimStart())
            .join("\n")
            .trim();
        if (!payload) return;
        if (payload === "[DONE]") {
            upstreamDone = true;
            return;
        }

        let chunk: any;
        try {
            chunk = JSON.parse(payload);
        } catch {
            throw new OpenAIStreamProtocolError(
                "STREAM_INVALID_EVENT",
                "Model stream contained an invalid JSON event",
            );
        }
        if (chunk?.error) {
            const message = typeof chunk.error === "string"
                ? chunk.error
                : chunk.error?.message || chunk.error?.code;
            throw new Error(message || "Model stream failed");
        }
        if (chunk?.usage) usage = chunk.usage as UsageBreakdown;

        const delta = chunk?.choices?.[0]?.delta ?? chunk?.choices?.[0]?.message;
        const thinkingDelta = streamThinking(delta);
        const outputDelta = streamOutput(delta);
        if (thinkingDelta) {
            thinking += thinkingDelta;
            await callbacks.onThinking?.(thinkingDelta);
        }
        if (outputDelta) {
            content += outputDelta;
            await callbacks.onOutput?.(outputDelta);
        }
    };

    const consumeBufferedEvents = async (flush = false): Promise<void> => {
        while (true) {
            const boundary = /\r?\n\r?\n/.exec(buffer);
            if (!boundary) break;
            const eventText = buffer.slice(0, boundary.index);
            buffer = buffer.slice(boundary.index + boundary[0].length);
            await consumeEvent(eventText);
            if (upstreamDone) return;
        }
        if (flush && buffer.trim()) {
            const eventText = buffer;
            buffer = "";
            await consumeEvent(eventText);
        }
    };

    try {
        while (!upstreamDone) {
            const { value, done } = await reader.read();
            if (done) break;
            callbacks.onActivity?.();
            buffer += decoder.decode(value, { stream: true });
            await consumeBufferedEvents();
        }
        buffer += decoder.decode();
        if (!upstreamDone) await consumeBufferedEvents(true);
    } finally {
        try { await reader.cancel(); } catch { /* best effort */ }
        reader.releaseLock();
    }

    if (!upstreamDone) {
        throw new OpenAIStreamProtocolError("STREAM_TRUNCATED", "Model stream ended before [DONE]");
    }
    if (callbacks.requireUsage && !usage) {
        throw new OpenAIStreamProtocolError("STREAM_USAGE_MISSING", "Model stream completed without usage");
    }

    return { content, thinking, usage };
}
