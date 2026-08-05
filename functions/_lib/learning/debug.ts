import type {
    LearningDebugMeta,
    LearningJobRecord,
    LearningJobTelemetry,
    LearningReasonCode,
} from "./types";

const REASON_CODES = new Set<LearningReasonCode>([
    "no_learning_needed",
    "static_contract_covered",
    "knowledge_cache_hit",
    "responses_not_configured",
    "auto_learning_disabled",
    "glm_auto_learning_disabled",
    "quota_exhausted",
    "discovery_timeout",
    "discovery_network",
    "discovery_http",
    "discovery_provider_incomplete",
    "discovery_provider_failed",
    "discovery_invalid_response",
    "no_candidate_sources",
    "no_fetchable_sources",
    "source_fetch_timeout",
    "verification_no_sources",
    "verification_timeout",
    "verification_http",
    "verification_invalid_response",
    "verification_failed",
    "unresolved_knowledge_needs",
    "revision_conflict",
    "lease_conflict",
    "storage_unavailable",
    "job_deadline",
    "client_deadline",
    "client_network",
    "internal_error",
]);

const LEGACY_REASONS: Record<string, LearningReasonCode> = {
    auto_learning_unavailable: "auto_learning_disabled",
    "DeepSeek API key is not configured": "responses_not_configured",
    "No knowledge needs to discover": "no_learning_needed",
};

const REASON_MESSAGES: Record<LearningReasonCode, string> = {
    no_learning_needed: "当前需求没有需要联网查证的技术缺口",
    static_contract_covered: "已有静态 API 契约覆盖技术缺口，无需联网查证",
    knowledge_cache_hit: "已复用经过验证的公共知识",
    responses_not_configured: "资料发现服务尚未配置，已按现有知识继续",
    auto_learning_disabled: "站点未启用自动联网学习，已按现有知识继续",
    glm_auto_learning_disabled: "GLM BYOK 不触发自动联网学习，已按现有知识继续",
    quota_exhausted: "当前任务额度已用尽，联网学习已停止",
    discovery_timeout: "资料发现服务响应超时，已按现有知识继续",
    discovery_network: "资料发现服务暂时无法连接，已按现有知识继续",
    discovery_http: "资料发现服务暂时不可用，已按现有知识继续",
    discovery_provider_incomplete: "资料发现服务未完成本次检索，已按现有知识继续",
    discovery_provider_failed: "资料发现服务未能完成本次检索，已按现有知识继续",
    discovery_invalid_response: "资料发现结果格式无效，已按现有知识继续",
    no_candidate_sources: "未找到可重新抓取的公开来源，已按现有知识继续",
    no_fetchable_sources: "候选来源无法安全读取，已按现有知识继续",
    source_fetch_timeout: "候选来源抓取超时，已按现有知识继续",
    verification_no_sources: "没有可供验证的公开证据，已按现有知识继续",
    verification_timeout: "技术证据验证超时，已按现有知识继续",
    verification_http: "技术证据验证服务暂时不可用，已按现有知识继续",
    verification_invalid_response: "技术证据验证结果格式无效，已按现有知识继续",
    verification_failed: "技术证据验证未完成，已按现有知识继续",
    unresolved_knowledge_needs: "部分技术缺口没有形成可采用结论，已按现有知识继续",
    revision_conflict: "学习任务已由另一请求推进，正在对账最新状态",
    lease_conflict: "学习任务正在由另一请求处理，正在对账最新状态",
    storage_unavailable: "学习存储暂不可用，已按现有知识继续",
    job_deadline: "本轮联网查证已进入 5 分钟收尾期限，已按现有知识继续",
    client_deadline: "浏览器未在本轮时限内确认联网查证结果，已按现有知识继续",
    client_network: "浏览器暂时无法确认联网查证状态，已按现有知识继续",
    internal_error: "联网学习未完成，已按现有知识继续",
};

function count(value: unknown): number {
    const number = Number(value);
    return Number.isFinite(number) && number > 0
        ? Math.min(1_000_000_000, Math.floor(number))
        : 0;
}

export function emptyLearningTelemetry(): LearningJobTelemetry {
    return {
        version: 1,
        discoveryAttempts: 0,
        discoveryElapsedMs: 0,
        discoveryTimeouts: 0,
        discoveryRetryableFailures: 0,
        discoveryLastHttpStatus: 0,
        discoveryLastProviderStatus: "unknown",
        candidateNeedCount: 0,
        candidateUrlCount: 0,
        sourceAttempts: 0,
        sourceAccepted: 0,
        sourceRejected: 0,
        sourceInvalid: 0,
        sourceDeduplicated: 0,
        sourceTimeouts: 0,
        sourceHttp4xx: 0,
        sourceHttp5xx: 0,
        sourceTooLarge: 0,
        sourceUnsupportedContentType: 0,
        sourceTooThin: 0,
        sourceElapsedMs: 0,
        sourceBudgetExhausted: 0,
        verificationAttempts: 0,
        verificationCompleted: 0,
        verificationSupported: 0,
        verificationContradicted: 0,
        verificationInsufficient: 0,
        verificationFailures: 0,
        verificationTimeouts: 0,
        verificationHttp4xx: 0,
        verificationHttp5xx: 0,
        verificationInvalidResponses: 0,
        verificationElapsedMs: 0,
    };
}

export function normalizeLearningTelemetry(value: unknown): LearningJobTelemetry {
    const raw = value && typeof value === "object" ? value as Record<string, unknown> : {};
    const providerStatus = raw.discoveryLastProviderStatus;
    return {
        version: 1,
        discoveryAttempts: count(raw.discoveryAttempts),
        discoveryElapsedMs: count(raw.discoveryElapsedMs),
        discoveryTimeouts: count(raw.discoveryTimeouts),
        discoveryRetryableFailures: count(raw.discoveryRetryableFailures),
        discoveryLastHttpStatus: count(raw.discoveryLastHttpStatus),
        discoveryLastProviderStatus: providerStatus === "completed"
            || providerStatus === "incomplete"
            || providerStatus === "failed"
            ? providerStatus
            : "unknown",
        candidateNeedCount: count(raw.candidateNeedCount),
        candidateUrlCount: count(raw.candidateUrlCount),
        sourceAttempts: count(raw.sourceAttempts),
        sourceAccepted: count(raw.sourceAccepted),
        sourceRejected: count(raw.sourceRejected),
        sourceInvalid: count(raw.sourceInvalid),
        sourceDeduplicated: count(raw.sourceDeduplicated),
        sourceTimeouts: count(raw.sourceTimeouts),
        sourceHttp4xx: count(raw.sourceHttp4xx),
        sourceHttp5xx: count(raw.sourceHttp5xx),
        sourceTooLarge: count(raw.sourceTooLarge),
        sourceUnsupportedContentType: count(raw.sourceUnsupportedContentType),
        sourceTooThin: count(raw.sourceTooThin),
        sourceElapsedMs: count(raw.sourceElapsedMs),
        sourceBudgetExhausted: count(raw.sourceBudgetExhausted),
        verificationAttempts: count(raw.verificationAttempts),
        verificationCompleted: count(raw.verificationCompleted),
        verificationSupported: count(raw.verificationSupported),
        verificationContradicted: count(raw.verificationContradicted),
        verificationInsufficient: count(raw.verificationInsufficient),
        verificationFailures: count(raw.verificationFailures),
        verificationTimeouts: count(raw.verificationTimeouts),
        verificationHttp4xx: count(raw.verificationHttp4xx),
        verificationHttp5xx: count(raw.verificationHttp5xx),
        verificationInvalidResponses: count(raw.verificationInvalidResponses),
        verificationElapsedMs: count(raw.verificationElapsedMs),
    };
}

export function normalizeLearningReasonCode(
    value: unknown,
    fallback?: LearningReasonCode,
): LearningReasonCode | undefined {
    if (typeof value !== "string" || !value) return fallback;
    if (REASON_CODES.has(value as LearningReasonCode)) return value as LearningReasonCode;
    return LEGACY_REASONS[value] ?? fallback ?? "internal_error";
}

export function learningReasonMessage(reasonCode: LearningReasonCode): string {
    return REASON_MESSAGES[reasonCode];
}

export function buildLearningDebugMeta(
    job: LearningJobRecord,
    options: {
        reasonCode?: LearningReasonCode;
        status?: LearningJobRecord["status"];
    } = {},
): LearningDebugMeta {
    const status = options.status ?? job.status;
    const terminalFallback = status === "deferred" || status === "failed" || status === "cancelled"
        ? "internal_error"
        : undefined;
    return {
        schemaVersion: "learning.debug.v1",
        jobId: job.jobId,
        stage: job.stage,
        status,
        revision: job.revision,
        reasonCode: options.reasonCode ?? normalizeLearningReasonCode(job.error, terminalFallback),
        updatedAt: job.updatedAt,
        telemetry: normalizeLearningTelemetry(job.work.telemetry),
    };
}
