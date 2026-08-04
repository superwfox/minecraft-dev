import { describe, expect, it } from "vitest";
import {
    learningCompletionStatus,
    learningKnowledgeIds,
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
        expect(snapshot.debugMeta?.status).toBe("deferred");
        expect(snapshot.learningProgress.message).toBe("自动联网学习已停用");
        expect(snapshot.learningDeferred).toBe(true);
    });

    it("merges cached, generated, and fallback knowledge IDs", () => {
        const job = makeJob("verifying");
        job.work.cachedKnowledgeIds = ["know-cached", "know-shared"];
        job.resultIds = ["know-generated", "know-shared"];

        expect(learningKnowledgeIds(job, ["know-fallback", "invalid id"])).toEqual([
            "know-cached",
            "know-shared",
            "know-generated",
            "know-fallback",
        ]);
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

    it("maps a closed reason code to a safe public message and telemetry", () => {
        const job = makeJob("deferred");
        job.error = "discovery_timeout";
        job.work.telemetry = {
            discoveryAttempts: 1,
            discoveryElapsedMs: 29_250,
            discoveryTimeouts: 1,
        } as any;

        const snapshot = learningSnapshot(job);

        expect(snapshot.learningProgress).toMatchObject({
            status: "deferred",
            reasonCode: "discovery_timeout",
            message: "资料发现服务响应超时，已按现有知识继续",
        });
        expect(snapshot.debugMeta).toMatchObject({
            schemaVersion: "learning.debug.v1",
            reasonCode: "discovery_timeout",
            telemetry: {
                discoveryAttempts: 1,
                discoveryElapsedMs: 29_250,
                discoveryTimeouts: 1,
            },
        });
    });

    it("does not expose unknown historical errors or lease data", () => {
        const job = makeJob("deferred");
        job.error = "private-upstream-error-sentinel";
        job.leaseToken = "lease-token-sentinel";
        job.work.currentNeed = "private-need-sentinel";

        const snapshot = learningSnapshot(job);
        const json = JSON.stringify(snapshot);

        expect(snapshot.learningProgress.reasonCode).toBe("internal_error");
        expect(snapshot.debugMeta?.reasonCode).toBe("internal_error");
        expect(json).not.toContain("private-upstream-error-sentinel");
        expect(json).not.toContain("lease-token-sentinel");
    });
});
