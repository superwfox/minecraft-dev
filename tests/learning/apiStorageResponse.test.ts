import { afterEach, describe, expect, it, vi } from "vitest";
import { onRequestPost as startLearning } from "../../functions/api/learning/start";
import { onRequestPost as stepLearning } from "../../functions/api/learning/step";
import { onRequestGet as getLearningStatus } from "../../functions/api/learning/status";
import { makeNeed } from "./testData";

function createTaskKv(raw: string): KVNamespace {
    return {
        get: async (key: string) => key === "task-1" ? raw : null,
        put: async () => undefined,
        delete: async () => undefined,
    } as unknown as KVNamespace;
}

function context(request: Request, raw: string): any {
    return {
        request,
        data: { uid: "user-1" },
        env: {
            TASKS: createTaskKv(raw),
            DEEPSEEK_API_KEY: "",
        },
    };
}

async function expectBareStorageUnavailable(response: Response): Promise<void> {
    expect(response.status).toBe(503);
    const body = await response.json() as Record<string, unknown>;
    expect(body).toMatchObject({ reasonCode: "storage_unavailable" });
    expect(body).not.toHaveProperty("learningProgress");
    expect(body).not.toHaveProperty("learningDeferred");
}

afterEach(() => {
    vi.restoreAllMocks();
});

describe("learning storage failure responses", () => {
    it("keeps start retryable instead of inventing a terminal progress snapshot", async () => {
        vi.spyOn(console, "warn").mockImplementation(() => undefined);
        const raw = JSON.stringify({
            uid: "user-1",
            coreType: "paper",
            version: "1.21.4",
            grade: { knowledgeNeeds: [makeNeed()] },
        });
        const response = await startLearning(context(new Request("https://example.test/api/learning/start", {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ taskId: "task-1", stage: "planner", remainingMs: 300_000 }),
        }), raw);

        await expectBareStorageUnavailable(response);
    });

    it("keeps step retryable when the authoritative job cannot be read", async () => {
        vi.spyOn(console, "warn").mockImplementation(() => undefined);
        const raw = JSON.stringify({ uid: "user-1", status: "planning" });
        const response = await stepLearning(context(new Request("https://example.test/api/learning/step", {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ taskId: "task-1", jobId: "learn-test", revision: 4 }),
        }), raw);

        await expectBareStorageUnavailable(response);
    });

    it("keeps status retryable when exact-job reconciliation storage is unavailable", async () => {
        vi.spyOn(console, "warn").mockImplementation(() => undefined);
        const raw = JSON.stringify({ uid: "user-1", status: "planning" });
        const response = await getLearningStatus(context(new Request(
            "https://example.test/api/learning/status?taskId=task-1&jobId=learn-test&stage=planner",
        ), raw));

        await expectBareStorageUnavailable(response);
    });
});
