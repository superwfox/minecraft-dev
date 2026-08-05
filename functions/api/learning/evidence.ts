import { learningKnowledgeIds } from "../../_lib/learning/public";
import { getLearningEvidenceItems, getLearningJob } from "../../_lib/learning/store";
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
    const url = new URL(context.request.url);
    const taskId = url.searchParams.get("taskId") || "";
    const jobId = url.searchParams.get("jobId") || "";
    const rawStage = url.searchParams.get("stage") || "";
    const rawRevision = url.searchParams.get("revision");
    if (!taskId) return json({ error: "Missing taskId" }, 400);

    const hasJobIdentity = !!jobId || !!rawStage || rawRevision !== null;
    const stage: LearningStage | "" = rawStage === "planner" || rawStage === "fix"
        ? rawStage
        : "";
    const revision = rawRevision === null ? 0 : Number(rawRevision);
    if (hasJobIdentity && (
        !/^[A-Za-z0-9_-]{1,100}$/.test(jobId)
        || !stage
        || !Number.isInteger(revision)
        || revision < 0
    )) {
        return json({ error: "Invalid learning evidence identity" }, 400);
    }

    const raw = await getOwnedTask(context.env, taskId, uid);
    if (!raw) return json({ error: "Task not found" }, 404);
    const state = JSON.parse(raw);
    if (!context.env.DB) return json({
        items: [],
        learningJobId: "",
        learningStage: "",
        learningStatus: "idle",
        learningRevision: 0,
    });

    const job = jobId ? await getLearningJob(context.env, jobId, uid) : null;
    if (jobId && (!job || job.generationTaskId !== taskId || job.stage !== stage)) {
        return json({ error: "Learning job not found" }, 404);
    }
    const ids = learningKnowledgeIds(
        job,
        (state.knowledgeUsed ?? []).map((item: any) => item.knowledgeId),
    );
    return json({
        items: await getLearningEvidenceItems(context.env, ids),
        learningJobId: job?.jobId ?? "",
        learningStage: job?.stage ?? "",
        learningStatus: job?.status ?? "idle",
        learningRevision: job?.revision ?? 0,
    });
};
