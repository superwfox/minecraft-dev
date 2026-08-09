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
    refreshLearningInactivity,
} from "../../_lib/learning/deadline";
import { normalizeLearningTelemetry } from "../../_lib/learning/debug";
import { learningJobAuthorizationFailure } from "../../_lib/learning/authorization";
import {
    containsSharedKnowledgeForbiddenTerm,
    sharedKnowledgeForbiddenTerms,
    unprovenSharedKnowledgeForbiddenTerms,
} from "../../_lib/learning/privacy";
import {
    learningCompletionStatus,
    learningKnowledgeIds,
    learningSnapshot,
} from "../../_lib/learning/public";
import {
    fetchLearningSources,
    learningNoSourcesReason,
    publicLearningCandidateUrl,
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
    ImplementationRecipeV1,
    KnowledgeNeed,
    LearningCandidate,
    LearningJobRecord,
    LearningJobStatus,
    LearningJobTelemetry,
    LearningNeedTriggerReason,
    LearningReasonCode,
    LearningSearchedSource,
    LearningSourceRecord,
    VerificationResult,
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
    let candidateUrlCount = 0;
    for (const candidate of result.candidates as LearningCandidate[]) {
        candidateUrlCount += candidateSources(candidate).length;
    }
    telemetry.candidateUrlCount = candidateUrlCount;
}

function candidateSources(candidate: LearningCandidate): Array<{ url: string; reason: string }> {
    if (Array.isArray(candidate.sources)) return candidate.sources;
    return Array.isArray(candidate.urls)
        ? candidate.urls.map((url) => ({
            url,
            reason: "旧版发现结果未记录该 URL 的搜索理由",
        }))
        : [];
}

function discoveredSources(candidates: LearningCandidate[]): LearningSearchedSource[] {
    return candidates.flatMap((candidate) => candidateSources(candidate).map((source) => ({
        needId: candidate.needId,
        url: publicLearningCandidateUrl(source.url),
        reason: source.reason.trim().replace(/\s+/g, " ").slice(0, 240)
            || "该候选未提供可用的搜索理由",
        status: "discovered" as const,
    })));
}

function applyEvidenceRelations(
    searchedSources: LearningSearchedSource[] | undefined,
    verification: VerificationResult,
): LearningSearchedSource[] {
    const relations = new Map<string, "supports" | "contradicts">();
    for (const evidence of verification.evidence) {
        const current = relations.get(evidence.sourceId);
        if (current !== "contradicts") relations.set(evidence.sourceId, evidence.relation);
    }
    return (searchedSources ?? []).map((source) => {
        if (!source.sourceId) return source;
        const relation = relations.get(source.sourceId);
        return relation ? { ...source, status: relation } : source;
    });
}

function learningReasonFor(
    need: KnowledgeNeed,
    recipe?: ImplementationRecipeV1,
): { code: LearningNeedTriggerReason; message: string } | null {
    const integrationKind = recipe?.integrationKind ?? need.integrationKind;
    const code = need.triggerReason ?? (
        integrationKind === "external_plugin"
            ? "external_plugin_contract"
            : integrationKind === "version_reflection"
                ? "reflection_contract"
                : integrationKind === "nms" || integrationKind === "craftbukkit"
                    ? "nms_version_sensitive"
                    : null
    );
    if (!code) return null;
    const messages: Record<LearningNeedTriggerReason, string> = {
        nms_version_sensitive: "目标 Minecraft 版本中的 NMS/CraftBukkit 接口需要公开来源核对",
        reflection_contract: "目标版本的 Spigot/Paper 反射契约需要公开来源核对",
        external_plugin_contract: "用户明确要求的第三方插件或 API 契约需要公开来源核对",
        persistent_diagnostic_gap: "普通修复后仍存在外部 API 或版本契约诊断缺口",
    };
    return { code, message: messages[code] };
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
    let forbiddenTerms: string[] = [];

    let current: LearningJobRecord | null = null;
    try {
        current = await getLearningJob(context.env, jobId, uid);
        if (!current || current.generationTaskId !== taskId) {
            return json({ error: "Learning job not found" }, 404);
        }
        forbiddenTerms = sharedKnowledgeForbiddenTerms({
            taskId,
            projectName: state.projectName,
            packageName: state.packageName,
            generatedFilePaths: Array.isArray(state.generatedFiles)
                ? state.generatedFiles
                    .map((file: any) => typeof file?.path === "string" ? file.path : "")
                    .filter(Boolean)
                : [],
            userPrompt: state.userPrompt,
            clarifyRounds: Array.isArray(state.clarifyRounds) ? state.clarifyRounds : [],
            externalDeps: Array.isArray(state.grade?.vector?.external_deps)
                ? state.grade.vector.external_deps.filter((value: unknown) => typeof value === "string")
                : [],
            knowledgeNeeds: current.needs,
        });
        if (current.revision !== expectedRevision) {
            return await conflictResponse(context.env, current, "revision");
        }
        const authorizationFailure = await learningJobAuthorizationFailure(state, current);
        if (authorizationFailure) {
            return json({
                error: "Learning job authorization is no longer current",
                reasonCode: authorizationFailure,
            }, 409);
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
        progressed = false,
    ): Promise<Response> => {
        try {
            const terminal = status === "ready" || status === "deferred" || status === "needs_review"
                || status === "failed" || status === "cancelled";
            let persistedWork = terminal && isLearningActiveStatus(leased!.status)
                ? { ...work, lastActiveStatus: leased!.status }
                : work;
            const persistedAt = Date.now();
            if (progressed) persistedWork = refreshLearningInactivity(persistedWork, persistedAt);
            const completed = await completeLearningJobStep(context.env, {
                jobId,
                ownerUid: uid,
                expectedRevision: leased!.revision,
                leaseToken,
                status,
                work: persistedWork,
                resultIds,
                error: reasonCode ?? "",
                taskStateFence: leased!.work.taskStateFence,
                now: persistedAt,
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

    const revalidateAuthorization = async (
        work: LearningJobRecord["work"],
        resultIds: string[] = leased!.resultIds,
    ): Promise<Response | null> => {
        try {
            const latestRaw = await getOwnedTask(context.env, taskId, uid);
            const latestState = latestRaw ? JSON.parse(latestRaw) : null;
            const reasonCode = latestState
                ? await learningJobAuthorizationFailure(latestState, leased!)
                : leased!.stage === "fix"
                    ? "fix_authorization_expired"
                    : "planner_authorization_expired";
            return reasonCode
                ? persist("deferred", work, resultIds, reasonCode)
                : null;
        } catch (error) {
            console.warn("learning authorization refresh failed", error);
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
        }, leased.resultIds, undefined, {}, true);
    }

    if (leased.status === "discovering") {
        const telemetry = normalizeLearningTelemetry(leased.work.telemetry);
        const discoveryBudget = learningStageBudget(leased, LEARNING_DISCOVERY_LIMIT_MS);
        if (discoveryBudget.budgetMs < LEARNING_MIN_OUTBOUND_MS) {
            return persist("deferred", { ...leased.work, telemetry }, leased.resultIds, "job_deadline");
        }

        let authorizationResponse = await revalidateAuthorization({ ...leased.work, telemetry });
        if (authorizationResponse) return authorizationResponse;

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

        authorizationResponse = await revalidateAuthorization({ ...leased.work, telemetry });
        if (authorizationResponse) return authorizationResponse;

        let quotaExhausted = false;
        try {
            quotaExhausted = await charge(discovery.usageEntries);
        } catch (error) {
            console.warn("learning discovery charge failed", error);
            return persist("deferred", { ...leased.work, telemetry }, leased.resultIds, "storage_unavailable");
        }
        authorizationResponse = await revalidateAuthorization({ ...leased.work, telemetry });
        if (authorizationResponse) return authorizationResponse;
        if (quotaExhausted) {
            return persist("deferred", { ...leased.work, telemetry }, leased.resultIds, "quota_exhausted");
        }
        if (discovery.ok === false) {
            const reasonCode = discovery.reasonCode === "discovery_timeout"
                && discoveryBudget.clippedByJobDeadline
                ? "job_deadline"
                : discovery.reasonCode;
            return persist("deferred", { ...leased.work, telemetry }, leased.resultIds, reasonCode);
        }

        const work = {
            ...leased.work,
            candidates: discovery.candidates,
            searchedSources: discoveredSources(discovery.candidates),
            telemetry,
        };
        return persist("fetching", work, leased.resultIds, undefined, {}, true);
    }

    if (leased.status === "fetching") {
        const telemetry = normalizeLearningTelemetry(leased.work.telemetry);
        const sourceBudget = learningStageBudget(leased, LEARNING_SOURCE_LIMIT_MS);
        if (sourceBudget.budgetMs < LEARNING_MIN_OUTBOUND_MS) {
            return persist("deferred", { ...leased.work, telemetry }, leased.resultIds, "job_deadline");
        }

        let authorizationResponse = await revalidateAuthorization({ ...leased.work, telemetry });
        if (authorizationResponse) return authorizationResponse;

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
            const reasonCode = error instanceof Error && error.message === "learning_candidate_bounds"
                ? "discovery_invalid_response"
                : learningJobNeedsFinalization(leased) ? "job_deadline" : "no_fetchable_sources";
            return persist("deferred", { ...leased.work, telemetry }, leased.resultIds, reasonCode);
        }
        Object.assign(telemetry, {
            ...fetched.telemetry,
            version: 1,
        });

        authorizationResponse = await revalidateAuthorization({ ...leased.work, telemetry });
        if (authorizationResponse) return authorizationResponse;

        const accumulatedSources = fetched.sources;
        const sourceEffects: LearningStepSideEffects = { sources: fetched.sources };
        const work = {
            ...leased.work,
            searchedSources: fetched.outcomes,
            sourceIds: accumulatedSources.map((source) => source.sourceId),
            telemetry,
        };
        if (!accumulatedSources.length) {
            const reasonCode = learningNoSourcesReason(
                fetched.telemetry,
                sourceBudget.clippedByJobDeadline,
            );
            return persist("deferred", work, leased.resultIds, reasonCode, sourceEffects, true);
        }
        return persist("verifying", {
            ...work,
            currentNeed: leased.needs[0]?.claim.question,
            completedNeeds: 0,
        }, leased.resultIds, undefined, sourceEffects, true);
    }

    if (leased.status === "verifying") {
        const telemetry = normalizeLearningTelemetry(leased.work.telemetry);
        const index = Math.max(0, Number(leased.work.completedNeeds) || 0);
        let authorizationResponse = await revalidateAuthorization({ ...leased.work, telemetry });
        if (authorizationResponse) return authorizationResponse;
        const advanceVerification = async (
            resultIds: string[],
            work: LearningJobRecord["work"],
            completedNeeds: number,
        ): Promise<Response> => {
            const completed = Math.min(leased!.needs.length, completedNeeds);
            let nextStatus: LearningJobStatus = "verifying";
            let reasonCode: LearningReasonCode | undefined;
            if (completed >= leased!.needs.length) {
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
            }, resultIds, reasonCode, {}, true);
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
        const verifierForbiddenTerms = unprovenSharedKnowledgeForbiddenTerms(
            forbiddenTerms,
            needSources,
        );
        if (containsSharedKnowledgeForbiddenTerm(need, verifierForbiddenTerms)) {
            telemetry.verificationFailures++;
            telemetry.verificationInvalidResponses++;
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

        authorizationResponse = await revalidateAuthorization({ ...leased.work, telemetry });
        if (authorizationResponse) return authorizationResponse;

        const verified = await verifyKnowledgeNeed({
            llm,
            need,
            sources: needSources,
            timeoutMs: verificationBudget.budgetMs,
            forbiddenTerms: verifierForbiddenTerms,
        });
        telemetry.verificationAttempts++;
        telemetry.verificationElapsedMs += verified.elapsedMs;
        authorizationResponse = await revalidateAuthorization({
            ...leased.work,
            verificationAttemptsByNeed,
            telemetry,
        });
        if (authorizationResponse) return authorizationResponse;
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
        authorizationResponse = await revalidateAuthorization({
            ...leased.work,
            verificationAttemptsByNeed,
            telemetry,
        });
        if (authorizationResponse) return authorizationResponse;

        if (verified.ok === false) {
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
                }, leased.resultIds, undefined, {}, true);
            }
            return persist("deferred", {
                ...leased.work,
                verificationAttemptsByNeed,
                telemetry,
            }, leased.resultIds, reasonCode);
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
        const learningReason = learningReasonFor(need, verified.verification.recipe);
        const payload = {
            claim: verified.verification.normalizedClaim ?? {},
            ...(learningReason ? { learningReason } : {}),
            ...(verified.verification.recipe ? { recipe: verified.verification.recipe } : {}),
        };
        const summary = verified.verification.runtimeSummary || need.claim.question;
        const citedSourceIds = new Set(
            verified.verification.evidence.map((item) => item.sourceId),
        );
        const commitForbiddenTerms = unprovenSharedKnowledgeForbiddenTerms(
            forbiddenTerms,
            needSources.filter((source) => citedSourceIds.has(source.sourceId)),
        );
        if (containsSharedKnowledgeForbiddenTerm({
            need,
            payload,
            summary,
        }, commitForbiddenTerms)) {
            telemetry.verificationFailures++;
            telemetry.verificationInvalidResponses++;
            return advanceVerification(leased.resultIds, {
                ...leased.work,
                verificationAttemptsByNeed,
            }, index + 1);
        }
        const knowledge: KnowledgeItemCreateInput & { knowledgeId: string } = {
            knowledgeId,
            kind: need.kind,
            lookupKey: knowledgeLookupKey(need),
            scope: need.scope,
            payload,
            summary,
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
            searchedSources: applyEvidenceRelations(
                leased.work.searchedSources,
                verified.verification,
            ),
            verifications,
            verificationAttemptsByNeed,
            completedNeeds,
            currentNeed: leased.needs[completedNeeds]?.claim.question,
            telemetry,
        }, resultIds, reasonCode, { knowledge }, true);
    }

    return persist("failed", {
        ...leased.work,
        telemetry: normalizeLearningTelemetry(leased.work.telemetry),
    }, leased.resultIds, "internal_error");
};
