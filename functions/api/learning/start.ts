import { partitionKnowledgeNeedsByApiContracts } from "../../_lib/apiContracts";
import { deepSeekKeyRequiredResponse, resolveTaskLLM } from "../../_lib/llm";
import { createLearningDeadlineAt, LEARNING_JOB_BUDGET_MS } from "../../_lib/learning/deadline";
import {
    assessKnowledgeNeeds,
    deduplicateKnowledgeNeeds,
    filterFixKnowledgeNeeds,
    knowledgeLookupKey,
    learningLookupHash,
    learningLookupKeys,
} from "../../_lib/learning/assessment";
import { mergeKnowledgeUsed } from "../../_lib/learning/context";
import { bindLearningJobLookupHashToTaskFence } from "../../_lib/learning/authorization";
import {
    currentFixLearningAuthorization,
    sameFixLearningAuthorization,
    type FixLearningAuthorization,
} from "../../_lib/learning/fixAuthorization";
import {
    assessPlannerLearningAuthorization,
    type PlannerLearningAuthorization,
} from "../../_lib/learning/plannerAuthorization";
import { learningSnapshot } from "../../_lib/learning/public";
import { normalizeLearningTelemetry } from "../../_lib/learning/debug";
import {
    currentModelLearningAuthorization,
    getModelLearningRequest,
    isAllowedModelLearningNeed,
    modelLearningAllowedPublicTerms,
    setModelLearningRequestResult,
    type ModelLearningRequest,
} from "../../_lib/learning/tool";
import {
    containsSharedKnowledgeForbiddenTerm,
    sharedKnowledgeForbiddenTerms,
} from "../../_lib/learning/privacy";
import {
    createOrGetLearningJob,
    findActiveKnowledge,
    LearningStoreUnavailableError,
} from "../../_lib/learning/store";
import type { KnowledgeNeed, LearningStage } from "../../_lib/learning/types";
import { getOwnedTask, putTaskState, taskOperationLeaseFromState } from "../../_lib/taskStore";

interface Env {
    DB?: D1Database;
    TASKS: KVNamespace;
    DEEPSEEK_API_KEY: string;
    DEEPSEEK_RESPONSES_WEB_SEARCH?: string;
}

function json(value: unknown, status = 200): Response {
    return new Response(JSON.stringify(value), { status, headers: { "Content-Type": "application/json" } });
}

function storageUnavailable(): Response {
    return json({
        error: "Learning storage is temporarily unavailable",
        reasonCode: "storage_unavailable",
    }, 503);
}

function isRetryableByokTerminal(job: Awaited<ReturnType<typeof createOrGetLearningJob>>): boolean {
    if (job.status !== "deferred" && job.status !== "failed") return false;
    if (job.error === "quota_exhausted") return true;
    const telemetry = normalizeLearningTelemetry(job.work.telemetry);
    return (job.error === "discovery_http" && telemetry.discoveryLastHttpStatus === 401)
        || (job.error === "verification_http" && (
            telemetry.verificationLastHttpStatus === 401
            // 兼容尚未记录精确 verifier HTTP 状态的旧终态。
            || (!telemetry.verificationLastHttpStatus && telemetry.verificationHttp4xx > 0)
        ));
}

export const onRequestPost: PagesFunction<Env> = async (context) => {
    const uid: string = (context.data as any)?.uid || "";
    let body: any = {};
    try { body = await context.request.json(); } catch { /* validated below */ }
    const taskId = typeof body.taskId === "string" ? body.taskId : "";
    const stage: LearningStage | null = body.stage === "planner"
        || body.stage === "fix"
        || body.stage === "tool"
        ? body.stage
        : null;
    if (!taskId) return json({ error: "Missing taskId" }, 400);
    if (!stage) return json({ error: "Invalid learning stage" }, 400);

    const raw = await getOwnedTask(context.env, taskId, uid);
    if (!raw) return json({ error: "Task not found" }, 404);
    const state = JSON.parse(raw);

    const chosenPathId = typeof body.chosenPathId === "string" ? body.chosenPathId.trim() : "";
    const toolRequestId = typeof body.toolRequestId === "string" ? body.toolRequestId.trim() : "";
    let toolRequest: ModelLearningRequest | null = null;
    if (stage === "tool") {
        toolRequest = getModelLearningRequest(state, toolRequestId);
        if (!toolRequest) {
            return json({
                error: "Model learning tool request is no longer current",
                reasonCode: "tool_authorization_expired",
            }, 409);
        }
    }
    let pathSelectionChanged = false;
    if (stage === "planner") {
        const paths = Array.isArray(state.grade?.paths) ? state.grade.paths : [];
        const validChosenPath = !!chosenPathId && paths.some((path: any) => path?.id === chosenPathId);
        if (state.grade?.gateRequired && !chosenPathId) {
            return json({ error: "Missing chosenPathId", code: "PATH_NOT_CONFIRMED" }, 400);
        }
        if (chosenPathId && !validChosenPath) return json({ error: "Invalid chosenPathId" }, 400);
        if (chosenPathId && state.grade?.chosenPathId !== chosenPathId) {
            state.grade.chosenPathId = chosenPathId;
            pathSelectionChanged = true;
        }
    }

    const requestedFixAuthorization = body.fixAuthorization as FixLearningAuthorization | undefined;
    const fixAuthorization = stage === "fix" ? currentFixLearningAuthorization(state) : null;
    if (stage === "fix" && !sameFixLearningAuthorization(
        fixAuthorization,
        requestedFixAuthorization,
    )) {
        return json({
            error: "Fix learning authorization is no longer current",
            reasonCode: "fix_authorization_expired",
        }, 409);
    }

    if (pathSelectionChanged) {
        try {
            await putTaskState(context.env, taskId, state, 3600, uid);
        } catch (error) {
            console.warn("learning path selection persistence failed", error);
            return storageUnavailable();
        }
    }

    const externalDeps = Array.isArray(state.grade?.vector?.external_deps)
        ? state.grade.vector.external_deps
        : [];
    let needs: KnowledgeNeed[] = [];
    let contractCoveredCount = 0;
    let plannerAuthorization: PlannerLearningAuthorization | undefined;
    let toolAuthorization: { requestId: string; needsFingerprint: string } | undefined;
    if (stage === "planner") {
        const plannerAssessment = await assessPlannerLearningAuthorization(state);
        if (!plannerAssessment) {
            return json({
                error: "Planner learning authorization is no longer current",
                reasonCode: "planner_authorization_expired",
            }, 409);
        }
        needs = plannerAssessment.needs;
        contractCoveredCount = plannerAssessment.coveredCount;
        plannerAuthorization = plannerAssessment.authorization;
    } else if (stage === "fix") {
        const assessment = assessKnowledgeNeeds(state.fixKnowledgeNeeds, {
            coreType: state.coreType,
            mcVersion: state.version,
        });
        const eligibleNeeds = filterFixKnowledgeNeeds(assessment.accepted, {
            repairAttempts: state.repairAttempts,
        }).accepted;
        const contractCoverage = partitionKnowledgeNeedsByApiContracts({
            coreType: state.coreType,
            version: state.version,
            externalDeps,
            generatedFiles: Array.isArray(state.generatedFiles)
                ? state.generatedFiles
                    .filter((file: any) => file && typeof file.path === "string")
                    .map((file: any) => ({
                        path: file.path,
                        content: typeof file.content === "string" ? file.content : undefined,
                    }))
                : [],
        }, eligibleNeeds);
        needs = deduplicateKnowledgeNeeds(contractCoverage.uncovered);
        contractCoveredCount = contractCoverage.covered.length;
    } else {
        const assessment = assessKnowledgeNeeds(toolRequest?.needs, {
            coreType: state.coreType,
            mcVersion: state.version,
        });
        if (!toolRequest
            || assessment.accepted.length !== toolRequest.needs.length
            || assessment.rejected.length > 0
            || assessment.accepted.some((need) => !isAllowedModelLearningNeed(need, externalDeps))) {
            setModelLearningRequestResult(state, toolRequestId, {
                status: "deferred",
                reasonCode: "tool_request_invalid",
            });
            try { await putTaskState(context.env, taskId, state, 3600, uid); }
            catch { return storageUnavailable(); }
            return json(learningSnapshot(null, [], 0, {
                status: "deferred",
                stage,
                reasonCode: "tool_request_invalid",
            }));
        }
        const allowedDependencyTerms = sharedKnowledgeForbiddenTerms({ externalDeps });
        const allowedToolTerms = new Set([
            ...allowedDependencyTerms,
            ...modelLearningAllowedPublicTerms(assessment.accepted),
        ]);
        const identityTerms = sharedKnowledgeForbiddenTerms({
            taskId,
            projectName: state.projectName,
            packageName: state.packageName,
            generatedFilePaths: Array.isArray(state.generatedFiles)
                ? state.generatedFiles.map((file: any) => typeof file?.path === "string" ? file.path : "").filter(Boolean)
                : [],
            clarifyRounds: Array.isArray(state.clarifyRounds) ? state.clarifyRounds : [],
        });
        const promptTerms = sharedKnowledgeForbiddenTerms({ userPrompt: state.userPrompt })
            .filter((term) => !allowedToolTerms.has(term));
        const privateTerms = [...new Set([...identityTerms, ...promptTerms])];
        if (containsSharedKnowledgeForbiddenTerm(assessment.accepted, privateTerms)) {
            setModelLearningRequestResult(state, toolRequestId, {
                status: "deferred",
                reasonCode: "tool_request_invalid",
            });
            try { await putTaskState(context.env, taskId, state, 3600, uid); }
            catch { return storageUnavailable(); }
            return json(learningSnapshot(null, [], 0, {
                status: "deferred",
                stage,
                reasonCode: "tool_request_invalid",
            }));
        }
        const contractCoverage = partitionKnowledgeNeedsByApiContracts({
            coreType: state.coreType,
            version: state.version,
            externalDeps,
            generatedFiles: Array.isArray(state.generatedFiles) ? state.generatedFiles : [],
        }, assessment.accepted);
        needs = deduplicateKnowledgeNeeds(contractCoverage.uncovered);
        contractCoveredCount = contractCoverage.covered.length;
        toolAuthorization = currentModelLearningAuthorization(state, toolRequestId) ?? undefined;
        if (!toolAuthorization) {
            return json({
                error: "Model learning tool request is no longer current",
                reasonCode: "tool_authorization_expired",
            }, 409);
        }
    }
    const lookupKeys = learningLookupKeys(needs);

    if (!needs.length) {
        if (stage === "tool") {
            setModelLearningRequestResult(state, toolRequestId, {
                status: "ready",
                reasonCode: contractCoveredCount ? "static_contract_covered" : "no_learning_needed",
            });
            try { await putTaskState(context.env, taskId, state, 3600, uid); }
            catch { return storageUnavailable(); }
        }
        return json(learningSnapshot(null, [], 0, {
            status: "ready",
            stage,
            reasonCode: contractCoveredCount
                ? "static_contract_covered"
                : "no_learning_needed",
            message: contractCoveredCount
                ? `已有静态 API 契约覆盖 ${contractCoveredCount} 个技术缺口，无需联网查证`
                : undefined,
        }));
    }

    try {
        const active = await findActiveKnowledge(context.env, lookupKeys);
        const activeKeys = new Set(active.map((item) => item.lookupKey));
        const pendingNeeds = needs.filter((need) => !activeKeys.has(knowledgeLookupKey(need)));
        if (!pendingNeeds.length) {
            const snapshot = learningSnapshot(null, active, 0, {
                status: "ready",
                stage,
                reasonCode: "knowledge_cache_hit",
                message: `已复用 ${active.length} 条经过验证的公共知识`,
            });
            try {
                state.knowledgeUsed = mergeKnowledgeUsed(state.knowledgeUsed, active);
                if (stage === "tool") {
                    setModelLearningRequestResult(state, toolRequestId, {
                        status: "ready",
                        reasonCode: "knowledge_cache_hit",
                    });
                }
                await putTaskState(context.env, taskId, state, 3600, uid);
            } catch (error) {
                console.warn("learning cache-hit task persistence failed", error);
                return storageUnavailable();
            }
            return json(snapshot);
        }

        const llm = await resolveTaskLLM(context, state);
        if (!llm) return deepSeekKeyRequiredResponse();

        if (state.quotaExhausted && !llm.byok) {
            if (stage === "tool") {
                state.knowledgeUsed = mergeKnowledgeUsed(state.knowledgeUsed, active);
                setModelLearningRequestResult(state, toolRequestId, {
                    status: "deferred",
                    reasonCode: "quota_exhausted",
                });
                try { await putTaskState(context.env, taskId, state, 3600, uid); }
                catch { return storageUnavailable(); }
            }
            return json(learningSnapshot(null, active, 0, {
                status: "deferred",
                stage,
                reasonCode: "quota_exhausted",
            }));
        }

        if (!llm.canAutoLearn) {
            const reasonCode = llm.providerId === "glm"
                ? "glm_auto_learning_disabled" as const
                : "auto_learning_disabled" as const;
            if (stage === "tool") {
                setModelLearningRequestResult(state, toolRequestId, {
                    status: "deferred",
                    reasonCode,
                });
                try { await putTaskState(context.env, taskId, state, 3600, uid); }
                catch { return storageUnavailable(); }
            }
            return json(learningSnapshot(null, active, 0, {
                status: "deferred",
                stage,
                reasonCode,
                message: llm.providerId === "deepseek"
                    ? "站点未启用自动联网学习（需配置 DEEPSEEK_RESPONSES_WEB_SEARCH=true），已按现有知识继续"
                    : undefined,
            }));
        }

        const taskStateFence = taskOperationLeaseFromState(state)?.token || "";
        if (!taskStateFence) return storageUnavailable();
        const now = Date.now();
        const baseLookupHash = await learningLookupHash(pendingNeeds);
        const authorizationLookupHash = fixAuthorization
            ? `${baseLookupHash}.${fixAuthorization.runId}.${fixAuthorization.previousRunId}.${fixAuthorization.diagnosticsFingerprint}.${fixAuthorization.repairAttempts}`
            : plannerAuthorization
                ? `${baseLookupHash}.${plannerAuthorization.needsFingerprint}.${plannerAuthorization.chosenPathId || "global"}`
                : toolAuthorization
                    ? `${baseLookupHash}.${toolAuthorization.requestId}.${toolAuthorization.needsFingerprint}`
                    : baseLookupHash;
        const jobLookupHash = await bindLearningJobLookupHashToTaskFence(
            authorizationLookupHash,
            taskStateFence,
        );
        const jobInput = {
            ownerUid: uid,
            generationTaskId: taskId,
            stage,
            lookupHash: jobLookupHash,
            needs: pendingNeeds,
            work: {
                lastProgressAt: now,
                inactivityDeadlineAt: createLearningDeadlineAt(now, LEARNING_JOB_BUDGET_MS),
                taskStateFence,
                ...(plannerAuthorization ? { plannerAuthorization } : {}),
                ...(fixAuthorization ? { fixAuthorization } : {}),
                ...(toolAuthorization ? { toolAuthorization } : {}),
                ...(active.length ? {
                    cachedKnowledgeIds: active.map((item) => item.knowledgeId),
                } : {}),
            },
            now,
        };
        let job = await createOrGetLearningJob(context.env, jobInput);
        // 旧任务可能已因平台额度耗尽进入终态。DeepSeek BYOK 改用独立重试键，
        // 让用户换成自己的 key 后继续，同时保留旧任务的审计记录。
        if (llm.byok && isRetryableByokTerminal(job)) {
            const retryLookupHash = llm.credentialId
                ? `${jobLookupHash}.deepseek_byok.${llm.credentialId}`
                : `${jobLookupHash}.deepseek_byok`;
            job = await createOrGetLearningJob(context.env, {
                ...jobInput,
                lookupHash: retryLookupHash,
            });
        }
        return json(learningSnapshot(job, active, 0, active.length ? {
            message: `已复用 ${active.length} 条公共知识，继续查证 ${pendingNeeds.length} 个缺口`,
        } : undefined));
    } catch (error) {
        if (!(error instanceof LearningStoreUnavailableError)) console.warn("learning start failed", error);
        return storageUnavailable();
    }
};
