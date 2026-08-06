import { isBuildInfrastructureDiagnostic, type BuildDiagnostic } from "../buildDiagnostics";
import type {
    KnowledgeAnswerType,
    KnowledgeKind,
    KnowledgeNeed,
    KnowledgeRisk,
    KnowledgeSpecificity,
    KnowledgeTrigger,
    LearningIntegrationKind,
    LearningNeedTriggerReason,
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
const INTEGRATION_KINDS = new Set<LearningIntegrationKind>([
    "nms",
    "craftbukkit",
    "version_reflection",
    "external_plugin",
]);
const TRIGGER_REASONS = new Set<LearningNeedTriggerReason>([
    "nms_version_sensitive",
    "reflection_contract",
    "external_plugin_contract",
    "persistent_diagnostic_gap",
]);
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

function strictPathIds(value: unknown): string[] | null {
    if (value === undefined) return [];
    if (!Array.isArray(value) || value.length > 3) return null;
    const seen = new Set<string>();
    const out: string[] = [];
    for (const item of value) {
        if (typeof item !== "string") return null;
        const normalized = item.trim().replace(/\s+/g, " ");
        if (!/^[A-Za-z0-9_-]{1,80}$/.test(normalized)) return null;
        if (seen.has(normalized)) continue;
        seen.add(normalized);
        out.push(normalized);
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
    defaults: { coreType?: string; mcVersion?: string; allowedPathIds?: string[] } = {},
    limit = 3,
): KnowledgeNeedAssessment {
    const rawNeeds = Array.isArray(value) ? value : [];
    const accepted: KnowledgeNeed[] = [];
    const rejected: KnowledgeNeedRejection[] = [];
    const ids = new Set<string>();
    const allowedPathIds = Array.isArray(defaults.allowedPathIds)
        ? new Set(defaults.allowedPathIds.filter((id) => /^[A-Za-z0-9_-]{1,80}$/.test(id)))
        : null;

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
        const integrationKind = item.integrationKind === undefined
            ? undefined
            : enumValue(item.integrationKind, INTEGRATION_KINDS) ?? undefined;
        const triggerReason = item.triggerReason === undefined
            ? undefined
            : enumValue(item.triggerReason, TRIGGER_REASONS) ?? undefined;
        const pathIds = strictPathIds(item.pathIds);

        let reason = "";
        if (!id || ids.has(id)) reason = "invalid_id";
        else if (!kind || !trigger || !specificity || !answerType || !risk || !sourcePolicy) reason = "invalid_enum";
        else if (item.integrationKind !== undefined && !integrationKind) reason = "invalid_integration_kind";
        else if (item.triggerReason !== undefined && !triggerReason) reason = "invalid_trigger_reason";
        else if (!pathIds) reason = "invalid_path_ids";
        else if (allowedPathIds && pathIds.some((pathId) => !allowedPathIds.has(pathId))) reason = "unknown_path_id";
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
            ...(integrationKind ? { integrationKind } : {}),
            ...(triggerReason ? { triggerReason } : {}),
            ...(pathIds?.length ? { pathIds } : {}),
        });
    }

    return { accepted, rejected };
}

function normalizedIdentifier(value: string): string {
    return value.toLowerCase().replace(/[^a-z0-9]/g, "");
}

function needIntegrationText(need: KnowledgeNeed): string {
    return [
        need.claim.subject,
        need.claim.question,
        need.scope.dependency,
        need.scope.packageName,
        need.scope.symbol,
    ].filter(Boolean).join(" ").toLowerCase();
}

function plannerIntegrationReason(
    need: KnowledgeNeed,
    input: { userPrompt?: string; externalDeps?: string[]; chosenPathId?: string },
): string {
    if (!need.integrationKind || !need.triggerReason) return "missing_integration_classification";
    if (need.kind !== "fact") return "planner_strategy_not_allowed";
    if (input.chosenPathId && need.pathIds?.length && !need.pathIds.includes(input.chosenPathId)) {
        return "unselected_path";
    }

    const text = needIntegrationText(need);
    if (need.integrationKind === "nms") {
        if (need.triggerReason !== "nms_version_sensitive" && need.triggerReason !== "reflection_contract") {
            return "invalid_nms_reason";
        }
        return /(?:\bnet\.minecraft\b|\bnms\b)/i.test(text) ? "" : "nms_scope_missing";
    }
    if (need.integrationKind === "craftbukkit") {
        if (need.triggerReason !== "nms_version_sensitive" && need.triggerReason !== "reflection_contract") {
            return "invalid_craftbukkit_reason";
        }
        return /(?:org\.bukkit\.craftbukkit|craftbukkit)/i.test(text) ? "" : "craftbukkit_scope_missing";
    }
    if (need.integrationKind === "version_reflection") {
        if (need.triggerReason !== "reflection_contract") return "invalid_reflection_reason";
        const reflectionBound = /(?:reflect|class\.forname|getdeclared|getmethod|getfield|反射)/i.test(text);
        const serverBound = /(?:net\.minecraft|org\.bukkit\.craftbukkit|craftbukkit|\bnms\b)/i.test(text);
        return reflectionBound && serverBound ? "" : "reflection_scope_missing";
    }

    if (need.triggerReason !== "external_plugin_contract") return "invalid_external_plugin_reason";
    const promptKey = normalizedIdentifier(input.userPrompt ?? "");
    const explicitDependencies = cleanList(input.externalDeps, 8, 120).filter((dependency) => {
        const key = normalizedIdentifier(dependency);
        return key.length >= 3 && promptKey.includes(key);
    });
    const needKey = normalizedIdentifier(text);
    const matched = explicitDependencies.some((dependency) => {
        const key = normalizedIdentifier(dependency);
        return key.length >= 3 && needKey.includes(key);
    });
    return matched ? "" : "external_plugin_not_declared";
}

export function filterPlannerKnowledgeNeeds(
    needs: KnowledgeNeed[],
    input: { userPrompt?: string; externalDeps?: string[]; chosenPathId?: string } = {},
): KnowledgeNeedAssessment {
    const accepted: KnowledgeNeed[] = [];
    const rejected: KnowledgeNeedRejection[] = [];
    needs.forEach((need, index) => {
        const reason = plannerIntegrationReason(need, input);
        if (reason) rejected.push({ index, reason });
        else accepted.push(need);
    });
    return { accepted, rejected };
}

export function filterSelectedPathKnowledgeNeeds(
    needs: KnowledgeNeed[],
    chosenPathId?: string,
): KnowledgeNeedAssessment {
    const selectedPathId = clean(chosenPathId, 80);
    const accepted: KnowledgeNeed[] = [];
    const rejected: KnowledgeNeedRejection[] = [];

    needs.forEach((need, index) => {
        if (need.pathIds?.length && (!selectedPathId || !need.pathIds.includes(selectedPathId))) {
            rejected.push({ index, reason: selectedPathId ? "unselected_path" : "path_not_selected" });
        } else {
            accepted.push(need);
        }
    });

    return { accepted, rejected };
}

export function filterFixKnowledgeNeeds(
    needs: KnowledgeNeed[],
    input: { repairAttempts?: number } = {},
): KnowledgeNeedAssessment {
    const repairAttempts = Math.max(0, Math.floor(Number(input.repairAttempts) || 0));
    const accepted: KnowledgeNeed[] = [];
    const rejected: KnowledgeNeedRejection[] = [];

    needs.forEach((need, index) => {
        let reason = "";
        if (repairAttempts < 1) reason = "repair_not_attempted";
        else if (need.kind !== "fact") reason = "fix_strategy_not_allowed";
        else if (need.trigger !== "diagnostic_repeat") reason = "fix_trigger_not_diagnostic_repeat";
        else if (!need.integrationKind) reason = "missing_integration_classification";
        else if (need.triggerReason !== "persistent_diagnostic_gap") reason = "fix_not_persistent_diagnostic_gap";

        if (reason) rejected.push({ index, reason });
        else accepted.push(need);
    });

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
    "net.minecraft",
    "org.bukkit",
    "io.papermc",
    "com.destroystokyo",
    "net.kyori",
    "net.milkbowl",
    "me.clip",
    "com.sk89q",
];
const EXTERNAL_PLUGIN_PACKAGE_PREFIXES = ["net.milkbowl", "me.clip", "com.sk89q"];

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

function diagnosticIntegrationKind(
    symbol: string,
    dependency: string,
    text: string,
): LearningIntegrationKind | undefined {
    const lowerSymbol = symbol.toLowerCase();
    if (lowerSymbol === "net.minecraft" || lowerSymbol.startsWith("net.minecraft.")) return "nms";
    if (lowerSymbol === "org.bukkit.craftbukkit" || lowerSymbol.startsWith("org.bukkit.craftbukkit.")) {
        return /(?:reflect|class\.forname|getdeclared|getmethod|getfield|反射)/i.test(text)
            ? "version_reflection"
            : "craftbukkit";
    }
    if (dependency) return "external_plugin";
    if (EXTERNAL_PLUGIN_PACKAGE_PREFIXES.some((prefix) =>
        lowerSymbol === prefix || lowerSymbol.startsWith(`${prefix}.`)
    )) return "external_plugin";
    return undefined;
}

interface DiagnosticKnowledgeIdentity {
    integrationKind: LearningIntegrationKind;
    dependencyKey: string;
    packageKey: string;
    symbolKey: string;
}

function publicPackageContract(symbol: string, integrationKind: LearningIntegrationKind): string {
    const packageName = packageOfSymbol(symbol).toLowerCase();
    if (!packageName) return "";
    if (integrationKind === "nms") return "net.minecraft";
    if (integrationKind === "craftbukkit" || integrationKind === "version_reflection") {
        return "org.bukkit.craftbukkit";
    }
    const knownPrefix = EXTERNAL_PLUGIN_PACKAGE_PREFIXES.find((prefix) =>
        packageName === prefix || packageName.startsWith(`${prefix}.`)
    );
    if (knownPrefix) {
        const suffix = packageName.slice(knownPrefix.length + 1).split(".").filter(Boolean)[0];
        return suffix ? `${knownPrefix}.${suffix}` : knownPrefix;
    }
    return packageName.split(".").filter(Boolean).slice(0, 3).join(".");
}

function diagnosticKnowledgeIdentity(
    diagnostic: BuildDiagnostic,
    externalDeps: string[],
    projectPackage?: string,
): DiagnosticKnowledgeIdentity | null {
    const text = diagnosticText(diagnostic);
    const dependency = dependencyFromDiagnostic(text, externalDeps);
    const symbol = publicSymbolFromDiagnostic(text, projectPackage);
    const integrationKind = diagnosticIntegrationKind(symbol, dependency, text);
    if (!integrationKind) return null;
    return {
        integrationKind,
        dependencyKey: normalizeDependencyName(dependency),
        packageKey: publicPackageContract(symbol, integrationKind),
        symbolKey: normalizeDependencyName(symbol),
    };
}

function sameDiagnosticKnowledgeContract(
    current: DiagnosticKnowledgeIdentity,
    previous: DiagnosticKnowledgeIdentity,
): boolean {
    if (current.integrationKind === "external_plugin" || previous.integrationKind === "external_plugin") {
        if (current.integrationKind !== previous.integrationKind) return false;
        if (current.dependencyKey && current.dependencyKey === previous.dependencyKey) return true;
        return !!current.packageKey && current.packageKey === previous.packageKey;
    }
    const currentFamily = current.integrationKind === "nms" ? "nms" : "craftbukkit";
    const previousFamily = previous.integrationKind === "nms" ? "nms" : "craftbukkit";
    if (currentFamily !== previousFamily) return false;
    if (current.symbolKey && current.symbolKey === previous.symbolKey) return true;
    return !!current.packageKey && current.packageKey === previous.packageKey;
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
    if (!limit || !input.mcVersion || !(input.previousDiagnostics?.length)) return [];
    // Maven transport/plugin resolution failures invalidate the whole diagnostic batch as learning evidence.
    if (input.diagnostics.some(isBuildInfrastructureDiagnostic)) return [];

    const externalDeps = cleanList(input.externalDeps, 8, 120);
    const previousIdentities = input.previousDiagnostics
        .filter((diagnostic) => !isBuildInfrastructureDiagnostic(diagnostic))
        .map((diagnostic) => diagnosticKnowledgeIdentity(diagnostic, externalDeps, input.projectPackage))
        .filter((identity): identity is DiagnosticKnowledgeIdentity => !!identity);
    if (!previousIdentities.length) return [];

    const rawNeeds: KnowledgeNeed[] = [];

    for (const diagnostic of input.diagnostics) {
        if (isBuildInfrastructureDiagnostic(diagnostic)) continue;
        const text = diagnosticText(diagnostic);
        const dependency = dependencyFromDiagnostic(text, externalDeps);
        const symbol = publicSymbolFromDiagnostic(text, input.projectPackage);
        const identity = diagnosticKnowledgeIdentity(diagnostic, externalDeps, input.projectPackage);
        if (!identity || !previousIdentities.some((previous) =>
            sameDiagnosticKnowledgeContract(identity, previous)
        )) continue;
        const integrationKind = identity.integrationKind;

        const coordinateQuestion = integrationKind === "external_plugin"
            && (diagnostic.category === "dependency" || /\b(?:artifact|dependency|package\s+.+does not exist)\b/i.test(text));
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
            integrationKind,
            triggerReason: "persistent_diagnostic_gap",
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
