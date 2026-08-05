import type { BuildDiagnostic } from "../buildDiagnostics";
import type {
    KnowledgeAnswerType,
    KnowledgeKind,
    KnowledgeNeed,
    KnowledgeRisk,
    KnowledgeSpecificity,
    KnowledgeTrigger,
    SourcePolicy,
} from "./types";

const KINDS = new Set<KnowledgeKind>(["fact", "strategy"]);
const TRIGGERS = new Set<KnowledgeTrigger>([
    "contract_miss",
    "version_gap",
    "dependency_gap",
    "skill_staleness",
    "diagnostic_repeat",
]);
const SPECIFICITIES = new Set<KnowledgeSpecificity>(["exact", "scoped", "ambiguous"]);
const ANSWER_TYPES = new Set<KnowledgeAnswerType>(["signature", "coordinate", "behavior", "migration", "rule"]);
const RISKS = new Set<KnowledgeRisk>(["low", "medium", "high"]);
const SOURCE_POLICIES = new Set<SourcePolicy>(["api_signature", "dependency", "behavior", "release"]);
const GENERIC_SUBJECTS = new Set([
    "api",
    "paper api",
    "bukkit api",
    "spigot api",
    "minecraft",
    "minecraft plugin",
    "插件开发",
    "learn",
    "learning",
    "学习",
]);

function clean(value: unknown, max = 500): string {
    return typeof value === "string" ? value.trim().replace(/\s+/g, " ").slice(0, max) : "";
}

function cleanList(value: unknown, maxItems: number, maxLength: number): string[] {
    if (!Array.isArray(value)) return [];
    const seen = new Set<string>();
    const out: string[] = [];
    for (const item of value) {
        const normalized = clean(item, maxLength);
        const key = normalized.toLowerCase();
        if (!normalized || seen.has(key)) continue;
        seen.add(key);
        out.push(normalized);
        if (out.length >= maxItems) break;
    }
    return out;
}

function enumValue<T extends string>(value: unknown, allowed: Set<T>): T | null {
    return typeof value === "string" && allowed.has(value as T) ? value as T : null;
}

function normalizeScope(value: unknown, defaults: { coreType?: string; mcVersion?: string }): KnowledgeNeed["scope"] {
    const raw = value && typeof value === "object" ? value as Record<string, unknown> : {};
    const scope: KnowledgeNeed["scope"] = {};
    const coreType = clean(raw.coreType, 40) || clean(defaults.coreType, 40);
    const mcVersion = clean(raw.mcVersion, 80) || clean(defaults.mcVersion, 80);
    const dependency = clean(raw.dependency, 180);
    const packageName = clean(raw.packageName, 180);
    const symbol = clean(raw.symbol, 240);
    if (coreType) scope.coreType = coreType;
    if (mcVersion) scope.mcVersion = mcVersion;
    if (dependency) scope.dependency = dependency;
    if (packageName) scope.packageName = packageName;
    if (symbol) scope.symbol = symbol;
    return scope;
}

export interface KnowledgeNeedRejection {
    index: number;
    reason: string;
}

export interface KnowledgeNeedAssessment {
    accepted: KnowledgeNeed[];
    rejected: KnowledgeNeedRejection[];
}

export function assessKnowledgeNeeds(
    value: unknown,
    defaults: { coreType?: string; mcVersion?: string } = {},
    limit = 3,
): KnowledgeNeedAssessment {
    const rawNeeds = Array.isArray(value) ? value : [];
    const accepted: KnowledgeNeed[] = [];
    const rejected: KnowledgeNeedRejection[] = [];
    const ids = new Set<string>();

    for (let index = 0; index < rawNeeds.length && accepted.length < Math.max(0, limit); index++) {
        const raw = rawNeeds[index];
        if (!raw || typeof raw !== "object") {
            rejected.push({ index, reason: "not_object" });
            continue;
        }
        const item = raw as Record<string, unknown>;
        const claimRaw = item.claim && typeof item.claim === "object"
            ? item.claim as Record<string, unknown>
            : {};
        const id = clean(item.id, 80);
        const kind = enumValue(item.kind, KINDS);
        const trigger = enumValue(item.trigger, TRIGGERS);
        const specificity = enumValue(item.specificity, SPECIFICITIES);
        const answerType = enumValue(claimRaw.answerType, ANSWER_TYPES);
        const risk = enumValue(item.risk, RISKS);
        const sourcePolicy = enumValue(item.sourcePolicy, SOURCE_POLICIES);
        const subject = clean(claimRaw.subject, 240);
        const question = clean(claimRaw.question, 600);
        const scope = normalizeScope(item.scope, defaults);
        const searchQueries = cleanList(item.searchQueries, 4, 300);
        const acceptanceCriteria = cleanList(item.acceptanceCriteria, 6, 300);

        let reason = "";
        if (!id || ids.has(id)) reason = "invalid_id";
        else if (!kind || !trigger || !specificity || !answerType || !risk || !sourcePolicy) reason = "invalid_enum";
        else if (specificity === "ambiguous") reason = "ambiguous";
        else if (!subject || GENERIC_SUBJECTS.has(subject.toLowerCase())) reason = "generic_subject";
        else if (question.length < 12) reason = "vague_question";
        else if (!scope.mcVersion && !scope.dependency && !scope.symbol) reason = "missing_scope";
        else if (!searchQueries.length) reason = "missing_queries";
        else if (!acceptanceCriteria.length) reason = "missing_acceptance";

        if (reason) {
            rejected.push({ index, reason });
            continue;
        }

        ids.add(id);
        accepted.push({
            id,
            kind,
            trigger,
            specificity,
            claim: { subject, question, answerType },
            scope,
            risk,
            sourcePolicy,
            searchQueries,
            acceptanceCriteria,
        });
    }

    return { accepted, rejected };
}

function canonicalScope(scope: KnowledgeNeed["scope"]): string {
    return Object.entries(scope)
        .filter(([, value]) => !!value)
        .sort(([a], [b]) => a.localeCompare(b))
        .map(([key, value]) => `${key}=${String(value).trim().toLowerCase()}`)
        .join("|");
}

export function knowledgeLookupKey(need: KnowledgeNeed): string {
    const acceptanceCriteria = [...new Set(need.acceptanceCriteria
        .map((criterion) => criterion.trim().replace(/\s+/g, " ").toLowerCase())
        .filter(Boolean))].sort();
    return [
        "v2",
        need.kind,
        need.specificity,
        need.risk,
        need.sourcePolicy,
        need.claim.answerType,
        need.claim.subject.trim().toLowerCase(),
        need.claim.question.trim().replace(/\s+/g, " ").toLowerCase(),
        canonicalScope(need.scope),
        JSON.stringify(acceptanceCriteria),
    ].join("::");
}

export function deduplicateKnowledgeNeeds(needs: KnowledgeNeed[]): KnowledgeNeed[] {
    const seen = new Set<string>();
    return needs.filter((need) => {
        const lookupKey = knowledgeLookupKey(need);
        if (seen.has(lookupKey)) return false;
        seen.add(lookupKey);
        return true;
    });
}

export function learningLookupKeys(needs: KnowledgeNeed[]): string[] {
    return [...new Set(needs.map(knowledgeLookupKey))].sort();
}

export async function learningLookupHash(needs: KnowledgeNeed[]): Promise<string> {
    const bytes = new TextEncoder().encode(learningLookupKeys(needs).join("\n"));
    const digest = await crypto.subtle.digest("SHA-256", bytes);
    return [...new Uint8Array(digest)].map((byte) => byte.toString(16).padStart(2, "0")).join("");
}

const PUBLIC_PACKAGE_PREFIXES = [
    "org.bukkit",
    "io.papermc",
    "com.destroystokyo",
    "net.kyori",
    "net.milkbowl",
    "me.clip",
    "com.sk89q",
];

function diagnosticText(diagnostic: BuildDiagnostic): string {
    return [diagnostic.message, ...diagnostic.details].join(" ").replace(/\s+/g, " ").trim();
}

function normalizeDependencyName(value: string): string {
    return value.toLowerCase().replace(/[^a-z0-9]/g, "");
}

function publicSymbolFromDiagnostic(text: string, projectPackage?: string): string {
    const missingPackage = text.match(/\bpackage\s+([a-zA-Z_$][\w$]*(?:\.[a-zA-Z_$][\w$]*)+)\s+does not exist\b/i)?.[1];
    const candidates = [
        ...(missingPackage ? [missingPackage] : []),
        ...(text.match(/\b(?:[a-z_][\w$]*\.){2,}[A-Za-z_$][\w$]*/g) ?? []),
    ];
    const ownPackage = projectPackage?.trim().toLowerCase();
    for (const candidate of candidates) {
        const normalized = candidate.replace(/[.,;:]+$/, "");
        const lower = normalized.toLowerCase();
        if (ownPackage && (lower === ownPackage || lower.startsWith(`${ownPackage}.`))) continue;
        if (PUBLIC_PACKAGE_PREFIXES.some((prefix) => lower === prefix || lower.startsWith(`${prefix}.`))) {
            return normalized;
        }
    }
    return "";
}

function dependencyFromDiagnostic(text: string, externalDeps: string[]): string {
    const normalizedText = normalizeDependencyName(text);
    const matched = externalDeps.find((dependency) => {
        const key = normalizeDependencyName(dependency);
        return key.length >= 3 && normalizedText.includes(key);
    });
    return matched ?? "";
}

function packageOfSymbol(symbol: string): string {
    const parts = symbol.split(".");
    if (parts.length < 2) return "";
    const last = parts[parts.length - 1];
    return /^[a-z_$][\w$]*$/.test(last) ? symbol : parts.slice(0, -1).join(".");
}

export function buildDiagnosticKnowledgeNeeds(input: {
    diagnostics: BuildDiagnostic[];
    previousDiagnostics?: BuildDiagnostic[];
    coreType?: string;
    mcVersion?: string;
    projectPackage?: string;
    externalDeps?: string[];
    limit?: number;
}): KnowledgeNeed[] {
    const limit = Math.max(0, Math.min(3, Math.floor(input.limit ?? 3)));
    if (!limit || !input.mcVersion) return [];

    const externalDeps = cleanList(input.externalDeps, 8, 120);
    const previousKeys = new Set((input.previousDiagnostics ?? []).map((item) => item.key));
    const repeatedOnly = previousKeys.size > 0;
    const candidates = input.diagnostics.filter((diagnostic) =>
        !repeatedOnly || previousKeys.has(diagnostic.key) || diagnostic.category === "dependency",
    );
    const rawNeeds: KnowledgeNeed[] = [];

    for (const diagnostic of candidates) {
        const text = diagnosticText(diagnostic);
        let dependency = dependencyFromDiagnostic(text, externalDeps);
        const symbol = publicSymbolFromDiagnostic(text, input.projectPackage);
        if (!dependency && externalDeps.length === 1 && (diagnostic.category === "dependency" || symbol)) {
            dependency = externalDeps[0];
        }
        if (!dependency && !symbol) continue;

        const coordinateQuestion = diagnostic.category === "dependency" || /\b(?:artifact|dependency|package\s+.+does not exist)\b/i.test(text);
        const subject = symbol || dependency;
        const answerType: KnowledgeAnswerType = coordinateQuestion && dependency ? "coordinate" : "signature";
        const question = answerType === "coordinate"
            ? `What official Maven coordinate and repository should be used for ${dependency} with ${input.coreType || "Paper"} ${input.mcVersion}?`
            : `What is the exact ${input.coreType || "Paper"} ${input.mcVersion} API signature and import for ${subject}?`;
        const scope: KnowledgeNeed["scope"] = {
            coreType: clean(input.coreType, 40) || undefined,
            mcVersion: clean(input.mcVersion, 80),
            dependency: dependency || undefined,
            packageName: symbol ? packageOfSymbol(symbol) || undefined : undefined,
            symbol: symbol || undefined,
        };
        const idSuffix = diagnostic.key.split(":").pop()?.replace(/[^a-z0-9]/gi, "").slice(-16) || String(rawNeeds.length + 1);
        rawNeeds.push({
            id: `fix-${idSuffix}`,
            kind: "fact",
            trigger: "diagnostic_repeat",
            specificity: symbol ? "exact" : "scoped",
            claim: { subject, question, answerType },
            scope,
            risk: "medium",
            sourcePolicy: answerType === "coordinate" ? "dependency" : "api_signature",
            searchQueries: answerType === "coordinate"
                ? [
                    `${dependency} official Maven repository ${input.mcVersion}`,
                    `${dependency} ${input.coreType || "Paper"} dependency documentation`,
                ]
                : [
                    `${subject} ${input.coreType || "Paper"} ${input.mcVersion} official Javadoc`,
                    `${subject} official API source tag ${input.mcVersion}`,
                ],
            acceptanceCriteria: answerType === "coordinate"
                ? [
                    "An official repository or immutable release metadata states the groupId, artifactId, version, and repository URL.",
                    `The artifact is applicable to ${input.coreType || "Paper"} ${input.mcVersion}.`,
                ]
                : [
                    "Versioned official Javadoc, artifact metadata, or an immutable source tag states the exact symbol and signature.",
                    `The signature is applicable to ${input.coreType || "Paper"} ${input.mcVersion}.`,
                ],
        });
        if (rawNeeds.length >= limit) break;
    }

    return assessKnowledgeNeeds(rawNeeds, {
        coreType: input.coreType,
        mcVersion: input.mcVersion,
    }, limit).accepted;
}
