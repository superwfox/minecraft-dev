import { afterEach, describe, expect, it, vi } from "vitest";

const accumulateCostMock = vi.hoisted(() => vi.fn(async () => ({
    consumed: 0,
    total: 0,
    outOfQuota: false,
    delta: 0,
})));

vi.mock("../../functions/_lib/quota", async (importOriginal) => ({
    ...await importOriginal<Record<string, unknown>>(),
    accumulateCost: accumulateCostMock,
}));

import { onRequestPost as chat } from "../../functions/api/chat";
import { onRequestPost as stream } from "../../functions/api/stream";
import { isClientCancelled } from "../../functions/_lib/clientAbort";

type TestContext = {
    context: any;
    waitUntilPromises: Promise<unknown>[];
};

function makeContext(path: "chat" | "stream", body: unknown, signal?: AbortSignal): TestContext {
    const waitUntilPromises: Promise<unknown>[] = [];
    const context = {
        request: new Request(`https://example.test/api/${path}`, {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify(body),
            signal,
        }),
        data: { uid: "user-1" },
        env: {
            DEEPSEEK_API_KEY: "platform-key",
            TASKS: {} as KVNamespace,
        },
        waitUntil(promise: Promise<unknown>) {
            waitUntilPromises.push(promise);
        },
    };
    return { context, waitUntilPromises };
}

afterEach(() => {
    vi.unstubAllGlobals();
});

describe("POST /api/chat", () => {
    it.each([null, [], "prompt", 42])("rejects a non-object JSON body: %j", async (body) => {
        const fetchMock = vi.fn();
        vi.stubGlobal("fetch", fetchMock);
        const { context } = makeContext("chat", body);

        const response = await chat(context);

        expect(response.status).toBe(400);
        await expect(response.json()).resolves.toMatchObject({ code: "INVALID_REQUEST_BODY" });
        expect(fetchMock).not.toHaveBeenCalled();
    });

    it("forces the server-owned Flash formatter contract", async () => {
        const fetchMock = vi.fn(async () => new Response(JSON.stringify({
            choices: [{
                message: {
                    content: JSON.stringify({
                        markdown: "# Boss 插件\n\n## 核心目标\n- 实现 **唯一 Boss**",
                    }),
                },
            }],
            usage: { prompt_tokens: 10, completion_tokens: 10 },
        }), {
            status: 200,
            headers: { "Content-Type": "application/json" },
        })) as unknown as typeof fetch;
        vi.stubGlobal("fetch", fetchMock);
        const { context, waitUntilPromises } = makeContext("chat", {
            purpose: "format_prompt",
            input: "做一个唯一 Boss，命令 /boss spawn",
            taskId: "client-controlled-task",
            model: "deepseek-v4-pro",
            messages: [{ role: "system", content: "caller-controlled prompt" }],
            response_format: { type: "text" },
        });

        const response = await chat(context);
        const result = await response.json() as { markdown?: string };

        expect(response.status).toBe(200);
        expect(result).toEqual({
            markdown: "# Boss 插件\n\n## 核心目标\n- 实现 **唯一 Boss**",
        });
        expect(fetchMock).toHaveBeenCalledOnce();
        const [, init] = vi.mocked(fetchMock).mock.calls[0];
        const payload = JSON.parse(String(init?.body));
        expect(payload.model).toBe("deepseek-v4-flash");
        expect(payload.response_format).toEqual({ type: "json_object" });
        expect(payload).not.toHaveProperty("reasoning_effort");
        expect(payload.messages).toHaveLength(2);
        expect(payload.messages[0]).toMatchObject({ role: "system" });
        expect(payload.messages[0].content).toContain("只能整理其含义");
        expect(payload.messages[0].content).not.toContain("caller-controlled prompt");
        expect(payload.messages[1]).toEqual({
            role: "user",
            content: "做一个唯一 Boss，命令 /boss spawn",
        });
        await Promise.all(waitUntilPromises);
        expect(accumulateCostMock).toHaveBeenCalledWith(
            expect.anything(),
            "user-1",
            "adhoc:user-1",
            "deepseek-v4-flash",
            { prompt_tokens: 10, completion_tokens: 10 },
            false,
        );
    });

    it("aborts the upstream request and returns 499 when the client leaves", async () => {
        const clientAbort = new AbortController();
        let upstreamSignal: AbortSignal | undefined;
        let notifyFetchStarted!: () => void;
        const fetchStarted = new Promise<void>((resolve) => {
            notifyFetchStarted = resolve;
        });
        const fetchMock = vi.fn((_input: RequestInfo | URL, init?: RequestInit) => {
            upstreamSignal = init?.signal ?? undefined;
            notifyFetchStarted();
            return new Promise<Response>((_resolve, reject) => {
                const signal = upstreamSignal;
                if (!signal) return reject(new Error("missing upstream abort signal"));
                const abort = () => reject(signal.reason);
                if (signal.aborted) abort();
                else signal.addEventListener("abort", abort, { once: true });
            });
        }) as unknown as typeof fetch;
        vi.stubGlobal("fetch", fetchMock);
        const { context } = makeContext("chat", {
            messages: [{ role: "user", content: "hello" }],
        }, clientAbort.signal);

        const pendingResponse = chat(context);
        await fetchStarted;
        clientAbort.abort(new DOMException("page left", "AbortError"));
        const response = await pendingResponse;

        expect(upstreamSignal?.aborted).toBe(true);
        expect(isClientCancelled(upstreamSignal?.reason)).toBe(true);
        expect(response.status).toBe(499);
        await expect(response.json()).resolves.toMatchObject({ code: "CLIENT_CANCELLED" });
    });
});

describe("POST /api/stream", () => {
    it("returns CLIENT_CANCELLED when disconnecting while reading a non-2xx upstream body", async () => {
        const clientAbort = new AbortController();
        let upstreamSignal: AbortSignal | undefined;
        const fetchMock = vi.fn(async (_input: RequestInfo | URL, init?: RequestInit) => {
            upstreamSignal = init?.signal ?? undefined;
            const body = new ReadableStream<Uint8Array>({
                start(controller) {
                    upstreamSignal?.addEventListener("abort", () => {
                        controller.error(upstreamSignal?.reason);
                    }, { once: true });
                },
            });
            return new Response(body, { status: 502 });
        }) as unknown as typeof fetch;
        vi.stubGlobal("fetch", fetchMock);
        const { context } = makeContext("stream", {
            messages: [{ role: "user", content: "hello" }],
        }, clientAbort.signal);

        const pendingResponse = stream(context);
        await vi.waitFor(() => expect(upstreamSignal).toBeDefined());
        clientAbort.abort(new DOMException("page left", "AbortError"));
        const response = await pendingResponse;

        expect(response.status).toBe(499);
        await expect(response.json()).resolves.toMatchObject({ code: "CLIENT_CANCELLED" });
    });

    it("aborts the upstream stream when the downstream reader is cancelled", async () => {
        const encoder = new TextEncoder();
        let upstreamController!: ReadableStreamDefaultController<Uint8Array>;
        let upstreamSignal: AbortSignal | undefined;
        const upstreamBody = new ReadableStream<Uint8Array>({
            start(controller) {
                upstreamController = controller;
                controller.enqueue(encoder.encode(
                    'data: {"choices":[{"delta":{"content":"hello"}}]}\n\n',
                ));
            },
        });
        const fetchMock = vi.fn(async (_input: RequestInfo | URL, init?: RequestInit) => {
            upstreamSignal = init?.signal ?? undefined;
            upstreamSignal?.addEventListener("abort", () => {
                try { upstreamController.error(upstreamSignal?.reason); } catch { /* already closed */ }
            }, { once: true });
            return new Response(upstreamBody, {
                status: 200,
                headers: { "Content-Type": "text/event-stream" },
            });
        }) as unknown as typeof fetch;
        vi.stubGlobal("fetch", fetchMock);
        const { context, waitUntilPromises } = makeContext("stream", {
            model: "deepseek-v4-flash",
            messages: [{ role: "user", content: "hello" }],
        });

        const response = await stream(context);
        const reader = response.body!.getReader();
        const first = await reader.read();
        expect(new TextDecoder().decode(first.value)).toContain("hello");

        await reader.cancel("view left");
        await vi.waitFor(() => {
            expect(upstreamSignal?.aborted).toBe(true);
            expect(isClientCancelled(upstreamSignal?.reason)).toBe(true);
        });
        await Promise.allSettled(waitUntilPromises);
    });
});
