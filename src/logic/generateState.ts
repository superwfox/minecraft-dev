import { reactive, ref, watch } from "vue";

export type GenPhase = "idle" | "planning" | "clarifying" | "grading" | "confirming" | "awaiting_input" | "generating" | "verifying" | "uploading" | "building" | "polling" | "fixing" | "done" | "error";

export type GradePath = {
    id: string;
    title: string;
    summary: string;
    mermaid: string;
    axes?: string[];
};
export type GradeInfo = { level: string; paths: GradePath[] };

export type LearningStage = "planner" | "fix";
export type LearningStatus = "idle" | "queued" | "discovering" | "fetching" | "verifying" | "ready" | "deferred" | "needs_review" | "failed" | "cancelled";
export type LearningActiveStatus = Extract<LearningStatus, "queued" | "discovering" | "fetching" | "verifying">;
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
    | "revision_conflict"
    | "lease_conflict"
    | "storage_unavailable"
    | "job_deadline"
    | "client_deadline"
    | "client_network"
    | "internal_error";
export type LearningProgress = {
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
    searchedSourceCount: number;
    message: string;
    reasonCode?: LearningReasonCode;
};

export type LearningProviderStatus = "completed" | "incomplete" | "failed" | "unknown";
export type LearningJobTelemetry = {
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
    verificationInvalidResponses: number;
    verificationElapsedMs: number;
};
export type LearningDebugMeta = {
    schemaVersion: "learning.debug.v1";
    jobId: string;
    stage: LearningStage;
    status: Exclude<LearningStatus, "idle">;
    revision: number;
    reasonCode?: LearningReasonCode;
    updatedAt: number;
    telemetry: LearningJobTelemetry;
};
export type LearningDebugEvent = {
    at: number;
    kind: "http" | "transition" | "conflict" | "client";
    stage: LearningStage;
    endpoint: "start" | "step" | "status";
    attempt: number;
    httpStatus: number;
    elapsedMs: number;
    jobId?: string;
    requestRevision?: number;
    responseRevision?: number;
    fromStatus?: LearningStatus;
    toStatus?: LearningStatus;
    reasonCode?: LearningReasonCode;
    conflictReason?: "revision" | "lease";
    telemetry?: LearningJobTelemetry;
};
export type KnowledgeUsed = {
    knowledgeId: string;
    summary: string;
    confidence: number;
    status: "active" | "skipped" | "needs_review";
};

export type PlannerResumeState = {
    plannerRequestId: string;
    plannerReplan: boolean;
    plannerAttempt: number;
};
export type FixResumeStage = "" | "diagnosing" | "learning" | "repairing" | "inspecting" | "rebuilding";

export function normalizeBuildRequestId(value: unknown): string {
    return typeof value === "string" && /^build_[a-f0-9]{32}$/i.test(value.trim())
        ? value.trim().toLowerCase()
        : "";
}

const FIX_RESUME_STAGES = new Set<FixResumeStage>([
    "",
    "diagnosing",
    "learning",
    "repairing",
    "inspecting",
    "rebuilding",
]);

export function normalizeFixResumeStage(value: unknown): FixResumeStage {
    return typeof value === "string" && FIX_RESUME_STAGES.has(value as FixResumeStage)
        ? value as FixResumeStage
        : "";
}

export function normalizePlannerResumeState(value: unknown): PlannerResumeState {
    const raw = value && typeof value === "object" ? value as Record<string, unknown> : {};
    const plannerRequestId = typeof raw.plannerRequestId === "string"
        && /^plan_[a-z0-9]{16,64}$/i.test(raw.plannerRequestId)
        ? raw.plannerRequestId
        : "";
    const plannerReplan = !!plannerRequestId && raw.plannerReplan === true;
    const rawAttempt = Number(raw.plannerAttempt);
    const plannerAttempt = plannerRequestId && plannerReplan && Number.isInteger(rawAttempt)
        ? Math.max(1, Math.min(10, rawAttempt))
        : 0;
    return { plannerRequestId, plannerReplan, plannerAttempt };
}

function emptyLearningProgress(): LearningProgress {
    return {
        jobId: "",
        status: "idle",
        revision: 0,
        totalNeeds: 0,
        completedNeeds: 0,
        sourceCount: 0,
        searchedSourceCount: 0,
        message: "",
    };
}

const LEARNING_REASON_CODES = new Set<LearningReasonCode>([
    "no_learning_needed", "static_contract_covered", "knowledge_cache_hit",
    "responses_not_configured", "auto_learning_disabled", "glm_auto_learning_disabled",
    "quota_exhausted", "discovery_timeout", "discovery_network", "discovery_http",
    "discovery_provider_incomplete", "discovery_provider_failed", "discovery_invalid_response",
    "no_candidate_sources", "no_fetchable_sources", "source_fetch_timeout", "verification_no_sources",
    "verification_timeout", "verification_http", "verification_invalid_response",
    "verification_failed", "unresolved_knowledge_needs", "planner_authorization_expired", "fix_authorization_expired", "revision_conflict", "lease_conflict",
    "storage_unavailable", "job_deadline", "client_deadline", "client_network", "internal_error",
]);
const LEARNING_STATUSES = new Set<LearningStatus>([
    "idle", "queued", "discovering", "fetching", "verifying", "ready",
    "deferred", "needs_review", "failed", "cancelled",
]);
const LEARNING_ACTIVE_STATUSES = new Set<LearningActiveStatus>([
    "queued", "discovering", "fetching", "verifying",
]);

function safeCount(value: unknown): number {
    const number = Number(value);
    return Number.isFinite(number) && number > 0
        ? Math.min(1_000_000_000, Math.floor(number))
        : 0;
}

function safeLearningText(value: unknown, max: number): string {
    return typeof value === "string" ? value.trim().slice(0, max) : "";
}

function optionalLearningTimestamp(value: unknown): number | undefined {
    const number = Number(value);
    return Number.isFinite(number) && number >= 0 && number <= 8_640_000_000_000_000
        ? Math.floor(number)
        : undefined;
}

function optionalLearningDuration(value: unknown): number | undefined {
    const number = Number(value);
    return Number.isFinite(number) && number >= 0
        ? Math.min(300_000, Math.floor(number))
        : undefined;
}

export function isUnconfirmedLearningProgress(
    progress: Pick<LearningProgress, "jobId" | "reasonCode">,
): boolean {
    return !!progress.jobId
        && (progress.reasonCode === "client_network" || progress.reasonCode === "client_deadline");
}

export function shouldResumeLearningProgress(
    progress: LearningProgress,
    stage: LearningStage,
    resumeExisting: boolean,
): boolean {
    return resumeExisting
        && progress.stage === stage
        && !!progress.jobId
        && (LEARNING_ACTIVE_STATUSES.has(progress.status as LearningActiveStatus)
            || isUnconfirmedLearningProgress(progress));
}

export function normalizeLearningProgress(value: unknown): LearningProgress {
    const raw = value && typeof value === "object" ? value as Record<string, unknown> : {};
    const status = typeof raw.status === "string" && LEARNING_STATUSES.has(raw.status as LearningStatus)
        ? raw.status as LearningStatus
        : "idle";
    const stage = raw.stage === "planner" || raw.stage === "fix" ? raw.stage : undefined;
    const jobId = typeof raw.jobId === "string" && /^[A-Za-z0-9_-]{1,100}$/.test(raw.jobId)
        ? raw.jobId
        : "";
    const totalNeeds = safeCount(raw.totalNeeds);
    const startedAt = optionalLearningTimestamp(raw.startedAt);
    const rawDeadlineAt = optionalLearningTimestamp(raw.deadlineAt);
    const deadlineAt = startedAt !== undefined
        && rawDeadlineAt !== undefined
        && rawDeadlineAt >= startedAt
        ? rawDeadlineAt
        : undefined;
    const rawReason = typeof raw.reasonCode === "string" ? raw.reasonCode as LearningReasonCode : undefined;
    const lastActiveStatus = typeof raw.lastActiveStatus === "string"
        && LEARNING_ACTIVE_STATUSES.has(raw.lastActiveStatus as LearningActiveStatus)
        ? raw.lastActiveStatus as LearningActiveStatus
        : undefined;
    const currentNeed = safeLearningText(raw.currentNeed, 500);
    return {
        jobId,
        status,
        revision: optionalCount(raw.revision) ?? 0,
        stage,
        startedAt,
        deadlineAt,
        remainingMs: optionalLearningDuration(raw.remainingMs),
        lastActiveStatus,
        currentNeed: currentNeed || undefined,
        totalNeeds,
        completedNeeds: Math.min(totalNeeds, safeCount(raw.completedNeeds)),
        sourceCount: safeCount(raw.sourceCount),
        searchedSourceCount: safeCount(raw.searchedSourceCount),
        message: safeLearningText(raw.message, 1_000),
        reasonCode: rawReason && LEARNING_REASON_CODES.has(rawReason) ? rawReason : undefined,
    };
}

export function normalizeLearningTelemetry(value: unknown): LearningJobTelemetry {
    const raw = value && typeof value === "object" ? value as Record<string, unknown> : {};
    const providerStatus = raw.discoveryLastProviderStatus;
    return {
        version: 1,
        discoveryAttempts: safeCount(raw.discoveryAttempts),
        discoveryElapsedMs: safeCount(raw.discoveryElapsedMs),
        discoveryTimeouts: safeCount(raw.discoveryTimeouts),
        discoveryRetryableFailures: safeCount(raw.discoveryRetryableFailures),
        discoveryLastHttpStatus: safeCount(raw.discoveryLastHttpStatus),
        discoveryLastProviderStatus: providerStatus === "completed"
            || providerStatus === "incomplete"
            || providerStatus === "failed"
            ? providerStatus
            : "unknown",
        candidateNeedCount: safeCount(raw.candidateNeedCount),
        candidateUrlCount: safeCount(raw.candidateUrlCount),
        sourceAttempts: safeCount(raw.sourceAttempts),
        sourceAccepted: safeCount(raw.sourceAccepted),
        sourceRejected: safeCount(raw.sourceRejected),
        sourceInvalid: safeCount(raw.sourceInvalid),
        sourceDeduplicated: safeCount(raw.sourceDeduplicated),
        sourceTimeouts: safeCount(raw.sourceTimeouts),
        sourceHttp4xx: safeCount(raw.sourceHttp4xx),
        sourceHttp5xx: safeCount(raw.sourceHttp5xx),
        sourceTooLarge: safeCount(raw.sourceTooLarge),
        sourceUnsupportedContentType: safeCount(raw.sourceUnsupportedContentType),
        sourceTooThin: safeCount(raw.sourceTooThin),
        sourceElapsedMs: safeCount(raw.sourceElapsedMs),
        sourceBudgetExhausted: safeCount(raw.sourceBudgetExhausted),
        verificationAttempts: safeCount(raw.verificationAttempts),
        verificationCompleted: safeCount(raw.verificationCompleted),
        verificationSupported: safeCount(raw.verificationSupported),
        verificationContradicted: safeCount(raw.verificationContradicted),
        verificationInsufficient: safeCount(raw.verificationInsufficient),
        verificationFailures: safeCount(raw.verificationFailures),
        verificationTimeouts: safeCount(raw.verificationTimeouts),
        verificationHttp4xx: safeCount(raw.verificationHttp4xx),
        verificationHttp5xx: safeCount(raw.verificationHttp5xx),
        verificationInvalidResponses: safeCount(raw.verificationInvalidResponses),
        verificationElapsedMs: safeCount(raw.verificationElapsedMs),
    };
}

export function normalizeLearningDebugMeta(value: unknown): LearningDebugMeta | undefined {
    if (!value || typeof value !== "object") return undefined;
    const raw = value as Record<string, unknown>;
    const jobId = typeof raw.jobId === "string" && /^[A-Za-z0-9_-]{1,100}$/.test(raw.jobId)
        ? raw.jobId
        : "";
    const stage = raw.stage === "fix" ? "fix" : raw.stage === "planner" ? "planner" : undefined;
    const status = typeof raw.status === "string" && raw.status !== "idle"
        && LEARNING_STATUSES.has(raw.status as LearningStatus)
        ? raw.status as Exclude<LearningStatus, "idle">
        : undefined;
    if (raw.schemaVersion !== "learning.debug.v1" || !jobId || !stage || !status) return undefined;
    const rawReason = typeof raw.reasonCode === "string" ? raw.reasonCode as LearningReasonCode : undefined;
    return {
        schemaVersion: "learning.debug.v1",
        jobId,
        stage,
        status,
        revision: optionalCount(raw.revision) ?? 0,
        reasonCode: rawReason && LEARNING_REASON_CODES.has(rawReason) ? rawReason : undefined,
        updatedAt: optionalCount(raw.updatedAt) ?? 0,
        telemetry: normalizeLearningTelemetry(raw.telemetry),
    };
}

export type GeneratorType =
    | "CommandGen" | "ListenerGen" | "TaskGen" | "ManagerGen"
    | "ConfigGen" | "ConfigClassGen" | "ModelGen" | "EnumGen"
    | "UtilGen" | "FileRelatedGen" | "MainGen";

export type GenFile = {
    path: string;
    role: string;
    content?: string;
    status: "pending" | "generating" | "done" | "error";
    generatorType?: GeneratorType;
    tag?: "gui" | null;
    pairPath?: string;
    bucket?: number;
    streamingContent?: string;
    streamingPhase?: string;
};

export type TodoItem = {
    id: string;
    question: string;
    options: string[];
    allowCustom: boolean;
    multiSelect: boolean;
    chart?: "linear" | "power2" | "power0.5" | "log" | "exp" | "multi" | null;
};

export type ClarifyRound = {
    todos: TodoItem[];
    answers: Record<string, string | string[]>;
};

export type GenTask = {
    taskId: string;
    phase: GenPhase;
    userPrompt: string;   // 原始需求（持久化用：刷新后重试/续跑）
    coreType: string;
    version: string;
    projectName: string;
    packageName: string;
    javaVersion: string;
    files: GenFile[];
    currentIndex: number;
    logs: string[];
    error: string;
    streamingContent: string;
    streamingPhase: string;
    streamingFile: string;
    clarifyTodos: TodoItem[];
    clarifyRound: number;
    clarifyHistory: ClarifyRound[];
    reasoningContent: string;
    reasoningVisible: boolean;
    moreInputHint: string;
    grade: GradeInfo | null;
    chosenPathId: string;
    plannerRequestId: string;
    plannerReplan: boolean;
    plannerAttempt: number;
    plannerLearningRequired: boolean;
    plannerLearningNeedCount: number;
    debugLog: any[]; // 后端 SSE debug 事件累积（可下载，用于定位桶零进度死因）
    buildDiagnostics: any[];
    buildHistory: any[];
    buildRequestId: string;
    fixResumeStage: FixResumeStage;
    learningProgress: LearningProgress;
    knowledgeUsed: KnowledgeUsed[];
    learningDeferred: boolean;
    learningDebugEvents: LearningDebugEvent[];
    learningDebugDroppedEvents: number;
};

export const genTask = reactive<GenTask>({
    taskId: "",
    phase: "idle",
    userPrompt: "",
    coreType: "",
    version: "",
    projectName: "",
    packageName: "",
    javaVersion: "",
    files: [],
    currentIndex: 0,
    logs: [],
    error: "",
    streamingContent: "",
    streamingPhase: "",
    streamingFile: "",
    clarifyTodos: [],
    clarifyRound: 0,
    clarifyHistory: [],
    reasoningContent: "",
    reasoningVisible: true,
    moreInputHint: "",
    grade: null,
    chosenPathId: "",
    plannerRequestId: "",
    plannerReplan: false,
    plannerAttempt: 0,
    plannerLearningRequired: false,
    plannerLearningNeedCount: 0,
    debugLog: [],
    buildDiagnostics: [],
    buildHistory: [],
    buildRequestId: "",
    fixResumeStage: "",
    learningProgress: emptyLearningProgress(),
    knowledgeUsed: [],
    learningDeferred: false,
    learningDebugEvents: [],
    learningDebugDroppedEvents: 0,
});

const MAX_LEARNING_DEBUG_EVENTS = 256;

function optionalCount(value: unknown): number | undefined {
    const number = Number(value);
    return Number.isFinite(number) && number >= 0
        ? Math.min(Number.MAX_SAFE_INTEGER, Math.floor(number))
        : undefined;
}

function normalizeLearningDebugEvent(value: unknown): LearningDebugEvent | null {
    if (!value || typeof value !== "object") return null;
    const raw = value as Record<string, unknown>;
    const kind = raw.kind === "http" || raw.kind === "transition"
        || raw.kind === "conflict" || raw.kind === "client"
        ? raw.kind
        : undefined;
    const stage = raw.stage === "planner" || raw.stage === "fix" ? raw.stage : undefined;
    const endpoint = raw.endpoint === "start" || raw.endpoint === "step" || raw.endpoint === "status"
        ? raw.endpoint
        : undefined;
    if (!kind || !stage || !endpoint) return null;
    const jobId = typeof raw.jobId === "string" && /^[A-Za-z0-9_-]{1,100}$/.test(raw.jobId)
        ? raw.jobId
        : undefined;
    const fromStatus = typeof raw.fromStatus === "string" && LEARNING_STATUSES.has(raw.fromStatus as LearningStatus)
        ? raw.fromStatus as LearningStatus
        : undefined;
    const toStatus = typeof raw.toStatus === "string" && LEARNING_STATUSES.has(raw.toStatus as LearningStatus)
        ? raw.toStatus as LearningStatus
        : undefined;
    const rawReason = typeof raw.reasonCode === "string" ? raw.reasonCode as LearningReasonCode : undefined;
    return {
        at: optionalCount(raw.at) || Date.now(),
        kind,
        stage,
        endpoint,
        attempt: safeCount(raw.attempt),
        httpStatus: safeCount(raw.httpStatus),
        elapsedMs: safeCount(raw.elapsedMs),
        jobId,
        requestRevision: optionalCount(raw.requestRevision),
        responseRevision: optionalCount(raw.responseRevision),
        fromStatus,
        toStatus,
        reasonCode: rawReason && LEARNING_REASON_CODES.has(rawReason) ? rawReason : undefined,
        conflictReason: raw.conflictReason === "revision" || raw.conflictReason === "lease"
            ? raw.conflictReason
            : undefined,
        telemetry: raw.telemetry ? normalizeLearningTelemetry(raw.telemetry) : undefined,
    };
}

export function recordLearningDebugEvent(
    event: Omit<LearningDebugEvent, "at"> & { at?: number },
): void {
    const normalized = normalizeLearningDebugEvent({ ...event, at: event.at ?? Date.now() });
    if (!normalized) return;
    genTask.learningDebugEvents.push(normalized);
    if (genTask.learningDebugEvents.length > MAX_LEARNING_DEBUG_EVENTS) {
        const dropped = genTask.learningDebugEvents.length - MAX_LEARNING_DEBUG_EVENTS;
        genTask.learningDebugEvents.splice(0, dropped);
        genTask.learningDebugDroppedEvents = Math.min(
            1_000_000_000,
            genTask.learningDebugDroppedEvents + dropped,
        );
    }
}

export function resetGenTask() {
    genTask.taskId = "";
    genTask.phase = "idle";
    genTask.userPrompt = "";
    genTask.coreType = "";
    genTask.version = "";
    genTask.projectName = "";
    genTask.packageName = "";
    genTask.javaVersion = "";
    genTask.files = [];
    genTask.currentIndex = 0;
    genTask.logs = [];
    genTask.error = "";
    genTask.streamingContent = "";
    genTask.streamingPhase = "";
    genTask.streamingFile = "";
    genTask.clarifyTodos = [];
    genTask.clarifyRound = 0;
    genTask.clarifyHistory = [];
    genTask.reasoningContent = "";
    genTask.reasoningVisible = true;
    genTask.moreInputHint = "";
    genTask.grade = null;
    genTask.chosenPathId = "";
    genTask.plannerRequestId = "";
    genTask.plannerReplan = false;
    genTask.plannerAttempt = 0;
    genTask.plannerLearningRequired = false;
    genTask.plannerLearningNeedCount = 0;
    genTask.debugLog = [];
    genTask.buildDiagnostics = [];
    genTask.buildHistory = [];
    genTask.buildRequestId = "";
    genTask.fixResumeStage = "";
    genTask.learningProgress = emptyLearningProgress();
    genTask.knowledgeUsed = [];
    genTask.learningDeferred = false;
    genTask.learningDebugEvents = [];
    genTask.learningDebugDroppedEvents = 0;
    clarifyWaiting.value = false;
    pathGateWaiting.value = false;
    clearPersistedGenTask();
}

// 超级并发开关：默认 false（桶内串行，每个 CF 请求只做 1 文件，最稳）。
// 开启后桶内并发生成、更快，但更易撞 Cloudflare Worker 单请求 CPU/时长/子请求上限导致「零进度 → 重新规划 → 失败」——慎用。
// 用户偏好，持久化到 localStorage。
function loadSuperConcurrency(): boolean {
    try { return localStorage.getItem("tahai-super-concurrency") === "1"; } catch { return false; }
}
export const superConcurrency = ref(loadSuperConcurrency());
export function setSuperConcurrency(on: boolean) {
    superConcurrency.value = on;
    try { localStorage.setItem("tahai-super-concurrency", on ? "1" : "0"); } catch { /* ignore */ }
}

// ── 生成态持久化：刷新不丢会话（taskID 的职责是重建会话，而非刷新即失败）──
// 快照存 localStorage（不含文件正文，保持体积小；正文在后端 KV，续跑时按需重取）。
const GEN_KEY = "tahai-gentask";
let persistTimer: any = null;

function writeGenTaskSnapshot() {
    try {
        if (genTask.phase === "idle" || !genTask.taskId) { localStorage.removeItem(GEN_KEY); return; }
        const snap = {
            taskId: genTask.taskId,
            phase: genTask.phase,
            userPrompt: genTask.userPrompt,
            coreType: genTask.coreType,
            version: genTask.version,
            projectName: genTask.projectName,
            packageName: genTask.packageName,
            javaVersion: genTask.javaVersion,
            files: genTask.files.map(f => ({
                path: f.path, role: f.role, status: f.status,
                generatorType: f.generatorType, tag: f.tag, pairPath: f.pairPath, bucket: f.bucket,
            })),
            currentIndex: genTask.currentIndex,
            logs: genTask.logs.slice(-200),
            clarifyHistory: genTask.clarifyHistory,
            grade: genTask.grade,
            chosenPathId: genTask.chosenPathId,
            plannerRequestId: genTask.plannerRequestId,
            plannerReplan: genTask.plannerReplan,
            plannerAttempt: genTask.plannerAttempt,
            plannerLearningRequired: genTask.plannerLearningRequired,
            plannerLearningNeedCount: genTask.plannerLearningNeedCount,
            buildDiagnostics: genTask.buildDiagnostics,
            buildHistory: genTask.buildHistory.slice(-6),
            buildRequestId: genTask.buildRequestId,
            fixResumeStage: genTask.fixResumeStage,
            learningProgress: genTask.learningProgress,
            knowledgeUsed: genTask.knowledgeUsed,
            learningDeferred: genTask.learningDeferred,
            learningDebugEvents: genTask.learningDebugEvents.slice(-MAX_LEARNING_DEBUG_EVENTS),
            learningDebugDroppedEvents: genTask.learningDebugDroppedEvents,
            error: genTask.error,
            t: Date.now(),
        };
        localStorage.setItem(GEN_KEY, JSON.stringify(snap));
    } catch { /* ignore（超配额等） */ }
}

export function persistGenTask() {
    if (persistTimer) clearTimeout(persistTimer);
    persistTimer = setTimeout(writeGenTaskSnapshot, 400);
}

export function persistGenTaskNow() {
    if (persistTimer) clearTimeout(persistTimer);
    persistTimer = null;
    writeGenTaskSnapshot();
}
export function clearPersistedGenTask() {
    try { localStorage.removeItem(GEN_KEY); } catch { /* ignore */ }
}
/** 页面加载时还原上次生成态。返回是否还原了一个「进行中/可续」的任务。 */
export function restoreGenTask(): boolean {
    try {
        const raw = localStorage.getItem(GEN_KEY);
        if (!raw) return false;
        const s = JSON.parse(raw);
        if (!s.taskId || s.phase === "idle") return false;
        if (s.t && Date.now() - s.t > 3600_000) { localStorage.removeItem(GEN_KEY); return false; } // 超 KV TTL 作废
        genTask.taskId = s.taskId;
        genTask.phase = s.phase;
        genTask.userPrompt = s.userPrompt || "";
        genTask.coreType = s.coreType || "";
        genTask.version = s.version || "";
        genTask.projectName = s.projectName || "";
        genTask.packageName = s.packageName || "";
        genTask.javaVersion = s.javaVersion || "";
        genTask.files = s.files || [];
        genTask.currentIndex = genTask.files.filter(file => file?.status === "done").length;
        genTask.logs = s.logs || [];
        genTask.clarifyHistory = s.clarifyHistory || [];
        genTask.grade = s.grade || null;
        genTask.chosenPathId = s.chosenPathId || "";
        const plannerResume = normalizePlannerResumeState(s);
        genTask.plannerRequestId = plannerResume.plannerRequestId;
        genTask.plannerReplan = plannerResume.plannerReplan;
        genTask.plannerAttempt = plannerResume.plannerAttempt;
        genTask.plannerLearningRequired = s.plannerLearningRequired === true;
        genTask.plannerLearningNeedCount = safeCount(s.plannerLearningNeedCount);
        genTask.buildDiagnostics = s.buildDiagnostics || [];
        genTask.buildHistory = s.buildHistory || [];
        genTask.buildRequestId = normalizeBuildRequestId(s.buildRequestId);
        genTask.fixResumeStage = normalizeFixResumeStage(s.fixResumeStage);
        genTask.learningProgress = normalizeLearningProgress(s.learningProgress);
        genTask.knowledgeUsed = s.knowledgeUsed || [];
        genTask.learningDeferred = !!s.learningDeferred;
        const rawLearningDebugEvents = Array.isArray(s.learningDebugEvents) ? s.learningDebugEvents : [];
        const boundedLearningDebugEvents = rawLearningDebugEvents.slice(-MAX_LEARNING_DEBUG_EVENTS);
        genTask.learningDebugEvents = boundedLearningDebugEvents
            .map(normalizeLearningDebugEvent)
            .filter((event: LearningDebugEvent | null): event is LearningDebugEvent => !!event);
        const restoreDropped = Math.max(0, rawLearningDebugEvents.length - MAX_LEARNING_DEBUG_EVENTS)
            + Math.max(0, boundedLearningDebugEvents.length - genTask.learningDebugEvents.length);
        genTask.learningDebugDroppedEvents = Math.min(
            1_000_000_000,
            safeCount(s.learningDebugDroppedEvents) + restoreDropped,
        );
        genTask.error = s.error || "";
        return true;
    } catch { return false; }
}

// genTask 关键字段变化 → 防抖落盘
watch(
    () => [genTask.phase, genTask.files.length, genTask.currentIndex, genTask.logs.length,
        genTask.files.filter(f => f.status === "done").length,
        genTask.learningProgress.status, genTask.learningProgress.revision, genTask.knowledgeUsed.length,
        genTask.learningDebugEvents.length, genTask.learningDebugDroppedEvents,
        genTask.plannerRequestId, genTask.plannerReplan, genTask.plannerAttempt,
        genTask.plannerLearningRequired, genTask.plannerLearningNeedCount,
        genTask.buildRequestId, genTask.fixResumeStage],
    persistGenTask,
);

// 中断标记：ESC 撤回时抛出，startGenerate 的 catch 据此安静复位
export class InterruptError extends Error {
    interrupted = true;
    constructor() { super("interrupted"); this.name = "InterruptError"; }
}

// 本轮澄清是否已就绪可作答（流式问题全部到达、resolver 已建立）。
// 卡片 UI 只在此为 true 时才允许提交，避免流未结束时提交丢失答案。
export const clarifyWaiting = ref(false);

// 等待用户确认的 Promise 解析器（作答完成时调用）
let clarifyResolver: ((answers: Record<string, string | string[]>) => void) | null = null;
let clarifyRejecter: ((e: any) => void) | null = null;

export function waitForClarifyAnswers(): Promise<Record<string, string | string[]>> {
    clarifyWaiting.value = true;
    return new Promise((resolve, reject) => {
        clarifyResolver = resolve;
        clarifyRejecter = reject;
    });
}

export function submitClarifyAnswers(answers: Record<string, string | string[]>) {
    if (clarifyResolver) {
        const r = clarifyResolver;
        clarifyResolver = null;
        clarifyRejecter = null;
        clarifyWaiting.value = false;
        r(answers);
    }
}

// 等待用户补充需求描述（awaiting_input 阶段）
let extraPromptResolver: ((extra: string) => void) | null = null;
let extraPromptRejecter: ((e: any) => void) | null = null;

export function waitForExtraPrompt(): Promise<string> {
    return new Promise((resolve, reject) => {
        extraPromptResolver = resolve;
        extraPromptRejecter = reject;
    });
}

export function submitExtraPrompt(extra: string) {
    if (extraPromptResolver) {
        const r = extraPromptResolver;
        extraPromptResolver = null;
        extraPromptRejecter = null;
        r(extra);
    }
}

// ── 实现路径确认门（confirming 阶段）：选路径 或 打回修正 ──
export const pathGateWaiting = ref(false);
let pathResolver: ((r: { pathId?: string; correction?: string }) => void) | null = null;
let pathRejecter: ((e: any) => void) | null = null;

export function waitForPathChoice(): Promise<{ pathId?: string; correction?: string }> {
    pathGateWaiting.value = true;
    return new Promise((resolve, reject) => {
        pathResolver = resolve;
        pathRejecter = reject;
    });
}
function resolvePath(r: { pathId?: string; correction?: string }) {
    if (pathResolver) {
        const fn = pathResolver;
        pathResolver = null;
        pathRejecter = null;
        pathGateWaiting.value = false;
        fn(r);
    }
}
export function submitPathChoice(pathId: string) { resolvePath({ pathId }); }
export function submitPathReject(correction: string) { resolvePath({ correction }); }

/** ESC 中断：拒绝任何正在等待用户输入的 Promise（澄清答题 / 补充描述 / 路径确认） */
export function cancelPendingInput() {
    clarifyWaiting.value = false;
    pathGateWaiting.value = false;
    if (pathRejecter) {
        const r = pathRejecter;
        pathResolver = null;
        pathRejecter = null;
        r(new InterruptError());
    }
    if (clarifyRejecter) {
        const r = clarifyRejecter;
        clarifyResolver = null;
        clarifyRejecter = null;
        r(new InterruptError());
    }
    if (extraPromptRejecter) {
        const r = extraPromptRejecter;
        extraPromptResolver = null;
        extraPromptRejecter = null;
        r(new InterruptError());
    }
}
