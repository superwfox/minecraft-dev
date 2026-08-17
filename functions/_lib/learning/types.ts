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
export type LearningIntegrationKind =
    | "public_api"
    | "nms"
    | "craftbukkit"
    | "version_reflection"
    | "external_plugin";
export type LearningNeedTriggerReason =
    | "nms_version_sensitive"
    | "reflection_contract"
    | "external_plugin_contract"
    | "persistent_diagnostic_gap";

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
    integrationKind?: LearningIntegrationKind;
    triggerReason?: LearningNeedTriggerReason;
    pathIds?: string[];
}

export interface VerificationEvidence {
    sourceId: string;
    relation: "supports" | "contradicts";
    locator: string;
    excerpt: string;
}

export interface ImplementationRecipeV1 {
    schemaVersion: "implementation_recipe.v1";
    language: "java";
    integrationKind: LearningIntegrationKind;
    title: string;
    code: string;
    imports: string[];
    versionScope: string;
    prerequisites: string[];
    notes: string[];
    sourceIds: string[];
}

export interface VerificationResult {
    needId: string;
    verdict: "supported" | "contradicted" | "insufficient";
    normalizedClaim?: Record<string, unknown>;
    evidence: VerificationEvidence[];
    confidence: number;
    runtimeSummary?: string;
    expiresInDays?: number;
    recipe?: ImplementationRecipeV1;
}

export type LearningStage = "planner" | "fix" | "tool";
export type LearningProviderStatus = "completed" | "incomplete" | "failed" | "unknown";
export type LearningReasonCode =
    | "no_learning_needed"
    | "static_contract_covered"
    | "knowledge_cache_hit"
    | "responses_not_configured"
    | "auto_learning_disabled"
    | "glm_auto_learning_disabled"
    | "quota_exhausted"
    | "discovery_timeout"
    | "discovery_network"
    | "discovery_http"
    | "discovery_provider_incomplete"
    | "discovery_provider_failed"
    | "discovery_invalid_response"
    | "no_candidate_sources"
    | "no_fetchable_sources"
    | "source_fetch_timeout"
    | "verification_no_sources"
    | "verification_timeout"
    | "verification_http"
    | "verification_invalid_response"
    | "verification_failed"
    | "unresolved_knowledge_needs"
    | "planner_authorization_expired"
    | "fix_authorization_expired"
    | "tool_authorization_expired"
    | "tool_request_invalid"
    | "revision_conflict"
    | "lease_conflict"
    | "storage_unavailable"
    | "job_deadline"
    | "client_deadline"
    | "client_network"
    | "internal_error";
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
export type LearningActiveStatus = Extract<
    LearningJobStatus,
    "queued" | "discovering" | "fetching" | "verifying"
>;

export interface LearningCandidateSource {
    url: string;
    reason: string;
}

export interface LearningCandidate {
    needId: string;
    sources?: LearningCandidateSource[];
    urls?: string[];
}

export type LearningSearchedSourceStatus =
    | "discovered"
    | "fetched"
    | "supports"
    | "contradicts"
    | "rejected"
    | "skipped";

export type LearningSourceRejectionCode =
    | "invalid_url"
    | "timeout"
    | "http_4xx"
    | "http_5xx"
    | "too_large"
    | "unsupported_type"
    | "too_thin"
    | "duplicate"
    | "budget_exhausted"
    | "source_limit";

export interface LearningSearchedSource {
    needId: string;
    url: string;
    canonicalUrl?: string;
    reason: string;
    status: LearningSearchedSourceStatus;
    rejectionCode?: LearningSourceRejectionCode;
    sourceId?: string;
    title?: string;
    sourceType?: string;
    authority?: string;
}

export interface LearningJobTelemetry {
    version: 1;
    discoveryAttempts: number;
    discoveryElapsedMs: number;
    discoveryTimeouts: number;
    discoveryRetryableFailures: number;
    discoveryLastHttpStatus: number;
    discoveryLastProviderStatus: LearningProviderStatus;
    candidateNeedCount: number;
    candidateUrlCount: number;
    sourceAttempts: number;
    sourceAccepted: number;
    sourceRejected: number;
    sourceInvalid: number;
    sourceDeduplicated: number;
    sourceTimeouts: number;
    sourceHttp4xx: number;
    sourceHttp5xx: number;
    sourceTooLarge: number;
    sourceUnsupportedContentType: number;
    sourceTooThin: number;
    sourceElapsedMs: number;
    sourceBudgetExhausted: number;
    verificationAttempts: number;
    verificationCompleted: number;
    verificationSupported: number;
    verificationContradicted: number;
    verificationInsufficient: number;
    verificationFailures: number;
    verificationTimeouts: number;
    verificationHttp4xx: number;
    verificationHttp5xx: number;
    verificationLastHttpStatus: number;
    verificationInvalidResponses: number;
    verificationElapsedMs: number;
}

export interface LearningJobWork {
    deadlineAt?: number;
    lastProgressAt?: number;
    inactivityDeadlineAt?: number;
    lastActiveStatus?: LearningActiveStatus;
    candidates?: LearningCandidate[];
    searchedSources?: LearningSearchedSource[];
    sourceIds?: string[];
    verifications?: VerificationResult[];
    cachedKnowledgeIds?: string[];
    verificationAttemptsByNeed?: Record<string, number>;
    taskStateFence?: string;
    plannerAuthorization?: {
        chosenPathId: string;
        needsFingerprint: string;
    };
    fixAuthorization?: {
        runId: number;
        previousRunId: number;
        diagnosticsFingerprint: string;
        repairAttempts: number;
    };
    toolAuthorization?: {
        requestId: string;
        needsFingerprint: string;
    };
    currentNeed?: string;
    completedNeeds?: number;
    telemetry?: LearningJobTelemetry;
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

export interface LearningDebugMeta {
    schemaVersion: "learning.debug.v1";
    jobId: string;
    stage: LearningStage;
    status: LearningJobStatus;
    revision: number;
    reasonCode?: LearningReasonCode;
    updatedAt: number;
    telemetry: LearningJobTelemetry;
}

export interface LearningProgress {
    jobId: string;
    status: LearningStatus;
    revision: number;
    stage?: LearningStage;
    startedAt?: number;
    deadlineAt?: number;
    remainingMs?: number;
    lastActiveStatus?: LearningActiveStatus;
    currentNeed?: string;
    totalNeeds: number;
    completedNeeds: number;
    sourceCount: number;
    searchedSourceCount?: number;
    message: string;
    reasonCode?: LearningReasonCode;
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

export interface LearningEvidenceReason {
    code: LearningNeedTriggerReason;
    message: string;
}

export interface LearningEvidenceItem {
    knowledgeId: string;
    summary: string;
    kind: string;
    confidence: number;
    status: string;
    scope: string;
    reason?: LearningEvidenceReason;
    recipe?: ImplementationRecipeV1;
    sources: LearningEvidenceSource[];
}

export interface PublicLearningSearchedSource {
    needId: string;
    question: string;
    url: string;
    canonicalUrl?: string;
    reason: string;
    status: LearningSearchedSourceStatus;
    rejectionCode?: LearningSourceRejectionCode;
    title: string;
    sourceType: string;
    authority: string;
}

export interface PublicLearningEvidenceSnapshot {
    learningJobId: string;
    learningStage: "" | LearningStage;
    learningStatus: LearningStatus;
    learningRevision: number;
    items: LearningEvidenceItem[];
    searchedSources: PublicLearningSearchedSource[];
}
