import { learningKnowledgeIds } from "../../_lib/learning/public";
import { publicLearningCandidateUrl } from "../../_lib/learning/sourceFetch";
import { getLearningEvidenceItems, getLearningJob } from "../../_lib/learning/store";
import type {
    LearningJobRecord,
    LearningSourceRejectionCode,
    LearningStage,
    LearningSearchedSourceStatus,
    PublicLearningEvidenceSnapshot,
    PublicLearningSearchedSource,
} from "../../_lib/learning/types";
import { getOwnedTask } from "../../_lib/taskStore";

interface Env {
    DB?: D1Database;
    TASKS: KVNamespace;
}

function json(value: unknown, status = 200): Response {
    return new Response(JSON.stringify(value), { status, headers: { "Content-Type": "application/json" } });
}

const SEARCHED_SOURCE_STATUSES = new Set<LearningSearchedSourceStatus>([
    "discovered",
    "fetched",
    "supports",
    "contradicts",
    "rejected",
    "skipped",
]);
const SOURCE_REJECTION_CODES = new Set<LearningSourceRejectionCode>([
    "invalid_url",
    "timeout",
    "http_4xx",
    "http_5xx",
    "too_large",
    "unsupported_type",
    "too_thin",
    "duplicate",
    "budget_exhausted",
    "source_limit",
]);

function safeText(value: unknown, max: number): string {
    return typeof value === "string"
        ? value.replace(/[\x00-\x08\x0b\x0c\x0e-\x1f]/g, " ").replace(/\s+/g, " ").trim().slice(0, max)
        : "";
}

function searchedSources(job: LearningJobRecord | null): PublicLearningSearchedSource[] {
    if (!job || !Array.isArray(job.work.searchedSources)) return [];
    const questions = new Map(job.needs.map((need) => [need.id, need.claim.question]));
    return job.work.searchedSources.flatMap((source) => {
        if (!source || typeof source !== "object") return [];
        const status = SEARCHED_SOURCE_STATUSES.has(source.status)
            ? source.status
            : undefined;
        if (!status) return [];
        const rejectionCode = source.rejectionCode
            && SOURCE_REJECTION_CODES.has(source.rejectionCode)
            ? source.rejectionCode
            : undefined;
        const projected: PublicLearningSearchedSource = {
            needId: safeText(source.needId, 100),
            question: safeText(questions.get(source.needId), 500),
            url: publicLearningCandidateUrl(source.url),
            canonicalUrl: source.canonicalUrl
                ? publicLearningCandidateUrl(source.canonicalUrl)
                : undefined,
            reason: safeText(source.reason, 240) || "该候选未提供可用的搜索理由",
            status,
            ...(rejectionCode ? { rejectionCode } : {}),
            title: safeText(source.title, 300),
            sourceType: safeText(source.sourceType, 80) || "unclassified",
            authority: safeText(source.authority, 80) || "unclassified",
        };
        return [projected];
    });
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
        searchedSources: [],
        learningJobId: "",
        learningStage: "",
        learningStatus: "idle",
        learningRevision: 0,
    } satisfies PublicLearningEvidenceSnapshot);

    const job = jobId ? await getLearningJob(context.env, jobId, uid) : null;
    if (jobId && (!job || job.generationTaskId !== taskId || job.stage !== stage)) {
        return json({ error: "Learning job not found" }, 404);
    }
    const ids = learningKnowledgeIds(
        job,
        (state.knowledgeUsed ?? []).map((item: any) => item.knowledgeId),
    );
    const snapshot: PublicLearningEvidenceSnapshot = {
        items: await getLearningEvidenceItems(context.env, ids),
        searchedSources: searchedSources(job),
        learningJobId: job?.jobId ?? "",
        learningStage: job?.stage ?? "",
        learningStatus: job?.status ?? "idle",
        learningRevision: job?.revision ?? 0,
    };
    return json(snapshot);
};
