import { discoverLearningSources } from "../../_lib/deepseekResponses";
import { resolveLLM } from "../../_lib/llm";
import { knowledgeLookupKey } from "../../_lib/learning/assessment";
import { normalizeLearningTelemetry } from "../../_lib/learning/debug";
import {
    learningCompletionStatus,
    learningKnowledgeIds,
    learningSnapshot,
} from "../../_lib/learning/public";
import { fetchLearningSources } from "../../_lib/learning/sourceFetch";
import {
    acquireLearningJobLease,
    completeLearningJobStep,
    createKnowledgeItem,
    getKnowledgeItemsByIds,
    getLearningJob,
    insertLearningSources,
    knowledgeIdForLearningResult,
    listLearningSources,
} from "../../_lib/learning/store";
import type {
    LearningJobRecord,
    LearningJobStatus,
    LearningJobTelemetry,
    LearningReasonCode,
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

const MAX_VERIFICATION_ATTEMPTS = 2;
const PLANNER_SOURCE_BUDGET_MS = 10_000;
const FIX_SOURCE_BUDGET_MS = 5_000;

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

function storageUnavailable(job: LearningJobRecord | null): Response {
    return json(learningSnapshot(job, [], 0, {
        status: "deferred",
        reasonCode: "storage_unavailable",
    }), 503);
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
        return storageUnavailable(current);
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
    if (state.quotaExhausted) preflightReason = "quota_exhausted";
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
            leaseMs: 120_000,
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
        return storageUnavailable(current);
    }

    const persist = async (
        status: LearningJobStatus,
        work: LearningJobRecord["work"],
        resultIds: string[],
        reasonCode?: LearningReasonCode,
    ): Promise<Response> => {
        try {
            const completed = await completeLearningJobStep(context.env, {
                jobId,
                ownerUid: uid,
                expectedRevision: leased!.revision,
                leaseToken,
                status,
                work,
                resultIds,
                error: reasonCode ?? "",
            });
            if (!completed) {
                const latest = await getLearningJob(context.env, jobId, uid);
                if (!latest) return json({ error: "Learning job not found" }, 404);
                return await conflictResponse(context.env, latest, "revision");
            }
            return json(await snapshot(context.env, completed));
        } catch (error) {
            console.warn("learning step persist failed", error);
            return storageUnavailable(leased);
        }
    };

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
        let discovery: Awaited<ReturnType<typeof discoverLearningSources>>;
        try {
            discovery = await discoverLearningSources({
                apiKey: context.env.DEEPSEEK_API_KEY,
                needs: leased.needs,
                budgetMs: leased.stage === "planner" ? 30_000 : 12_000,
            });
        } catch (error) {
            console.warn("learning discovery failed", error);
            return persist("deferred", { ...leased.work, telemetry }, leased.resultIds, "internal_error");
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
            return persist("deferred", { ...leased.work, telemetry }, leased.resultIds, discovery.reasonCode);
        }
        return persist("fetching", {
            ...leased.work,
            candidates: discovery.candidates,
            telemetry,
        }, leased.resultIds);
    }

    if (leased.status === "fetching") {
        const telemetry = normalizeLearningTelemetry(leased.work.telemetry);
        let fetched: Awaited<ReturnType<typeof fetchLearningSources>>;
        try {
            fetched = await fetchLearningSources({
                jobId,
                needs: leased.needs,
                candidates: leased.work.candidates ?? [],
                budgetMs: leased.stage === "planner"
                    ? PLANNER_SOURCE_BUDGET_MS
                    : FIX_SOURCE_BUDGET_MS,
                maxSources: 6,
            });
        } catch (error) {
            console.warn("learning source fetch failed", error);
            return persist("deferred", { ...leased.work, telemetry }, leased.resultIds, "no_fetchable_sources");
        }
        Object.assign(telemetry, {
            ...fetched.telemetry,
            version: 1,
        });

        let accumulatedSources;
        try {
            await insertLearningSources(context.env, fetched.sources);
            accumulatedSources = await listLearningSources(context.env, jobId, uid);
        } catch (error) {
            console.warn("learning source storage failed", error);
            return storageUnavailable(leased);
        }
        if (!accumulatedSources.length) {
            return persist("deferred", {
                ...leased.work,
                sourceIds: [],
                telemetry,
            }, leased.resultIds, fetched.telemetry.sourceBudgetExhausted
                ? "source_fetch_timeout"
                : "no_fetchable_sources");
        }
        return persist("verifying", {
            ...leased.work,
            sourceIds: accumulatedSources.map((source) => source.sourceId),
            currentNeed: leased.needs[0]?.claim.question,
            completedNeeds: 0,
            telemetry,
        }, leased.resultIds);
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
            if (completed >= leased!.needs.length) {
                try {
                    const items = await getKnowledgeItemsByIds(context.env, resultIds);
                    nextStatus = learningCompletionStatus(leased!.needs.length, items);
                } catch (error) {
                    console.warn("learning result read failed", error);
                    return storageUnavailable(leased);
                }
            }
            return persist(nextStatus, {
                ...work,
                completedNeeds: completed,
                currentNeed: leased!.needs[completed]?.claim.question,
                telemetry,
            }, resultIds, nextStatus === "deferred" ? "unresolved_knowledge_needs" : undefined);
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
            return storageUnavailable(leased);
        }
        const needSources = allSources.filter((source) => source.needId === need.id);
        if (!needSources.length) {
            telemetry.verificationFailures++;
            return advanceVerification(leased.resultIds, leased.work, index + 1);
        }

        const verificationAttemptsByNeed = { ...leased.work.verificationAttemptsByNeed };
        const previousAttempts = Math.max(0, Number(verificationAttemptsByNeed[need.id]) || 0);
        const verificationAttempt = Math.min(MAX_VERIFICATION_ATTEMPTS, previousAttempts + 1);
        verificationAttemptsByNeed[need.id] = verificationAttempt;

        const verified = await verifyKnowledgeNeed({ llm, need, sources: needSources });
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
            if (verified.retryable && verificationAttempt < MAX_VERIFICATION_ATTEMPTS) {
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
            }, leased.resultIds, verified.reasonCode);
        }

        telemetry.verificationCompleted++;
        if (verified.verification.verdict === "supported") telemetry.verificationSupported++;
        else if (verified.verification.verdict === "contradicted") telemetry.verificationContradicted++;
        else telemetry.verificationInsufficient++;

        const resultIds = leased.resultIds.slice();
        const verifications = leased.work.verifications?.slice() ?? [];
        verifications.push(verified.verification);
        try {
            const now = Date.now();
            const activation = decideKnowledgeStatus(need, verified.verification, needSources, now);
            const item = await createKnowledgeItem(context.env, {
                knowledgeId: knowledgeIdForLearningResult(jobId, index),
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
            });
            if (!resultIds.includes(item.knowledgeId)) resultIds.push(item.knowledgeId);
        } catch (error) {
            console.warn("learning knowledge persist failed", error);
            return storageUnavailable(leased);
        }

        return advanceVerification(resultIds, {
            ...leased.work,
            verifications,
            verificationAttemptsByNeed,
        }, index + 1);
    }

    return persist("failed", {
        ...leased.work,
        telemetry: normalizeLearningTelemetry(leased.work.telemetry),
    }, leased.resultIds, "internal_error");
};
