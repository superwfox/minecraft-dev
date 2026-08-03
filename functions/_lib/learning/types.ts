export type KnowledgeKind = "fact" | "strategy";
export type KnowledgeTrigger =
    | "contract_miss"
    | "version_gap"
    | "dependency_gap"
    | "skill_staleness"
    | "diagnostic_repeat";
export type KnowledgeSpecificity = "exact" | "scoped" | "ambiguous";
export type KnowledgeAnswerType = "signature" | "coordinate" | "behavior" | "migration" | "rule";
export type KnowledgeRisk = "low" | "medium" | "high";
export type SourcePolicy = "api_signature" | "dependency" | "behavior" | "release";

export interface KnowledgeNeed {
    id: string;
    kind: KnowledgeKind;
    trigger: KnowledgeTrigger;
    specificity: KnowledgeSpecificity;
    claim: {
        subject: string;
        question: string;
        answerType: KnowledgeAnswerType;
    };
    scope: {
        coreType?: string;
        mcVersion?: string;
        dependency?: string;
        packageName?: string;
        symbol?: string;
    };
    risk: KnowledgeRisk;
    sourcePolicy: SourcePolicy;
    searchQueries: string[];
    acceptanceCriteria: string[];
}

export interface VerificationEvidence {
    sourceId: string;
    relation: "supports" | "contradicts";
    locator: string;
    excerpt: string;
}

export interface VerificationResult {
    needId: string;
    verdict: "supported" | "contradicted" | "insufficient";
    normalizedClaim?: Record<string, unknown>;
    evidence: VerificationEvidence[];
    confidence: number;
    runtimeSummary?: string;
    expiresInDays?: number;
}

export type LearningStage = "planner" | "fix";
export type LearningJobStatus =
    | "queued"
    | "discovering"
    | "fetching"
    | "verifying"
    | "ready"
    | "deferred"
    | "needs_review"
    | "failed"
    | "cancelled";

export interface LearningCandidate {
    needId: string;
    urls: string[];
}

export interface LearningJobWork {
    candidates?: LearningCandidate[];
    sourceIds?: string[];
    verifications?: VerificationResult[];
    currentNeed?: string;
    completedNeeds?: number;
}

export interface LearningJobRecord {
    jobId: string;
    ownerUid: string;
    generationTaskId: string;
    stage: LearningStage;
    lookupHash: string;
    status: LearningJobStatus;
    needs: KnowledgeNeed[];
    work: LearningJobWork;
    resultIds: string[];
    revision: number;
    leaseToken: string;
    leaseUntil: number;
    error: string;
    createdAt: number;
    updatedAt: number;
}

export type KnowledgeStatus = "draft" | "active" | "needs_review" | "deprecated" | "expired" | "rejected";

export interface KnowledgeItemRecord {
    knowledgeId: string;
    kind: KnowledgeKind;
    lookupKey: string;
    scope: KnowledgeNeed["scope"];
    payload: Record<string, unknown>;
    summary: string;
    risk: KnowledgeRisk;
    confidence: number;
    status: KnowledgeStatus;
    validFrom: number;
    expiresAt: number;
    supersedesId?: string;
    revision: number;
    reviewNote: string;
    createdAt: number;
    updatedAt: number;
}

export interface LearningSourceRecord {
    sourceId: string;
    jobId: string;
    needId: string;
    canonicalUrl: string;
    domain: string;
    sourceType: string;
    authority: string;
    title: string;
    publishedAt?: number;
    fetchedAt: number;
    contentHash: string;
    excerpt: string;
    verificationState: string;
}

export type LearningStatus = "idle" | LearningJobStatus;

export interface LearningProgress {
    jobId: string;
    status: LearningStatus;
    revision: number;
    currentNeed?: string;
    totalNeeds: number;
    completedNeeds: number;
    sourceCount: number;
    message: string;
}

export interface KnowledgeUsed {
    knowledgeId: string;
    summary: string;
    confidence: number;
    status: "active" | "skipped" | "needs_review";
}

export interface LearningEvidenceSource {
    sourceId: string;
    title: string;
    url: string;
    sourceType: string;
    authority: string;
    publishedAt?: number;
    fetchedAt: number;
    excerpt: string;
    relation: string;
}

export interface LearningEvidenceItem {
    knowledgeId: string;
    summary: string;
    kind: string;
    confidence: number;
    status: string;
    scope: string;
    sources: LearningEvidenceSource[];
}
