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
    "nms",
    "craftbukkit",
    "version_reflection",
    "external_plugin",
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
    integrationKind: "nms" | "craftbukkit" | "version_reflection" | "external_plugin";
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
    title: string;
    sourceType: string;
    authority: string;
}

function text(value: unknown, max: number): string {
    return typeof value === "string" ? value.trim().slice(0, max) : "";
}

function count(value: unknown): number {
    const number = Number(value);
    return Number.isFinite(number) && number >= 0 ? number : 0;
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
    return {
        knowledgeId,
        summary: text(raw.summary, 1_000),
        kind: text(raw.kind, 40),
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
    return {
        needId: text(raw.needId, 100),
        question: text(raw.question, 500),
        url: text(raw.url, 2_000),
        canonicalUrl: text(raw.canonicalUrl, 2_000) || undefined,
        reason: text(raw.reason, 240),
        status,
        ...(rejectionCode ? { rejectionCode } : {}),
        title: text(raw.title, 300),
        sourceType: text(raw.sourceType, 80) || "unclassified",
        authority: text(raw.authority, 80) || "unclassified",
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
    cache: boolean;
}

export function resolveLearningEvidenceResult(
    items: unknown,
    serverStatus: unknown,
    expectedIdentity: LearningEvidenceIdentity,
    responseIdentity: LearningEvidenceIdentity,
    searchedSources?: unknown,
): LearningEvidenceResultState {
    const identityMatches = isMatchingLearningEvidenceIdentity(expectedIdentity, responseIdentity);
    const acceptedItems = identityMatches && Array.isArray(items)
        ? items.map(normalizeEvidenceItem).filter((item): item is LearningEvidenceItem => !!item)
        : [];
    const acceptedSources = identityMatches && Array.isArray(searchedSources)
        ? searchedSources.map(normalizeSearchedSource).filter((item): item is LearningSearchedSource => !!item)
        : [];
    return {
        identityMatches,
        items: acceptedItems,
        searchedSources: acceptedSources,
        cache: identityMatches
            && (acceptedItems.length > 0
                || acceptedSources.length > 0
                || isLearningEvidenceTerminalStatus(serverStatus)),
    };
}

export function shouldCacheLearningEvidenceResult(
    items: unknown,
    serverStatus: unknown,
    expectedIdentity: LearningEvidenceIdentity,
    responseIdentity: LearningEvidenceIdentity,
    searchedSources?: unknown,
): boolean {
    return resolveLearningEvidenceResult(
        items,
        serverStatus,
        expectedIdentity,
        responseIdentity,
        searchedSources,
    ).cache;
}
