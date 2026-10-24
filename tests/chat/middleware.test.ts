import { beforeEach, describe, expect, it, vi } from "vitest";

const verifySessionMock = vi.hoisted(() => vi.fn());
const getQuotaMock = vi.hoisted(() => vi.fn());
const resolveLLMMock = vi.hoisted(() => vi.fn());
const consumeMock = vi.hoisted(() => vi.fn());

vi.mock("../../functions/_lib/session", () => ({
    getSessionCookie: vi.fn(() => "session-token"),
    verifySession: verifySessionMock,
}));

vi.mock("../../functions/_lib/quota", () => ({
    consume: consumeMock,
    getQuota: getQuotaMock,
    ipAllow: vi.fn(async () => true),
}));

vi.mock("../../functions/_lib/llm", () => ({
    isDeepSeekByokRequest: vi.fn(() => false),
    resolveLLM: resolveLLMMock,
}));

import { onRequest } from "../../functions/api/_middleware";

function makeContext(body: Record<string, unknown>): { context: any; next: ReturnType<typeof vi.fn> } {
    const next = vi.fn(async () => new Response(null, { status: 204 }));
    return {
        context: {
            request: new Request("https://example.test/api/chat", {
                method: "POST",
                headers: { "Content-Type": "application/json" },
                body: JSON.stringify(body),
            }),
            data: {},
            env: {
                DEEPSEEK_API_KEY: "platform-key",
                EDGE_RATE_LIMITING: "true",
                SESSION_SECRET: "session-secret",
                TASKS: {} as KVNamespace,
            },
            next,
        },
        next,
    };
}

beforeEach(() => {
    verifySessionMock.mockResolvedValue({ uid: "user-1", login: "user", exp: 9_999_999_999 });
    getQuotaMock.mockResolvedValue({ remaining: 0 });
    resolveLLMMock.mockResolvedValue({ byok: false });
    consumeMock.mockResolvedValue(true);
});

describe("task creation quota route", () => {
    it.each(["PATCH", "DELETE"])("does not charge task %s", async method => {
        const { context } = makeContext({ taskId: "owned-task" });
        context.request = new Request("https://example.test/api/generate/task", { method });
        expect((await onRequest(context)).status).toBe(204);
        expect(consumeMock).not.toHaveBeenCalled();
    });
    it("charges only successful POST task creation", async () => {
        getQuotaMock.mockResolvedValue({ remaining: 1 });
        const { context } = makeContext({});
        context.request = new Request("https://example.test/api/generate/task", { method: "POST", body: "{}" });
        expect((await onRequest(context)).status).toBe(204);
        expect(consumeMock).toHaveBeenCalledWith(context.env.TASKS, "user-1");
    });
    it("does not charge the retired plan route", async () => {
        const { context } = makeContext({});
        context.request = new Request("https://example.test/api/generate/plan", { method: "POST", body: "{}" });
        expect((await onRequest(context)).status).toBe(204);
        expect(consumeMock).not.toHaveBeenCalled();
    });
});

describe("chat middleware quota policy", () => {
    it("treats format_prompt as adhoc usage even when the client supplies a taskId", async () => {
        const { context, next } = makeContext({
            purpose: "format_prompt",
            input: "format me",
            taskId: "client-controlled-task",
        });

        const response = await onRequest(context);

        expect(response.status).toBe(402);
        await expect(response.json()).resolves.toMatchObject({ code: "QUOTA_EXHAUSTED" });
        expect(getQuotaMock).toHaveBeenCalledWith(expect.anything(), "user-1");
        expect(next).not.toHaveBeenCalled();
    });

    it("keeps regular task-bound chat calls out of the adhoc balance check", async () => {
        const { context, next } = makeContext({
            messages: [{ role: "user", content: "continue" }],
            taskId: "owned-task",
        });

        const response = await onRequest(context);

        expect(response.status).toBe(204);
        expect(getQuotaMock).not.toHaveBeenCalled();
        expect(resolveLLMMock).not.toHaveBeenCalled();
        expect(next).toHaveBeenCalledOnce();
    });
});
