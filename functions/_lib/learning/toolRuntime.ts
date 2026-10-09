import { loadKnowledgeContext } from "./context";
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
import type { LearningJobRecord } from "./types";
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
    if (!result) {
        const jobId = typeof input.jobId === "string" ? input.jobId.trim() : "";
        let job: LearningJobRecord | null;
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
    return {
        status: "resolved",
        request,
        messages: modelLearningContinuation(request, toolResult),
        result: toolResult,
        knowledgeUsed: knowledge.used,
    };
}
