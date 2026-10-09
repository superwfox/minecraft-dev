import { buildKnowledgeContext, loadKnowledgeContext } from "./context";
import { compileNegativeEvidence, currentCompileApiEvidence } from "./compileApiEvidence";
import { loadLearningNegativeFacts, loadNegativeNeedCache, negativeFactsUsed } from "./negativeLearning";
import { knowledgeLookupKey } from "./assessment";
import { negativeApiFactsContext } from "./negativeApiFacts";
import { learningJobAuthorizationFailure } from "./authorization";
import { normalizeLearningReasonCode } from "./debug";
import { getLatestLearningJobForTask, getLearningJob } from "./store";
import {
    getModelLearningRequest,
    modelLearningContinuation,
    type ModelChatMessage,
    type ModelLearningRequest,
    type ModelLearningToolResult,
} from "./tool";
import type { LearningJobRecord, NegativeFactUsed } from "./types";
import { learningJobTiming } from "./deadline";

interface Env {
    DB?: D1Database;
    TASKS: KVNamespace;
}

const TERMINAL_STATUSES = new Set<LearningJobRecord["status"]>([
    "ready", "deferred", "needs_review", "failed", "cancelled",
]);

export type ModelLearningResolution =
    | {
        status: "missing";
        request: null;
    }
    | {
        status: "pending";
        request: ModelLearningRequest;
        jobDeadlineAt?: number;
    }
    | {
        status: "resolved";
        request: ModelLearningRequest;
        messages: ModelChatMessage[];
        result: ModelLearningToolResult;
        knowledgeUsed: Awaited<ReturnType<typeof loadKnowledgeContext>>["used"];
        negativeFactsUsed: NegativeFactUsed[];
    };

export async function resolveModelLearningRequest(input: {
    env: Env;
    state: any;
    uid: string;
    taskId: string;
    requestId: string;
    jobId?: string;
    maxCharacters?: number;
}): Promise<ModelLearningResolution> {
    const request = getModelLearningRequest(input.state, input.requestId);
    if (!request) return { status: "missing", request: null };

    let result = request.result;
    let job: LearningJobRecord | null = null;
    if (!result) {
        const jobId = typeof input.jobId === "string" ? input.jobId.trim() : "";
        try {
            job = jobId ? await getLearningJob(input.env, jobId, input.uid)
                : await getLatestLearningJobForTask(input.env, input.taskId, input.uid, "tool");
        } catch {
            return { status: "pending", request };
        }
        if (!job
            || job.generationTaskId !== input.taskId
            || job.stage !== "tool"
            || job.work.toolAuthorization?.requestId !== request.requestId
            || await learningJobAuthorizationFailure(input.state, job)) {
            return { status: "pending", request };
        }
        if (!TERMINAL_STATUSES.has(job.status)) return { status: "pending", request, jobDeadlineAt: learningJobTiming(job).deadlineAt };
        result = {
            status: job.status as ModelLearningToolResult["status"],
            reasonCode: normalizeLearningReasonCode(
                job.error,
                job.status === "deferred" || job.status === "failed" || job.status === "cancelled"
                    ? "internal_error"
                    : undefined,
            ),
        };
    }

    const knowledge = await loadKnowledgeContext({
        env: input.env,
        needs: request.needs,
        maxCharacters: Math.max(1_000, Math.min(8_000, input.maxCharacters ?? 6_000)),
        title: "模型主动调用 Learning 后取得的已验证公共技术知识",
    });
    const toolResult: ModelLearningToolResult = {
        status: result.status,
        reasonCode: result.reasonCode,
        knowledgeContext: knowledge.context,
    };
    const evidence = await currentCompileApiEvidence(input.state);
    const negatives = job
        ? await loadLearningNegativeFacts(input.env, job, input.state, knowledge.used)
        : await loadNegativeNeedCache(input.env, input.state, request.needs, knowledge.used);
    const expectedNegatives = result.negativeResultIds ?? job?.work.negativeResultIds ?? {};
    if (toolResult.status === "ready" && Object.values(expectedNegatives).some(id => !negatives.some(fact => fact.factId === id))) {
        toolResult.status = "deferred";
        toolResult.reasonCode = "unresolved_knowledge_needs";
    }
    if (evidence) {
        const absentKeys = new Set(request.needs.filter(need => compileNegativeEvidence(need, evidence))
            .map(knowledgeLookupKey));
        knowledge.used = knowledge.used.filter(item => !absentKeys.has(item.lookupKey));
        toolResult.knowledgeContext = [buildKnowledgeContext(knowledge.used, input.maxCharacters ?? 6_000).context,
            negativeApiFactsContext(negatives)].filter(Boolean).join("\n\n");
    }
    return {
        status: "resolved",
        request,
        messages: modelLearningContinuation(request, toolResult),
        result: toolResult,
        knowledgeUsed: knowledge.used,
        negativeFactsUsed: negativeFactsUsed(negatives, job?.work.cachedNegativeFactIds ?? Object.values(result.negativeResultIds ?? {})),
    };
}
