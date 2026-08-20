import { afterEach, describe, expect, it, vi } from "vitest";

const getRunJobsMock = vi.hoisted(() => vi.fn());
const getJobLogsMock = vi.hoisted(() => vi.fn());
const getOwnedTaskMock = vi.hoisted(() => vi.fn());
const acquireTaskOperationLeaseMock = vi.hoisted(() => vi.fn());
const putTaskWithOperationLeaseMock = vi.hoisted(() => vi.fn());
const releaseTaskOperationLeaseMock = vi.hoisted(() => vi.fn());
const renewTaskOperationLeaseMock = vi.hoisted(() => vi.fn());
const markTaskQuotaExhaustedMock = vi.hoisted(() => vi.fn());
const resolveTaskLLMMock = vi.hoisted(() => vi.fn());
const accumulateCostsMock = vi.hoisted(() => vi.fn());
const loadKnowledgeContextMock = vi.hoisted(() => vi.fn());

vi.mock("../../functions/_lib/github", () => ({
    getRunJobs: getRunJobsMock,
    getJobLogs: getJobLogsMock,
}));

vi.mock("../../functions/_lib/taskStore", async (importOriginal) => ({
    ...await importOriginal<Record<string, unknown>>(),
    getOwnedTask: getOwnedTaskMock,
    acquireTaskOperationLease: acquireTaskOperationLeaseMock,
    putTaskWithOperationLease: putTaskWithOperationLeaseMock,
    releaseTaskOperationLease: releaseTaskOperationLeaseMock,
    renewTaskOperationLease: renewTaskOperationLeaseMock,
    markTaskQuotaExhausted: markTaskQuotaExhaustedMock,
}));

vi.mock("../../functions/_lib/llm", async (importOriginal) => ({
    ...await importOriginal<Record<string, unknown>>(),
    resolveTaskLLM: resolveTaskLLMMock,
}));

vi.mock("../../functions/_lib/quota", async (importOriginal) => ({
    ...await importOriginal<Record<string, unknown>>(),
    accumulateCosts: accumulateCostsMock,
}));

vi.mock("../../functions/_lib/learning/context", async (importOriginal) => ({
    ...await importOriginal<Record<string, unknown>>(),
    loadKnowledgeContext: loadKnowledgeContextMock,
}));

import { diagnosticsFingerprint, parseBuildDiagnostics } from "../../functions/_lib/buildDiagnostics";
import { isClientCancelled } from "../../functions/_lib/clientAbort";
import { onRequestPost as fixBuild } from "../../functions/api/generate/fix";

const FILE_PATH = "src/main/java/dev/example/Main.java";
const BUILD_LOG = [
    `[ERROR] /workspace/${FILE_PATH}:[12,8] cannot find symbol`,
    "[ERROR]   symbol:   class MissingType",
    "[ERROR]   location: class dev.example.Main",
].join("\n");

function initialState(): Record<string, any> {
    const fingerprint = diagnosticsFingerprint(parseBuildDiagnostics(BUILD_LOG));
    return {
        taskId: "task-1",
        uid: "user-1",
        billingProvider: "platform",
        status: "error",
        error: "Build failed",
        runId: 202,
        repairAttempts: 1,
        fixStagnation: 0,
        projectName: "ExamplePlugin",
        packageName: "dev.example",
        coreType: "Paper",
        version: "1.21.4",
        javaVersion: "21",
        grade: { vector: { external_deps: [] } },
        generatedFiles: [{
            path: FILE_PATH,
            role: "Plugin entrypoint",
            content: "package dev.example; public final class Main {}",
            apiSummary: null,
        }],
        logs: ["Build failed"],
        fixDiagnosticsFingerprint: fingerprint,
        fixKnowledgeNeeds: [],
        fixRepairAuthorization: {
            runId: 202,
            diagnosticsFingerprint: fingerprint,
            repairAttempts: 1,
        },
    };
}

afterEach(() => {
    vi.clearAllMocks();
    vi.unstubAllGlobals();
});

describe("Fix client cancellation", () => {
    it("settles received usage and restores an immediately resumable state", async () => {
        const initial = initialState();
        let raw = JSON.stringify(initial);
        getOwnedTaskMock.mockImplementation(async () => raw);
        acquireTaskOperationLeaseMock.mockResolvedValue("d1");
        putTaskWithOperationLeaseMock.mockImplementation(async (
            _env: unknown,
            _taskId: string,
            nextRaw: string,
        ) => {
            raw = nextRaw;
            return true;
        });
        releaseTaskOperationLeaseMock.mockResolvedValue(true);
        renewTaskOperationLeaseMock.mockResolvedValue(true);
        markTaskQuotaExhaustedMock.mockResolvedValue(undefined);
        resolveTaskLLMMock.mockResolvedValue({
            providerId: "deepseek",
            url: "https://model.test/chat/completions",
            apiKey: "platform-key",
            byok: false,
            credentialId: "",
            learningCacheRead: true,
            canAutoLearn: false,
            modelFor: () => "deepseek-v4-pro",
        });
        accumulateCostsMock
            .mockRejectedValueOnce(new Error("temporary quota store failure"))
            .mockResolvedValue({
                total: 1.25,
                consumed: 2,
                outOfQuota: false,
                delta: 0.25,
            });
        loadKnowledgeContextMock.mockResolvedValue({ context: "", used: [] });
        getRunJobsMock.mockResolvedValue([{ id: 303, name: "build", conclusion: "failure" }]);
        getJobLogsMock.mockResolvedValue(BUILD_LOG);

        const clientAbort = new AbortController();
        let upstreamSignal: AbortSignal | undefined;
        let notifyModelStarted!: () => void;
        const modelStarted = new Promise<void>((resolve) => {
            notifyModelStarted = resolve;
        });
        const usage = {
            prompt_tokens: 100,
            completion_tokens: 20,
            prompt_cache_hit_tokens: 0,
            prompt_cache_miss_tokens: 100,
        };
        const fetchMock = vi.fn((_input: RequestInfo | URL, init?: RequestInit) => {
            upstreamSignal = init?.signal ?? undefined;
            notifyModelStarted();
            const encoder = new TextEncoder();
            return Promise.resolve(new Response(new ReadableStream<Uint8Array>({
                start(controller) {
                    controller.enqueue(encoder.encode(`data: ${JSON.stringify({ usage })}\n\n`));
                    const signal = upstreamSignal;
                    const abort = () => controller.error(signal?.reason);
                    if (signal?.aborted) abort();
                    else signal?.addEventListener("abort", abort, { once: true });
                },
            }), { status: 200 }));
        }) as unknown as typeof fetch;
        vi.stubGlobal("fetch", fetchMock);

        const waits: Promise<unknown>[] = [];
        const response = await fixBuild({
            request: new Request("https://example.test/api/generate/fix", {
                method: "POST",
                headers: { "Content-Type": "application/json" },
                body: JSON.stringify({
                    taskId: "task-1",
                    mode: "repair",
                    repairAuthorization: initial.fixRepairAuthorization,
                }),
                signal: clientAbort.signal,
            }),
            data: { uid: "user-1" },
            env: {
                DB: {},
                TASKS: {} as KVNamespace,
                GITHUB_PAT: "test-token",
                DEEPSEEK_API_KEY: "platform-key",
            },
            waitUntil(promise: Promise<unknown>) {
                waits.push(promise);
            },
        } as any);

        const responseText = response.text();
        await modelStarted;
        await new Promise<void>((resolve) => setTimeout(resolve, 0));
        clientAbort.abort(new DOMException("page left", "AbortError"));
        await responseText;
        await Promise.allSettled(waits);

        expect(upstreamSignal?.aborted).toBe(true);
        expect(isClientCancelled(upstreamSignal?.reason)).toBe(true);
        expect(accumulateCostsMock).toHaveBeenCalledTimes(2);
        for (const call of accumulateCostsMock.mock.calls) {
            expect(call[3]).toEqual([{
                model: "deepseek-v4-pro",
                usage,
            }]);
        }

        expect(putTaskWithOperationLeaseMock).toHaveBeenCalledTimes(2);
        const recoveryCommit = putTaskWithOperationLeaseMock.mock.calls[1];
        expect(recoveryCommit[7]).toBe(true);
        const recovered = JSON.parse(recoveryCommit[2]);
        expect(recovered).toMatchObject({
            status: "error",
            error: null,
            repairAttempts: 1,
            totalCost: 1.25,
            consumedQuota: 2,
            fixRepairAuthorization: initial.fixRepairAuthorization,
        });
        expect(recovered).not.toHaveProperty("repairStartedAt");
        expect(recovered.generatedFiles).toEqual(initial.generatedFiles);
        expect(recovered.logs).toEqual(initial.logs);
        expect(JSON.parse(raw)).toEqual(recovered);
        expect(releaseTaskOperationLeaseMock).not.toHaveBeenCalled();
    });
});
