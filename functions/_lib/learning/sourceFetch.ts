import type { KnowledgeNeed, LearningSourceRecord } from "./types";

const MAX_REDIRECTS = 3;
const MAX_BYTES = 256 * 1024;
const DEFAULT_TIMEOUT_MS = 8_000;
const ALLOWED_CONTENT_TYPES = [
    "text/html",
    "text/plain",
    "application/json",
    "application/xml",
    "text/xml",
];

const TRUSTED_ARTIFACT_HOSTS = [
    "repo.papermc.io",
    "repo.maven.apache.org",
    "maven.enginehub.org",
    "repo.extendedclip.com",
];
const OFFICIAL_HOSTS = [
    "papermc.io",
    "docs.papermc.io",
    "jd.papermc.io",
    "spigotmc.org",
    "hub.spigotmc.org",
    ...TRUSTED_ARTIFACT_HOSTS,
];
const OFFICIAL_GITHUB_OWNERS = new Set([
    "enginehub",
    "milkbowl",
    "papermc",
    "placeholderapi",
    "spigotmc",
]);

function hostMatches(host: string, domains: string[]): boolean {
    return domains.some((domain) => host === domain || host.endsWith(`.${domain}`));
}

function isIpLiteral(hostname: string): boolean {
    const normalized = hostname.replace(/^\[|\]$/g, "");
    if (normalized.includes(":")) return true;
    const parts = normalized.split(".");
    return parts.length === 4
        && parts.every((part) => /^\d{1,3}$/.test(part) && Number(part) >= 0 && Number(part) <= 255);
}

function githubOwner(url: URL): string {
    if (url.hostname !== "github.com" && url.hostname !== "raw.githubusercontent.com") return "";
    return url.pathname.split("/").filter(Boolean)[0]?.toLowerCase() ?? "";
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
    return url;
}

function sourceClassification(url: URL, need: KnowledgeNeed): { sourceType: string; authority: string } {
    const host = url.hostname.toLowerCase();
    const path = decodedPath(url).toLowerCase();
    const isPom = path.endsWith(".pom");
    const isMavenMetadata = path.endsWith("maven-metadata.xml");
    const isPinnedGithub = (host === "github.com" && (/\/blob\/[0-9a-f]{40}\//.test(path) || /\/releases\/tag\//.test(path)))
        || (host === "raw.githubusercontent.com" && /\/[0-9a-f]{40}\//.test(path));
    const isTrustedArtifactHost = hostMatches(host, TRUSTED_ARTIFACT_HOSTS);
    const isOfficial = hostMatches(host, OFFICIAL_HOSTS);
    const isOfficialRepository = isPinnedGithub && OFFICIAL_GITHUB_OWNERS.has(githubOwner(url));
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
    if (isPinnedGithub) {
        return { sourceType: "repository", authority: isOfficialRepository ? "ground_truth" : "secondary" };
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
    timeoutMs: number,
): Promise<{ url: URL; contentType: string; text: string }> {
    let url = validatePublicSourceUrl(initialUrl);
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    try {
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
    } finally {
        clearTimeout(timer);
    }
}

export async function fetchLearningSource(input: {
    jobId: string;
    need: KnowledgeNeed;
    url: string;
    fetchImpl?: typeof fetch;
    timeoutMs?: number;
    now?: number;
}): Promise<LearningSourceRecord> {
    const fetched = await fetchOne(input.url, input.fetchImpl ?? fetch, input.timeoutMs ?? DEFAULT_TIMEOUT_MS);
    const isHtml = fetched.contentType === "text/html";
    const normalized = isHtml ? htmlToText(fetched.text) : { title: "", text: fetched.text.replace(/\s+/g, " ").trim() };
    const excerpt = normalized.text.slice(0, 24_000);
    if (excerpt.length < 40) throw new Error("source_too_thin");
    const classification = sourceClassification(fetched.url, input.need);
    const canonicalUrl = fetched.url.href;
    const [contentHash, sourceKey] = await Promise.all([
        sha256(excerpt),
        sha256(JSON.stringify([input.jobId, input.need.id, canonicalUrl])),
    ]);
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
}

export async function fetchLearningSources(input: {
    jobId: string;
    needs: KnowledgeNeed[];
    candidates: { needId: string; urls: string[] }[];
    fetchImpl?: typeof fetch;
    timeoutMs?: number;
    maxSources?: number;
}): Promise<{ sources: LearningSourceRecord[]; errors: string[] }> {
    const needs = new Map(input.needs.map((need) => [need.id, need]));
    const urlsByNeed = new Map([...needs.keys()].map((needId) => [needId, [] as string[]]));
    for (const candidate of input.candidates) {
        urlsByNeed.get(candidate.needId)?.push(...candidate.urls);
    }
    const queues = [...needs.values()].map((need) => ({
        need,
        urls: urlsByNeed.get(need.id) ?? [],
        index: 0,
        sourceCount: 0,
    }));
    const sources: LearningSourceRecord[] = [];
    const errors: string[] = [];
    const seenCandidates = new Set<string>();
    const acceptedSources = new Set<string>();
    const maxSources = Math.max(1, Math.min(6, input.maxSources ?? 6));

    const tryNext = async (queue: typeof queues[number]): Promise<"success" | "attempted" | "exhausted"> => {
        while (queue.index < queue.urls.length) {
            const rawUrl = queue.urls[queue.index++];
            let canonicalUrl: string;
            try {
                canonicalUrl = validatePublicSourceUrl(rawUrl).href;
            } catch (error: any) {
                errors.push(`${queue.need.id}:${error?.message || "invalid_url"}`);
                continue;
            }
            const candidateKey = `${queue.need.id}\n${canonicalUrl}`;
            if (seenCandidates.has(candidateKey)) continue;
            seenCandidates.add(candidateKey);
            try {
                const source = await fetchLearningSource({
                    jobId: input.jobId,
                    need: queue.need,
                    url: canonicalUrl,
                    fetchImpl: input.fetchImpl,
                    timeoutMs: input.timeoutMs,
                });
                const sourceKey = `${queue.need.id}\n${source.canonicalUrl}`;
                if (acceptedSources.has(sourceKey)) return "attempted";
                acceptedSources.add(sourceKey);
                queue.sourceCount++;
                sources.push(source);
                return "success";
            } catch (error: any) {
                errors.push(`${queue.need.id}:${error?.message || "fetch_failed"}`);
                return "attempted";
            }
        }
        return "exhausted";
    };

    while (sources.length < maxSources) {
        let hasUnsourcedCandidates = false;
        let attempted = false;
        for (const queue of queues) {
            if (queue.sourceCount || queue.index >= queue.urls.length) continue;
            hasUnsourcedCandidates = true;
            const outcome = await tryNext(queue);
            if (outcome !== "exhausted") attempted = true;
            if (sources.length >= maxSources) return { sources, errors };
        }
        if (!hasUnsourcedCandidates || !attempted) break;
    }

    while (sources.length < maxSources) {
        let attempted = false;
        for (const queue of queues) {
            if (queue.index >= queue.urls.length) continue;
            const outcome = await tryNext(queue);
            if (outcome !== "exhausted") attempted = true;
            if (sources.length >= maxSources) return { sources, errors };
        }
        if (!attempted) break;
    }
    return { sources, errors };
}
