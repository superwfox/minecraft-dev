import type {
    KnowledgeItemRecord,
    KnowledgeUsed,
    LearningJobRecord,
    LearningProgress,
} from "./types";

const STATUS_MESSAGES: Record<LearningJobRecord["status"], string> = {
    queued: "准备查证技术资料",
    discovering: "正在发现权威来源",
    fetching: "正在抓取并整理证据",
    verifying: "正在交叉验证技术结论",
    ready: "技术证据已准备完成",
    deferred: "联网学习未完成，已按现有知识继续",
    needs_review: "发现的新知识正在等待审核，本次未采用",
    failed: "联网学习失败，已按现有知识继续",
    cancelled: "联网学习已取消",
};

export interface PublicLearningSnapshot {
    learningProgress: LearningProgress;
    knowledgeUsed: KnowledgeUsed[];
    learningDeferred: boolean;
}

function publicStatus(item: KnowledgeItemRecord): KnowledgeUsed["status"] {
    if (item.status === "active") return "active";
    if (item.status === "needs_review") return "needs_review";
    return "skipped";
}

export function learningCompletionStatus(
    totalNeeds: number,
    items: Pick<KnowledgeItemRecord, "status">[],
): LearningJobRecord["status"] {
    if (totalNeeds <= 0) return "ready";
    if (items.length < totalNeeds) return "deferred";
    if (items.every((item) => item.status === "active")) return "ready";
    if (items.some((item) => item.status === "needs_review")) return "needs_review";
    return "deferred";
}

export function learningSnapshot(
    job: LearningJobRecord | null,
    items: KnowledgeItemRecord[] = [],
    sourceCount = 0,
    fallback?: { status?: LearningProgress["status"]; message?: string },
): PublicLearningSnapshot {
    const status = fallback?.status ?? job?.status ?? "idle";
    const completedNeeds = Math.max(0, Math.min(
        job?.needs.length ?? 0,
        Number(job?.work.completedNeeds) || (job?.status === "ready" ? job.needs.length : 0),
    ));
    return {
        learningProgress: {
            jobId: job?.jobId ?? "",
            status,
            revision: job?.revision ?? 0,
            currentNeed: job?.work.currentNeed,
            totalNeeds: job?.needs.length ?? 0,
            completedNeeds,
            sourceCount,
            message: fallback?.message || (job ? STATUS_MESSAGES[job.status] : ""),
        },
        knowledgeUsed: items.map((item) => ({
            knowledgeId: item.knowledgeId,
            summary: item.summary,
            confidence: item.confidence,
            status: publicStatus(item),
        })),
        learningDeferred: status === "deferred" || status === "failed" || status === "cancelled",
    };
}
