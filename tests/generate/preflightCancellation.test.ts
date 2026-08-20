import { afterEach, describe, expect, it, vi } from "vitest";

const getOwnedTaskMock = vi.hoisted(() => vi.fn());
const acquireTaskOperationLeaseMock = vi.hoisted(() => vi.fn());
const putTaskWithOperationLeaseMock = vi.hoisted(() => vi.fn());
const putTaskWithOperationLeaseAndCostMock = vi.hoisted(() => vi.fn());
const releaseTaskOperationLeaseMock = vi.hoisted(() => vi.fn());
const markTaskQuotaExhaustedMock = vi.hoisted(() => vi.fn());
const resolveTaskLLMMock = vi.hoisted(() => vi.fn());
const settleTaskCostQuotaMock = vi.hoisted(() => vi.fn());
const usageCostMock = vi.hoisted(() => vi.fn());

vi.mock("../../functions/_lib/taskStore", async (importOriginal) => ({
    ...await importOriginal<Record<string, unknown>>(),
    getOwnedTask: getOwnedTaskMock,
    acquireTaskOperationLease: acquireTaskOperationLeaseMock,
    putTaskWithOperationLease: putTaskWithOperationLeaseMock,
    putTaskWithOperationLeaseAndCost: putTaskWithOperationLeaseAndCostMock,
    releaseTaskOperationLease: releaseTaskOperationLeaseMock,
    markTaskQuotaExhausted: markTaskQuotaExhaustedMock,
}));

vi.mock("../../functions/_lib/llm", async (importOriginal) => ({
    ...await importOriginal<Record<string, unknown>>(),
    resolveTaskLLM: resolveTaskLLMMock,
}));

vi.mock("../../functions/_lib/quota", async (importOriginal) => ({
    ...await importOriginal<Record<string, unknown>>(),
    settleTaskCostQuota: settleTaskCostQuotaMock,
    usageCost: usageCostMock,
}));

import { isClientCancelled } from "../../functions/_lib/clientAbort";
import {
    activePreflightOperation,
    appendPreflightOperation,
    preflightOperations,
} from "../../functions/_lib/preflightOperations";
import { onRequestPost as clarify } from "../../functions/api/generate/clarify";
import { onRequestPost as grade } from "../../functions/api/generate/grade";

type Stage = "clarify" | "grade";

const CLARIFY_REQUEST_ID = `clarify_${"a".repeat(16)}`;
const GRADE_REQUEST_ID = `grade_${"b".repeat(16)}`;

function baseState(stage: Stage): Record<string, unknown> {
    return {
        taskId: "task-1",
        uid: "user-1",
        userPrompt: "Build a Paper plugin",
        coreType: "Paper",
        version: "1.21.4",
        clarifyRounds: [],
        clarifyDone: stage === "grade",
        preflightProtocolVersion: 1,
        clarifyOperations: stage === "grade" ? [{
            requestId: CLARIFY_REQUEST_ID,
            inputHash: "clarify-input",
            input: {},
            status: "completed",
            result: { done: true, todos: [] },
            billingSettled: true,
            startedAt: 1,
            completedAt: 2,
        }] : [],
        gradeOperations: [],
        grade: null,
        knowledgeNeeds: [],
        skills: [],
        logs: [],
    };
}

function makeContext(stage: Stage, signal: AbortSignal, waitUntilPromises: Promise<unknown>[]): any {
    const requestBody = stage === "clarify"
        ? { taskId: "task-1", clarifyRequestId: CLARIFY_REQUEST_ID }
        : { taskId: "task-1", gradeRequestId: GRADE_REQUEST_ID };
    return {
        request: new Request(`https://example.test/api/generate/${stage}`, {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify(requestBody),
            signal,
        }),
        data: { uid: "user-1" },
        env: {
            DB: {},
            TASKS: {} as KVNamespace,
            DEEPSEEK_API_KEY: "platform-key",
        },
        waitUntil(promise: Promise<unknown>) {
            waitUntilPromises.push(promise);
        },
    };
}

function prepareState(stage: Stage): { readState: () => any } {
    let raw = JSON.stringify(baseState(stage));
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
    putTaskWithOperationLeaseAndCostMock.mockImplementation(async (
        _env: unknown,
        _taskId: string,
        nextRaw: string,
    ) => {
        raw = nextRaw;
        return true;
    });
    releaseTaskOperationLeaseMock.mockResolvedValue(true);
    resolveTaskLLMMock.mockResolvedValue({
        url: "https://model.test/chat/completions",
        apiKey: "platform-key",
        byok: false,
        modelFor: () => "deepseek-v4-pro",
    });
    settleTaskCostQuotaMock.mockResolvedValue({
        total: 0,
        consumed: 0,
        outOfQuota: false,
    });
    usageCostMock.mockReturnValue(1);
    return { readState: () => JSON.parse(raw) };
}

async function expectCancellation(stage: Stage): Promise<void> {
    const { readState } = prepareState(stage);
    const clientAbort = new AbortController();
    const waitUntilPromises: Promise<unknown>[] = [];
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

    const handler = stage === "clarify" ? clarify : grade;
    const response = await handler(makeContext(stage, clientAbort.signal, waitUntilPromises));
    const responseText = response.text();
    await fetchStarted;
    clientAbort.abort(new DOMException("page left", "AbortError"));
    const streamed = await responseText;
    await Promise.allSettled(waitUntilPromises);

    expect(upstreamSignal?.aborted).toBe(true);
    expect(isClientCancelled(upstreamSignal?.reason)).toBe(true);
    expect(streamed).not.toContain("TIMEOUT");
    expect(streamed).not.toContain('"type":"error"');
    expect(streamed).not.toContain('"retryable":true');

    const state = readState();
    const operations = preflightOperations(state, stage);
    const record = operations.at(-1);
    expect(record).toMatchObject({
        requestId: stage === "clarify" ? CLARIFY_REQUEST_ID : GRADE_REQUEST_ID,
        status: "cancelled",
        billingSettled: true,
        lastError: "客户端已取消",
    });
    expect(record).not.toHaveProperty("result");
    expect(putTaskWithOperationLeaseAndCostMock).toHaveBeenCalledOnce();
    const costCommit = putTaskWithOperationLeaseAndCostMock.mock.calls[0];
    expect(costCommit[5]).toBe(0);
    expect(costCommit[8]).toBe(true);
    expect(settleTaskCostQuotaMock).not.toHaveBeenCalled();
    expect(usageCostMock).not.toHaveBeenCalled();
}

afterEach(() => {
    vi.clearAllMocks();
    vi.unstubAllGlobals();
});

describe("preflight cancelled operations", () => {
    it("retains cancelled history without treating it as active", () => {
        const state: Record<string, unknown> = { clarifyOperations: [] };
        appendPreflightOperation(state, "clarify", {
            requestId: CLARIFY_REQUEST_ID,
            inputHash: "input",
            input: {},
            status: "cancelled",
            billingSettled: true,
            startedAt: 1,
            completedAt: 2,
        });

        expect(preflightOperations(state, "clarify")).toHaveLength(1);
        expect(preflightOperations(state, "clarify")[0].status).toBe("cancelled");
        expect(activePreflightOperation(state, "clarify")).toBeUndefined();
    });
});

describe("preflight client cancellation", () => {
    it("cancels Clarify upstream work without retry output or fabricated usage", async () => {
        await expectCancellation("clarify");
    });

    it("cancels Grade upstream work without retry output or fabricated usage", async () => {
        await expectCancellation("grade");
    });
});
