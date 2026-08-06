import type { LearningJobRecord, LearningReasonCode } from "./types";

export const LEARNING_JOB_BUDGET_MS = 300_000;
export const LEARNING_STATUS_RESERVE_MS = 12_000;
export const LEARNING_PERSIST_RESERVE_MS = 3_000;
export const LEARNING_OUTBOUND_RESERVE_MS =
    LEARNING_STATUS_RESERVE_MS + LEARNING_PERSIST_RESERVE_MS;

export const LEARNING_DISCOVERY_LIMIT_MS = 90_000;
export const LEARNING_SOURCE_LIMIT_MS = 30_000;
export const LEARNING_SOURCE_TIMEOUT_MS = 8_000;
export const LEARNING_VERIFIER_LIMIT_MS = 90_000;
export const LEARNING_CLIENT_REQUEST_LIMIT_MS = 126_000;
export const LEARNING_LEASE_LIMIT_MS = 120_000;
export const LEARNING_MIN_OUTBOUND_MS = 1_000;

function timestamp(value: unknown): number {
    const number = Number(value);
    return Number.isFinite(number) && number > 0
        ? Math.floor(number)
        : 0;
}

export function clampLearningRemainingMs(value: unknown): number {
    const number = Number(value);
    if (!Number.isFinite(number)) return LEARNING_JOB_BUDGET_MS;
    return Math.max(1, Math.min(LEARNING_JOB_BUDGET_MS, Math.floor(number)));
}

export function createLearningDeadlineAt(now: number, remainingMs: unknown): number {
    return timestamp(now) + clampLearningRemainingMs(remainingMs);
}

export function refreshLearningInactivity<T extends LearningJobRecord["work"]>(
    work: T,
    now = Date.now(),
): T {
    const progressedAt = timestamp(now);
    return {
        ...work,
        lastProgressAt: progressedAt,
        inactivityDeadlineAt: progressedAt + LEARNING_JOB_BUDGET_MS,
    };
}

export function learningJobTiming(
    job: Pick<LearningJobRecord, "createdAt" | "work">,
): { startedAt: number; lastProgressAt: number; deadlineAt: number } {
    const startedAt = timestamp(job.createdAt);
    const storedProgressAt = timestamp(job.work.lastProgressAt);
    const lastProgressAt = storedProgressAt >= startedAt ? storedProgressAt : startedAt;
    const storedInactivityDeadline = timestamp(job.work.inactivityDeadlineAt);
    const legacyDeadline = timestamp(job.work.deadlineAt);
    const deadlineAt = storedInactivityDeadline > lastProgressAt
        ? storedInactivityDeadline
        : legacyDeadline > startedAt
            ? legacyDeadline
            : lastProgressAt + LEARNING_JOB_BUDGET_MS;
    return { startedAt, lastProgressAt, deadlineAt };
}

export function learningJobRemainingMs(
    job: Pick<LearningJobRecord, "createdAt" | "work">,
    now = Date.now(),
): number {
    return Math.max(0, learningJobTiming(job).deadlineAt - now);
}

export function learningOutboundRemainingMs(
    job: Pick<LearningJobRecord, "createdAt" | "work">,
    now = Date.now(),
): number {
    return Math.max(
        0,
        learningJobTiming(job).deadlineAt - now - LEARNING_OUTBOUND_RESERVE_MS,
    );
}

export function learningStageBudget(
    job: Pick<LearningJobRecord, "createdAt" | "work">,
    stageLimitMs: number,
    now = Date.now(),
): { budgetMs: number; clippedByJobDeadline: boolean } {
    const limitMs = Math.max(0, Math.floor(stageLimitMs));
    const remainingMs = learningOutboundRemainingMs(job, now);
    return {
        budgetMs: Math.min(limitMs, remainingMs),
        clippedByJobDeadline: remainingMs < limitMs,
    };
}

export function learningLeaseMs(
    job: Pick<LearningJobRecord, "createdAt" | "work">,
    stageLimitMs: number,
    now = Date.now(),
): number {
    const hardRemainingMs = learningJobRemainingMs(job, now);
    const { budgetMs } = learningStageBudget(job, stageLimitMs, now);
    return Math.max(1, Math.min(
        LEARNING_LEASE_LIMIT_MS,
        Math.max(hardRemainingMs, LEARNING_PERSIST_RESERVE_MS),
        budgetMs + LEARNING_OUTBOUND_RESERVE_MS,
    ));
}

export function learningVerificationFailureReason(
    reasonCode: LearningReasonCode,
    clippedByJobDeadline: boolean,
): LearningReasonCode {
    return reasonCode === "verification_timeout" && clippedByJobDeadline
        ? "job_deadline"
        : reasonCode;
}
