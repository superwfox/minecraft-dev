import { afterEach, describe, expect, it, vi } from "vitest";

const getRunJobsMock = vi.hoisted(() => vi.fn());
const getJobLogsMock = vi.hoisted(() => vi.fn());

vi.mock("../../functions/_lib/github", async (importOriginal) => ({
    ...await importOriginal<Record<string, unknown>>(),
    getRunJobs: getRunJobsMock,
    getJobLogs: getJobLogsMock,
}));

import { onRequestPost as fixBuild } from "../../functions/api/generate/fix";
import { onRequestGet as getBuildStatus } from "../../functions/api/generate/status";

function taskState(overrides: Record<string, unknown> = {}): Record<string, unknown> {
    return {
        taskId: "task-1",
        uid: "user-1",
        status: "error",
        runId: 202,
        repairAttempts: 1,
        generatedFiles: [],
        logs: [],
        fixDiagnosticsFingerprint: "a1b2c3d4",
        fixRepairAuthorization: {
            runId: 202,
            diagnosticsFingerprint: "a1b2c3d4",
            repairAttempts: 1,
        },
        fixLearningAuthorization: {
            runId: 202,
            previousRunId: 101,
            diagnosticsFingerprint: "a1b2c3d4",
            repairAttempts: 1,
        },
        fixKnowledgeNeeds: [{ id: "obsolete-need" }],
        ...overrides,
    };
}

function endpointContext(mode: "diagnose" | "repair", initial: Record<string, unknown>): {
    context: any;
    readState: () => Record<string, unknown>;
    waits: Promise<unknown>[];
} {
    let raw = JSON.stringify(initial);
    const waits: Promise<unknown>[] = [];
    const tasks = {
        get: async (key: string) => key === "task-1" ? raw : null,
        put: async (key: string, value: string) => {
            if (key === "task-1") raw = value;
        },
        delete: async () => undefined,
    } as unknown as KVNamespace;
    return {
        context: {
            request: new Request("https://example.test/api/generate/fix", {
                method: "POST",
                headers: { "Content-Type": "application/json" },
                body: JSON.stringify({
                    taskId: "task-1",
                    mode,
                    repairAuthorization: initial.fixRepairAuthorization,
                }),
            }),
            data: { uid: "user-1" },
            env: {
                TASKS: tasks,
                GITHUB_PAT: "test-token",
                DEEPSEEK_API_KEY: "",
            },
            waitUntil(promise: Promise<unknown>) {
                waits.push(promise);
            },
        },
        readState: () => JSON.parse(raw),
        waits,
    };
}

function statusContext(initial: Record<string, unknown>): any {
    const raw = JSON.stringify(initial);
    return {
        request: new Request("https://example.test/api/generate/status?taskId=task-1"),
        data: { uid: "user-1" },
        env: {
            TASKS: {
                get: async (key: string) => key === "task-1" ? raw : null,
            } as unknown as KVNamespace,
            GITHUB_PAT: "test-token",
        },
    };
}

async function consumeStream(response: Response, waits: Promise<unknown>[]): Promise<void> {
    await response.text();
    await Promise.all(waits);
}

afterEach(() => {
    getRunJobsMock.mockReset();
    getJobLogsMock.mockReset();
});

describe("Fix authorization lifecycle", () => {
    it("rejects an obsolete repair request without mutating a completed task", async () => {
        const initial = taskState({ status: "done" });
        const { context, readState } = endpointContext("repair", initial);

        const response = await fixBuild(context);

        expect(response.status).toBe(409);
        expect(await response.json()).toMatchObject({ code: "REPAIR_AUTHORIZATION_EXPIRED" });
        expect(readState()).toEqual(initial);
        expect(getRunJobsMock).not.toHaveBeenCalled();
    });

    it("revokes old Fix authorizations when diagnose finds no usable diagnostics", async () => {
        getRunJobsMock.mockResolvedValue([{ id: 303, conclusion: "failure" }]);
        getJobLogsMock.mockResolvedValue("Build failed without a structured compiler diagnostic");
        const { context, readState, waits } = endpointContext("diagnose", taskState());

        const response = await fixBuild(context);
        await consumeStream(response, waits);

        const stored = readState();
        expect(stored.status).toBe("error");
        expect(stored).not.toHaveProperty("fixRepairAuthorization");
        expect(stored).not.toHaveProperty("fixLearningAuthorization");
        expect(stored).not.toHaveProperty("fixKnowledgeNeeds");
        expect(stored).not.toHaveProperty("fixDiagnosticsFingerprint");
    });

    it("revokes old Fix authorizations when diagnose throws", async () => {
        getRunJobsMock.mockRejectedValue(new Error("GitHub unavailable"));
        const { context, readState, waits } = endpointContext("diagnose", taskState());

        const response = await fixBuild(context);
        await consumeStream(response, waits);

        const stored = readState();
        expect(stored.status).toBe("error");
        expect(stored).not.toHaveProperty("fixRepairAuthorization");
        expect(stored).not.toHaveProperty("fixLearningAuthorization");
        expect(stored).not.toHaveProperty("fixKnowledgeNeeds");
        expect(stored).not.toHaveProperty("fixDiagnosticsFingerprint");
    });

    it("returns the current repair authorization for an error awaiting repair", async () => {
        const initial = taskState();

        const response = await getBuildStatus(statusContext(initial));

        expect(response.status).toBe(200);
        expect(await response.json()).toEqual({
            status: "error",
            repairPending: true,
            repairAuthorization: initial.fixRepairAuthorization,
        });
    });

    it("returns the same authorization while an interrupted repair is recoverable", async () => {
        const initial = taskState({
            status: "repairing",
            repairStartedAt: Date.now() - 1_000,
        });

        const response = await getBuildStatus(statusContext(initial));
        const body = await response.json() as Record<string, unknown>;

        expect(response.status).toBe(200);
        expect(body).toMatchObject({
            status: "repairing",
            repairAuthorization: initial.fixRepairAuthorization,
        });
        expect(Number(body.repairRetryAfterMs)).toBeGreaterThan(0);
    });
});
