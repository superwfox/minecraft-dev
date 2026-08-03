import { getLearningEvidenceItems, getLatestLearningJobForTask } from "../../_lib/learning/store";
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
    if (!context.env.DB) return json({ items: [] });

    const job = await getLatestLearningJobForTask(context.env, taskId, uid);
    const ids = [...new Set([
        ...(job?.resultIds ?? []),
        ...(state.knowledgeUsed ?? []).map((item: any) => item.knowledgeId).filter(Boolean),
    ])] as string[];
    return json({ items: await getLearningEvidenceItems(context.env, ids) });
};
