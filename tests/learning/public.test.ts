import { describe, expect, it } from "vitest";
import {
    learningCompletionStatus,
    learningSnapshot,
} from "../../functions/_lib/learning/public";
import type { LearningJobRecord } from "../../functions/_lib/learning/types";

function makeJob(status: LearningJobRecord["status"]): LearningJobRecord {
    return {
        jobId: "learn-test",
        ownerUid: "user-1",
        generationTaskId: "task-1",
        stage: "planner",
        lookupHash: "lookup-hash",
        status,
        needs: [],
        work: {},
        resultIds: [],
        revision: 1,
        leaseToken: "",
        leaseUntil: 0,
        error: "",
        createdAt: 1_700_000_000_000,
        updatedAt: 1_700_000_000_000,
    };
}

describe("public learning snapshot", () => {
    it("lets an explicit capability fallback override an in-progress job", () => {
        const snapshot = learningSnapshot(makeJob("fetching"), [], 0, {
            status: "deferred",
            message: "自动联网学习已停用",
        });

        expect(snapshot.learningProgress.status).toBe("deferred");
        expect(snapshot.learningProgress.message).toBe("自动联网学习已停用");
        expect(snapshot.learningDeferred).toBe(true);
    });

    it("reports ready only when every requested need produced an active fact", () => {
        expect(learningCompletionStatus(2, [{ status: "active" }])).toBe("deferred");
        expect(learningCompletionStatus(2, [
            { status: "active" },
            { status: "needs_review" },
        ])).toBe("needs_review");
        expect(learningCompletionStatus(2, [
            { status: "active" },
            { status: "active" },
        ])).toBe("ready");
    });
});
