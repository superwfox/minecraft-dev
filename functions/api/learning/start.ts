import { partitionKnowledgeNeedsByApiContracts } from "../../_lib/apiContracts";
import { resolveLLM } from "../../_lib/llm";
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

export const onRequestPost: PagesFunction<Env> = async (context) => {
    const uid: string = (context.data as any)?.uid || "";
    let body: any = {};
    try { body = await context.request.json(); } catch { /* validated below */ }
    const taskId = typeof body.taskId === "string" ? body.taskId : "";
    const stage: LearningStage = body.stage === "fix" ? "fix" : "planner";
    if (!taskId) return json({ error: "Missing taskId" }, 400);

    const raw = await getOwnedTask(context.env, taskId, uid);
    if (!raw) return json({ error: "Task not found" }, 404);
    const state = JSON.parse(raw);

    const chosenPathId = typeof body.chosenPathId === "string" ? body.chosenPathId.trim() : "";
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
    } else {
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
    }
    const lookupKeys = learningLookupKeys(needs);

    if (!needs.length) {
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
                await putTaskState(context.env, taskId, state, 3600, uid);
            } catch (error) {
                console.warn("learning cache-hit task persistence failed", error);
                return storageUnavailable();
            }
            return json(snapshot);
        }

        const llm = await resolveLLM(context);
        if (!llm.canAutoLearn) {
            return json(learningSnapshot(null, active, 0, {
                status: "deferred",
                stage,
                reasonCode: llm.providerId === "glm"
                    ? "glm_auto_learning_disabled"
                    : "auto_learning_disabled",
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
                : baseLookupHash;
        const jobLookupHash = await bindLearningJobLookupHashToTaskFence(
            authorizationLookupHash,
            taskStateFence,
        );
        const job = await createOrGetLearningJob(context.env, {
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
                ...(active.length ? {
                    cachedKnowledgeIds: active.map((item) => item.knowledgeId),
                } : {}),
            },
            now,
        });
        return json(learningSnapshot(job, active, 0, active.length ? {
            message: `已复用 ${active.length} 条公共知识，继续查证 ${pendingNeeds.length} 个缺口`,
        } : undefined));
    } catch (error) {
        if (!(error instanceof LearningStoreUnavailableError)) console.warn("learning start failed", error);
        return storageUnavailable();
    }
};
