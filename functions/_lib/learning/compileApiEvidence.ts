import { compileDependencyContextHash, dependencyOwnsSymbol, resolveCompileDependencyContext } from "./assessment";
import {
    canonicalNegativeApiSymbol, dependencyIdentity, type NegativeApiFact,
    type ResolvedDependencyIdentity, type SharedNegativeApiEvidence,
} from "./negativeApiFacts";
import type { KnowledgeNeed, LearningSourceRecord } from "./types";

export const COMPILE_EVIDENCE_STEP = "Collect compile API evidence v1";
export const COMPILE_EVIDENCE_MARKER = "COMPILE_API_EVIDENCE_V1 ";
export const COMPILE_EVIDENCE_MAX_BYTES = 2 * 1024 * 1024;
// Reviewed producer blobs; changing the bundled producer requires updating these pins.
export const COMPILE_EVIDENCE_WORKFLOW_BLOB = "7bcd704e84e0d80864759b62cc11d42680781794";
export const COMPILE_EVIDENCE_SCANNER_BLOB = "950407c557b77814a36f8490cf8785304f2cc4a8";
const REPOSITORY = "superwfox/minecraft-dev-workflow";
const HASH = /^(?:sha256:)?[a-f0-9]{64}$/;
const SHA = /^[a-f0-9]{40}$/;
// Inventories also contain anonymous/local classes (ChatColor.1) and package-info.
// Public fact subjects still pass the stricter source-symbol validator.
const NAME = /^(?:[A-Za-z_$][\w$]*(?:\.[\w$]+)+|[A-Za-z_$][\w$]*(?:\.[\w$]+)*\.package-info)$/;
const FIELD = /^[A-Za-z_$][\w$]*$/;
const PUBLIC_NAMESPACES = ["org.bukkit", "io.papermc", "com.destroystokyo", "net.kyori", "com.sk89q", "net.milkbowl", "me.clip"];

export interface CompileApiClass {
    name: string;
    superName: string;
    interfaces: string[];
    fields: string[];
    enumConstants: string[];
    isEnum: boolean;
}
export interface CompileApiDependency extends Partial<ResolvedDependencyIdentity> {
    fingerprint: string;
    complete: true;
    publicVerified: boolean;
    sourceUrl?: string;
    classes: CompileApiClass[];
}
export interface CompileApiEvidence {
    schemaVersion: "compile_api_evidence.v1";
    repository: string;
    headSha: string;
    runId: number;
    runAttempt: number;
    javaRelease: number;
    pomHash: string;
    complete: true;
    dependencies: CompileApiDependency[];
    jdkClasses: CompileApiClass[];
    /** Server-attested dedicated step, never accepted from an API request body. */
    attestation: { workflowBlob: string; scannerBlob: string; jobId: number; stepIndex: number };
    contextHash: string;
}

export function protectedBuildPath(path: unknown): boolean {
    if (typeof path !== "string" || !path || path.length > 600 || /[\x00-\x1f\\]/.test(path)) return true;
    const segments = path.split("/");
    if (segments.some(part => !part || part === "." || part === "..")) return true;
    const normalized = path.toLowerCase();
    return normalized.startsWith(".github/") || normalized.startsWith(".git/")
        || normalized === ".github" || normalized === ".git"
        || normalized === "tools/compile_api_evidence.py";
}

function publicNamespace(symbol: string): string | undefined {
    return PUBLIC_NAMESPACES.find(prefix => symbol.startsWith(`${prefix}.`));
}

function publicArtifactUrl(dependency: CompileApiDependency): boolean {
    if (!dependencyIdentity(dependency as ResolvedDependencyIdentity) || !dependency.sourceUrl || !dependency.resolvedVersion) return false;
    let url: URL;
    try { url = new URL(dependency.sourceUrl); } catch { return false; }
    if (url.protocol !== "https:" || url.username || url.password || url.search || url.hash) return false;
    const group = dependency.groupId!;
    const repositories = group === "io.papermc.paper" ? ["https://repo.papermc.io/repository/maven-public/"]
        : ["org.spigotmc", "org.bukkit"].includes(group) ? ["https://hub.spigotmc.org/nexus/content/repositories/snapshots/"]
        : group.startsWith("net.kyori") ? ["https://repo.maven.apache.org/maven2/"]
        : group.startsWith("com.sk89q") ? ["https://maven.enginehub.org/repo/", "https://repo.maven.apache.org/maven2/"]
        : group.startsWith("me.clip") ? ["https://repo.extendedclip.com/content/repositories/placeholderapi/"]
        : group.startsWith("net.milkbowl") ? ["https://repo.maven.apache.org/maven2/", "https://repo.papermc.io/repository/maven-public/", "https://hub.spigotmc.org/nexus/content/repositories/snapshots/", "https://maven.enginehub.org/repo/", "https://repo.extendedclip.com/content/repositories/placeholderapi/"]
        : [];
    const suffix = `${group.replace(/\./g, "/")}/${dependency.artifactId}/${dependency.version}/${dependency.artifactId}-${dependency.resolvedVersion}${dependency.classifier ? `-${dependency.classifier}` : ""}.jar`;
    return repositories.some(repository => url.href === repository + suffix);
}

function validClasses(value: unknown, jdk = false): value is CompileApiClass[] {
    if (!Array.isArray(value) || value.length > 50_000) return false;
    const seen = new Set<string>();
    return value.every(item => {
        if (!item || typeof item !== "object" || !NAME.test(item.name) || item.name.length > 300
            || (jdk ? !/^(?:java|javax)\./.test(item.name) : !publicNamespace(item.name))
            || seen.has(item.name) || typeof item.isEnum !== "boolean"
            || typeof item.superName !== "string" || (item.superName !== "" && !NAME.test(item.superName))) return false;
        seen.add(item.name);
        return [item.interfaces, item.fields, item.enumConstants].every((values, index) =>
            Array.isArray(values) && values.length <= 10_000 && new Set(values).size === values.length
            && values.every(value => typeof value === "string" && value.length <= 300 && (index === 0 ? NAME : FIELD).test(value)))
            && item.enumConstants.every(value => item.fields.includes(value));
    });
}

export async function parseCompileApiEvidence(log: string, expected: {
    headSha: string; runId: number; runAttempt: number; pomHash: string; javaRelease: number;
    attestation: CompileApiEvidence["attestation"];
}): Promise<CompileApiEvidence | null> {
    if (new TextEncoder().encode(log).length > COMPILE_EVIDENCE_MAX_BYTES + 32_768
        || !SHA.test(expected.headSha) || !HASH.test(expected.pomHash)
        || expected.attestation.workflowBlob !== COMPILE_EVIDENCE_WORKFLOW_BLOB
        || expected.attestation.scannerBlob !== COMPILE_EVIDENCE_SCANNER_BLOB) return null;
    // Exactly one record from a dedicated step; global job stdout is never a source.
    const lines = log.split(/\r?\n/).filter(line => /^(?:\d{4}-\d{2}-\d{2}T\S+\s+)?COMPILE_API_EVIDENCE_V1 /.test(line));
    if (lines.length !== 1) return null;
    const encoded = lines[0].slice(lines[0].indexOf(COMPILE_EVIDENCE_MARKER) + COMPILE_EVIDENCE_MARKER.length);
    if (new TextEncoder().encode(encoded).length > COMPILE_EVIDENCE_MAX_BYTES) return null;
    let report: any;
    try { report = JSON.parse(encoded); } catch { return null; }
    if (report?.schemaVersion !== "compile_api_evidence.v1" || report.complete !== true
        || report.repository !== REPOSITORY || report.headSha !== expected.headSha
        || report.runId !== expected.runId || report.runAttempt !== expected.runAttempt
        || report.pomHash !== expected.pomHash || report.javaRelease !== expected.javaRelease
        || !Array.isArray(report.dependencies) || !report.dependencies.length || report.dependencies.length > 128
        || !validClasses(report.jdkClasses, true)) return null;
    let count = report.jdkClasses.length;
    const identities = new Set<string>();
    for (const dependency of report.dependencies) {
        if (!dependency || dependency.complete !== true || !HASH.test(dependency.fingerprint)
            || typeof dependency.publicVerified !== "boolean" || !validClasses(dependency.classes)) return null;
        const identity = dependencyIdentity(dependency as ResolvedDependencyIdentity);
        if (identity && identities.has(identity)) return null;
        if (identity) identities.add(identity);
        if (dependency.publicVerified && !publicArtifactUrl(dependency)) return null;
        count += dependency.classes.length;
        if (count > 50_000) return null;
    }
    const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(encoded));
    return { schemaVersion: report.schemaVersion, repository: report.repository, headSha: report.headSha,
        runId: report.runId, runAttempt: report.runAttempt, javaRelease: report.javaRelease,
        pomHash: report.pomHash, complete: true, dependencies: report.dependencies,
        jdkClasses: report.jdkClasses, attestation: expected.attestation,
        contextHash: [...new Uint8Array(digest)].map(value => value.toString(16).padStart(2, "0")).join("") };
}

export async function currentCompileApiEvidence(state: any, files = state.generatedFiles ?? []): Promise<CompileApiEvidence | null> {
    const evidence = state.compileApiEvidence as CompileApiEvidence | undefined;
    if (!evidence || evidence.complete !== true || evidence.schemaVersion !== "compile_api_evidence.v1"
        || evidence.repository !== REPOSITORY || evidence.headSha !== state.buildHeadSha
        || evidence.runId !== Number(state.runId) || !HASH.test(evidence.contextHash || "")
        || evidence.javaRelease !== Number(state.javaVersion)
        || evidence.attestation?.workflowBlob !== COMPILE_EVIDENCE_WORKFLOW_BLOB
        || evidence.attestation?.scannerBlob !== COMPILE_EVIDENCE_SCANNER_BLOB
        || evidence.pomHash !== await compileDependencyContextHash(files)) return null;
    return evidence;
}

export async function resolvedCompileDependencies(state: any, files = state.generatedFiles ?? []): Promise<ResolvedDependencyIdentity[]> {
    const declared = resolveCompileDependencyContext(files);
    const evidence = await currentCompileApiEvidence(state, files);
    if (!evidence) return declared;
    return declared.map(dependency => {
        const actual = evidence.dependencies.find(item => dependencyIdentity(item as ResolvedDependencyIdentity) === dependencyIdentity(dependency));
        return actual ? { ...dependency, resolvedVersion: actual.resolvedVersion, fingerprint: actual.fingerprint } : dependency;
    });
}

/** Presence anywhere wins; unresolved/ambiguous enum hierarchy can never prove absence. */
export function compileEvidenceSymbolAbsent(evidence: CompileApiEvidence, symbolValue: string, ownerDependency: string): boolean {
    const symbol = canonicalNegativeApiSymbol(symbolValue);
    const [owner, field] = symbol.split("#");
    if (!publicNamespace(owner)) return false;
    const dependency = evidence.dependencies.find(item => dependencyIdentity(item as ResolvedDependencyIdentity) === ownerDependency);
    if (!dependency?.publicVerified || !publicArtifactUrl(dependency)
        || !dependencyOwnsSymbol(dependency as ResolvedDependencyIdentity, owner)) return false;
    const all = [...evidence.dependencies.flatMap(item => item.classes), ...evidence.jdkClasses];
    const matches = all.filter(item => item.name === owner);
    if (!field) return matches.length === 0;
    const target = dependency.classes.find(item => item.name === owner);
    if (matches.length !== 1 || !target?.isEnum || !/^[A-Z][A-Z0-9_]*$/.test(field)) return false;
    const visited = new Set<string>();
    const pending = [owner];
    while (pending.length) {
        const name = pending.pop()!;
        if (visited.has(name)) continue;
        visited.add(name);
        const definitions = all.filter(item => item.name === name);
        if (definitions.length !== 1 || definitions[0].fields.includes(field)) return false;
        pending.push(...[definitions[0].superName, ...definitions[0].interfaces].filter(Boolean));
        if (visited.size > 512) return false;
    }
    return true;
}

export function compileEvidenceFactApplies(evidence: CompileApiEvidence | null, fact: NegativeApiFact): boolean {
    const actual = evidence?.dependencies.find(item => dependencyIdentity(item as ResolvedDependencyIdentity) === fact.dependencyIdentity);
    return !!evidence && !!actual && HASH.test(fact.dependencyFingerprint || "")
        && actual.fingerprint.replace(/^sha256:/, "") === fact.dependencyFingerprint!.replace(/^sha256:/, "")
        && compileEvidenceSymbolAbsent(evidence, fact.symbol, fact.dependencyIdentity);
}

export function compileNegativeEvidence(need: KnowledgeNeed, evidence: CompileApiEvidence, now = Date.now()): {
    fact: NegativeApiFact; evidence: SharedNegativeApiEvidence; source: LearningSourceRecord;
} | null {
    if (need.kind !== "fact" || need.claim.answerType !== "signature"
        || !need.scope.coreType || !need.scope.mcVersion || !need.scope.symbol || !need.scope.dependency) return null;
    const symbol = canonicalNegativeApiSymbol(need.scope.symbol);
    if (!compileEvidenceSymbolAbsent(evidence, symbol, need.scope.dependency)) return null;
    const dependency = evidence.dependencies.find(item => dependencyIdentity(item as ResolvedDependencyIdentity) === need.scope.dependency)!;
    const sourceId = `src_jar_${crypto.randomUUID().replace(/-/g, "")}`;
    const source: LearningSourceRecord = { sourceId, jobId: "", needId: need.id,
        canonicalUrl: dependency.sourceUrl!, domain: new URL(dependency.sourceUrl!).hostname,
        sourceType: "artifact", authority: "ground_truth", contentHash: dependency.fingerprint,
        title: `${need.scope.dependency} 公开符号清单`, fetchedAt: now,
        excerpt: JSON.stringify({ schemaVersion: evidence.schemaVersion, symbol, assertion: "verified_absent",
            dependencyIdentity: need.scope.dependency, dependencyFingerprint: dependency.fingerprint }),
        verificationState: "verified_absent" };
    return {
        fact: { factId: "", symbol, coreType: need.scope.coreType.toLowerCase(), mcVersion: need.scope.mcVersion,
            dependencyIdentity: need.scope.dependency, dependencyFingerprint: dependency.fingerprint,
            assertion: "unavailable", assertionScope: "versioned_api", evidenceKind: "artifact",
            confidence: 1, createdAt: now, expiresAt: now + 90 * 86_400_000, status: "active" },
        evidence: { source, symbol, dependencyIdentity: need.scope.dependency, dependencyFingerprint: dependency.fingerprint,
            publicApiNamespace: publicNamespace(symbol)!, verificationMethod: "artifact_symbol_inventory",
            verifiedBy: "deterministic", assertion: "verified_absent", exhaustive: true, public: true }, source,
    };
}
