import { afterEach, describe, expect, it, vi } from "vitest";

const assertBoundTaskStoreSchemaMock = vi.hoisted(() => vi.fn());
const cleanupExpiredTasksMock = vi.hoisted(() => vi.fn());
const deleteTaskMock = vi.hoisted(() => vi.fn());
const putTaskStateMock = vi.hoisted(() => vi.fn());
const resolveLLMMock = vi.hoisted(() => vi.fn());

vi.mock("../../functions/_lib/taskStore", async (importOriginal) => ({
    ...await importOriginal<Record<string, unknown>>(),
    assertBoundTaskStoreSchema: assertBoundTaskStoreSchemaMock,
    cleanupExpiredTasks: cleanupExpiredTasksMock,
    deleteTask: deleteTaskMock,
    putTaskState: putTaskStateMock,
}));

vi.mock("../../functions/_lib/llm", async (importOriginal) => ({
    ...await importOriginal<Record<string, unknown>>(),
    resolveLLM: resolveLLMMock,
}));

import { onRequestPost as plan } from "../../functions/api/generate/plan";

afterEach(() => {
    vi.clearAllMocks();
});

describe("Planner task creation cancellation", () => {
    it("returns the absolute server task expiry with a new task", async () => {
        const now = 1_788_263_407_150;
        const dateNow = vi.spyOn(Date, "now").mockReturnValue(now);
        try {
            resolveLLMMock.mockResolvedValue({
                providerId: "deepseek",
                url: "https://model.test/chat/completions",
                apiKey: "platform-key",
                byok: false,
                credentialId: "",
                learningCacheRead: true,
                canAutoLearn: false,
                modelFor: () => "deepseek-v4-flash",
            });
            assertBoundTaskStoreSchemaMock.mockResolvedValue(undefined);
            putTaskStateMock.mockResolvedValue(undefined);
            cleanupExpiredTasksMock.mockResolvedValue(undefined);
            const waits: Promise<unknown>[] = [];

            const response = await plan({
                request: new Request("https://example.test/api/generate/plan", {
                    method: "POST",
                    headers: { "Content-Type": "application/json" },
                    body: JSON.stringify({
                        userPrompt: "Build a Paper plugin",
                        coreType: "Paper",
                        version: "1.21.4",
                    }),
                }),
                data: { uid: "user-1" },
                env: {
                    DB: {},
                    TASKS: {} as KVNamespace,
                    DEEPSEEK_API_KEY: "platform-key",
                },
                waitUntil(promise: Promise<unknown>) {
                    waits.push(promise);
                },
            } as any);

            expect(response.status).toBe(200);
            await expect(response.json()).resolves.toMatchObject({
                taskId: expect.any(String),
                expiresAt: Math.floor(now / 1000) * 1000 + 3_600_000,
            });
            expect(waits).toHaveLength(1);
            await Promise.all(waits);
        } finally {
            dateNow.mockRestore();
        }
    });

    it("deletes a task persisted while the client cancellation is pending", async () => {
        const clientAbort = new AbortController();
        let finishPersist!: () => void;
        let notifyPersistStarted!: () => void;
        const persistStarted = new Promise<void>((resolve) => {
            notifyPersistStarted = resolve;
        });
        const persistGate = new Promise<void>((resolve) => {
            finishPersist = resolve;
        });

        resolveLLMMock.mockResolvedValue({
            providerId: "deepseek",
            url: "https://model.test/chat/completions",
            apiKey: "platform-key",
            byok: false,
            credentialId: "",
            learningCacheRead: true,
            canAutoLearn: false,
            modelFor: () => "deepseek-v4-flash",
        });
        assertBoundTaskStoreSchemaMock.mockResolvedValue(undefined);
        putTaskStateMock.mockImplementation(async () => {
            notifyPersistStarted();
            await persistGate;
        });
        deleteTaskMock.mockResolvedValue(true);
        cleanupExpiredTasksMock.mockResolvedValue(undefined);

        const waits: Promise<unknown>[] = [];
        const request = new Request("https://example.test/api/generate/plan", {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({
                userPrompt: "Build a Paper plugin",
                coreType: "Paper",
                version: "1.21.4",
            }),
            signal: clientAbort.signal,
        });
        const responsePromise = plan({
            request,
            data: { uid: "user-1" },
            env: {
                DB: {},
                TASKS: {} as KVNamespace,
                DEEPSEEK_API_KEY: "platform-key",
            },
            waitUntil(promise: Promise<unknown>) {
                waits.push(promise);
            },
        } as any);

        await persistStarted;
        clientAbort.abort(new DOMException("page left", "AbortError"));
        finishPersist();

        const response = await responsePromise;
        expect(response.status).toBe(499);
        expect(await response.json()).toMatchObject({
            code: "CLIENT_CANCELLED",
            retryable: false,
        });
        expect(putTaskStateMock).toHaveBeenCalledOnce();
        const persistedTaskId = putTaskStateMock.mock.calls[0][1];
        expect(deleteTaskMock).toHaveBeenCalledWith(
            expect.anything(),
            persistedTaskId,
            "user-1",
        );
        expect(cleanupExpiredTasksMock).not.toHaveBeenCalled();
        expect(waits).toHaveLength(0);
    });
});
