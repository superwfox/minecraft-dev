import { assertOpenAIResponse, OpenAIStreamProtocolError, type OpenAIStreamResult } from "./openAIStream";
import type { UsageBreakdown } from "./quota";
import type { ModelChatMessage } from "./learning/tool";

interface ChatStreamCallbacks {
    onActivity?: () => void;
    onToolCall?: (index: number, name: string) => void | Promise<void>;
    onThinking?: (content: string) => void | Promise<void>;
    onOutput?: (content: string) => void | Promise<void>;
    onUsage?: (usage: UsageBreakdown) => void | Promise<void>;
    requireUsage?: boolean;
}

interface ChatStreamResult extends OpenAIStreamResult {
    message: ModelChatMessage;
}

function streamText(value: unknown): string {
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

/** Consume one streamed planner response while preserving incremental tool calls. */
export async function consumeChatStream(
    response: Response,
    callbacks: ChatStreamCallbacks = {},
): Promise<ChatStreamResult> {
    await assertOpenAIResponse(response);
    if (!response.body) throw new Error("Model service returned an empty stream");

    type ToolCall = NonNullable<ModelChatMessage["tool_calls"]>[number];
    const toolCalls = new Map<number, ToolCall>();
    const announced = new Set<number>();
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
            callbacks.onActivity?.();
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
        if (chunk?.usage) {
            callbacks.onActivity?.();
            usage = chunk.usage as UsageBreakdown;
            await callbacks.onUsage?.(usage);
        }

        const delta = chunk?.choices?.[0]?.delta ?? chunk?.choices?.[0]?.message ?? {};
        const thinkingDelta = streamText(
            delta.reasoning_content
            ?? delta.reasoning
            ?? delta.thinking_content
            ?? delta.thinking,
        );
        const outputDelta = streamText(delta.content);
        if (thinkingDelta) {
            callbacks.onActivity?.();
            thinking += thinkingDelta;
            await callbacks.onThinking?.(thinkingDelta);
        }
        if (outputDelta) {
            callbacks.onActivity?.();
            content += outputDelta;
            await callbacks.onOutput?.(outputDelta);
        }

        const rawCalls = Array.isArray(delta.tool_calls) ? delta.tool_calls : [];
        if (rawCalls.length > 0 || chunk?.choices?.[0]?.finish_reason != null) {
            callbacks.onActivity?.();
        }
        for (let fallbackIndex = 0; fallbackIndex < rawCalls.length; fallbackIndex++) {
            const rawCall = rawCalls[fallbackIndex];
            const parsedIndex = Number(rawCall?.index);
            const index = Number.isFinite(parsedIndex) && parsedIndex >= 0
                ? Math.floor(parsedIndex)
                : fallbackIndex;
            const current = toolCalls.get(index) ?? {
                id: "",
                type: "function" as const,
                function: { name: "", arguments: "" },
            };
            if (typeof rawCall?.id === "string") current.id += rawCall.id;
            if (typeof rawCall?.function?.name === "string") current.function.name += rawCall.function.name;
            if (typeof rawCall?.function?.arguments === "string") {
                current.function.arguments += rawCall.function.arguments;
            }
            toolCalls.set(index, current);
            if (current.function.name && !announced.has(index)) { announced.add(index); await callbacks.onToolCall?.(index, current.function.name); }
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

    const orderedToolCalls = [...toolCalls.entries()]
        .sort(([left], [right]) => left - right)
        .map(([, call]) => call);
    return {
        content,
        thinking,
        usage,
        message: {
            role: "assistant",
            content,
            ...(thinking ? { reasoning_content: thinking } : {}),
            ...(orderedToolCalls.length ? { tool_calls: orderedToolCalls } : {}),
        },
    };
}

