import { learningSnapshot } from "../../_lib/learning/public";
import {
    getKnowledgeItemsByIds,
    getLatestLearningJobForTask,
    listLearningSources,
    LearningStoreUnavailableError,
} from "../../_lib/learning/store";
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
    const taskId = new URL(context.request.url).searchParams.get("taskId") || "";
    if (!taskId) return json({ error: "Missing taskId" }, 400);
    const raw = await getOwnedTask(context.env, taskId, uid);
    if (!raw) return json({ error: "Task not found" }, 404);
    const state = JSON.parse(raw);
    try {
        const job = await getLatestLearningJobForTask(context.env, taskId, uid);
        const ids = job?.resultIds?.length
            ? job.resultIds
            : (state.knowledgeUsed ?? []).map((item: any) => item.knowledgeId).filter(Boolean);
        const [items, sources] = await Promise.all([
            getKnowledgeItemsByIds(context.env, ids),
            job ? listLearningSources(context.env, job.jobId, uid) : Promise.resolve([]),
        ]);
        return json(learningSnapshot(job, items, sources.length));
    } catch (error) {
        if (!(error instanceof LearningStoreUnavailableError)) console.warn("learning status failed", error);
        return json(learningSnapshot(null, [], 0, {
            status: "deferred",
            message: "学习状态暂不可用，已按现有知识继续",
        }));
    }
};
