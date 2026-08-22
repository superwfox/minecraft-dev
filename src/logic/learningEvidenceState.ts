const TERMINAL_LEARNING_EVIDENCE_STATUSES = new Set([
    "ready",
    "deferred",
    "needs_review",
    "failed",
    "cancelled",
]);
const SEARCHED_SOURCE_STATUSES = new Set([
    "discovered",
    "fetched",
    "supports",
    "contradicts",
    "rejected",
    "skipped",
]);
const SOURCE_REJECTION_CODES = new Set([
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
const INTEGRATION_KINDS = new Set([
    "public_api",
    "nms",
    "craftbukkit",
    "version_reflection",
    "external_plugin",
]);
const DIAGNOSTIC_STAGES = new Set([
    "discovery",
    "fetch",
    "privacy",
    "verification",
    "activation",
]);
const DIAGNOSTIC_STATUSES = new Set([
    "info",
    "success",
    "warning",
    "error",
    "skipped",
]);

export interface LearningEvidenceIdentity {
    jobId: string;
    stage: string;
    revision: number;
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
    code: string;
    message: string;
}

export interface ImplementationRecipe {
    schemaVersion: "implementation_recipe.v1";
    language: "java";
    integrationKind: "public_api" | "nms" | "craftbukkit" | "version_reflection" | "external_plugin";
    title: string;
    code: string;
    imports: string[];
    versionScope: string;
    prerequisites: string[];
    notes: string[];
    sourceIds: string[];
}

export interface LearningEvidenceItem {
    knowledgeId: string;
    summary: string;
    kind: string;
    answerType?: "signature" | "coordinate" | "behavior" | "migration" | "rule";
    confidence: number;
    status: string;
    scope: unknown;
    reason?: LearningEvidenceReason;
    recipe?: ImplementationRecipe;
    sources: LearningEvidenceSource[];
}

export interface LearningSearchedSource {
    needId: string;
    question: string;
    url: string;
    canonicalUrl?: string;
    reason: string;
    status: "discovered" | "fetched" | "supports" | "contradicts" | "rejected" | "skipped";
    rejectionCode?: string;
    detailCode?: string;
    httpStatus?: number;
    contentType?: string;
    byteCount?: number;
    elapsedMs?: number;
    title: string;
    sourceType: string;
    authority: string;
}

export interface LearningDiagnosticEvent {
    at: number;
    stage: "discovery" | "fetch" | "privacy" | "verification" | "activation";
    status: "info" | "success" | "warning" | "error" | "skipped";
    code: string;
    message: string;
    needId?: string;
    query?: string;
    url?: string;
    httpStatus?: number;
    contentType?: string;
    byteCount?: number;
    elapsedMs?: number;
}

function text(value: unknown, max: number): string {
    return typeof value === "string" ? value.trim().slice(0, max) : "";
}

function count(value: unknown): number {
    const number = Number(value);
    return Number.isFinite(number) && number >= 0 ? number : 0;
}

function optionalCount(value: unknown, max = 1_000_000_000): number | undefined {
    const number = Number(value);
    return Number.isFinite(number) && number >= 0
        ? Math.min(max, Math.floor(number))
        : undefined;
}

function boundedText(value: unknown, max: number): string {
    if (typeof value !== "string" || /[\x00-\x08\x0b\x0c\x0e-\x1f]/.test(value)) return "";
    const normalized = value.trim();
    return normalized.length <= max ? normalized : "";
}

function textList(value: unknown, maxItems: number, maxLength: number): string[] | null {
    if (!Array.isArray(value) || value.length === 0 || value.length > maxItems) return null;
    const items = value.map(item => boundedText(item, maxLength));
    return items.every(Boolean) ? items : null;
}

function normalizeRecipe(value: unknown): ImplementationRecipe | undefined {
    if (!value || typeof value !== "object" || Array.isArray(value)) return undefined;
    const raw = value as Record<string, unknown>;
    const integrationKind = typeof raw.integrationKind === "string" && INTEGRATION_KINDS.has(raw.integrationKind)
        ? raw.integrationKind as ImplementationRecipe["integrationKind"]
        : undefined;
    const imports = textList(raw.imports, 24, 240);
    const prerequisites = textList(raw.prerequisites, 8, 400);
    const notes = textList(raw.notes, 8, 500);
    const sourceIds = textList(raw.sourceIds, 6, 100);
    const title = boundedText(raw.title, 160);
    const code = boundedText(raw.code, 10_000);
    const versionScope = boundedText(raw.versionScope, 300);
    if (raw.schemaVersion !== "implementation_recipe.v1"
        || raw.language !== "java"
        || !integrationKind
        || !imports
        || !prerequisites
        || !notes
        || !sourceIds
        || !title
        || !code
        || !versionScope) return undefined;
    return {
        schemaVersion: "implementation_recipe.v1",
        language: "java",
        integrationKind,
        title,
        code,
        imports,
        versionScope,
        prerequisites,
        notes,
        sourceIds,
    };
}

function httpsUrl(value: unknown): string {
    const raw = text(value, 2_000);
    if (!raw) return "";
    try {
        const url = new URL(raw);
        return url.protocol === "https:" && !url.username && !url.password ? url.href : "";
    } catch {
        return "";
    }
}

function normalizeEvidenceSource(value: unknown): LearningEvidenceSource | null {
    if (!value || typeof value !== "object" || Array.isArray(value)) return null;
    const raw = value as Record<string, unknown>;
    const sourceId = text(raw.sourceId, 100);
    const url = httpsUrl(raw.url);
    if (!sourceId || !url) return null;
    return {
        sourceId,
        title: text(raw.title, 300) || url,
        url,
        sourceType: text(raw.sourceType, 80) || "unclassified",
        authority: text(raw.authority, 80) || "unclassified",
        publishedAt: count(raw.publishedAt) || undefined,
        fetchedAt: count(raw.fetchedAt),
        excerpt: text(raw.excerpt, 1_500),
        relation: text(raw.relation, 40),
    };
}

function normalizeEvidenceItem(value: unknown): LearningEvidenceItem | null {
    if (!value || typeof value !== "object" || Array.isArray(value)) return null;
    const raw = value as Record<string, unknown>;
    const knowledgeId = text(raw.knowledgeId, 100);
    if (!knowledgeId) return null;
    const rawReason = raw.reason && typeof raw.reason === "object" && !Array.isArray(raw.reason)
        ? raw.reason as Record<string, unknown>
        : null;
    const reasonCode = text(rawReason?.code, 80);
    const reasonMessage = text(rawReason?.message, 500);
    const recipe = normalizeRecipe(raw.recipe);
    const answerType = raw.answerType === "signature"
        || raw.answerType === "coordinate"
        || raw.answerType === "behavior"
        || raw.answerType === "migration"
        || raw.answerType === "rule"
        ? raw.answerType
        : undefined;
    return {
        knowledgeId,
        summary: text(raw.summary, 1_000),
        kind: text(raw.kind, 40),
        ...(answerType ? { answerType } : {}),
        confidence: Math.min(1, count(raw.confidence)),
        status: text(raw.status, 40),
        scope: raw.scope,
        ...(reasonCode && reasonMessage ? { reason: { code: reasonCode, message: reasonMessage } } : {}),
        ...(recipe ? { recipe } : {}),
        sources: Array.isArray(raw.sources)
            ? raw.sources.map(normalizeEvidenceSource).filter((item): item is LearningEvidenceSource => !!item)
            : [],
    };
}

function normalizeSearchedSource(value: unknown): LearningSearchedSource | null {
    if (!value || typeof value !== "object" || Array.isArray(value)) return null;
    const raw = value as Record<string, unknown>;
    const status = typeof raw.status === "string" && SEARCHED_SOURCE_STATUSES.has(raw.status)
        ? raw.status as LearningSearchedSource["status"]
        : undefined;
    if (!status) return null;
    const rejectionCode = typeof raw.rejectionCode === "string" && SOURCE_REJECTION_CODES.has(raw.rejectionCode)
        ? raw.rejectionCode
        : undefined;
    const detailCode = text(raw.detailCode, 100);
    const httpStatus = optionalCount(raw.httpStatus, 999);
    const contentType = text(raw.contentType, 120);
    const byteCount = optionalCount(raw.byteCount);
    const elapsedMs = optionalCount(raw.elapsedMs, 300_000);
    return {
        needId: text(raw.needId, 100),
        question: text(raw.question, 500),
        url: text(raw.url, 2_000),
        canonicalUrl: text(raw.canonicalUrl, 2_000) || undefined,
        reason: text(raw.reason, 240),
        status,
        ...(rejectionCode ? { rejectionCode } : {}),
        ...(detailCode ? { detailCode } : {}),
        ...(httpStatus !== undefined ? { httpStatus } : {}),
        ...(contentType ? { contentType } : {}),
        ...(byteCount !== undefined ? { byteCount } : {}),
        ...(elapsedMs !== undefined ? { elapsedMs } : {}),
        title: text(raw.title, 300),
        sourceType: text(raw.sourceType, 80) || "unclassified",
        authority: text(raw.authority, 80) || "unclassified",
    };
}

function normalizeDiagnostic(value: unknown): LearningDiagnosticEvent | null {
    if (!value || typeof value !== "object" || Array.isArray(value)) return null;
    const raw = value as Record<string, unknown>;
    const stage = typeof raw.stage === "string" && DIAGNOSTIC_STAGES.has(raw.stage)
        ? raw.stage as LearningDiagnosticEvent["stage"]
        : undefined;
    const status = typeof raw.status === "string" && DIAGNOSTIC_STATUSES.has(raw.status)
        ? raw.status as LearningDiagnosticEvent["status"]
        : undefined;
    const code = text(raw.code, 100);
    const message = text(raw.message, 600);
    if (!stage || !status || !code || !message) return null;
    const url = httpsUrl(raw.url);
    return {
        at: optionalCount(raw.at, 8_640_000_000_000_000) ?? 0,
        stage,
        status,
        code,
        message,
        needId: text(raw.needId, 100) || undefined,
        query: text(raw.query, 500) || undefined,
        url: url || undefined,
        httpStatus: optionalCount(raw.httpStatus, 999),
        contentType: text(raw.contentType, 120) || undefined,
        byteCount: optionalCount(raw.byteCount),
        elapsedMs: optionalCount(raw.elapsedMs, 300_000),
    };
}

export function isLearningEvidenceTerminalStatus(value: unknown): boolean {
    return typeof value === "string" && TERMINAL_LEARNING_EVIDENCE_STATUSES.has(value);
}

export function isMatchingLearningEvidenceIdentity(
    expected: LearningEvidenceIdentity,
    actual: LearningEvidenceIdentity,
): boolean {
    return expected.jobId === actual.jobId
        && expected.stage === actual.stage
        && expected.revision === actual.revision;
}

export interface LearningEvidenceResultState {
    identityMatches: boolean;
    items: LearningEvidenceItem[];
    searchedSources: LearningSearchedSource[];
    diagnostics: LearningDiagnosticEvent[];
    cache: boolean;
}

export function resolveLearningEvidenceResult(
    items: unknown,
    serverStatus: unknown,
    expectedIdentity: LearningEvidenceIdentity,
    responseIdentity: LearningEvidenceIdentity,
    searchedSources?: unknown,
    diagnostics?: unknown,
): LearningEvidenceResultState {
    const identityMatches = isMatchingLearningEvidenceIdentity(expectedIdentity, responseIdentity);
    const acceptedItems = identityMatches && Array.isArray(items)
        ? items.map(normalizeEvidenceItem).filter((item): item is LearningEvidenceItem => !!item)
        : [];
    const acceptedSources = identityMatches && Array.isArray(searchedSources)
        ? searchedSources.map(normalizeSearchedSource).filter((item): item is LearningSearchedSource => !!item)
        : [];
    const acceptedDiagnostics = identityMatches && Array.isArray(diagnostics)
        ? diagnostics.map(normalizeDiagnostic).filter((item): item is LearningDiagnosticEvent => !!item)
        : [];
    return {
        identityMatches,
        items: acceptedItems,
        searchedSources: acceptedSources,
        diagnostics: acceptedDiagnostics,
        cache: identityMatches
            && (acceptedItems.length > 0
                || acceptedSources.length > 0
                || acceptedDiagnostics.length > 0
                || isLearningEvidenceTerminalStatus(serverStatus)),
    };
}

export function shouldCacheLearningEvidenceResult(
    items: unknown,
    serverStatus: unknown,
    expectedIdentity: LearningEvidenceIdentity,
    responseIdentity: LearningEvidenceIdentity,
    searchedSources?: unknown,
    diagnostics?: unknown,
): boolean {
    return resolveLearningEvidenceResult(
        items,
        serverStatus,
        expectedIdentity,
        responseIdentity,
        searchedSources,
        diagnostics,
    ).cache;
}
