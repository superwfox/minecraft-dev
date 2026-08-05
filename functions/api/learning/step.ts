import { discoverLearningSources } from "../../_lib/deepseekResponses";
import { resolveLLM } from "../../_lib/llm";
import { knowledgeLookupKey } from "../../_lib/learning/assessment";
import {
    LEARNING_DISCOVERY_LIMIT_MS,
    LEARNING_MIN_OUTBOUND_MS,
    LEARNING_SOURCE_LIMIT_MS,
    LEARNING_SOURCE_TIMEOUT_MS,
    LEARNING_VERIFIER_LIMIT_MS,
    learningLeaseMs,
    learningOutboundRemainingMs,
    learningStageBudget,
    learningVerificationFailureReason,
} from "../../_lib/learning/deadline";
import { normalizeLearningTelemetry } from "../../_lib/learning/debug";
import {
    learningCompletionStatus,
    learningKnowledgeIds,
    learningSnapshot,
} from "../../_lib/learning/public";
import {
    fetchLearningSources,
    learningNoSourcesReason,
} from "../../_lib/learning/sourceFetch";
import {
    acquireLearningJobLease,
    completeLearningJobStep,
    getKnowledgeItemsByIds,
    getLearningJob,
    knowledgeIdForLearningResult,
    listLearningSources,
    type KnowledgeItemCreateInput,
} from "../../_lib/learning/store";
import type {
    LearningActiveStatus,
    LearningJobRecord,
    LearningJobStatus,
    LearningJobTelemetry,
    LearningReasonCode,
    LearningSourceRecord,
} from "../../_lib/learning/types";
import { decideKnowledgeStatus, verifyKnowledgeNeed } from "../../_lib/learning/verification";
import { accumulateCosts, type UsageCostEntry } from "../../_lib/quota";
import { getOwnedTask, markTaskQuotaExhausted } from "../../_lib/taskStore";

interface Env {
    DB?: D1Database;
    TASKS: KVNamespace;
    DEEPSEEK_API_KEY: string;
    DEEPSEEK_RESPONSES_WEB_SEARCH?: string;
}

type LearningConflictReason = "revision" | "lease";

interface LearningStepSideEffects {
    sources?: LearningSourceRecord[];
    knowledge?: KnowledgeItemCreateInput & { knowledgeId: string };
}

const MAX_VERIFICATION_ATTEMPTS = 2;

function learningStepLimitMs(status: LearningJobStatus): number {
    if (status === "discovering") return LEARNING_DISCOVERY_LIMIT_MS;
    if (status === "fetching") return LEARNING_SOURCE_LIMIT_MS;
    if (status === "verifying") return LEARNING_VERIFIER_LIMIT_MS;
    return 0;
}

function learningJobNeedsFinalization(job: LearningJobRecord): boolean {
    return learningOutboundRemainingMs(job) < LEARNING_MIN_OUTBOUND_MS;
}

function isLearningActiveStatus(status: LearningJobStatus): status is LearningActiveStatus {
    return status === "queued" || status === "discovering" || status === "fetching" || status === "verifying";
}

function json(value: unknown, status = 200): Response {
    return new Response(JSON.stringify(value), { status, headers: { "Content-Type": "application/json" } });
}

async function snapshot(env: Env, job: LearningJobRecord) {
    const [items, sources] = await Promise.all([
        getKnowledgeItemsByIds(env, learningKnowledgeIds(job)),
        listLearningSources(env, job.jobId, job.ownerUid),
    ]);
    return learningSnapshot(job, items, sources.length);
}

function storageUnavailable(): Response {
    return json({
        error: "Learning storage is temporarily unavailable",
        reasonCode: "storage_unavailable",
    }, 503);
}

async function conflictResponse(
    env: Env,
    job: LearningJobRecord,
    reason: LearningConflictReason,
): Promise<Response> {
    return json({
        ...await snapshot(env, job),
        conflictReason: reason,
    }, 409);
}

function applyDiscoveryTelemetry(
    telemetry: LearningJobTelemetry,
    result: Awaited<ReturnType<typeof discoverLearningSources>>,
): void {
    telemetry.discoveryAttempts += result.attempts.length;
    telemetry.discoveryElapsedMs += result.elapsedMs;
    telemetry.discoveryTimeouts += result.attempts.filter((attempt) =>
        attempt.reasonCode === "discovery_timeout",
    ).length;
    telemetry.discoveryRetryableFailures += result.attempts.filter((attempt) =>
        !!attempt.reasonCode && attempt.retryable,
    ).length;
    const last = result.attempts[result.attempts.length - 1];
    telemetry.discoveryLastHttpStatus = last?.httpStatus ?? 0;
    telemetry.discoveryLastProviderStatus = last?.providerStatus ?? "unknown";
    telemetry.candidateNeedCount = result.candidates.length;
    telemetry.candidateUrlCount = result.candidates.reduce((sum, candidate) => sum + candidate.urls.length, 0);
}

function applyVerificationFailureTelemetry(
    telemetry: LearningJobTelemetry,
    result: Extract<Awaited<ReturnType<typeof verifyKnowledgeNeed>>, { ok: false }>,
): void {
    telemetry.verificationFailures++;
    if (result.reasonCode === "verification_timeout") telemetry.verificationTimeouts++;
    if (result.reasonCode === "verification_invalid_response") telemetry.verificationInvalidResponses++;
    if (result.httpStatus >= 400 && result.httpStatus < 500) telemetry.verificationHttp4xx++;
    if (result.httpStatus >= 500) telemetry.verificationHttp5xx++;
}

export const onRequestPost: PagesFunction<Env> = async (context) => {
    const uid: string = (context.data as any)?.uid || "";
    let body: any = {};
    try { body = await context.request.json(); } catch { /* validated below */ }
    const taskId = typeof body.taskId === "string" ? body.taskId : "";
    const jobId = typeof body.jobId === "string" ? body.jobId : "";
    const expectedRevision = Number(body.revision);
    if (!taskId || !jobId || !Number.isInteger(expectedRevision) || expectedRevision < 0) {
        return json({ error: "Invalid learning step request" }, 400);
    }

    const raw = await getOwnedTask(context.env, taskId, uid);
    if (!raw) return json({ error: "Task not found" }, 404);
    const state = JSON.parse(raw);

    let current: LearningJobRecord | null = null;
    try {
        current = await getLearningJob(context.env, jobId, uid);
        if (!current || current.generationTaskId !== taskId) {
            return json({ error: "Learning job not found" }, 404);
        }
        if (current.revision !== expectedRevision) {
            return await conflictResponse(context.env, current, "revision");
        }
        if (["ready", "deferred", "needs_review", "failed", "cancelled"].includes(current.status)) {
            return json(await snapshot(context.env, current));
        }
    } catch (error) {
        console.warn("learning step read failed", error);
        return storageUnavailable();
    }

    let llm: Awaited<ReturnType<typeof resolveLLM>>;
    try {
        llm = await resolveLLM(context);
    } catch (error) {
        console.warn("learning provider resolution failed", error);
        llm = {
            providerId: "deepseek",
            url: "",
            apiKey: "",
            byok: false,
            learningCacheRead: true,
            canAutoLearn: false,
            modelFor: () => "",
        };
    }

    let preflightReason: LearningReasonCode | undefined;
    if (learningJobNeedsFinalization(current)) preflightReason = "job_deadline";
    else if (state.quotaExhausted) preflightReason = "quota_exhausted";
    else if (!llm.canAutoLearn || llm.providerId !== "deepseek") {
        preflightReason = llm.providerId === "glm"
            ? "glm_auto_learning_disabled"
            : "auto_learning_disabled";
    }

    const leaseToken = `lease_${crypto.randomUUID().replace(/-/g, "")}`;
    let leased: LearningJobRecord | null = null;
    try {
        leased = await acquireLearningJobLease(context.env, {
            jobId,
            ownerUid: uid,
            expectedRevision,
            leaseToken,
            leaseMs: learningLeaseMs(current, learningStepLimitMs(current.status)),
        });
        if (!leased) {
            const latest = await getLearningJob(context.env, jobId, uid);
            if (!latest) return json({ error: "Learning job not found" }, 404);
            return await conflictResponse(
                context.env,
                latest,
                latest.revision === expectedRevision ? "lease" : "revision",
            );
        }
    } catch (error) {
        console.warn("learning lease failed", error);
        return storageUnavailable();
    }

    const persist = async (
        status: LearningJobStatus,
        work: LearningJobRecord["work"],
        resultIds: string[],
        reasonCode?: LearningReasonCode,
        sideEffects: LearningStepSideEffects = {},
    ): Promise<Response> => {
        try {
            const terminal = status === "ready" || status === "deferred" || status === "needs_review"
                || status === "failed" || status === "cancelled";
            const persistedWork = terminal && isLearningActiveStatus(leased!.status)
                ? { ...work, lastActiveStatus: leased!.status }
                : work;
            const completed = await completeLearningJobStep(context.env, {
                jobId,
                ownerUid: uid,
                expectedRevision: leased!.revision,
                leaseToken,
                status,
                work: persistedWork,
                resultIds,
                error: reasonCode ?? "",
                ...sideEffects,
            });
            if (!completed) {
                const latest = await getLearningJob(context.env, jobId, uid);
                if (!latest) return json({ error: "Learning job not found" }, 404);
                return await conflictResponse(context.env, latest, "revision");
            }
            return json(await snapshot(context.env, completed));
        } catch (error) {
            console.warn("learning step persist failed", error);
            return storageUnavailable();
        }
    };

    if (!preflightReason && learningJobNeedsFinalization(leased)) {
        preflightReason = "job_deadline";
    }
    if (preflightReason) {
        return persist("deferred", {
            ...leased.work,
            telemetry: normalizeLearningTelemetry(leased.work.telemetry),
        }, leased.resultIds, preflightReason);
    }

    const charge = async (entries: UsageCostEntry[]): Promise<boolean> => {
        if (!entries.length) return false;
        const cost = await accumulateCosts(context.env, uid, taskId, entries);
        if (cost.outOfQuota) await markTaskQuotaExhausted(context.env, taskId, uid);
        return cost.outOfQuota;
    };

    if (leased.status === "queued") {
        return persist("discovering", {
            ...leased.work,
            currentNeed: leased.needs[0]?.claim.question,
            completedNeeds: 0,
            telemetry: normalizeLearningTelemetry(leased.work.telemetry),
        }, leased.resultIds);
    }

    if (leased.status === "discovering") {
        const telemetry = normalizeLearningTelemetry(leased.work.telemetry);
        const discoveryBudget = learningStageBudget(leased, LEARNING_DISCOVERY_LIMIT_MS);
        if (discoveryBudget.budgetMs < LEARNING_MIN_OUTBOUND_MS) {
            return persist("deferred", { ...leased.work, telemetry }, leased.resultIds, "job_deadline");
        }

        let discovery: Awaited<ReturnType<typeof discoverLearningSources>>;
        try {
            discovery = await discoverLearningSources({
                apiKey: context.env.DEEPSEEK_API_KEY,
                needs: leased.needs,
                budgetMs: discoveryBudget.budgetMs,
            });
        } catch (error) {
            console.warn("learning discovery failed", error);
            return persist("deferred", { ...leased.work, telemetry }, leased.resultIds,
                learningJobNeedsFinalization(leased) ? "job_deadline" : "internal_error");
        }
        applyDiscoveryTelemetry(telemetry, discovery);

        let quotaExhausted = false;
        try {
            quotaExhausted = await charge(discovery.usageEntries);
        } catch (error) {
            console.warn("learning discovery charge failed", error);
            return persist("deferred", { ...leased.work, telemetry }, leased.resultIds, "storage_unavailable");
        }
        if (quotaExhausted) {
            return persist("deferred", { ...leased.work, telemetry }, leased.resultIds, "quota_exhausted");
        }
        if (!discovery.ok) {
            const reasonCode = discovery.reasonCode === "discovery_timeout"
                && discoveryBudget.clippedByJobDeadline
                ? "job_deadline"
                : discovery.reasonCode;
            return persist("deferred", { ...leased.work, telemetry }, leased.resultIds, reasonCode);
        }

        const work = {
            ...leased.work,
            candidates: discovery.candidates,
            telemetry,
        };
        if (learningJobNeedsFinalization(leased)) {
            return persist("deferred", work, leased.resultIds, "job_deadline");
        }
        return persist("fetching", work, leased.resultIds);
    }

    if (leased.status === "fetching") {
        const telemetry = normalizeLearningTelemetry(leased.work.telemetry);
        const sourceBudget = learningStageBudget(leased, LEARNING_SOURCE_LIMIT_MS);
        if (sourceBudget.budgetMs < LEARNING_MIN_OUTBOUND_MS) {
            return persist("deferred", { ...leased.work, telemetry }, leased.resultIds, "job_deadline");
        }

        let fetched: Awaited<ReturnType<typeof fetchLearningSources>>;
        try {
            fetched = await fetchLearningSources({
                jobId,
                needs: leased.needs,
                candidates: leased.work.candidates ?? [],
                budgetMs: sourceBudget.budgetMs,
                timeoutMs: LEARNING_SOURCE_TIMEOUT_MS,
                maxSources: 6,
            });
        } catch (error) {
            console.warn("learning source fetch failed", error);
            return persist("deferred", { ...leased.work, telemetry }, leased.resultIds,
                learningJobNeedsFinalization(leased) ? "job_deadline" : "no_fetchable_sources");
        }
        Object.assign(telemetry, {
            ...fetched.telemetry,
            version: 1,
        });

        const accumulatedSources = fetched.sources;
        const sourceEffects: LearningStepSideEffects = { sources: fetched.sources };
        const work = {
            ...leased.work,
            sourceIds: accumulatedSources.map((source) => source.sourceId),
            telemetry,
        };
        if (!accumulatedSources.length) {
            const reasonCode = learningNoSourcesReason(
                fetched.telemetry,
                sourceBudget.clippedByJobDeadline,
            );
            return persist("deferred", work, leased.resultIds, reasonCode, sourceEffects);
        }
        if (learningJobNeedsFinalization(leased)) {
            return persist("deferred", work, leased.resultIds, "job_deadline", sourceEffects);
        }
        return persist("verifying", {
            ...work,
            currentNeed: leased.needs[0]?.claim.question,
            completedNeeds: 0,
        }, leased.resultIds, undefined, sourceEffects);
    }

    if (leased.status === "verifying") {
        const telemetry = normalizeLearningTelemetry(leased.work.telemetry);
        const index = Math.max(0, Number(leased.work.completedNeeds) || 0);
        const advanceVerification = async (
            resultIds: string[],
            work: LearningJobRecord["work"],
            completedNeeds: number,
        ): Promise<Response> => {
            const completed = Math.min(leased!.needs.length, completedNeeds);
            let nextStatus: LearningJobStatus = "verifying";
            let reasonCode: LearningReasonCode | undefined;
            if (learningJobNeedsFinalization(leased!)) {
                nextStatus = "deferred";
                reasonCode = "job_deadline";
            } else if (completed >= leased!.needs.length) {
                try {
                    const items = await getKnowledgeItemsByIds(context.env, resultIds);
                    nextStatus = learningCompletionStatus(leased!.needs.length, items);
                    if (nextStatus === "deferred") reasonCode = "unresolved_knowledge_needs";
                } catch (error) {
                    console.warn("learning result read failed", error);
                    return storageUnavailable();
                }
            }
            return persist(nextStatus, {
                ...work,
                completedNeeds: completed,
                currentNeed: leased!.needs[completed]?.claim.question,
                telemetry,
            }, resultIds, reasonCode);
        };

        const need = leased.needs[index];
        if (!need) {
            return advanceVerification(leased.resultIds, leased.work, leased.needs.length);
        }

        let allSources;
        try {
            allSources = await listLearningSources(context.env, jobId, uid);
        } catch (error) {
            console.warn("learning verification source read failed", error);
            return storageUnavailable();
        }
        const needSources = allSources.filter((source) => source.needId === need.id);
        if (!needSources.length) {
            telemetry.verificationFailures++;
            return advanceVerification(leased.resultIds, leased.work, index + 1);
        }

        const verificationBudget = learningStageBudget(leased, LEARNING_VERIFIER_LIMIT_MS);
        if (verificationBudget.budgetMs < LEARNING_MIN_OUTBOUND_MS) {
            return persist("deferred", { ...leased.work, telemetry }, leased.resultIds, "job_deadline");
        }

        const verificationAttemptsByNeed = { ...leased.work.verificationAttemptsByNeed };
        const previousAttempts = Math.max(0, Number(verificationAttemptsByNeed[need.id]) || 0);
        const verificationAttempt = Math.min(MAX_VERIFICATION_ATTEMPTS, previousAttempts + 1);
        verificationAttemptsByNeed[need.id] = verificationAttempt;

        const verified = await verifyKnowledgeNeed({
            llm,
            need,
            sources: needSources,
            timeoutMs: verificationBudget.budgetMs,
        });
        telemetry.verificationAttempts++;
        telemetry.verificationElapsedMs += verified.elapsedMs;
        try {
            const quotaExhausted = await charge(verified.usage
                ? [{ model: verified.model, usage: verified.usage }]
                : []);
            if (quotaExhausted) {
                return persist("deferred", {
                    ...leased.work,
                    verificationAttemptsByNeed,
                    telemetry,
                }, leased.resultIds, "quota_exhausted");
            }
        } catch (error) {
            console.warn("learning verification charge failed", error);
            return persist("deferred", {
                ...leased.work,
                verificationAttemptsByNeed,
                telemetry,
            }, leased.resultIds, "storage_unavailable");
        }

        if (!verified.ok) {
            applyVerificationFailureTelemetry(telemetry, verified);
            const reasonCode = learningVerificationFailureReason(
                verified.reasonCode,
                verificationBudget.clippedByJobDeadline,
            );
            const canRetry = reasonCode !== "job_deadline"
                && verified.retryable
                && verificationAttempt < MAX_VERIFICATION_ATTEMPTS;
            const retryBlockedByDeadline = canRetry && learningJobNeedsFinalization(leased);
            if (canRetry && !retryBlockedByDeadline) {
                return persist("verifying", {
                    ...leased.work,
                    verificationAttemptsByNeed,
                    telemetry,
                }, leased.resultIds);
            }
            return persist("deferred", {
                ...leased.work,
                verificationAttemptsByNeed,
                telemetry,
            }, leased.resultIds, reasonCode);
        }

        if (learningJobNeedsFinalization(leased)) {
            return persist("deferred", {
                ...leased.work,
                verificationAttemptsByNeed,
                telemetry,
            }, leased.resultIds, "job_deadline");
        }

        telemetry.verificationCompleted++;
        if (verified.verification.verdict === "supported") telemetry.verificationSupported++;
        else if (verified.verification.verdict === "contradicted") telemetry.verificationContradicted++;
        else telemetry.verificationInsufficient++;

        const resultIds = leased.resultIds.slice();
        const verifications = leased.work.verifications?.slice() ?? [];
        verifications.push(verified.verification);
        const now = Date.now();
        const activation = decideKnowledgeStatus(need, verified.verification, needSources, now);
        const knowledgeId = knowledgeIdForLearningResult(jobId, index);
        if (!resultIds.includes(knowledgeId)) resultIds.push(knowledgeId);
        const knowledge: KnowledgeItemCreateInput & { knowledgeId: string } = {
            knowledgeId,
            kind: need.kind,
            lookupKey: knowledgeLookupKey(need),
            scope: need.scope,
            payload: verified.verification.normalizedClaim ?? {},
            summary: verified.verification.runtimeSummary || need.claim.question,
            risk: need.risk,
            confidence: verified.verification.confidence,
            status: activation.status,
            validFrom: now,
            expiresAt: activation.expiresAt,
            evidence: verified.verification.evidence,
            now,
        };

        const completedNeeds = Math.min(leased.needs.length, index + 1);
        let nextStatus: LearningJobStatus = "verifying";
        let reasonCode: LearningReasonCode | undefined;
        if (completedNeeds >= leased.needs.length) {
            try {
                const items = await getKnowledgeItemsByIds(context.env, resultIds);
                const completionItems = [
                    ...items.filter((item) => item.knowledgeId !== knowledgeId),
                    { status: activation.status },
                ];
                nextStatus = learningCompletionStatus(leased.needs.length, completionItems);
                if (nextStatus === "deferred") reasonCode = "unresolved_knowledge_needs";
            } catch (error) {
                console.warn("learning result read failed", error);
                return storageUnavailable();
            }
        }

        return persist(nextStatus, {
            ...leased.work,
            verifications,
            verificationAttemptsByNeed,
            completedNeeds,
            currentNeed: leased.needs[completedNeeds]?.claim.question,
            telemetry,
        }, resultIds, reasonCode, { knowledge });
    }

    return persist("failed", {
        ...leased.work,
        telemetry: normalizeLearningTelemetry(leased.work.telemetry),
    }, leased.resultIds, "internal_error");
};
