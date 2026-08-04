import { partitionKnowledgeNeedsByApiContracts } from "../../_lib/apiContracts";
import { resolveLLM } from "../../_lib/llm";
import {
    assessKnowledgeNeeds,
    deduplicateKnowledgeNeeds,
    knowledgeLookupKey,
    learningLookupHash,
    learningLookupKeys,
} from "../../_lib/learning/assessment";
import { learningSnapshot } from "../../_lib/learning/public";
import {
    createOrGetLearningJob,
    findActiveKnowledge,
    LearningStoreUnavailableError,
} from "../../_lib/learning/store";
import type { LearningStage } from "../../_lib/learning/types";
import { getOwnedTask } from "../../_lib/taskStore";

interface Env {
    DB?: D1Database;
    TASKS: KVNamespace;
    DEEPSEEK_API_KEY: string;
    DEEPSEEK_RESPONSES_WEB_SEARCH?: string;
}

function json(value: unknown, status = 200): Response {
    return new Response(JSON.stringify(value), { status, headers: { "Content-Type": "application/json" } });
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
    if (chosenPathId && state.grade?.gateRequired) {
        const valid = Array.isArray(state.grade.paths)
            && state.grade.paths.some((path: any) => path?.id === chosenPathId);
        if (!valid) return json({ error: "Invalid chosenPathId" }, 400);
    }

    const rawNeeds = stage === "fix"
        ? state.fixKnowledgeNeeds
        : state.grade?.knowledgeNeeds ?? state.knowledgeNeeds;
    const assessment = assessKnowledgeNeeds(rawNeeds, {
        coreType: state.coreType,
        mcVersion: state.version,
    });
    const contractCoverage = partitionKnowledgeNeedsByApiContracts({
        coreType: state.coreType,
        version: state.version,
        externalDeps: Array.isArray(state.grade?.vector?.external_deps)
            ? state.grade.vector.external_deps
            : [],
        generatedFiles: Array.isArray(state.generatedFiles)
            ? state.generatedFiles
                .filter((file: any) => file && typeof file.path === "string")
                .map((file: any) => ({
                    path: file.path,
                    content: typeof file.content === "string" ? file.content : undefined,
                }))
            : [],
    }, assessment.accepted);
    const needs = deduplicateKnowledgeNeeds(contractCoverage.uncovered);
    const lookupKeys = learningLookupKeys(needs);

    if (!needs.length) {
        return json(learningSnapshot(null, [], 0, {
            status: "ready",
            reasonCode: contractCoverage.covered.length
                ? "static_contract_covered"
                : "no_learning_needed",
            message: contractCoverage.covered.length
                ? `已有静态 API 契约覆盖 ${contractCoverage.covered.length} 个技术缺口，无需联网查证`
                : undefined,
        }));
    }

    try {
        const active = await findActiveKnowledge(context.env, lookupKeys);
        const activeKeys = new Set(active.map((item) => item.lookupKey));
        const pendingNeeds = needs.filter((need) => !activeKeys.has(knowledgeLookupKey(need)));
        if (!pendingNeeds.length) {
            return json(learningSnapshot(null, active, 0, {
                status: "ready",
                reasonCode: "knowledge_cache_hit",
                message: `已复用 ${active.length} 条经过验证的公共知识`,
            }));
        }

        const llm = await resolveLLM(context);
        if (!llm.canAutoLearn) {
            return json(learningSnapshot(null, active, 0, {
                status: "deferred",
                reasonCode: llm.providerId === "glm"
                    ? "glm_auto_learning_disabled"
                    : "auto_learning_disabled",
                message: llm.providerId === "deepseek"
                    ? "站点未启用自动联网学习（需配置 DEEPSEEK_RESPONSES_WEB_SEARCH=true），已按现有知识继续"
                    : undefined,
            }));
        }

        const job = await createOrGetLearningJob(context.env, {
            ownerUid: uid,
            generationTaskId: taskId,
            stage,
            lookupHash: await learningLookupHash(pendingNeeds),
            needs: pendingNeeds,
            work: active.length ? {
                cachedKnowledgeIds: active.map((item) => item.knowledgeId),
            } : undefined,
        });
        return json(learningSnapshot(job, active, 0, active.length ? {
            message: `已复用 ${active.length} 条公共知识，继续查证 ${pendingNeeds.length} 个缺口`,
        } : undefined));
    } catch (error) {
        if (!(error instanceof LearningStoreUnavailableError)) console.warn("learning start failed", error);
        return json(learningSnapshot(null, [], 0, {
            status: "deferred",
            reasonCode: "storage_unavailable",
        }), 503);
    }
};
