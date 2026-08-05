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
} from "../../functions/_lib/learning/deadline";

function timingJob(createdAt: number, deadlineAt?: number) {
    return {
        createdAt,
        work: deadlineAt === undefined ? {} : { deadlineAt },
    };
}

describe("learning job deadline", () => {
    it("clamps the client remaining budget to one through 300 seconds", () => {
        expect(clampLearningRemainingMs(undefined)).toBe(LEARNING_JOB_BUDGET_MS);
        expect(clampLearningRemainingMs(Number.NaN)).toBe(LEARNING_JOB_BUDGET_MS);
        expect(clampLearningRemainingMs(500_000)).toBe(LEARNING_JOB_BUDGET_MS);
        expect(clampLearningRemainingMs(0)).toBe(1);
        expect(clampLearningRemainingMs(1_234.9)).toBe(1_234);
        expect(createLearningDeadlineAt(1_700_000_000_000, 45_000)).toBe(1_700_000_045_000);
    });

    it("uses the stored deadline without allowing retries to extend the hard limit", () => {
        const createdAt = 1_700_000_000_000;

        expect(learningJobTiming(timingJob(createdAt))).toEqual({
            startedAt: createdAt,
            deadlineAt: createdAt + LEARNING_JOB_BUDGET_MS,
        });
        expect(learningJobTiming(timingJob(createdAt, createdAt + 240_000))).toEqual({
            startedAt: createdAt,
            deadlineAt: createdAt + 240_000,
        });
        expect(learningJobTiming(timingJob(createdAt, createdAt + 900_000)).deadlineAt)
            .toBe(createdAt + LEARNING_JOB_BUDGET_MS);
        expect(learningJobTiming(timingJob(createdAt, createdAt - 1)).deadlineAt)
            .toBe(createdAt + LEARNING_JOB_BUDGET_MS);
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

    it("bounds leases by the stage, outbound reserve, and hard deadline", () => {
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

    it("preserves a full verifier timeout unless the job deadline clipped its budget", () => {
        expect(learningVerificationFailureReason("verification_timeout", false))
            .toBe("verification_timeout");
        expect(learningVerificationFailureReason("verification_timeout", true))
            .toBe("job_deadline");
        expect(learningVerificationFailureReason("verification_http", true))
            .toBe("verification_http");
    });
});
