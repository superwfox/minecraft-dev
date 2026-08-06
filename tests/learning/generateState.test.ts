import { describe, expect, it } from "vitest";
import {
    isUnconfirmedLearningProgress,
    normalizeBuildRequestId,
    normalizeFixResumeStage,
    normalizeLearningProgress,
    shouldResumeLearningProgress,
} from "../../src/logic/generateState";

describe("learning progress normalization", () => {
    it("accepts only bounded public progress fields", () => {
        const startedAt = 1_700_000_000_000;
        const progress = normalizeLearningProgress({
            jobId: "learn_safe-1",
            status: "verifying",
            revision: 4,
            stage: "fix",
            startedAt,
            deadlineAt: startedAt + 240_000,
            remainingMs: 123_456,
            lastActiveStatus: "fetching",
            currentNeed: "  Which API is available?  ",
            totalNeeds: 2,
            completedNeeds: 9,
            sourceCount: 3,
            searchedSourceCount: 7,
            message: "  正在交叉验证  ",
            reasonCode: "job_deadline",
        });

        expect(progress).toEqual({
            jobId: "learn_safe-1",
            status: "verifying",
            revision: 4,
            stage: "fix",
            startedAt,
            deadlineAt: startedAt + 240_000,
            remainingMs: 123_456,
            lastActiveStatus: "fetching",
            currentNeed: "Which API is available?",
            totalNeeds: 2,
            completedNeeds: 2,
            sourceCount: 3,
            searchedSourceCount: 7,
            message: "正在交叉验证",
            reasonCode: "job_deadline",
        });
    });

    it("rejects unknown public fields while accepting a renewed inactivity deadline", () => {
        const startedAt = 1_700_000_000_000;
        const progress = normalizeLearningProgress({
            jobId: "invalid job id",
            status: "private_status",
            revision: -1,
            stage: "private_stage",
            startedAt,
            deadlineAt: startedAt + 900_000,
            remainingMs: -1,
            lastActiveStatus: "private_status",
            totalNeeds: -3,
            completedNeeds: 10,
            sourceCount: Number.NaN,
            searchedSourceCount: -1,
            message: 123,
            reasonCode: "private_error_body",
        });

        expect(progress).toEqual({
            jobId: "",
            status: "idle",
            revision: 0,
            stage: undefined,
            startedAt,
            deadlineAt: startedAt + 900_000,
            remainingMs: undefined,
            lastActiveStatus: undefined,
            currentNeed: undefined,
            totalNeeds: 0,
            completedNeeds: 0,
            sourceCount: 0,
            searchedSourceCount: 0,
            message: "",
            reasonCode: undefined,
        });
    });

    it("treats only client-side terminal fallbacks with a job ID as unconfirmed", () => {
        expect(isUnconfirmedLearningProgress({
            jobId: "learn-safe",
            reasonCode: "client_network",
        })).toBe(true);
        expect(isUnconfirmedLearningProgress({
            jobId: "learn-safe",
            reasonCode: "client_deadline",
        })).toBe(true);
        expect(isUnconfirmedLearningProgress({
            jobId: "learn-safe",
            reasonCode: "job_deadline",
        })).toBe(false);
        expect(isUnconfirmedLearningProgress({
            jobId: "",
            reasonCode: "client_network",
        })).toBe(false);
    });

    it("resumes only the exact active or locally unconfirmed learning job", () => {
        const active = normalizeLearningProgress({
            jobId: "learn-active",
            stage: "fix",
            status: "verifying",
        });
        expect(shouldResumeLearningProgress(active, "fix", true)).toBe(true);
        expect(shouldResumeLearningProgress(active, "planner", true)).toBe(false);
        expect(shouldResumeLearningProgress(active, "fix", false)).toBe(false);

        const unconfirmed = normalizeLearningProgress({
            jobId: "learn-unconfirmed",
            stage: "fix",
            status: "deferred",
            reasonCode: "client_network",
        });
        expect(shouldResumeLearningProgress(unconfirmed, "fix", true)).toBe(true);

        const completed = normalizeLearningProgress({
            jobId: "learn-completed",
            stage: "fix",
            status: "ready",
            reasonCode: "knowledge_cache_hit",
        });
        expect(shouldResumeLearningProgress(completed, "fix", true)).toBe(false);
        expect(shouldResumeLearningProgress({ ...active, jobId: "" }, "fix", true)).toBe(false);
    });

    it("caps server-reported remaining time at the five-minute public limit", () => {
        expect(normalizeLearningProgress({
            status: "discovering",
            remainingMs: 999_999,
        }).remainingMs).toBe(300_000);
    });

    it("does not accept a deadline without a valid start anchor", () => {
        const progress = normalizeLearningProgress({
            status: "queued",
            deadlineAt: 1_700_000_300_000,
        });

        expect(progress.startedAt).toBeUndefined();
        expect(progress.deadlineAt).toBeUndefined();
    });

    it("restores only canonical build request IDs", () => {
        const requestId = `build_${"A".repeat(32)}`;
        expect(normalizeBuildRequestId(requestId)).toBe(requestId.toLowerCase());
        expect(normalizeBuildRequestId("build_short")).toBe("");
        expect(normalizeBuildRequestId("plan_" + "a".repeat(32))).toBe("");
        expect(normalizeBuildRequestId({ requestId })).toBe("");
    });

    it("restores only explicit build repair substages", () => {
        for (const stage of ["diagnosing", "learning", "repairing", "inspecting", "rebuilding"] as const) {
            expect(normalizeFixResumeStage(stage)).toBe(stage);
        }
        expect(normalizeFixResumeStage("building")).toBe("");
        expect(normalizeFixResumeStage({ stage: "repairing" })).toBe("");
    });
});
