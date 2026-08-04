import { discoverLearningSources } from "../../_lib/deepseekResponses";
import { resolveLLM } from "../../_lib/llm";
import { knowledgeLookupKey } from "../../_lib/learning/assessment";
import { learningCompletionStatus, learningSnapshot } from "../../_lib/learning/public";
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
import type { LearningJobRecord, LearningJobStatus } from "../../_lib/learning/types";
import { decideKnowledgeStatus, verifyKnowledgeNeed } from "../../_lib/learning/verification";
import { accumulateCost, type UsageBreakdown } from "../../_lib/quota";
import { getOwnedTask, markTaskQuotaExhausted } from "../../_lib/taskStore";

interface Env {
    DB?: D1Database;
    TASKS: KVNamespace;
    DEEPSEEK_API_KEY: string;
    DEEPSEEK_RESPONSES_WEB_SEARCH?: string;
}

function json(value: unknown, status = 200): Response {
    return new Response(JSON.stringify(value), { status, headers: { "Content-Type": "application/json" } });
}

async function snapshot(
    env: Env,
    job: LearningJobRecord,
    fallback?: Parameters<typeof learningSnapshot>[3],
) {
    const [items, sources] = await Promise.all([
        getKnowledgeItemsByIds(env, job.resultIds),
        listLearningSources(env, job.jobId, job.ownerUid),
    ]);
    return learningSnapshot(job, items, sources.length, fallback);
}

async function deferLearningJob(
    env: Env,
    job: LearningJobRecord,
    ownerUid: string,
    message: string,
    error: string,
) {
    const fallback = { status: "deferred" as const, message };
    try {
        const leaseToken = `lease_${crypto.randomUUID().replace(/-/g, "")}`;
        const leased = await acquireLearningJobLease(env, {
            jobId: job.jobId,
            ownerUid,
            expectedRevision: job.revision,
            leaseToken,
            leaseMs: 120_000,
        });
        if (!leased) return snapshot(env, job, fallback);
        const completed = await completeLearningJobStep(env, {
            jobId: job.jobId,
            ownerUid,
            expectedRevision: leased.revision,
            leaseToken,
            status: "deferred",
            work: leased.work,
            resultIds: leased.resultIds,
            error,
        });
        return snapshot(env, completed ?? job, fallback);
    } catch (deferError) {
        console.warn("learning job defer failed", deferError);
        return snapshot(env, job, fallback);
    }
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
    const current = await getLearningJob(context.env, jobId, uid);
    if (!current || current.generationTaskId !== taskId) return json({ error: "Learning job not found" }, 404);
    if (current.revision !== expectedRevision) return json(await snapshot(context.env, current), 409);
    if (["ready", "deferred", "needs_review", "failed", "cancelled"].includes(current.status)) {
        return json(await snapshot(context.env, current));
    }

    if (state.quotaExhausted) {
        return json(await deferLearningJob(
            context.env,
            current,
            uid,
            "当前任务额度已用尽，联网学习已停止",
            "quota_exhausted",
        ));
    }

    const llm = await resolveLLM(context);
    if (!llm.canAutoLearn || llm.providerId !== "deepseek") {
        return json(await deferLearningJob(
            context.env,
            current,
            uid,
            llm.providerId === "glm"
                ? "GLM BYOK 不触发自动联网学习，已按现有知识继续"
                : "站点未启用自动联网学习（需配置 DEEPSEEK_RESPONSES_WEB_SEARCH=true），已按现有知识继续",
            "auto_learning_unavailable",
        ));
    }

    const leaseToken = `lease_${crypto.randomUUID().replace(/-/g, "")}`;
    const leased = await acquireLearningJobLease(context.env, {
        jobId,
        ownerUid: uid,
        expectedRevision,
        leaseToken,
        leaseMs: 120_000,
    });
    if (!leased) {
        const latest = await getLearningJob(context.env, jobId, uid);
        return json(latest ? await snapshot(context.env, latest) : { error: "Learning job not found" }, 409);
    }

    const charge = async (model: string, usage?: UsageBreakdown): Promise<boolean> => {
        if (!usage) return false;
        const cost = await accumulateCost(context.env, uid, taskId, model, usage);
        if (cost.outOfQuota) await markTaskQuotaExhausted(context.env, taskId, uid);
        return cost.outOfQuota;
    };

    let recoveryStatus: LearningJobStatus = "deferred";
    let recoveryWork = leased.work;
    let recoveryResultIds = leased.resultIds;
    let recoveryError = "";
    let completed: LearningJobRecord | null = null;
    try {
        if (leased.status === "queued") {
            recoveryStatus = "discovering";
            recoveryWork = {
                ...leased.work,
                currentNeed: leased.needs[0]?.claim.question,
                completedNeeds: 0,
            };
            completed = await completeLearningJobStep(context.env, {
                jobId,
                ownerUid: uid,
                expectedRevision: leased.revision,
                leaseToken,
                status: recoveryStatus,
                work: recoveryWork,
                resultIds: recoveryResultIds,
            });
        } else if (leased.status === "discovering") {
            const discovery = await discoverLearningSources({
                apiKey: context.env.DEEPSEEK_API_KEY,
                needs: leased.needs,
            });
            const quotaExhausted = await charge(discovery.response.model, discovery.response.usage);
            recoveryStatus = quotaExhausted
                ? "deferred"
                : discovery.candidates.length ? "fetching" : "deferred";
            recoveryWork = { ...leased.work, candidates: discovery.candidates };
            recoveryError = quotaExhausted
                ? "quota_exhausted"
                : discovery.candidates.length ? "" : "no_candidate_sources";
            completed = await completeLearningJobStep(context.env, {
                jobId,
                ownerUid: uid,
                expectedRevision: leased.revision,
                leaseToken,
                status: recoveryStatus,
                work: recoveryWork,
                resultIds: recoveryResultIds,
                error: recoveryError,
            });
        } else if (leased.status === "fetching") {
            const fetched = await fetchLearningSources({
                jobId,
                needs: leased.needs,
                candidates: leased.work.candidates ?? [],
                maxSources: 6,
            });
            await insertLearningSources(context.env, fetched.sources);
            const accumulatedSources = await listLearningSources(context.env, jobId, uid);
            recoveryStatus = accumulatedSources.length ? "verifying" : "deferred";
            recoveryWork = {
                ...leased.work,
                sourceIds: accumulatedSources.map((source) => source.sourceId),
                currentNeed: leased.needs[0]?.claim.question,
                completedNeeds: 0,
            };
            recoveryError = accumulatedSources.length
                ? fetched.errors.join(";").slice(0, 1_000)
                : "no_fetchable_sources";
            completed = await completeLearningJobStep(context.env, {
                jobId,
                ownerUid: uid,
                expectedRevision: leased.revision,
                leaseToken,
                status: recoveryStatus,
                work: recoveryWork,
                resultIds: recoveryResultIds,
                error: recoveryError,
            });
        } else if (leased.status === "verifying") {
            const index = Math.max(0, Number(leased.work.completedNeeds) || 0);
            const need = leased.needs[index];
            const allSources = await listLearningSources(context.env, jobId, uid);
            const needSources = need ? allSources.filter((source) => source.needId === need.id) : [];
            const resultIds = leased.resultIds.slice();
            const verifications = leased.work.verifications?.slice() ?? [];
            let quotaExhausted = false;

            if (need && needSources.length) {
                const verified = await verifyKnowledgeNeed({ llm, need, sources: needSources });
                quotaExhausted = await charge(verified.model, verified.usage);
                verifications.push(verified.verification);
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
            }

            const completedNeeds = Math.min(leased.needs.length, index + 1);
            let nextStatus: LearningJobStatus = quotaExhausted ? "deferred" : "verifying";
            if (!quotaExhausted && completedNeeds >= leased.needs.length) {
                const items = await getKnowledgeItemsByIds(context.env, resultIds);
                nextStatus = learningCompletionStatus(leased.needs.length, items);
            }
            recoveryStatus = nextStatus;
            recoveryWork = {
                ...leased.work,
                verifications,
                completedNeeds,
                currentNeed: leased.needs[completedNeeds]?.claim.question,
            };
            recoveryResultIds = resultIds;
            recoveryError = quotaExhausted
                ? "quota_exhausted"
                : completedNeeds >= leased.needs.length && resultIds.length < leased.needs.length
                    ? "unresolved_knowledge_needs"
                    : "";
            completed = await completeLearningJobStep(context.env, {
                jobId,
                ownerUid: uid,
                expectedRevision: leased.revision,
                leaseToken,
                status: recoveryStatus,
                work: recoveryWork,
                resultIds: recoveryResultIds,
                error: recoveryError,
            });
        }
    } catch (error: any) {
        console.warn("learning step failed", error);
        completed = await completeLearningJobStep(context.env, {
            jobId,
            ownerUid: uid,
            expectedRevision: leased.revision,
            leaseToken,
            status: recoveryStatus,
            work: recoveryWork,
            resultIds: recoveryResultIds,
            error: (recoveryError || String(error?.message || error)).slice(0, 1_000),
        });
    }

    if (!completed) {
        const latest = await getLearningJob(context.env, jobId, uid);
        return json(latest ? await snapshot(context.env, latest) : { error: "Learning step conflict" }, 409);
    }

    return json(await snapshot(context.env, completed));
};
