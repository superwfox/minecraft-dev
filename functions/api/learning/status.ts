import { learningJobAuthorizationFailure } from "../../_lib/learning/authorization";
import { learningKnowledgeIds, learningSnapshot } from "../../_lib/learning/public";
import {
    getKnowledgeItemsByIds,
    getLatestLearningJobForTask,
    getLearningJob,
    listLearningSources,
    LearningStoreUnavailableError,
} from "../../_lib/learning/store";
import type { LearningStage } from "../../_lib/learning/types";
import { getOwnedTask } from "../../_lib/taskStore";

interface Env {
    DB?: D1Database;
    TASKS: KVNamespace;
}

function json(value: unknown, status = 200): Response {
    return new Response(JSON.stringify(value), { status, headers: { "Content-Type": "application/json" } });
}

export const onRequestGet: PagesFunction<Env> = async (context) => {
    const uid: string = (context.data as any)?.uid || "";
    const params = new URL(context.request.url).searchParams;
    const taskId = params.get("taskId") || "";
    const jobId = params.get("jobId") || "";
    const stageParam = params.get("stage") || "";
    const stage: LearningStage | undefined = stageParam === "planner" || stageParam === "fix" || stageParam === "tool"
        ? stageParam
        : undefined;
    if (!taskId) return json({ error: "Missing taskId" }, 400);
    if (stageParam && !stage) return json({ error: "Invalid stage" }, 400);
    const raw = await getOwnedTask(context.env, taskId, uid);
    if (!raw) return json({ error: "Task not found" }, 404);
    const state = JSON.parse(raw);
    try {
        const job = jobId
            ? await getLearningJob(context.env, jobId, uid)
            : await getLatestLearningJobForTask(context.env, taskId, uid, stage);
        if (jobId && (!job || job.generationTaskId !== taskId || (stage && job.stage !== stage))) {
            return json({ error: "Learning job not found" }, 404);
        }
        if (job) {
            const authorizationFailure = await learningJobAuthorizationFailure(state, job);
            if (authorizationFailure) {
                return json({
                    error: "Learning job authorization is no longer current",
                    reasonCode: authorizationFailure,
                }, 404);
            }
        }
        const ids = learningKnowledgeIds(
            job,
            (state.knowledgeUsed ?? []).map((item: any) => item.knowledgeId),
        );
        const [items, sources] = await Promise.all([
            getKnowledgeItemsByIds(context.env, ids),
            job ? listLearningSources(context.env, job.jobId, uid) : Promise.resolve([]),
        ]);
        return json(learningSnapshot(job, items, sources.length));
    } catch (error) {
        if (!(error instanceof LearningStoreUnavailableError)) console.warn("learning status failed", error);
        return json({
            error: "Learning storage is temporarily unavailable",
            reasonCode: "storage_unavailable",
        }, 503);
    }
};
