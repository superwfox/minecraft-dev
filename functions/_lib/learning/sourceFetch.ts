import {
    LEARNING_SOURCE_LIMIT_MS,
    LEARNING_SOURCE_TIMEOUT_MS,
} from "./deadline";
import type {
    KnowledgeNeed,
    LearningCandidate,
    LearningReasonCode,
    LearningSearchedSource,
    LearningSourceRecord,
    LearningSourceRejectionCode,
} from "./types";

const MAX_REDIRECTS = 3;
const MAX_CANDIDATE_NEEDS = 3;
const MAX_CANDIDATE_SOURCES_PER_NEED = 3;
const MAX_CANDIDATE_URL_LENGTH = 2_000;
const MIN_CANDIDATE_REASON_LENGTH = 8;
const MAX_CANDIDATE_REASON_LENGTH = 240;
const MAX_BYTES = 256 * 1024;
const DEFAULT_TIMEOUT_MS = LEARNING_SOURCE_TIMEOUT_MS;
const DEFAULT_BUDGET_MS = LEARNING_SOURCE_LIMIT_MS;
const MAX_BUDGET_MS = LEARNING_SOURCE_LIMIT_MS;
const ALLOWED_CONTENT_TYPES = [
    "text/html",
    "text/plain",
    "application/json",
    "application/xml",
    "text/xml",
];
const SENSITIVE_QUERY_KEYS = new Set([
    "access_token",
    "apikey",
    "api_key",
    "auth",
    "authorization",
    "key",
    "password",
    "signature",
    "sig",
    "token",
]);

const TRUSTED_ARTIFACT_HOSTS = new Set([
    "repo.papermc.io",
    "repo.maven.apache.org",
    "maven.enginehub.org",
    "repo.extendedclip.com",
]);
const OFFICIAL_DOCUMENTATION_HOSTS = new Set([
    "papermc.io",
    "docs.papermc.io",
    "jd.papermc.io",
    "hub.spigotmc.org",
]);
const OFFICIAL_GITHUB_REPOSITORIES = new Set([
    "enginehub/worldedit",
    "enginehub/worldguard",
    "milkbowl/vaultapi",
    "papermc/paper",
    "placeholderapi/placeholderapi",
    "spigotmc/spigot-api",
]);

function isIpLiteral(hostname: string): boolean {
    const normalized = hostname.replace(/^\[|\]$/g, "");
    if (normalized.includes(":")) return true;
    const parts = normalized.split(".");
    return parts.length === 4
        && parts.every((part) => /^\d{1,3}$/.test(part) && Number(part) >= 0 && Number(part) <= 255);
}

function githubRepository(url: URL): string {
    if (url.hostname !== "github.com" && url.hostname !== "raw.githubusercontent.com") return "";
    const parts = url.pathname.split("/").filter(Boolean);
    return parts.length >= 2 ? `${parts[0]}/${parts[1]}`.toLowerCase() : "";
}

function decodedPath(url: URL): string {
    try { return decodeURIComponent(url.pathname); } catch { return url.pathname; }
}

function explicitDependencyCoordinate(need: KnowledgeNeed): {
    groupId: string;
    artifactId: string;
    version: string;
} | null {
    const parts = need.scope.dependency?.split(":").map((part) => part.trim()) ?? [];
    if (parts.length !== 3 || parts.some((part) => !part)) return null;
    const [groupId, artifactId, version] = parts;
    if (!/^[A-Za-z0-9_.-]+$/.test(groupId)
        || !/^[A-Za-z0-9_.-]+$/.test(artifactId)
        || !/^[A-Za-z0-9_.-]+$/.test(version)
        || /(?:^|[._-])x(?:$|[._-])/i.test(version)
        || /^(?:latest|release)(?:[._-]|$)/i.test(version)) return null;
    return { groupId, artifactId, version };
}

function versionPomMatchesNeed(url: URL, need: KnowledgeNeed): boolean {
    const coordinate = explicitDependencyCoordinate(need);
    if (!coordinate) return false;
    const segments = decodedPath(url).split("/").filter(Boolean);
    const groupSegments = coordinate.groupId.split(".");
    const coordinateStart = segments.length - groupSegments.length - 3;
    if (coordinateStart < 0) return false;
    const artifactId = segments[segments.length - 3];
    const version = segments[segments.length - 2];
    const filename = segments[segments.length - 1];
    return artifactId === coordinate.artifactId
        && version === coordinate.version
        && filename === `${coordinate.artifactId}-${coordinate.version}.pom`
        && groupSegments.every((part, index) => segments[coordinateStart + index] === part);
}

function pathMatchesVersion(path: string, rawVersion: string | undefined): boolean {
    const version = rawVersion?.trim().toLowerCase();
    if (!version) return false;
    return path.split("/").filter(Boolean).some((segment) =>
        segment === version || segment.startsWith(`${version}-`),
    );
}

function javadocOwner(need: KnowledgeNeed): string {
    const symbol = need.scope.symbol?.trim().replace(/\(.*$/, "") ?? "";
    if (!symbol) return "";
    const packageName = need.scope.packageName?.trim().replace(/\.$/, "") ?? "";
    const memberSeparator = symbol.includes("#") ? "#" : symbol.includes("::") ? "::" : "";
    let owner = memberSeparator ? symbol.split(memberSeparator, 1)[0].trim() : symbol;

    if (!memberSeparator) {
        if (packageName && owner.startsWith(`${packageName}.`)) {
            const classParts: string[] = [];
            for (const part of owner.slice(packageName.length + 1).split(".")) {
                if (!classParts.length || /^[A-Z_$]/.test(part)) classParts.push(part);
                else break;
            }
            if (classParts.length) owner = `${packageName}.${classParts.join(".")}`;
        } else {
            const parts = owner.split(".");
            const last = parts[parts.length - 1] ?? "";
            if (parts.length > 1 && /^[a-z_$]/.test(last)) owner = parts.slice(0, -1).join(".");
        }
    }

    if (packageName && !owner.startsWith(`${packageName}.`) && /^[A-Z_$]/.test(owner)) {
        owner = `${packageName}.${owner}`;
    }
    return owner;
}

function javadocMatchesNeed(url: URL, need: KnowledgeNeed): boolean {
    const owner = javadocOwner(need);
    if (!owner) return false;
    const ownerParts = owner.split(".").filter(Boolean);
    let packageLength = 0;
    const packageName = need.scope.packageName?.trim().replace(/\.$/, "") ?? "";
    if (packageName && owner.startsWith(`${packageName}.`)) {
        packageLength = packageName.split(".").filter(Boolean).length;
    } else {
        while (packageLength < ownerParts.length && /^[a-z_$]/.test(ownerParts[packageLength])) {
            packageLength++;
        }
    }
    const classParts = ownerParts.slice(packageLength);
    if (!classParts.length || !/^[A-Z_$]/.test(classParts[0])) return false;
    const expectedPath = [
        ...ownerParts.slice(0, packageLength),
        classParts.join("."),
    ].join("/").toLowerCase();
    return decodedPath(url).toLowerCase().endsWith(`/${expectedPath}.html`);
}

export function publicLearningCandidateUrl(raw: string): string {
    let url: URL;
    try { url = new URL(raw.trim()); } catch { return ""; }
    url.username = "";
    url.password = "";
    url.hash = "";
    for (const key of [...url.searchParams.keys()]) {
        if (SENSITIVE_QUERY_KEYS.has(key.toLowerCase())) url.searchParams.delete(key);
    }
    return url.href.slice(0, 2_000);
}

export function validatePublicSourceUrl(raw: string): URL {
    let url: URL;
    try { url = new URL(raw); } catch { throw new Error("invalid_url"); }
    if (url.protocol !== "https:") throw new Error("https_required");
    if (url.username || url.password) throw new Error("credentials_forbidden");
    if (url.port && url.port !== "443") throw new Error("port_forbidden");
    const hostname = url.hostname.toLowerCase().replace(/\.$/, "");
    if (!hostname || hostname === "localhost" || hostname.endsWith(".localhost")) throw new Error("localhost_forbidden");
    if (hostname === "metadata.google.internal") throw new Error("metadata_forbidden");
    if ([".local", ".internal", ".home", ".lan"].some((suffix) => hostname.endsWith(suffix))) {
        throw new Error("private_hostname_forbidden");
    }
    if (isIpLiteral(hostname)) throw new Error("ip_literal_forbidden");
    url.hash = "";
    for (const key of [...url.searchParams.keys()]) {
        if (SENSITIVE_QUERY_KEYS.has(key.toLowerCase())) url.searchParams.delete(key);
    }
    return url;
}

function sourceClassification(url: URL, need: KnowledgeNeed): { sourceType: string; authority: string } {
    const host = url.hostname.toLowerCase();
    const path = decodedPath(url).toLowerCase();
    const isPom = path.endsWith(".pom");
    const isMavenMetadata = path.endsWith("maven-metadata.xml");
    const isPinnedGithubCommit = (host === "github.com" && /\/blob\/[0-9a-f]{40}\//.test(path))
        || (host === "raw.githubusercontent.com" && /\/[0-9a-f]{40}\//.test(path));
    const isGithubRelease = host === "github.com" && /\/releases\/tag\//.test(path);
    const isTrustedArtifactHost = TRUSTED_ARTIFACT_HOSTS.has(host);
    const isOfficial = isTrustedArtifactHost || OFFICIAL_DOCUMENTATION_HOSTS.has(host);
    const isOfficialGithubRelease = isGithubRelease
        && OFFICIAL_GITHUB_REPOSITORIES.has(githubRepository(url));
    if (isMavenMetadata) {
        return {
            sourceType: "artifact",
            authority: isTrustedArtifactHost ? "official" : "secondary",
        };
    }
    if (isPom) {
        return {
            sourceType: "artifact",
            authority: isTrustedArtifactHost && versionPomMatchesNeed(url, need)
                ? "ground_truth"
                : isTrustedArtifactHost ? "official" : "secondary",
        };
    }
    if (isPinnedGithubCommit) {
        // SHA 外形不能证明提交属于上游受信任 ref；fork network 中的对象不得自动升级权威性。
        return { sourceType: "repository", authority: "secondary" };
    }
    if (isGithubRelease) {
        return {
            sourceType: "release",
            authority: isOfficialGithubRelease ? "official" : "secondary",
        };
    }
    if (path.includes("javadoc") || host.startsWith("jd.")) {
        const versionBound = pathMatchesVersion(path, need.scope.mcVersion);
        const symbolBound = javadocMatchesNeed(url, need);
        return {
            sourceType: "javadoc",
            authority: isOfficial && versionBound && symbolBound ? "ground_truth" : isOfficial ? "official" : "secondary",
        };
    }
    if (path.includes("release") || path.includes("migration") || path.includes("changelog")) {
        return { sourceType: "release", authority: isOfficial ? "official" : "secondary" };
    }
    if (isOfficial) return { sourceType: "documentation", authority: "official" };
    if (host === "github.com" || host === "raw.githubusercontent.com") {
        return { sourceType: "repository", authority: "secondary" };
    }
    return { sourceType: "community", authority: "untrusted" };
}

function htmlToText(raw: string): { title: string; text: string } {
    const title = raw.match(/<title\b[^>]*>([\s\S]*?)<\/title>/i)?.[1] ?? "";
    const withoutNoise = raw
        .replace(/<script\b[^>]*>[\s\S]*?<\/script>/gi, " ")
        .replace(/<style\b[^>]*>[\s\S]*?<\/style>/gi, " ")
        .replace(/<!--[\s\S]*?-->/g, " ")
        .replace(/<[^>]+>/g, " ");
    const decode = (value: string) => value
        .replace(/&nbsp;/gi, " ")
        .replace(/&amp;/gi, "&")
        .replace(/&lt;/gi, "<")
        .replace(/&gt;/gi, ">")
        .replace(/&quot;/gi, '"')
        .replace(/&#39;/gi, "'")
        .replace(/\s+/g, " ")
        .trim();
    return { title: decode(title).slice(0, 300), text: decode(withoutNoise) };
}

async function sha256(value: string): Promise<string> {
    const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(value));
    return [...new Uint8Array(digest)].map((byte) => byte.toString(16).padStart(2, "0")).join("");
}

async function readLimitedBody(response: Response, controller: AbortController): Promise<Uint8Array> {
    if (!response.body) {
        const bytes = new Uint8Array(await response.arrayBuffer());
        if (bytes.byteLength > MAX_BYTES) throw new Error("source_too_large");
        return bytes;
    }

    const reader = response.body.getReader();
    const chunks: Uint8Array[] = [];
    let total = 0;
    try {
        while (true) {
            const { done, value } = await reader.read();
            if (done) break;
            if (!value?.byteLength) continue;
            total += value.byteLength;
            if (total > MAX_BYTES) {
                controller.abort();
                await reader.cancel("source_too_large").catch(() => undefined);
                throw new Error("source_too_large");
            }
            chunks.push(value);
        }
    } finally {
        reader.releaseLock();
    }

    const bytes = new Uint8Array(total);
    let offset = 0;
    for (const chunk of chunks) {
        bytes.set(chunk, offset);
        offset += chunk.byteLength;
    }
    return bytes;
}

async function fetchOne(
    initialUrl: string,
    fetchImpl: typeof fetch,
    controller: AbortController,
): Promise<{ url: URL; contentType: string; text: string }> {
    let url = validatePublicSourceUrl(initialUrl);
    for (let redirects = 0; redirects <= MAX_REDIRECTS; redirects++) {
        const response = await fetchImpl(url.href, {
            method: "GET",
            redirect: "manual",
            headers: {
                Accept: "text/html,text/plain,application/json,application/xml;q=0.8,text/xml;q=0.8",
                "User-Agent": "TAHAI-Learning/1.0",
            },
            signal: controller.signal,
        });
        if (response.status >= 300 && response.status < 400) {
            const location = response.headers.get("Location");
            if (!location || redirects >= MAX_REDIRECTS) throw new Error("redirect_limit");
            url = validatePublicSourceUrl(new URL(location, url).href);
            continue;
        }
        if (!response.ok) throw new Error(`source_http_${response.status}`);
        const contentType = (response.headers.get("Content-Type") || "").split(";", 1)[0].trim().toLowerCase();
        if (!ALLOWED_CONTENT_TYPES.includes(contentType)) throw new Error("unsupported_content_type");
        const declaredSize = Number(response.headers.get("Content-Length") || 0);
        if (declaredSize > MAX_BYTES) throw new Error("source_too_large");
        const bytes = await readLimitedBody(response, controller);
        return { url, contentType, text: new TextDecoder().decode(bytes) };
    }
    throw new Error("redirect_limit");
}

function ensureSourceDeadline(controller: AbortController, deadlineAt: number): void {
    if (!controller.signal.aborted && Date.now() < deadlineAt) return;
    controller.abort();
    throw new DOMException("Aborted", "AbortError");
}

export async function fetchLearningSource(input: {
    jobId: string;
    need: KnowledgeNeed;
    url: string;
    fetchImpl?: typeof fetch;
    timeoutMs?: number;
    now?: number;
}): Promise<LearningSourceRecord> {
    const configuredTimeout = Number(input.timeoutMs);
    const timeoutMs = Number.isFinite(configuredTimeout) && configuredTimeout > 0
        ? Math.min(DEFAULT_TIMEOUT_MS, Math.floor(configuredTimeout))
        : DEFAULT_TIMEOUT_MS;
    const deadlineAt = Date.now() + timeoutMs;
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    try {
        const fetched = await fetchOne(input.url, input.fetchImpl ?? fetch, controller);
        ensureSourceDeadline(controller, deadlineAt);
        const isHtml = fetched.contentType === "text/html";
        const normalized = isHtml
            ? htmlToText(fetched.text)
            : { title: "", text: fetched.text.replace(/\s+/g, " ").trim() };
        ensureSourceDeadline(controller, deadlineAt);
        const excerpt = normalized.text.slice(0, 24_000);
        if (excerpt.length < 40) throw new Error("source_too_thin");
        const classification = sourceClassification(fetched.url, input.need);
        const canonicalUrl = fetched.url.href;
        const [contentHash, sourceKey] = await Promise.all([
            sha256(excerpt),
            sha256(JSON.stringify([input.jobId, input.need.id, canonicalUrl])),
        ]);
        ensureSourceDeadline(controller, deadlineAt);
        return {
            sourceId: `src_${sourceKey}`,
            jobId: input.jobId,
            needId: input.need.id,
            canonicalUrl,
            domain: fetched.url.hostname.toLowerCase(),
            sourceType: classification.sourceType,
            authority: classification.authority,
            title: normalized.title || fetched.url.hostname,
            fetchedAt: input.now ?? Date.now(),
            contentHash,
            excerpt,
            verificationState: "pending",
        };
    } finally {
        clearTimeout(timer);
    }
}

export interface LearningSourceFetchTelemetry {
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
}

export function learningNoSourcesReason(
    telemetry: Pick<LearningSourceFetchTelemetry, "sourceTimeouts" | "sourceBudgetExhausted">,
    clippedByJobDeadline: boolean,
): LearningReasonCode {
    if (telemetry.sourceBudgetExhausted > 0 && clippedByJobDeadline) return "job_deadline";
    if (telemetry.sourceBudgetExhausted > 0 || telemetry.sourceTimeouts > 0) return "source_fetch_timeout";
    return "no_fetchable_sources";
}

function recordSourceFailure(
    telemetry: LearningSourceFetchTelemetry,
    error: unknown,
): LearningSourceRejectionCode {
    telemetry.sourceRejected++;
    const name = error && typeof error === "object" ? String((error as { name?: unknown }).name || "") : "";
    const code = error && typeof error === "object" ? String((error as { message?: unknown }).message || "") : "";
    if (name === "AbortError") {
        telemetry.sourceTimeouts++;
        return "timeout";
    }
    if (/^source_http_4\d\d$/.test(code)) {
        telemetry.sourceHttp4xx++;
        return "http_4xx";
    }
    if (/^source_http_5\d\d$/.test(code)) {
        telemetry.sourceHttp5xx++;
        return "http_5xx";
    }
    if (code === "source_too_large") {
        telemetry.sourceTooLarge++;
        return "too_large";
    }
    if (code === "unsupported_content_type") {
        telemetry.sourceUnsupportedContentType++;
        return "unsupported_type";
    }
    if (code === "source_too_thin") {
        telemetry.sourceTooThin++;
        return "too_thin";
    }
    telemetry.sourceInvalid++;
    return "invalid_url";
}

function candidateSources(candidate: LearningCandidate): Array<{ url: string; reason: string }> {
    if (Array.isArray(candidate.sources)) return candidate.sources;
    return Array.isArray(candidate.urls)
        ? candidate.urls.map((url) => ({
            url,
            reason: "旧版发现结果未记录该 URL 的搜索理由",
        }))
        : [];
}

function assertLearningCandidateBounds(
    needs: KnowledgeNeed[],
    candidates: LearningCandidate[],
): void {
    if (!Array.isArray(candidates)
        || candidates.length > Math.min(MAX_CANDIDATE_NEEDS, new Set(needs.map((need) => need.id)).size)) {
        throw new Error("learning_candidate_bounds");
    }
    const allowedNeedIds = new Set(needs.map((need) => need.id));
    const seenNeedIds = new Set<string>();
    for (const rawCandidate of candidates as unknown[]) {
        if (!rawCandidate || typeof rawCandidate !== "object" || Array.isArray(rawCandidate)) {
            throw new Error("learning_candidate_bounds");
        }
        const candidate = rawCandidate as LearningCandidate;
        const needId = typeof candidate.needId === "string" ? candidate.needId.trim() : "";
        const hasSources = Array.isArray(candidate.sources);
        const hasLegacyUrls = Array.isArray(candidate.urls);
        if (!allowedNeedIds.has(needId)
            || seenNeedIds.has(needId)
            || hasSources === hasLegacyUrls) {
            throw new Error("learning_candidate_bounds");
        }
        seenNeedIds.add(needId);
        const sources = candidateSources(candidate);
        if (!sources.length || sources.length > MAX_CANDIDATE_SOURCES_PER_NEED) {
            throw new Error("learning_candidate_bounds");
        }
        for (const rawSource of sources as unknown[]) {
            if (!rawSource || typeof rawSource !== "object" || Array.isArray(rawSource)) {
                throw new Error("learning_candidate_bounds");
            }
            const source = rawSource as { url?: unknown; reason?: unknown };
            const url = typeof source.url === "string" ? source.url.trim() : "";
            const reason = typeof source.reason === "string"
                ? source.reason.trim().replace(/\s+/g, " ")
                : "";
            if (!url
                || url.length > MAX_CANDIDATE_URL_LENGTH
                || reason.length < MIN_CANDIDATE_REASON_LENGTH
                || reason.length > MAX_CANDIDATE_REASON_LENGTH) {
                throw new Error("learning_candidate_bounds");
            }
        }
    }
}

export async function fetchLearningSources(input: {
    jobId: string;
    needs: KnowledgeNeed[];
    candidates: LearningCandidate[];
    fetchImpl?: typeof fetch;
    timeoutMs?: number;
    budgetMs?: number;
    maxSources?: number;
}): Promise<{
    sources: LearningSourceRecord[];
    outcomes: LearningSearchedSource[];
    telemetry: LearningSourceFetchTelemetry;
}> {
    assertLearningCandidateBounds(input.needs, input.candidates);
    const startedAt = Date.now();
    const configuredBudget = Number(input.budgetMs);
    const budgetMs = Number.isFinite(configuredBudget) && configuredBudget > 0
        ? Math.min(MAX_BUDGET_MS, Math.floor(configuredBudget))
        : DEFAULT_BUDGET_MS;
    const deadline = startedAt + budgetMs;
    const remainingMs = () => Math.max(0, deadline - Date.now());
    const needs = new Map(input.needs.map((need) => [need.id, need]));
    const entriesByNeed = new Map([...needs.keys()].map((needId) => [needId, [] as Array<{
        url: string;
        reason: string;
        outcomeIndex: number;
    }>]));
    const outcomes: LearningSearchedSource[] = [];
    for (const candidate of input.candidates) {
        const entries = entriesByNeed.get(candidate.needId);
        if (!entries) continue;
        for (const source of candidateSources(candidate)) {
            if (typeof source.url !== "string" || !source.url.trim()) continue;
            const outcomeIndex = outcomes.length;
            const reason = typeof source.reason === "string"
                ? source.reason.trim().replace(/\s+/g, " ").slice(0, 240)
                : "";
            outcomes.push({
                needId: candidate.needId,
                url: publicLearningCandidateUrl(source.url),
                reason: reason || "该候选未提供可用的搜索理由",
                status: "discovered",
            });
            entries.push({ url: source.url.trim(), reason, outcomeIndex });
        }
    }
    const queues = [...needs.values()].map((need) => ({
        need,
        entries: entriesByNeed.get(need.id) ?? [],
        index: 0,
        sourceCount: 0,
    }));
    const sources: LearningSourceRecord[] = [];
    const telemetry: LearningSourceFetchTelemetry = {
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
    };
    const seenCandidates = new Set<string>();
    const acceptedSources = new Set<string>();
    const maxSources = Math.max(1, Math.min(6, input.maxSources ?? 6));
    const markRemainingSkipped = (rejectionCode: LearningSourceRejectionCode) => {
        for (const outcome of outcomes) {
            if (outcome.status !== "discovered") continue;
            outcome.status = "skipped";
            outcome.rejectionCode = rejectionCode;
        }
    };
    const finish = (skippedReason?: LearningSourceRejectionCode) => {
        if (skippedReason) markRemainingSkipped(skippedReason);
        telemetry.sourceElapsedMs = Math.max(0, Date.now() - startedAt);
        return { sources, outcomes, telemetry };
    };
    const budgetExhausted = () => {
        telemetry.sourceBudgetExhausted = 1;
        return "budget_exhausted" as const;
    };

    const tryNext = async (queue: typeof queues[number]): Promise<
        "success" | "attempted" | "exhausted" | "budget_exhausted"
    > => {
        while (queue.index < queue.entries.length) {
            if (remainingMs() <= 0) return budgetExhausted();
            const entry = queue.entries[queue.index++];
            const audit = outcomes[entry.outcomeIndex];
            telemetry.sourceAttempts++;
            let canonicalUrl: string;
            try {
                canonicalUrl = validatePublicSourceUrl(entry.url).href;
                audit.url = canonicalUrl;
            } catch {
                telemetry.sourceRejected++;
                telemetry.sourceInvalid++;
                audit.status = "rejected";
                audit.rejectionCode = "invalid_url";
                continue;
            }
            const candidateKey = `${queue.need.id}\n${canonicalUrl}`;
            if (seenCandidates.has(candidateKey)) {
                telemetry.sourceRejected++;
                telemetry.sourceDeduplicated++;
                audit.status = "rejected";
                audit.rejectionCode = "duplicate";
                continue;
            }
            seenCandidates.add(candidateKey);
            const remaining = remainingMs();
            if (remaining <= 0) return budgetExhausted();
            const configuredTimeout = Number(input.timeoutMs);
            const timeoutMs = Number.isFinite(configuredTimeout) && configuredTimeout > 0
                ? Math.min(DEFAULT_TIMEOUT_MS, Math.floor(configuredTimeout))
                : DEFAULT_TIMEOUT_MS;
            try {
                const source = await fetchLearningSource({
                    jobId: input.jobId,
                    need: queue.need,
                    url: canonicalUrl,
                    fetchImpl: input.fetchImpl,
                    timeoutMs: Math.max(1, Math.min(timeoutMs, remaining)),
                });
                const sourceKey = `${queue.need.id}\n${source.canonicalUrl}`;
                if (acceptedSources.has(sourceKey)) {
                    telemetry.sourceRejected++;
                    telemetry.sourceDeduplicated++;
                    audit.status = "rejected";
                    audit.rejectionCode = "duplicate";
                    return "attempted";
                }
                acceptedSources.add(sourceKey);
                queue.sourceCount++;
                sources.push(source);
                telemetry.sourceAccepted++;
                audit.status = "fetched";
                audit.canonicalUrl = source.canonicalUrl;
                audit.sourceId = source.sourceId;
                audit.title = source.title;
                audit.sourceType = source.sourceType;
                audit.authority = source.authority;
                return "success";
            } catch (error) {
                audit.status = "rejected";
                audit.rejectionCode = recordSourceFailure(telemetry, error);
                return remainingMs() <= 0 ? budgetExhausted() : "attempted";
            }
        }
        return "exhausted";
    };

    while (sources.length < maxSources) {
        let hasUnsourcedCandidates = false;
        let attempted = false;
        for (const queue of queues) {
            if (queue.sourceCount || queue.index >= queue.entries.length) continue;
            hasUnsourcedCandidates = true;
            const outcome = await tryNext(queue);
            if (outcome === "budget_exhausted") return finish("budget_exhausted");
            if (outcome !== "exhausted") attempted = true;
            if (sources.length >= maxSources) return finish("source_limit");
        }
        if (!hasUnsourcedCandidates || !attempted) break;
    }

    while (sources.length < maxSources) {
        let attempted = false;
        for (const queue of queues) {
            if (queue.index >= queue.entries.length) continue;
            const outcome = await tryNext(queue);
            if (outcome === "budget_exhausted") return finish("budget_exhausted");
            if (outcome !== "exhausted") attempted = true;
            if (sources.length >= maxSources) return finish("source_limit");
        }
        if (!attempted) break;
    }
    return finish();
}
