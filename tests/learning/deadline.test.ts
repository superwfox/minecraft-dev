import { describe, expect, it } from "vitest";
import {
    LEARNING_DISCOVERY_LIMIT_MS,
    LEARNING_JOB_BUDGET_MS,
    LEARNING_OUTBOUND_RESERVE_MS,
    LEARNING_PERSIST_RESERVE_MS,
    LEARNING_SOURCE_LIMIT_MS,
    clampLearningRemainingMs,
    createLearningDeadlineAt,
    learningJobRemainingMs,
    learningJobTiming,
    learningLeaseMs,
    learningOutboundRemainingMs,
    learningStageBudget,
    learningVerificationFailureReason,
    refreshLearningInactivity,
} from "../../functions/_lib/learning/deadline";
import type { LearningJobWork } from "../../functions/_lib/learning/types";

function timingJob(createdAt: number, work: LearningJobWork = {}) {
    return { createdAt, work };
}

describe("learning inactivity deadline", () => {
    it("clamps one inactivity window to one through 300 seconds", () => {
        expect(clampLearningRemainingMs(undefined)).toBe(LEARNING_JOB_BUDGET_MS);
        expect(clampLearningRemainingMs(Number.NaN)).toBe(LEARNING_JOB_BUDGET_MS);
        expect(clampLearningRemainingMs(500_000)).toBe(LEARNING_JOB_BUDGET_MS);
        expect(clampLearningRemainingMs(0)).toBe(1);
        expect(clampLearningRemainingMs(1_234.9)).toBe(1_234);
        expect(createLearningDeadlineAt(1_700_000_000_000, 45_000)).toBe(1_700_000_045_000);
    });

    it("keeps legacy deadlines but lets persisted progress start a fresh window", () => {
        const createdAt = 1_700_000_000_000;

        expect(learningJobTiming(timingJob(createdAt))).toEqual({
            startedAt: createdAt,
            lastProgressAt: createdAt,
            deadlineAt: createdAt + LEARNING_JOB_BUDGET_MS,
        });
        expect(learningJobTiming(timingJob(createdAt, {
            deadlineAt: createdAt + 240_000,
        }))).toEqual({
            startedAt: createdAt,
            lastProgressAt: createdAt,
            deadlineAt: createdAt + 240_000,
        });
        expect(learningJobTiming(timingJob(createdAt, {
            deadlineAt: createdAt + 900_000,
        })).deadlineAt).toBe(createdAt + 900_000);
        expect(learningJobTiming(timingJob(createdAt, {
            deadlineAt: createdAt - 1,
        })).deadlineAt).toBe(createdAt + LEARNING_JOB_BUDGET_MS);

        const progressedAt = createdAt + 260_000;
        const refreshed = refreshLearningInactivity({ deadlineAt: createdAt + 280_000 }, progressedAt);
        expect(refreshed).toEqual({
            deadlineAt: createdAt + 280_000,
            lastProgressAt: progressedAt,
            inactivityDeadlineAt: progressedAt + LEARNING_JOB_BUDGET_MS,
        });
        expect(learningJobTiming(timingJob(createdAt, refreshed))).toEqual({
            startedAt: createdAt,
            lastProgressAt: progressedAt,
            deadlineAt: progressedAt + LEARNING_JOB_BUDGET_MS,
        });
        expect(learningJobRemainingMs(timingJob(createdAt, refreshed), progressedAt + 20_000))
            .toBe(LEARNING_JOB_BUDGET_MS - 20_000);
    });

    it("reserves final status and persistence time before starting outbound work", () => {
        const createdAt = 1_700_000_000_000;
        const job = timingJob(createdAt);
        const now = createdAt + 200_000;

        expect(learningJobRemainingMs(job, now)).toBe(100_000);
        expect(learningOutboundRemainingMs(job, now)).toBe(
            100_000 - LEARNING_OUTBOUND_RESERVE_MS,
        );
        expect(learningStageBudget(job, LEARNING_DISCOVERY_LIMIT_MS, now)).toEqual({
            budgetMs: 100_000 - LEARNING_OUTBOUND_RESERVE_MS,
            clippedByJobDeadline: true,
        });
        expect(learningStageBudget(job, LEARNING_SOURCE_LIMIT_MS, now)).toEqual({
            budgetMs: LEARNING_SOURCE_LIMIT_MS,
            clippedByJobDeadline: false,
        });
    });

    it("bounds leases by the stage, outbound reserve, and inactivity deadline", () => {
        const createdAt = 1_700_000_000_000;
        const job = timingJob(createdAt);

        expect(learningLeaseMs(job, LEARNING_DISCOVERY_LIMIT_MS, createdAt)).toBe(
            LEARNING_DISCOVERY_LIMIT_MS + LEARNING_OUTBOUND_RESERVE_MS,
        );
        expect(learningLeaseMs(job, LEARNING_DISCOVERY_LIMIT_MS, createdAt + 299_500))
            .toBe(LEARNING_PERSIST_RESERVE_MS);
        expect(learningLeaseMs(job, LEARNING_DISCOVERY_LIMIT_MS, createdAt + 300_001))
            .toBe(LEARNING_PERSIST_RESERVE_MS);
    });

    it("preserves a verifier timeout unless the inactivity deadline clipped its budget", () => {
        expect(learningVerificationFailureReason("verification_timeout", false))
            .toBe("verification_timeout");
        expect(learningVerificationFailureReason("verification_timeout", true))
            .toBe("job_deadline");
        expect(learningVerificationFailureReason("verification_http", true))
            .toBe("verification_http");
    });
});
