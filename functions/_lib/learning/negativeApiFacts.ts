import type { BuildDiagnostic } from "../buildDiagnostics";
import { containsSharedKnowledgeForbiddenTerm } from "./privacy";
import { LearningStoreUnavailableError, type LearningStoreEnv } from "./store";
import type { KnowledgeItemRecord, LearningSourceRecord } from "./types";

export interface ResolvedDependencyIdentity {
    groupId: string;
    artifactId: string;
    version: string;
    scope?: string;
    classifier?: string;
    type?: string;
    resolvedVersion?: string;
    fingerprint?: string;
}

export interface NegativeApiEnvironment {
    coreType: string;
    mcVersion: string;
    dependencies: ResolvedDependencyIdentity[];
    /** Current build's complete declared/resolved dependency context, not a JAR digest. */
    classpathFingerprint: string;
    compileRunId?: number;
}

export interface NegativeApiFact {
    factId: string;
    symbol: string;
    coreType: string;
    mcVersion: string;
    dependencyIdentity: string;
    dependencyFingerprint?: string;
    assertion: "unavailable";
    assertionScope: "compile_environment" | "versioned_api";
    evidenceKind: "compiler" | "artifact" | "official";
    confidence: number;
    createdAt: number;
    expiresAt: number;
    status: "active" | "suspended" | "invalidated";
    /** Compiler observations stay in this task's private state. */
    taskId?: string;
    compileRunId?: number;
    classpathFingerprint?: string;
    evidenceSourceId?: string;
    evidenceContentHash?: string;
    evidenceSourceUrl?: string;
    verificationMethod?: SharedNegativeApiEvidence["verificationMethod"];
    verifiedBy?: SharedNegativeApiEvidence["verifiedBy"];
}

export interface PositiveApiFact {
    knowledgeId: string;
    symbol: string;
    coreType: string;
    mcVersion: string;
    dependencyIdentity: string;
    dependencyFingerprint?: string;
    classpathFingerprint?: string;
}

const ID = /^[A-Za-z0-9_.-]+$/;
const HASH = /^(?:sha256:)?[a-f0-9]{64}$/i;
const SYMBOL = /^[A-Za-z_$][A-Za-z0-9_$]*(?:\.[A-Za-z_$][A-Za-z0-9_$]*)+(?:#[A-Za-z_$][A-Za-z0-9_$]*)?$/;
const DAY = 86_400_000;

export function dependencyIdentity(dependency: ResolvedDependencyIdentity): string {
    const { groupId, artifactId, version } = dependency;
    if (![groupId, artifactId, version].every((value) => typeof value === "string" && ID.test(value))
        || /^(?:LATEST|RELEASE)$/i.test(version)) return "";
    if (dependency.type && !ID.test(dependency.type)) return "";
    if (dependency.classifier && !ID.test(dependency.classifier)) return "";
    const coordinate = `${groupId}:${artifactId}:${version}`;
    return dependency.classifier || (dependency.type && dependency.type !== "jar")
        ? `${coordinate}:${dependency.type || "jar"}:${dependency.classifier || ""}`
        : coordinate;
}

function normalizedSymbol(value: unknown): string {
    if (typeof value !== "string") return "";
    const symbol = value.trim().replace(/\([^)]*\)$/, "");
    return symbol.length <= 300 && SYMBOL.test(symbol) ? symbol : "";
}

function canonicalFieldSymbol(symbol: string): string {
    const field = symbol.match(/^(.*\.[A-Z][\w$]*)\.([A-Z][A-Z0-9_]*)$/);
    return field ? `${field[1]}#${field[2]}` : symbol;
}

/** Class FQNs stay unchanged; member facts use Owner#member everywhere. */
export function canonicalNegativeApiSymbol(value: unknown, symbolKind?: string): string {
    const symbol = normalizedSymbol(value);
    if (!symbol || symbol.includes("#")) return symbol;
    if (["class", "interface", "enum"].includes(symbolKind || "")) return symbol;
    if (symbolKind === "variable") {
        const dot = symbol.lastIndexOf(".");
        return `${symbol.slice(0, dot)}#${symbol.slice(dot + 1)}`;
    }
    return canonicalFieldSymbol(symbol);
}

function strictIdentity(value: string): boolean {
    const parts = value.split(":");
    return (parts.length === 3 || parts.length === 5)
        && parts.slice(0, 3).every((part) => ID.test(part))
        && (parts.length === 3 || (ID.test(parts[3]) && (!parts[4] || ID.test(parts[4]))));
}

function immutableVersion(identity: string): boolean {
    const version = identity.split(":")[2] || "";
    return /^(?:\d[A-Za-z0-9_.-]*|[a-f0-9]{40})$/i.test(version) && !/SNAPSHOT|LATEST|RELEASE/i.test(version);
}

function normalizedFingerprint(value: string | undefined): string {
    return value && HASH.test(value) ? `sha256:${value.replace(/^sha256:/i, "").toLowerCase()}` : "";
}

function validOptionalFingerprint(value: unknown): boolean {
    return value === undefined || value === "" || (typeof value === "string" && HASH.test(value));
}

async function digest(value: string): Promise<string> {
    const buffer = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(value));
    return `sha256:${Array.from(new Uint8Array(buffer), (byte) => byte.toString(16).padStart(2, "0")).join("")}`;
}

export async function buildNegativeApiEnvironment(input: {
    coreType: string;
    mcVersion: string;
    dependencies: ResolvedDependencyIdentity[];
    pomContent?: string;
    compileRunId?: number;
}): Promise<NegativeApiEnvironment> {
    const dependencies = input.dependencies.filter((item) => dependencyIdentity(item)).map((item) => ({ ...item }));
    // Keep unresolved entries in the invalidation digest as well: a newly fixed
    // property/parent version changes the build context even before it is usable.
    const manifest = input.dependencies.map((item) => [
        dependencyIdentity(item) || `${item.groupId}:${item.artifactId}:${item.version}`, item.resolvedVersion || "", item.fingerprint || "", item.scope || "compile",
    ].join("|")).sort();
    return {
        coreType: input.coreType.toLowerCase(),
        mcVersion: input.mcVersion,
        dependencies,
        classpathFingerprint: await digest(JSON.stringify({ manifest, pom: input.pomContent || "" })),
        ...(input.compileRunId ? { compileRunId: input.compileRunId } : {}),
    };
}

function diagnosticSymbol(diagnostic: BuildDiagnostic): string {
    const kind = diagnostic.symbolKind || diagnostic.details.find((line) => /^symbol:/i.test(line))?.match(/^symbol:\s*(\S+)/i)?.[1];
    // Missing overloads and constructors do not establish absence of the whole member.
    if (diagnostic.category !== "compile" || !/cannot find symbol/i.test(diagnostic.message)
        || !["class", "interface", "enum", "variable"].includes(kind || "")) return "";
    if (normalizedSymbol(diagnostic.qualifiedSymbol)) {
        return canonicalNegativeApiSymbol(diagnostic.qualifiedSymbol, kind);
    }
    const symbol = diagnostic.details.find((line) => /^symbol:\s*class\s+/i.test(line))?.match(/^symbol:\s*class\s+(\S+)/i)?.[1];
    const packageName = diagnostic.details.find((line) => /^location:\s*package\s+/i.test(line))?.match(/^location:\s*package\s+(\S+)/i)?.[1];
    return symbol && packageName ? normalizedSymbol(`${packageName}.${symbol}`) : "";
}

export async function createCompilerNegativeApiFacts(input: {
    taskId: string;
    compileRunId: number;
    diagnostics: BuildDiagnostic[];
    environment: NegativeApiEnvironment;
    /** The caller must establish ownership; package resemblance alone is insufficient. */
    dependencyForSymbol: (symbol: string) => ResolvedDependencyIdentity | undefined;
    now?: number;
}): Promise<NegativeApiFact[]> {
    if (!input.taskId || !Number.isSafeInteger(input.compileRunId) || input.compileRunId <= 0
        || !HASH.test(input.environment.classpathFingerprint)) return [];
    const now = input.now ?? Date.now();
    const facts: NegativeApiFact[] = [];
    for (const diagnostic of input.diagnostics) {
        const symbol = diagnosticSymbol(diagnostic);
        if (!symbol) continue;
        const dependency = input.dependencyForSymbol(symbol);
        const identity = dependency && dependencyIdentity(dependency);
        if (!identity || !input.environment.dependencies.some((item) => dependencyIdentity(item) === identity)) continue;
        const key = [input.taskId, input.environment.classpathFingerprint, symbol, identity].join("|");
        facts.push({
            factId: `neg_${(await digest(key)).slice(7)}`,
            symbol, coreType: input.environment.coreType, mcVersion: input.environment.mcVersion,
            dependencyIdentity: identity,
            ...(dependency?.fingerprint ? { dependencyFingerprint: dependency.fingerprint } : {}),
            assertion: "unavailable", assertionScope: "compile_environment", evidenceKind: "compiler",
            confidence: 1, createdAt: now, expiresAt: now + DAY,
            status: "active", taskId: input.taskId, compileRunId: input.compileRunId,
            classpathFingerprint: input.environment.classpathFingerprint,
        });
    }
    return mergeTaskNegativeApiFacts([], facts, input.taskId, input.environment, now, input.compileRunId);
}

export function negativeApiFactApplies(
    fact: NegativeApiFact,
    environment: NegativeApiEnvironment,
    taskId?: string,
    now = Date.now(),
    compileRunId = environment.compileRunId,
): boolean {
    if (!fact || fact.assertion !== "unavailable" || fact.status !== "active" || !normalizedSymbol(fact.symbol)
        || !Number.isFinite(fact.createdAt) || !Number.isFinite(fact.expiresAt)
        || fact.createdAt > now || fact.expiresAt <= now
        || fact.coreType !== environment.coreType || fact.mcVersion !== environment.mcVersion) return false;
    const dependency = environment.dependencies.find((item) => dependencyIdentity(item) === fact.dependencyIdentity);
    if (!dependency) return false;
    if (fact.evidenceKind === "compiler") {
        return fact.assertionScope === "compile_environment" && !!taskId && fact.taskId === taskId
            && fact.classpathFingerprint === environment.classpathFingerprint
            && !!compileRunId && fact.compileRunId === compileRunId;
    }
    if (fact.assertionScope !== "versioned_api" || !["artifact", "official"].includes(fact.evidenceKind)) return false;
    if (fact.dependencyFingerprint) return !!normalizedFingerprint(fact.dependencyFingerprint)
        && normalizedFingerprint(fact.dependencyFingerprint) === normalizedFingerprint(dependency.fingerprint);
    return fact.evidenceKind === "official" && immutableVersion(fact.dependencyIdentity);
}

export function mergeTaskNegativeApiFacts(
    existing: NegativeApiFact[] | undefined,
    incoming: NegativeApiFact[],
    taskId: string,
    environment: NegativeApiEnvironment,
    now = Date.now(),
    compileRunId = environment.compileRunId,
): NegativeApiFact[] {
    const facts = new Map<string, NegativeApiFact>();
    for (const fact of [...(Array.isArray(existing) ? existing : []), ...incoming]) {
        if (!negativeApiFactApplies(fact, environment, taskId, now, compileRunId)) continue;
        const key = [canonicalNegativeApiSymbol(fact.symbol), fact.dependencyIdentity, fact.dependencyFingerprint || "", fact.classpathFingerprint || ""].join("|");
        const prior = facts.get(key);
        if (!prior || (fact.compileRunId || 0) > (prior.compileRunId || 0)) facts.set(key, fact);
    }
    return [...facts.values()].slice(-64);
}

function recordValue(value: unknown): Record<string, unknown> {
    return value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : {};
}

function explicitlyAvailable(value: Record<string, unknown>): boolean {
    return value.assertion === "available" || value.assertion === "exists"
        || value.availability === "available" || value.available === true || value.exists === true;
}

function explicitlyUnavailable(value: Record<string, unknown>): boolean {
    return value.assertion === "unavailable" || value.assertion === "absent"
        || value.availability === "unavailable" || value.available === false || value.exists === false;
}

function signatureAssertsSymbol(value: unknown, symbol: string): boolean {
    if (typeof value !== "string" || !value.trim() || value.length > 4_000) return false;
    if (canonicalNegativeApiSymbol(value) === symbol) return true;
    const [owner, member] = symbol.split("#");
    if (member) {
        if (new RegExp(`(?<![\\w$])${escapeRegex(member)}\\s*\\(`).test(value)) return true;
        if (/^[A-Z][A-Z0-9_]*$/.test(member) && value.trim() === member) return true;
        const type = "(?:[A-Za-z_$][\\w$]*\\.)*(?:[A-Z_$][\\w$]*|boolean|byte|short|int|long|float|double|char)(?:\\s*<[^;{}>]+>)?(?:\\[\\])*";
        return new RegExp(`^(?:(?:public|protected|private|static|final|transient|volatile)\\s+)*${type}\\s+${escapeRegex(member)}\\s*(?:;|=[\\s\\S]*|$)$`).test(value.trim());
    }
    const simple = owner.split(".").pop()!;
    return new RegExp(`\\b(?:class|interface|enum|record)\\s+${escapeRegex(simple)}(?![\\w$])`).test(value);
}

/** Mere mention in a migration, behavior or alternative recipe is not existence evidence. */
function assertsPositiveAvailability(payload: Record<string, unknown>, symbol: string): boolean {
    const claim = recordValue(payload.claim);
    const claimSymbol = canonicalNegativeApiSymbol(claim.symbol);
    if (explicitlyUnavailable(payload) || (claimSymbol === symbol && explicitlyUnavailable(claim))) return false;
    const payloadSymbol = canonicalNegativeApiSymbol(payload.symbol);
    if (payloadSymbol && payloadSymbol !== symbol) return false;
    if (explicitlyAvailable(payload)) return true;
    if (claimSymbol === symbol && explicitlyAvailable(claim)) return true;
    if (payload.answerType && payload.answerType !== "signature") return false;
    if (claimSymbol && claimSymbol !== symbol) return false;
    return signatureAssertsSymbol(payload.signature, symbol) || signatureAssertsSymbol(claim.signature, symbol)
        || (payload.answerType === "signature" && claimSymbol === symbol && typeof claim.symbol === "string" && /\([^)]*\)$/.test(claim.symbol));
}

/** Generic version-only knowledge cannot erase a current compiler observation. */
export function positiveApiFactsFromKnowledge(items: KnowledgeItemRecord[]): PositiveApiFact[] {
    const out: PositiveApiFact[] = [];
    for (const item of Array.isArray(items) ? items : []) {
        if (!item || typeof item !== "object") continue;
        const scope = item.scope || {}, payload = recordValue(item.payload);
        const symbol = canonicalNegativeApiSymbol(scope.symbol || payload.symbol);
        const identity = typeof payload.dependencyIdentity === "string" ? payload.dependencyIdentity : scope.dependency;
        if (item.kind !== "fact" || item.status !== "active" || !symbol
            || typeof scope.coreType !== "string" || !scope.coreType
            || typeof scope.mcVersion !== "string" || !scope.mcVersion
            || typeof identity !== "string" || !strictIdentity(identity)
            || !validOptionalFingerprint(payload.dependencyFingerprint)
            || !assertsPositiveAvailability(payload, symbol)) continue;
        out.push({
            knowledgeId: item.knowledgeId, symbol, coreType: scope.coreType.toLowerCase(),
            mcVersion: scope.mcVersion, dependencyIdentity: identity,
            ...(typeof payload.dependencyFingerprint === "string" ? { dependencyFingerprint: payload.dependencyFingerprint } : {}),
            ...(typeof payload.classpathFingerprint === "string" ? { classpathFingerprint: payload.classpathFingerprint } : {}),
        });
    }
    return out;
}

export function reconcileNegativeApiFacts(input: {
    facts: NegativeApiFact[];
    positiveFacts: PositiveApiFact[];
    environment: NegativeApiEnvironment;
    taskId?: string;
    compileRunId?: number;
    now?: number;
}): { active: NegativeApiFact[]; conflicts: NegativeApiFact[]; suspendedKnowledgeIds: string[] } {
    const active: NegativeApiFact[] = [], conflicts: NegativeApiFact[] = [];
    const suspended = new Set<string>();
    for (const fact of input.facts) {
        if (!negativeApiFactApplies(fact, input.environment, input.taskId, input.now, input.compileRunId)) continue;
        const positives = input.positiveFacts.filter((positive) => canonicalNegativeApiSymbol(positive.symbol) === canonicalNegativeApiSymbol(fact.symbol)
            && positive.coreType === fact.coreType && positive.mcVersion === fact.mcVersion
            && positive.dependencyIdentity === fact.dependencyIdentity
            && (fact.dependencyFingerprint
                ? !!normalizedFingerprint(positive.dependencyFingerprint)
                    && normalizedFingerprint(positive.dependencyFingerprint) === normalizedFingerprint(fact.dependencyFingerprint)
                : /SNAPSHOT/i.test(fact.dependencyIdentity)
                    ? !!fact.classpathFingerprint && positive.classpathFingerprint === fact.classpathFingerprint
                    : !positive.dependencyFingerprint || normalizedFingerprint(positive.dependencyFingerprint) === normalizedFingerprint(input.environment.dependencies
                        .find((item) => dependencyIdentity(item) === fact.dependencyIdentity)?.fingerprint)));
        if (positives.length) {
            conflicts.push({ ...fact, status: "suspended" });
            positives.forEach((item) => suspended.add(item.knowledgeId));
        } else active.push(fact);
    }
    return { active, conflicts, suspendedKnowledgeIds: [...suspended] };
}

export function negativeApiFactsContext(facts: NegativeApiFact[], maxCharacters = 4_000): string {
    const symbols = [...new Set(facts.filter((fact) => fact.status === "active" && strictIdentity(fact.dependencyIdentity)).map((fact) => normalizedSymbol(fact.symbol)).filter(Boolean))];
    if (!symbols.length) return "";
    const title = "\n\n已确认以下完整限定符号在当前编译依赖环境中不可用：\n";
    const suffix = "\n不得再次引用上述符号。请使用目标版本实际可用的 API。该结论仅适用于列出的依赖环境。";
    const lines: string[] = [];
    let size = title.length + suffix.length;
    for (const symbol of symbols) {
        const fact = facts.find((item) => normalizedSymbol(item.symbol) === symbol)!;
        const line = `${symbol} [${fact.dependencyIdentity}]`;
        if (size + line.length + 1 > maxCharacters) continue;
        lines.push(line); size += line.length + 1;
    }
    return lines.length ? title + lines.join("\n") + suffix : "";
}

export interface SharedNegativeApiEvidence {
    source: Pick<LearningSourceRecord, "sourceId" | "canonicalUrl" | "sourceType" | "authority" | "contentHash">;
    symbol: string;
    dependencyIdentity: string;
    dependencyFingerprint?: string;
    publicApiNamespace: string;
    verificationMethod: "artifact_symbol_inventory" | "official_versioned_inventory";
    verifiedBy: "deterministic" | "human_review";
    /** Explicit exhaustive symbol absence; a contradicted positive claim is not this evidence. */
    assertion: "verified_absent";
    exhaustive: true;
    public: true;
}

function sharedEvidenceValid(fact: NegativeApiFact, evidence: SharedNegativeApiEvidence): boolean {
    let url: URL;
    try { url = new URL(evidence.source.canonicalUrl); } catch { return false; }
    if (fact.evidenceKind === "compiler" || fact.assertionScope !== "versioned_api"
        || fact.taskId || fact.compileRunId || fact.classpathFingerprint
        || evidence.assertion !== "verified_absent" || evidence.exhaustive !== true || evidence.public !== true
        || !["deterministic", "human_review"].includes(evidence.verifiedBy)
        || fact.symbol !== evidence.symbol || fact.dependencyIdentity !== evidence.dependencyIdentity
        || normalizedFingerprint(fact.dependencyFingerprint) !== normalizedFingerprint(evidence.dependencyFingerprint)
        || evidence.source.authority !== "ground_truth" || !HASH.test(evidence.source.contentHash)
        || !/^[A-Za-z0-9_-]{1,100}$/.test(evidence.source.sourceId)
        || !SYMBOL.test(`${evidence.publicApiNamespace}.Api`) || !fact.symbol.startsWith(`${evidence.publicApiNamespace}.`)
        || url.protocol !== "https:" || url.username || url.password || url.search || url.hash
        || !url.hostname.includes(".") || /^(?:\d|localhost$)/i.test(url.hostname)
        || /\.(?:local|internal|test)$/i.test(url.hostname)) return false;
    if (fact.evidenceKind === "artifact") return evidence.verificationMethod === "artifact_symbol_inventory"
        && evidence.verifiedBy === "deterministic" && evidence.source.sourceType === "artifact"
        && HASH.test(fact.dependencyFingerprint || "")
        && fact.dependencyFingerprint!.replace(/^sha256:/i, "").toLowerCase() === evidence.source.contentHash.replace(/^sha256:/i, "").toLowerCase()
        && /\.jar$/i.test(url.pathname);
    return fact.evidenceKind === "official" && evidence.verificationMethod === "official_versioned_inventory"
        && ["javadoc", "documentation"].includes(evidence.source.sourceType);
}

export async function persistVerifiedNegativeApiFact(
    env: LearningStoreEnv,
    input: {
        fact: NegativeApiFact;
        evidence: SharedNegativeApiEvidence;
        forbiddenTerms?: string[];
        /** Explicit fresh inventory verification against the last reviewed record. */
        revalidation?: { factId: string; evidenceContentHash: string };
        now?: number;
    },
): Promise<NegativeApiFact> {
    const now = input.now ?? Date.now();
    const fact = { ...input.fact, symbol: canonicalNegativeApiSymbol(input.fact.symbol) };
    const evidence = { ...input.evidence, symbol: canonicalNegativeApiSymbol(input.evidence.symbol) };
    if (!SYMBOL.test(input.fact.symbol) || !SYMBOL.test(input.evidence.symbol)
        || !validOptionalFingerprint(input.fact.dependencyFingerprint)
        || !validOptionalFingerprint(input.evidence.dependencyFingerprint)
        || !sharedEvidenceValid(fact, evidence) || normalizedSymbol(fact.symbol) !== fact.symbol
        || fact.status !== "active" || fact.assertion !== "unavailable"
        || !strictIdentity(fact.dependencyIdentity) || !/^[a-z][a-z0-9_-]{0,39}$/.test(fact.coreType)
        || !ID.test(fact.mcVersion) || fact.mcVersion.length > 80
        || fact.createdAt > now || !Number.isFinite(fact.createdAt)
        || !Number.isFinite(fact.expiresAt) || !Number.isFinite(fact.confidence) || fact.confidence < 0 || fact.confidence > 1
        || (!immutableVersion(fact.dependencyIdentity) && !HASH.test(fact.dependencyFingerprint || ""))) {
        throw new Error("negative_api_fact_unverified");
    }
    const expiresAt = Math.min(fact.expiresAt || now + 90 * DAY, now + 90 * DAY);
    const dependencyFingerprint = normalizedFingerprint(fact.dependencyFingerprint);
    if (expiresAt <= now) throw new Error("negative_api_fact_expired");
    // Project/task/source text is deliberately excluded from the public projection.
    const publicFact = {
        symbol: fact.symbol, coreType: fact.coreType, mcVersion: fact.mcVersion,
        dependencyIdentity: fact.dependencyIdentity, dependencyFingerprint,
        sourceId: input.evidence.source.sourceId, sourceUrl: input.evidence.source.canonicalUrl,
    };
    if (containsSharedKnowledgeForbiddenTerm(publicFact, input.forbiddenTerms || [])) throw new Error("negative_api_fact_private_content");
    const key = [fact.symbol, fact.coreType, fact.mcVersion, fact.dependencyIdentity, dependencyFingerprint].join("|");
    const factId = `neg_${(await digest(key)).slice(7)}`;
    if (input.revalidation && (input.revalidation.factId !== factId || !HASH.test(input.revalidation.evidenceContentHash))) {
        throw new Error("negative_api_fact_revision_conflict");
    }
    if (!env.DB) throw new LearningStoreUnavailableError();
    await env.DB.prepare(`
        INSERT OR IGNORE INTO negative_api_facts (
            fact_id, symbol, core_type, mc_version, dependency_identity, dependency_fingerprint,
            assertion, assertion_scope, evidence_kind, evidence_source_id, evidence_content_hash,
            verification_method, confidence, status, created_at, expires_at, updated_at, evidence_source_url, verified_by
        ) VALUES (?1, ?2, ?3, ?4, ?5, ?6, 'unavailable', 'versioned_api', ?7, ?8, ?9, ?10, ?11, 'active', ?12, ?13, ?14, ?15, ?16)
    `).bind(factId, fact.symbol, fact.coreType, fact.mcVersion, fact.dependencyIdentity,
        dependencyFingerprint, fact.evidenceKind, input.evidence.source.sourceId,
        input.evidence.source.contentHash, input.evidence.verificationMethod, fact.confidence,
        fact.createdAt, expiresAt, now, input.evidence.source.canonicalUrl, input.evidence.verifiedBy).run();
    // A fresh exhaustive verification can renew an expired active fact. Suspended
    // and invalidated conclusions require an explicit compare-and-swap revalidation.
    await env.DB.prepare(`
        UPDATE negative_api_facts
        SET evidence_kind = ?2, evidence_source_id = ?3, evidence_content_hash = ?4,
            verification_method = ?5, confidence = ?6, created_at = ?7, expires_at = ?8, updated_at = ?9,
            evidence_source_url = ?11, verified_by = ?12, status = 'active'
        WHERE fact_id = ?1 AND (
            (status = 'active' AND expires_at <= ?9)
            OR (?10 <> '' AND status IN ('suspended', 'invalidated') AND evidence_content_hash = ?10 AND updated_at < ?7)
        )
    `).bind(factId, fact.evidenceKind, input.evidence.source.sourceId, input.evidence.source.contentHash,
        input.evidence.verificationMethod, fact.confidence, fact.createdAt, expiresAt, now,
        input.revalidation?.evidenceContentHash || "", input.evidence.source.canonicalUrl, input.evidence.verifiedBy).run();
    const row = await env.DB.prepare("SELECT * FROM negative_api_facts WHERE fact_id = ?1").bind(factId).first<NegativeApiFactRow>();
    if (!row) throw new Error("negative_api_fact_not_persisted");
    if (input.revalidation && row.status !== "active") throw new Error("negative_api_fact_revision_conflict");
    return mapFact(row);
}

interface NegativeApiFactRow {
    fact_id: string; symbol: string; core_type: string; mc_version: string; dependency_identity: string;
    dependency_fingerprint: string; evidence_kind: "artifact" | "official";
    evidence_source_id: string; evidence_content_hash: string; evidence_source_url: string;
    verification_method: SharedNegativeApiEvidence["verificationMethod"]; verified_by: SharedNegativeApiEvidence["verifiedBy"]; confidence: number;
    status: NegativeApiFact["status"]; created_at: number; expires_at: number;
}

function mapFact(row: NegativeApiFactRow): NegativeApiFact {
    return {
        factId: row.fact_id, symbol: row.symbol, coreType: row.core_type, mcVersion: row.mc_version,
        dependencyIdentity: row.dependency_identity,
        ...(row.dependency_fingerprint ? { dependencyFingerprint: row.dependency_fingerprint } : {}),
        assertion: "unavailable", assertionScope: "versioned_api", evidenceKind: row.evidence_kind,
        evidenceSourceId: row.evidence_source_id, evidenceContentHash: row.evidence_content_hash,
        evidenceSourceUrl: row.evidence_source_url, verificationMethod: row.verification_method, verifiedBy: row.verified_by,
        confidence: Number(row.confidence), status: row.status,
        createdAt: Number(row.created_at), expiresAt: Number(row.expires_at),
    };
}

export async function findActiveNegativeApiFacts(
    env: LearningStoreEnv,
    input: { symbols: string[]; environment: NegativeApiEnvironment; now?: number },
): Promise<NegativeApiFact[]> {
    const symbols = [...new Set(input.symbols.map((symbol) => canonicalNegativeApiSymbol(symbol)).filter(Boolean))].slice(0, 64);
    const identities = [...new Set(input.environment.dependencies.map(dependencyIdentity).filter(Boolean))];
    if (!symbols.length || !identities.length || !env.DB) return [];
    const now = input.now ?? Date.now();
    const facts: NegativeApiFact[] = [];
    // Preserve all dependencies while bounding statement parameter counts.
    for (let s = 0; s < symbols.length; s += 24) {
        for (let d = 0; d < identities.length; d += 64) {
            const symbolBatch = symbols.slice(s, s + 24), identityBatch = identities.slice(d, d + 64);
            const symbolSlots = symbolBatch.map((_, i) => `?${i + 1}`).join(", ");
            const identitySlots = identityBatch.map((_, i) => `?${symbolBatch.length + i + 1}`).join(", ");
            const base = symbolBatch.length + identityBatch.length;
            const rows = await env.DB.prepare(`
                SELECT * FROM negative_api_facts
                WHERE symbol IN (${symbolSlots}) AND dependency_identity IN (${identitySlots})
                  AND core_type = ?${base + 1} AND mc_version = ?${base + 2}
                  AND status = 'active' AND created_at <= ?${base + 3} AND expires_at > ?${base + 3}
            `).bind(...symbolBatch, ...identityBatch, input.environment.coreType, input.environment.mcVersion, now).all<NegativeApiFactRow>();
            facts.push(...rows.results.map(mapFact).filter((fact) => negativeApiFactApplies(fact, input.environment, undefined, now)));
        }
    }
    return [...new Map(facts.map((fact) => [fact.factId, fact])).values()];
}

export async function invalidateNegativeApiFacts(
    env: LearningStoreEnv,
    input: { dependencyIdentity: string; symbol?: string; dependencyFingerprint?: string; status?: "suspended" | "invalidated"; now?: number },
): Promise<void> {
    const symbol = input.symbol ? canonicalNegativeApiSymbol(input.symbol) : "";
    if (!strictIdentity(input.dependencyIdentity) || (input.symbol && (!SYMBOL.test(input.symbol) || !symbol))) {
        throw new Error("negative_api_fact_invalid_scope");
    }
    if (!validOptionalFingerprint(input.dependencyFingerprint)) throw new Error("negative_api_fact_invalid_fingerprint");
    if (!env.DB) throw new LearningStoreUnavailableError();
    await env.DB.prepare(`
        UPDATE negative_api_facts SET status = ?1, updated_at = ?2
        WHERE dependency_identity = ?3 AND status = 'active'
          AND (?4 = '' OR symbol = ?4) AND (?5 = '' OR dependency_fingerprint = ?5)
    `).bind(input.status || "invalidated", input.now ?? Date.now(), input.dependencyIdentity,
        symbol, normalizedFingerprint(input.dependencyFingerprint)).run();
}

/** Remove literals/comments while retaining offsets for diagnostics. */
function javaCode(source: string): string {
    return source.replace(/\/\*[\s\S]*?\*\/|\/\/[^\r\n]*|"""[\s\S]*?"""|"(?:\\[\s\S]|[^"\\])*"|'(?:\\[\s\S]|[^'\\])*'/g,
        (value) => value.replace(/[^\r\n]/g, " "));
}

function escapeRegex(value: string): string { return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"); }

export interface NegativeApiCandidateViolation { path: string; line: number; symbol: string; factId: string; }

export function validateNegativeApiCandidate(input: {
    files: { path: string; content?: string }[];
    facts: NegativeApiFact[];
    environment: NegativeApiEnvironment;
    taskId?: string;
    compileRunId?: number;
    now?: number;
}): NegativeApiCandidateViolation[] {
    const applicable = input.facts.filter((fact) => negativeApiFactApplies(fact, input.environment, input.taskId, input.now, input.compileRunId));
    const violations: NegativeApiCandidateViolation[] = [];
    const sourceTypes = new Set<string>();
    for (const file of input.files.filter((item) => item.path.endsWith(".java"))) {
        const code = javaCode(file.content || "");
        const packageName = code.match(/\bpackage\s+([\w$.]+)\s*;/)?.[1];
        if (!packageName) continue;
        for (const match of code.matchAll(/\b(?:class|interface|enum|record)\s+([\w$]+)/g)) sourceTypes.add(`${packageName}.${match[1]}`);
    }
    for (const file of input.files.filter((item) => item.path.endsWith(".java"))) {
        const code = javaCode(file.content || "");
        const imports = new Map<string, string>();
        const wildcardPackages: string[] = [];
        const staticImports: string[] = [];
        for (const match of code.matchAll(/\bimport\s+(static\s+)?([A-Za-z_$][\w$]*(?:\s*\.\s*(?:[A-Za-z_$][\w$]*|\*))+)\s*;/g)) {
            const name = match[2].replace(/\s/g, "");
            if (match[1]) staticImports.push(name);
            else if (name.endsWith(".*")) wildcardPackages.push(name.slice(0, -2));
            else imports.set(name.split(".").pop()!, name);
        }
        const packageName = code.match(/\bpackage\s+([\w$.]+)\s*;/)?.[1] || "";
        const localTypes = new Set([...code.matchAll(/\b(?:class|interface|enum|record)\s+([\w$]+)/g)].map((match) => match[1]));
        const body = code.replace(/\b(?:import|package)\b[^;]*;/g, (value) => " ".repeat(value.length));
        for (const fact of applicable) {
            let [type, member] = fact.symbol.split("#");
            // Existing variable diagnostics use Type.CONSTANT rather than Type#CONSTANT.
            if (!member && /\.[A-Z][A-Z0-9_]*$/.test(type)) {
                const owner = type.slice(0, type.lastIndexOf("."));
                if (/\.[A-Z][\w$]*$/.test(owner)) { member = type.slice(type.lastIndexOf(".") + 1); type = owner; }
            }
            const simple = type.split(".").pop()!, ownerPackage = type.slice(0, type.lastIndexOf("."));
            const exact = member ? `${type}.${member}` : type;
            const patterns = [`(?<![\\w$.])${escapeRegex(exact).replace(/\\\./g, "\\s*\\.\\s*")}(?![\\w$])`];
            let match = new RegExp(patterns[0]).exec(code);
            const imported = imports.get(simple);
            const simpleIsLocalBinding = new RegExp(`\\b[A-Za-z_$][\\w$]*(?:\\s*<[^;{}>]+>)?(?:\\[\\])?\\s+${escapeRegex(simple)}\\s*(?:[=;,)]|\\()`).test(body);
            const resolvesSimple = !localTypes.has(simple) && !simpleIsLocalBinding && (imported === type
                || (!imported && ((packageName === ownerPackage)
                    || (wildcardPackages.length === 1 && wildcardPackages[0] === ownerPackage
                        && !sourceTypes.has(`${packageName}.${simple}`)))));
            if (!match && resolvesSimple) {
                const simpleReference = member ? `${escapeRegex(simple)}\\s*\\.\\s*${escapeRegex(member)}` : escapeRegex(simple);
                match = new RegExp(`(?<![\\w$.])${simpleReference}(?![\\w$])`).exec(body);
                if (!match && member) {
                    for (const declaration of body.matchAll(new RegExp(`(?<![\\w$.])${escapeRegex(simple)}\\s+([A-Za-z_$][\\w$]*)\\b`, "g"))) {
                        const bindings = [...body.matchAll(new RegExp(`\\b([A-Za-z_$][\\w$.]*)\\s+${escapeRegex(declaration[1])}\\b`, "g"))];
                        if (bindings.some((binding) => binding[1] !== simple && binding[1] !== type)) continue;
                        match = new RegExp(`(?<![\\w$.])${escapeRegex(declaration[1])}\\s*\\.\\s*${escapeRegex(member)}(?![\\w$])`).exec(body);
                        if (match) break;
                    }
                }
            }
            const memberIsLocalBinding = member && new RegExp(`\\b[A-Za-z_$][\\w$]*(?:\\s*<[^;{}>]+>)?(?:\\[\\])?\\s+${escapeRegex(member)}\\s*(?:[=;,)]|\\()`).test(body);
            if (!match && member && !memberIsLocalBinding && staticImports.some((name) => name === exact || name === `${type}.*`)) {
                match = new RegExp(`(?<![\\w$.])${escapeRegex(member)}(?![\\w$])`).exec(body);
            }
            if (match) violations.push({ path: file.path, line: code.slice(0, match.index).split("\n").length, symbol: fact.symbol, factId: fact.factId });
        }
    }
    return violations;
}
