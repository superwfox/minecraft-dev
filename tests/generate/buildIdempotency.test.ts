import { afterEach, describe, expect, it, vi } from "vitest";

const getDefaultBranchShaMock = vi.hoisted(() => vi.fn());
const createBranchMock = vi.hoisted(() => vi.fn());
const createBlobMock = vi.hoisted(() => vi.fn());
const createTreeMock = vi.hoisted(() => vi.fn());
const createCommitAndUpdateRefMock = vi.hoisted(() => vi.fn());
const triggerWorkflowMock = vi.hoisted(() => vi.fn());
const findRunByBranchMock = vi.hoisted(() => vi.fn());
const deleteBranchMock = vi.hoisted(() => vi.fn());
const getOwnedTaskMock = vi.hoisted(() => vi.fn());
const putTaskStateMock = vi.hoisted(() => vi.fn());
const acquireTaskOperationLeaseMock = vi.hoisted(() => vi.fn());
const putTaskWithOperationLeaseMock = vi.hoisted(() => vi.fn());
const releaseTaskOperationLeaseMock = vi.hoisted(() => vi.fn());
const renewTaskOperationLeaseMock = vi.hoisted(() => vi.fn());
const userBuildCheckMock = vi.hoisted(() => vi.fn());
const userBuildIncrementMock = vi.hoisted(() => vi.fn());

vi.mock("../../functions/_lib/github", () => ({
    getDefaultBranchSha: getDefaultBranchShaMock,
    createBranch: createBranchMock,
    createBlob: createBlobMock,
    createTree: createTreeMock,
    createCommitAndUpdateRef: createCommitAndUpdateRefMock,
    triggerWorkflow: triggerWorkflowMock,
    findRunByBranch: findRunByBranchMock,
    deleteBranch: deleteBranchMock,
}));

vi.mock("../../functions/_lib/taskStore", async (importOriginal) => ({
    ...await importOriginal<Record<string, unknown>>(),
    getOwnedTask: getOwnedTaskMock,
    putTaskState: putTaskStateMock,
    acquireTaskOperationLease: acquireTaskOperationLeaseMock,
    putTaskWithOperationLease: putTaskWithOperationLeaseMock,
    releaseTaskOperationLease: releaseTaskOperationLeaseMock,
    renewTaskOperationLease: renewTaskOperationLeaseMock,
}));

vi.mock("../../functions/_lib/quota", async (importOriginal) => ({
    ...await importOriginal<Record<string, unknown>>(),
    userBuildCheck: userBuildCheckMock,
    userBuildIncrement: userBuildIncrementMock,
}));

import { onRequestPost as startBuild } from "../../functions/api/generate/build";

const BUILD_REQUEST_ID = `build_${"a".repeat(32)}`;
const OTHER_BUILD_REQUEST_ID = `build_${"b".repeat(32)}`;
let currentRaw = "";

function initialState(): Record<string, unknown> {
    return {
        taskId: "task-1",
        uid: "user-1",
        status: "fixed",
        javaVersion: "21",
        projectName: "ExamplePlugin",
        packageName: "dev.example.plugin",
        coreType: "Paper",
        version: "1.21.4",
        repairAttempts: 1,
        fixStagnation: 0,
        fixRepairAuthorization: {
            runId: 88,
            diagnosticsFingerprint: "a1b2c3d4",
            repairAttempts: 0,
        },
        pendingFixSnapshot: {
            attempt: 1,
            runId: 88,
            diagnostics: [{ key: "compile:a" }],
            changedFiles: ["src/main/java/dev/example/plugin/Main.java"],
            files: [],
        },
        generatedFiles: [{
            path: "src/main/java/dev/example/plugin/Main.java",
            content: "package dev.example.plugin; public final class Main {}",
        }],
        logs: [],
    };
}

function context(buildRequestId = BUILD_REQUEST_ID): any {
    return {
        request: new Request("https://example.test/api/generate/build", {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ taskId: "task-1", buildRequestId }),
        }),
        data: { uid: "user-1" },
        env: {
            DB: {},
            TASKS: {} as KVNamespace,
            GITHUB_PAT: "test-token",
        },
    };
}

function storedState(): any {
    return JSON.parse(currentRaw);
}

function prepareSuccessfulBuild(): void {
    currentRaw = JSON.stringify(initialState());
    getOwnedTaskMock.mockImplementation(async () => currentRaw);
    acquireTaskOperationLeaseMock.mockResolvedValue("d1");
    putTaskWithOperationLeaseMock.mockImplementation(async (
        _env: unknown,
        _taskId: string,
        raw: string,
    ) => {
        currentRaw = raw;
        return true;
    });
    releaseTaskOperationLeaseMock.mockResolvedValue(true);
    renewTaskOperationLeaseMock.mockResolvedValue(true);
    userBuildCheckMock.mockResolvedValue({ ok: true, used: 0 });
    userBuildIncrementMock.mockResolvedValue(undefined);
    getDefaultBranchShaMock.mockResolvedValue({ sha: "base-sha" });
    deleteBranchMock.mockResolvedValue(undefined);
    createBranchMock.mockResolvedValue(undefined);
    createBlobMock.mockResolvedValue("blob-sha");
    createTreeMock.mockResolvedValue("tree-sha");
    createCommitAndUpdateRefMock.mockResolvedValue(undefined);
    triggerWorkflowMock.mockResolvedValue(undefined);
    findRunByBranchMock.mockResolvedValue(9001);
}

afterEach(() => {
    vi.clearAllMocks();
    currentRaw = "";
});

describe("build request idempotency", () => {
    it("replays a completed start request without triggering another workflow or resetting repair history", async () => {
        prepareSuccessfulBuild();

        const first = await startBuild(context());
        const firstBody = await first.json() as Record<string, unknown>;
        const stateAfterFirst = storedState();
        const second = await startBuild(context());
        const secondBody = await second.json() as Record<string, unknown>;

        expect(first.status).toBe(200);
        expect(second.status).toBe(200);
        expect(secondBody).toEqual(firstBody);
        expect(triggerWorkflowMock).toHaveBeenCalledTimes(1);
        expect(acquireTaskOperationLeaseMock).toHaveBeenCalledTimes(1);
        expect(userBuildIncrementMock).toHaveBeenCalledTimes(1);
        expect(storedState()).toEqual(stateAfterFirst);
        expect(stateAfterFirst.repairAttempts).toBe(1);
        expect(stateAfterFirst.pendingFixSnapshot).toBeDefined();
        expect(stateAfterFirst).not.toHaveProperty("fixRepairAuthorization");
    });

    it("keeps a duplicate request pending while its original lease is active", async () => {
        prepareSuccessfulBuild();
        currentRaw = JSON.stringify({
            ...initialState(),
            status: "uploading",
            buildRequestId: BUILD_REQUEST_ID,
            buildRequestStartedAt: 1_700_000_000_000,
            __taskOperationFence: `build:${BUILD_REQUEST_ID}`,
            __taskOperationLeaseUntil: Date.now() + 60_000,
        });

        const response = await startBuild(context());

        expect(response.status).toBe(503);
        expect(await response.json()).toMatchObject({ code: "BUILD_RECONCILIATION_PENDING" });
        expect(acquireTaskOperationLeaseMock).not.toHaveBeenCalled();
        expect(triggerWorkflowMock).not.toHaveBeenCalled();
    });

    it("rejects a different request while the recorded build is running", async () => {
        prepareSuccessfulBuild();
        await startBuild(context());
        vi.clearAllMocks();
        getOwnedTaskMock.mockImplementation(async () => currentRaw);

        const response = await startBuild(context(OTHER_BUILD_REQUEST_ID));

        expect(response.status).toBe(409);
        expect(await response.json()).toMatchObject({ code: "BUILD_IN_PROGRESS" });
        expect(acquireTaskOperationLeaseMock).not.toHaveBeenCalled();
        expect(triggerWorkflowMock).not.toHaveBeenCalled();
    });

    it("keeps a confirmed workflow trigger successful when run reconciliation fails", async () => {
        prepareSuccessfulBuild();
        findRunByBranchMock.mockRejectedValue(new Error("run lookup failed"));

        const first = await startBuild(context());
        const firstBody = await first.json() as Record<string, unknown>;
        const second = await startBuild(context());
        const secondBody = await second.json() as Record<string, unknown>;

        expect(first.status).toBe(200);
        expect(second.status).toBe(200);
        expect(secondBody).toEqual(firstBody);
        expect(triggerWorkflowMock).toHaveBeenCalledTimes(1);
        expect(acquireTaskOperationLeaseMock).toHaveBeenCalledTimes(1);
        expect(storedState().status).toBe("building");
        expect(storedState()).not.toHaveProperty("buildRequestStartError");
    });

    it("keeps an uncertain recorded dispatch recoverable without uploading again", async () => {
        prepareSuccessfulBuild();
        currentRaw = JSON.stringify({
            ...initialState(),
            status: "uploading",
            buildRequestId: BUILD_REQUEST_ID,
            buildRequestStartedAt: 1_700_000_000_000,
            buildBranch: "build-task-1",
            buildRunStartedAfter: "2026-08-02T00:00:00.000Z",
        });
        findRunByBranchMock.mockRejectedValue(new Error("run lookup temporarily unavailable"));

        const response = await startBuild(context());

        expect(response.status).toBe(503);
        expect(await response.json()).toMatchObject({ code: "BUILD_RECONCILIATION_PENDING" });
        expect(storedState().status).toBe("uploading");
        expect(storedState()).not.toHaveProperty("buildRequestStartError");
        expect(triggerWorkflowMock).not.toHaveBeenCalled();
        expect(getDefaultBranchShaMock).not.toHaveBeenCalled();
    });

    it("keeps a recorded dispatch pending when GitHub has not exposed the run yet", async () => {
        prepareSuccessfulBuild();
        currentRaw = JSON.stringify({
            ...initialState(),
            status: "uploading",
            buildRequestId: BUILD_REQUEST_ID,
            buildRequestStartedAt: 1_700_000_000_000,
            buildBranch: "build-task-1",
            buildRunStartedAfter: "2026-08-02T00:00:00.000Z",
        });
        findRunByBranchMock.mockResolvedValue(null);

        const response = await startBuild(context());

        expect(response.status).toBe(503);
        expect(await response.json()).toMatchObject({ code: "BUILD_RECONCILIATION_PENDING" });
        expect(storedState().status).toBe("uploading");
        expect(storedState()).not.toHaveProperty("buildRequestStartError");
        expect(triggerWorkflowMock).not.toHaveBeenCalled();
        expect(getDefaultBranchShaMock).not.toHaveBeenCalled();
    });

    it("resumes the same request after transient reconciliation without dispatching again", async () => {
        prepareSuccessfulBuild();
        currentRaw = JSON.stringify({
            ...initialState(),
            status: "uploading",
            buildRequestId: BUILD_REQUEST_ID,
            buildRequestStartedAt: 1_700_000_000_000,
            buildBranch: "build-task-1",
            buildRunStartedAfter: "2026-08-02T00:00:00.000Z",
        });
        findRunByBranchMock
            .mockRejectedValueOnce(new Error("run lookup temporarily unavailable"))
            .mockResolvedValueOnce(9001);

        const first = await startBuild(context());
        const second = await startBuild(context());

        expect(first.status).toBe(503);
        expect(second.status).toBe(200);
        expect(await second.json()).toMatchObject({ runId: 9001 });
        expect(storedState().status).toBe("building");
        expect(triggerWorkflowMock).not.toHaveBeenCalled();
        expect(getDefaultBranchShaMock).not.toHaveBeenCalled();
        expect(acquireTaskOperationLeaseMock).toHaveBeenCalledTimes(2);
        expect(userBuildIncrementMock).toHaveBeenCalledTimes(1);
    });

    it("replays the original startup failure without triggering GitHub again", async () => {
        prepareSuccessfulBuild();
        triggerWorkflowMock.mockRejectedValue(new Error("workflow dispatch failed"));

        const first = await startBuild(context());
        const firstBody = await first.json() as Record<string, unknown>;
        const second = await startBuild(context());
        const secondBody = await second.json() as Record<string, unknown>;

        expect(first.status).toBe(500);
        expect(second.status).toBe(500);
        expect(secondBody).toEqual(firstBody);
        expect(secondBody).toMatchObject({ code: "BUILD_START_FAILED" });
        expect(triggerWorkflowMock).toHaveBeenCalledTimes(1);
        expect(acquireTaskOperationLeaseMock).toHaveBeenCalledTimes(1);
        expect(userBuildIncrementMock).not.toHaveBeenCalled();
    });
});
