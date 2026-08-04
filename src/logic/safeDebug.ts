import type {
    GenPhase,
    GenTask,
    LearningDebugEvent,
    LearningJobTelemetry,
    LearningReasonCode,
    LearningStatus,
} from "./generateState";

export const SAFE_DEBUG_EVENT_LIMIT = 256;
export const SAFE_DEBUG_BYTE_LIMIT = 128 * 1024;
export const SAFE_DEBUG_REDACTION_POLICY = "tahai.safe-debug.redaction.v1" as const;

const GENERATION_PHASES = new Set<GenPhase>([
    "idle", "planning", "clarifying", "grading", "confirming", "awaiting_input",
    "generating", "verifying", "uploading", "building", "polling", "fixing", "done", "error",
]);
const LEARNING_STATUSES = new Set<LearningStatus>([
    "idle", "queued", "discovering", "fetching", "verifying", "ready",
    "deferred", "needs_review", "failed", "cancelled",
]);
const LEARNING_REASON_CODES = new Set<LearningReasonCode>([
    "no_learning_needed", "static_contract_covered", "knowledge_cache_hit",
    "responses_not_configured", "auto_learning_disabled", "glm_auto_learning_disabled",
    "quota_exhausted", "discovery_timeout", "discovery_network", "discovery_http",
    "discovery_provider_incomplete", "discovery_provider_failed", "discovery_invalid_response",
    "no_candidate_sources", "no_fetchable_sources", "source_fetch_timeout", "verification_no_sources",
    "verification_timeout", "verification_http", "verification_invalid_response",
    "verification_failed", "unresolved_knowledge_needs", "revision_conflict", "lease_conflict",
    "storage_unavailable", "client_deadline", "client_network", "internal_error",
]);
const BUCKET_DEBUG_MESSAGES = new Set([
    "callAI:req", "callAI:http", "callAI:http-err", "callAI:done", "callAI:throw",
    "stream:req", "stream:http", "stream:http-err", "stream:done", "stream:throw",
    "file:dispatch", "file:gen-begin", "file:review-begin", "file:review-known-api",
    "file:review-parse-fail", "file:review-done", "file:rework-begin", "file:summary-begin",
    "file:summary-fallback", "file:return", "heartbeat", "process:start", "batch:begin",
    "task:begin", "task:ok", "task:throw", "result:replan", "result:ok",
    "process:catch", "process:finally",
]);
const BUILD_FIX_DEBUG_MESSAGES = new Set([
    "fix:diagnostics", "fix:no-target", "fix:contract-rejected", "fix:unchanged", "fix:result",
]);
const TELEMETRY_COUNT_KEYS = [
    "discoveryAttempts", "discoveryElapsedMs", "discoveryTimeouts", "discoveryRetryableFailures",
    "discoveryLastHttpStatus", "candidateNeedCount", "candidateUrlCount", "sourceAttempts",
    "sourceAccepted", "sourceRejected", "sourceInvalid", "sourceDeduplicated", "sourceTimeouts",
    "sourceHttp4xx", "sourceHttp5xx", "sourceTooLarge", "sourceUnsupportedContentType",
    "sourceTooThin", "sourceElapsedMs", "sourceBudgetExhausted", "verificationAttempts", "verificationCompleted",
    "verificationSupported", "verificationContradicted", "verificationInsufficient",
    "verificationFailures", "verificationTimeouts", "verificationHttp4xx", "verificationHttp5xx",
    "verificationInvalidResponses", "verificationElapsedMs",
] as const satisfies readonly (keyof LearningJobTelemetry)[];

export type SafeDebugSource = Pick<GenTask,
    | "taskId"
    | "phase"
    | "files"
    | "currentIndex"
    | "plannerAttempt"
    | "plannerReplan"
    | "debugLog"
    | "buildDiagnostics"
    | "learningProgress"
    | "learningDebugEvents"
    | "learningDebugDroppedEvents"
>;

type SafeLearningEvent = Omit<LearningDebugEvent, "jobId" | "telemetry">;

type NormalizedLearningEvent = SafeLearningEvent & {
    jobId?: string;
    telemetry?: LearningJobTelemetry;
};

type SafeStageSummary = {
    stage: "planner" | "fix";
    jobId?: string;
    status?: LearningStatus;
    revision?: number;
    reasonCode?: LearningReasonCode;
    lastEventAt: number;
    eventCounts: {
        total: number;
        start: number;
        step: number;
        status: number;
        http: number;
        transition: number;
        conflict: number;
        client: number;
    };
    telemetry?: LearningJobTelemetry;
};

export type SafeDebugExport = {
    schemaVersion: "tahai.safe-debug.v1";
    exportedAt: string;
    redaction: {
        policyVersion: typeof SAFE_DEBUG_REDACTION_POLICY;
        maxEvents: number;
        maxBytes: number;
        droppedEvents: number;
        truncated: boolean;
    };
    generation: {
        taskId: string;
        phase: GenPhase;
        currentIndex: number;
        plannerAttempt: number;
        plannerReplan: boolean;
        files: {
            total: number;
            pending: number;
            generating: number;
            done: number;
            error: number;
            unknown: number;
        };
        debug: {
            rawEvents: number;
            acceptedEvents: number;
            rejectedEvents: number;
            summaries: Array<{
                scope: "bucket" | "build-fix";
                msg: string;
                count: number;
            }>;
        };
    };
    learning: {
        current: {
            jobId: string;
            status: LearningStatus;
            revision: number;
            reasonCode?: LearningReasonCode;
            totalNeeds: number;
            completedNeeds: number;
            sourceCount: number;
        };
        stages: SafeStageSummary[];
        events: SafeLearningEvent[];
    };
    build: {
        diagnostics: {
            total: number;
            compile: number;
            dependency: number;
            build: number;
            unknown: number;
        };
    };
};

function safeCount(value: unknown, max = 1_000_000_000): number {
    const number = Number(value);
    return Number.isFinite(number) && number > 0
        ? Math.min(max, Math.floor(number))
        : 0;
}

function optionalCount(value: unknown, max = Number.MAX_SAFE_INTEGER): number | undefined {
    const number = Number(value);
    return Number.isFinite(number) && number >= 0
        ? Math.min(max, Math.floor(number))
        : undefined;
}

function safeOpaqueId(value: unknown): string {
    return typeof value === "string" && /^[A-Za-z0-9_-]{1,100}$/.test(value) ? value : "";
}

function safeStatus(value: unknown): LearningStatus | undefined {
    return typeof value === "string" && LEARNING_STATUSES.has(value as LearningStatus)
        ? value as LearningStatus
        : undefined;
}

function safeReasonCode(value: unknown): LearningReasonCode | undefined {
    return typeof value === "string" && LEARNING_REASON_CODES.has(value as LearningReasonCode)
        ? value as LearningReasonCode
        : undefined;
}

function normalizeTelemetry(value: unknown): LearningJobTelemetry {
    const raw = value && typeof value === "object" ? value as Record<string, unknown> : {};
    const telemetry = {
        version: 1,
        discoveryLastProviderStatus: raw.discoveryLastProviderStatus === "completed"
            || raw.discoveryLastProviderStatus === "incomplete"
            || raw.discoveryLastProviderStatus === "failed"
            ? raw.discoveryLastProviderStatus
            : "unknown",
    } as LearningJobTelemetry;
    for (const key of TELEMETRY_COUNT_KEYS) telemetry[key] = safeCount(raw[key]) as never;
    return telemetry;
}

function normalizeLearningEvent(value: unknown): NormalizedLearningEvent | null {
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

    const fromStatus = safeStatus(raw.fromStatus);
    const toStatus = safeStatus(raw.toStatus);
    const conflictReason = raw.conflictReason === "revision" || raw.conflictReason === "lease"
        ? raw.conflictReason
        : undefined;
    return {
        at: optionalCount(raw.at) ?? 0,
        kind,
        stage,
        endpoint,
        attempt: safeCount(raw.attempt),
        httpStatus: safeCount(raw.httpStatus),
        elapsedMs: safeCount(raw.elapsedMs),
        requestRevision: optionalCount(raw.requestRevision),
        responseRevision: optionalCount(raw.responseRevision),
        fromStatus,
        toStatus,
        reasonCode: safeReasonCode(raw.reasonCode),
        conflictReason,
        jobId: safeOpaqueId(raw.jobId) || undefined,
        telemetry: raw.telemetry ? normalizeTelemetry(raw.telemetry) : undefined,
    };
}

function summarizeGenerationDebug(values: unknown[]): SafeDebugExport["generation"]["debug"] {
    const counts = new Map<string, { scope: "bucket" | "build-fix"; msg: string; count: number }>();
    let acceptedEvents = 0;
    for (const value of values) {
        if (!value || typeof value !== "object") continue;
        const raw = value as Record<string, unknown>;
        const msg = typeof raw.msg === "string" ? raw.msg : "";
        const scope = raw.scope === "build-fix"
            ? "build-fix"
            : Number.isInteger(Number(raw.bucket)) ? "bucket" : undefined;
        const accepted = scope === "build-fix"
            ? BUILD_FIX_DEBUG_MESSAGES.has(msg)
            : scope === "bucket" && BUCKET_DEBUG_MESSAGES.has(msg);
        if (!scope || !accepted) continue;
        acceptedEvents++;
        const key = `${scope}\n${msg}`;
        const existing = counts.get(key);
        if (existing) existing.count++;
        else counts.set(key, { scope, msg, count: 1 });
    }
    return {
        rawEvents: values.length,
        acceptedEvents,
        rejectedEvents: Math.max(0, values.length - acceptedEvents),
        summaries: [...counts.values()].sort((left, right) =>
            left.scope.localeCompare(right.scope) || left.msg.localeCompare(right.msg),
        ),
    };
}

function summarizeFiles(values: SafeDebugSource["files"]): SafeDebugExport["generation"]["files"] {
    const summary = { total: values.length, pending: 0, generating: 0, done: 0, error: 0, unknown: 0 };
    for (const file of values) {
        if (file?.status === "pending" || file?.status === "generating"
            || file?.status === "done" || file?.status === "error") {
            summary[file.status]++;
        } else {
            summary.unknown++;
        }
    }
    return summary;
}

function summarizeBuildDiagnostics(values: unknown[]): SafeDebugExport["build"]["diagnostics"] {
    const summary = { total: values.length, compile: 0, dependency: 0, build: 0, unknown: 0 };
    for (const value of values) {
        const category = value && typeof value === "object"
            ? (value as Record<string, unknown>).category
            : undefined;
        if (category === "compile" || category === "dependency" || category === "build") summary[category]++;
        else summary.unknown++;
    }
    return summary;
}

function summarizeLearningStages(events: NormalizedLearningEvent[]): SafeStageSummary[] {
    const summaries = new Map<"planner" | "fix", SafeStageSummary>();
    for (const event of events) {
        let summary = summaries.get(event.stage);
        if (!summary) {
            summary = {
                stage: event.stage,
                lastEventAt: 0,
                eventCounts: {
                    total: 0, start: 0, step: 0, status: 0,
                    http: 0, transition: 0, conflict: 0, client: 0,
                },
            };
            summaries.set(event.stage, summary);
        }
        summary.lastEventAt = Math.max(summary.lastEventAt, event.at);
        summary.eventCounts.total++;
        summary.eventCounts[event.endpoint]++;
        summary.eventCounts[event.kind]++;
        if (event.jobId) summary.jobId = event.jobId;
        if (event.toStatus) {
            summary.status = event.toStatus;
            if (event.reasonCode) summary.reasonCode = event.reasonCode;
            else delete summary.reasonCode;
        } else if (event.reasonCode) {
            summary.reasonCode = event.reasonCode;
        }
        if (event.responseRevision !== undefined) summary.revision = event.responseRevision;
        if (event.telemetry) summary.telemetry = event.telemetry;
    }
    return ["planner", "fix"]
        .map((stage) => summaries.get(stage as "planner" | "fix"))
        .filter((summary): summary is SafeStageSummary => !!summary);
}

function publicLearningEvent(event: NormalizedLearningEvent): SafeLearningEvent {
    return {
        at: event.at,
        kind: event.kind,
        stage: event.stage,
        endpoint: event.endpoint,
        attempt: event.attempt,
        httpStatus: event.httpStatus,
        elapsedMs: event.elapsedMs,
        requestRevision: event.requestRevision,
        responseRevision: event.responseRevision,
        fromStatus: event.fromStatus,
        toStatus: event.toStatus,
        reasonCode: event.reasonCode,
        conflictReason: event.conflictReason,
    };
}

function isPriorityLearningEvent(event: SafeLearningEvent): boolean {
    return event.kind !== "http"
        || event.httpStatus >= 400
        || !!event.reasonCode
        || event.toStatus === "ready"
        || event.toStatus === "deferred"
        || event.toStatus === "needs_review"
        || event.toStatus === "failed"
        || event.toStatus === "cancelled";
}

function serializedBytes(value: unknown): number {
    return new TextEncoder().encode(JSON.stringify(value, null, 2)).byteLength;
}

export function buildSafeDebugExport(source: SafeDebugSource, now = Date.now()): SafeDebugExport {
    const rawLearningEvents = Array.isArray(source.learningDebugEvents) ? source.learningDebugEvents : [];
    const normalizedLearningEvents = rawLearningEvents
        .map(normalizeLearningEvent)
        .filter((event): event is NormalizedLearningEvent => !!event);
    const stages = summarizeLearningStages(normalizedLearningEvents);
    const overEventLimit = Math.max(0, normalizedLearningEvents.length - SAFE_DEBUG_EVENT_LIMIT);
    const invalidEvents = Math.max(0, rawLearningEvents.length - normalizedLearningEvents.length);
    const events = normalizedLearningEvents.slice(-SAFE_DEBUG_EVENT_LIMIT).map(publicLearningEvent);
    let droppedEvents = safeCount(source.learningDebugDroppedEvents) + overEventLimit + invalidEvents;
    let truncated = droppedEvents > 0;

    const timestamp = Number.isFinite(now) && now >= 0 && now <= 8_640_000_000_000_000
        ? now
        : Date.now();
    const progress = source.learningProgress && typeof source.learningProgress === "object"
        ? source.learningProgress
        : {} as SafeDebugSource["learningProgress"];
    const phase = GENERATION_PHASES.has(source.phase) ? source.phase : "idle";
    const debugValues = Array.isArray(source.debugLog) ? source.debugLog : [];
    const diagnostics = Array.isArray(source.buildDiagnostics) ? source.buildDiagnostics : [];
    const files = Array.isArray(source.files) ? source.files : [];

    const makePayload = (): SafeDebugExport => ({
        schemaVersion: "tahai.safe-debug.v1",
        exportedAt: new Date(timestamp).toISOString(),
        redaction: {
            policyVersion: SAFE_DEBUG_REDACTION_POLICY,
            maxEvents: SAFE_DEBUG_EVENT_LIMIT,
            maxBytes: SAFE_DEBUG_BYTE_LIMIT,
            droppedEvents,
            truncated,
        },
        generation: {
            taskId: safeOpaqueId(source.taskId),
            phase,
            currentIndex: safeCount(source.currentIndex),
            plannerAttempt: safeCount(source.plannerAttempt),
            plannerReplan: !!source.plannerReplan,
            files: summarizeFiles(files),
            debug: summarizeGenerationDebug(debugValues),
        },
        learning: {
            current: {
                jobId: safeOpaqueId(progress.jobId),
                status: safeStatus(progress.status) ?? "idle",
                revision: safeCount(progress.revision, Number.MAX_SAFE_INTEGER),
                reasonCode: safeReasonCode(progress.reasonCode),
                totalNeeds: safeCount(progress.totalNeeds),
                completedNeeds: safeCount(progress.completedNeeds),
                sourceCount: safeCount(progress.sourceCount),
            },
            stages,
            events,
        },
        build: {
            diagnostics: summarizeBuildDiagnostics(diagnostics),
        },
    });

    let payload = makePayload();
    while (events.length && serializedBytes(payload) > SAFE_DEBUG_BYTE_LIMIT) {
        const ordinaryIndex = events.findIndex((event) => !isPriorityLearningEvent(event));
        events.splice(ordinaryIndex >= 0 ? ordinaryIndex : 0, 1);
        droppedEvents++;
        truncated = true;
        payload = makePayload();
    }

    if (serializedBytes(payload) > SAFE_DEBUG_BYTE_LIMIT) {
        payload.generation.debug.summaries = [];
        payload.redaction.truncated = true;
    }
    if (serializedBytes(payload) > SAFE_DEBUG_BYTE_LIMIT) {
        for (const stage of payload.learning.stages) delete stage.telemetry;
        payload.redaction.truncated = true;
    }
    return payload;
}
