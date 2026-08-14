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
const TRIGGERS = new Set<KnowledgeTrigger>(["contract_miss", "version_gap", "dependency_gap", "skill_staleness", "diagnostic_repeat"]);
const SPECIFICITIES = new Set<KnowledgeSpecificity>(["exact", "scoped", "ambiguous"]);
const ANSWER_TYPES = new Set<KnowledgeAnswerType>(["signature", "coordinate", "behavior", "migration", "rule"]);
const RISKS = new Set<KnowledgeRisk>(["low", "medium", "high"]);
const SOURCE_POLICIES = new Set<SourcePolicy>(["api_signature", "dependency", "behavior", "release"]);
const INTEGRATION_KINDS = new Set<LearningIntegrationKind>(["public_api", "nms", "craftbukkit", "version_reflection", "external_plugin"]);
const TRIGGER_REASONS = new Set<LearningNeedTriggerReason>(["nms_version_sensitive", "reflection_contract", "external_plugin_contract", "persistent_diagnostic_gap"]);
const GENERIC_SUBJECTS = new Set(["api", "paper api", "bukkit api", "spigot api", "minecraft", "minecraft plugin", "插件开发", "learn", "learning", "学习"]);

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
        if (!seen.has(normalized)) out.push(normalized);
        seen.add(normalized);
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

export interface KnowledgeNeedRejection { index: number; reason: string; }
export interface KnowledgeNeedAssessment { accepted: KnowledgeNeed[]; rejected: KnowledgeNeedRejection[]; }

export function assessKnowledgeNeeds(value: unknown, defaults: { coreType?: string; mcVersion?: string; allowedPathIds?: string[] } = {}, limit = 3): KnowledgeNeedAssessment {
    const rawNeeds = Array.isArray(value) ? value : [];
    const accepted: KnowledgeNeed[] = [];
    const rejected: KnowledgeNeedRejection[] = [];
    const ids = new Set<string>();
    const allowedPathIds = Array.isArray(defaults.allowedPathIds) ? new Set(defaults.allowedPathIds.filter((id) => /^[A-Za-z0-9_-]{1,80}$/.test(id))) : null;
    for (let index = 0; index < rawNeeds.length && accepted.length < Math.max(0, limit); index++) {
        const raw = rawNeeds[index];
        if (!raw || typeof raw !== "object") { rejected.push({ index, reason: "not_object" }); continue; }
        const item = raw as Record<string, unknown>;
        const claimRaw = item.claim && typeof item.claim === "object" ? item.claim as Record<string, unknown> : {};
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
        const integrationKind = item.integrationKind === undefined ? undefined : enumValue(item.integrationKind, INTEGRATION_KINDS) ?? undefined;
        const triggerReason = item.triggerReason === undefined ? undefined : enumValue(item.triggerReason, TRIGGER_REASONS) ?? undefined;
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
        if (reason) { rejected.push({ index, reason }); continue; }
        ids.add(id);
        accepted.push({ id, kind, trigger, specificity, claim: { subject, question, answerType }, scope, risk, sourcePolicy, searchQueries, acceptanceCriteria, ...(integrationKind ? { integrationKind } : {}), ...(triggerReason ? { triggerReason } : {}), ...(pathIds.length ? { pathIds } : {}) });
    }
    return { accepted, rejected };
}

function normalizedIdentifier(value: string): string { return value.toLowerCase().replace(/[^a-z0-9]/g, ""); }
function needIntegrationText(need: KnowledgeNeed): string { return [need.claim.subject, need.claim.question, need.scope.dependency, need.scope.packageName, need.scope.symbol].filter(Boolean).join(" ").toLowerCase(); }

function plannerIntegrationReason(need: KnowledgeNeed, input: { userPrompt?: string; externalDeps?: string[]; chosenPathId?: string }): string {
    if (!need.integrationKind || !need.triggerReason) return "missing_integration_classification";
    if (need.kind !== "fact") return "planner_strategy_not_allowed";
    if (input.chosenPathId && need.pathIds?.length && !need.pathIds.includes(input.chosenPathId)) return "unselected_path";
    const text = needIntegrationText(need);
    if (need.integrationKind === "public_api") return "planner_public_api_not_allowed";
    if (need.integrationKind === "nms") {
        if (need.triggerReason !== "nms_version_sensitive" && need.triggerReason !== "reflection_contract") return "invalid_nms_reason";
        return /(?:\bnet\.minecraft\b|\bnms\b)/i.test(text) ? "" : "nms_scope_missing";
    }
    if (need.integrationKind === "craftbukkit") {
        if (need.triggerReason !== "nms_version_sensitive" && need.triggerReason !== "reflection_contract") return "invalid_craftbukkit_reason";
        return /(?:org\.bukkit\.craftbukkit|craftbukkit)/i.test(text) ? "" : "craftbukkit_scope_missing";
    }
    if (need.integrationKind === "version_reflection") {
        if (need.triggerReason !== "reflection_contract") return "invalid_reflection_reason";
        return /(?:reflect|class\.forname|getdeclared|getmethod|getfield|反射)/i.test(text) && /(?:net\.minecraft|org\.bukkit\.craftbukkit|craftbukkit|\bnms\b)/i.test(text) ? "" : "reflection_scope_missing";
    }
    if (need.triggerReason !== "external_plugin_contract") return "invalid_external_plugin_reason";
    const promptKey = normalizedIdentifier(input.userPrompt ?? "");
    const explicitDependencies = cleanList(input.externalDeps, 8, 120).filter((dependency) => { const key = normalizedIdentifier(dependency); return key.length >= 3 && promptKey.includes(key); });
    const needKey = normalizedIdentifier(text);
    return explicitDependencies.some((dependency) => { const key = normalizedIdentifier(dependency); return key.length >= 3 && needKey.includes(key); }) ? "" : "external_plugin_not_declared";
}

export function filterPlannerKnowledgeNeeds(needs: KnowledgeNeed[], input: { userPrompt?: string; externalDeps?: string[]; chosenPathId?: string } = {}): KnowledgeNeedAssessment {
    const accepted: KnowledgeNeed[] = [], rejected: KnowledgeNeedRejection[] = [];
    needs.forEach((need, index) => { const reason = plannerIntegrationReason(need, input); reason ? rejected.push({ index, reason }) : accepted.push(need); });
    return { accepted, rejected };
}

export function filterSelectedPathKnowledgeNeeds(needs: KnowledgeNeed[], chosenPathId?: string): KnowledgeNeedAssessment {
    const selectedPathId = clean(chosenPathId, 80); const accepted: KnowledgeNeed[] = [], rejected: KnowledgeNeedRejection[] = [];
    needs.forEach((need, index) => need.pathIds?.length && (!selectedPathId || !need.pathIds.includes(selectedPathId)) ? rejected.push({ index, reason: selectedPathId ? "unselected_path" : "path_not_selected" }) : accepted.push(need));
    return { accepted, rejected };
}

export function filterFixKnowledgeNeeds(needs: KnowledgeNeed[], input: { repairAttempts?: number } = {}): KnowledgeNeedAssessment {
    const repairAttempts = Math.max(0, Math.floor(Number(input.repairAttempts) || 0)); const accepted: KnowledgeNeed[] = [], rejected: KnowledgeNeedRejection[] = [];
    needs.forEach((need, index) => {
        let reason = "";
        if (repairAttempts < 1) reason = "repair_not_attempted";
        else if (need.kind !== "fact") reason = "fix_strategy_not_allowed";
        else if (need.trigger !== "diagnostic_repeat") reason = "fix_trigger_not_diagnostic_repeat";
        else if (!need.integrationKind) reason = "missing_integration_classification";
        else if (need.triggerReason !== "persistent_diagnostic_gap") reason = "fix_not_persistent_diagnostic_gap";
        reason ? rejected.push({ index, reason }) : accepted.push(need);
    });
    return { accepted, rejected };
}

function canonicalScope(scope: KnowledgeNeed["scope"]): string { return Object.entries(scope).filter(([, value]) => !!value).sort(([a], [b]) => a.localeCompare(b)).map(([key, value]) => `${key}=${String(value).trim().toLowerCase()}`).join("|"); }
export function knowledgeLookupKey(need: KnowledgeNeed): string {
    const criteria = [...new Set(need.acceptanceCriteria.map((c) => c.trim().replace(/\s+/g, " ").toLowerCase()).filter(Boolean))].sort();
    return ["v2", need.kind, need.specificity, need.risk, need.sourcePolicy, need.claim.answerType, need.claim.subject.trim().toLowerCase(), need.claim.question.trim().replace(/\s+/g, " ").toLowerCase(), canonicalScope(need.scope), JSON.stringify(criteria)].join("::");
}
export function deduplicateKnowledgeNeeds(needs: KnowledgeNeed[]): KnowledgeNeed[] { const seen = new Set<string>(); return needs.filter((need) => { const key = knowledgeLookupKey(need); if (seen.has(key)) return false; seen.add(key); return true; }); }
export function learningLookupKeys(needs: KnowledgeNeed[]): string[] { return [...new Set(needs.map(knowledgeLookupKey))].sort(); }
export async function learningLookupHash(needs: KnowledgeNeed[]): Promise<string> { const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(learningLookupKeys(needs).join("\n"))); return [...new Uint8Array(digest)].map((byte) => byte.toString(16).padStart(2, "0")).join(""); }

const PUBLIC_PACKAGE_PREFIXES = ["net.minecraft", "org.bukkit", "io.papermc", "com.destroystokyo", "net.kyori", "net.milkbowl", "me.clip", "com.sk89q"];
const PUBLIC_API_PACKAGE_PREFIXES = ["org.bukkit", "io.papermc", "com.destroystokyo", "net.kyori"];
const EXTERNAL_PLUGIN_PACKAGE_PREFIXES = ["net.milkbowl", "me.clip", "com.sk89q"];
const PUBLIC_API_SIMPLE_TYPES: Record<string, string> = {
    Particle: "org.bukkit.Particle",
    Attribute: "org.bukkit.attribute.Attribute",
    PlayerProfile: "org.bukkit.profile.PlayerProfile",
    NamespacedKey: "org.bukkit.NamespacedKey",
    Material: "org.bukkit.Material",
    Sound: "org.bukkit.Sound",
    EntityType: "org.bukkit.entity.EntityType",
};

function diagnosticText(diagnostic: BuildDiagnostic): string { return [diagnostic.message, ...diagnostic.details].join(" ").replace(/\s+/g, " ").trim(); }
function normalizeDependencyName(value: string): string { return value.toLowerCase().replace(/[^a-z0-9]/g, ""); }
function publicSymbolFromDiagnostic(text: string, projectPackage?: string): string {
    const missingPackage = text.match(/\bpackage\s+([a-zA-Z_$][\w$]*(?:\.[a-zA-Z_$][\w$]*)+)\s+does not exist\b/i)?.[1];
    const candidates = [...(missingPackage ? [missingPackage] : []), ...(text.match(/\b(?:[a-z_][\w$]*\.){2,}[A-Za-z_$][\w$]*/g) ?? [])];
    const ownPackage = projectPackage?.trim().toLowerCase();
    for (const candidate of candidates) {
        const normalized = candidate.replace(/[.,;:]+$/, ""); const lower = normalized.toLowerCase();
        if (ownPackage && (lower === ownPackage || lower.startsWith(`${ownPackage}.`))) continue;
        if (PUBLIC_PACKAGE_PREFIXES.some((prefix) => lower === prefix || lower.startsWith(`${prefix}.`))) return normalized;
    }
    const location = text.match(/\blocation:\s+(?:class|interface|enum)\s+([A-Za-z_$][\w$]*)/i)?.[1];
    const missing = text.match(/\bsymbol:\s+(?:variable|method|class|interface)\s+([A-Za-z_$][\w$]*)/i)?.[1];
    const qualifiedType = location && PUBLIC_API_SIMPLE_TYPES[location];
    if (qualifiedType) return missing && missing !== location ? `${qualifiedType}.${missing}` : qualifiedType;
    return "";
}
function dependencyFromDiagnostic(text: string, externalDeps: string[]): string { const normalizedText = normalizeDependencyName(text); return externalDeps.find((dependency) => { const key = normalizeDependencyName(dependency); return key.length >= 3 && normalizedText.includes(key); }) ?? ""; }
function packageOfSymbol(symbol: string): string {
    const memberBase = symbol.replace(/\.[A-Z][A-Z0-9_]*$/, "");
    const parts = memberBase.split("."); if (parts.length < 2) return "";
    const typeIndex = parts.findIndex((part) => /^[A-Z_$]/.test(part));
    return typeIndex > 0 ? parts.slice(0, typeIndex).join(".") : parts.slice(0, -1).join(".");
}
function diagnosticIntegrationKind(symbol: string, dependency: string, text: string): LearningIntegrationKind | undefined {
    const lower = symbol.toLowerCase();
    if (lower === "net.minecraft" || lower.startsWith("net.minecraft.")) return "nms";
    if (lower === "org.bukkit.craftbukkit" || lower.startsWith("org.bukkit.craftbukkit.")) return /(?:reflect|class\.forname|getdeclared|getmethod|getfield|反射)/i.test(text) ? "version_reflection" : "craftbukkit";
    if (dependency || EXTERNAL_PLUGIN_PACKAGE_PREFIXES.some((prefix) => lower === prefix || lower.startsWith(`${prefix}.`))) return "external_plugin";
    if (PUBLIC_API_PACKAGE_PREFIXES.some((prefix) => lower === prefix || lower.startsWith(`${prefix}.`))) return "public_api";
    return undefined;
}
interface DiagnosticKnowledgeIdentity { integrationKind: LearningIntegrationKind; dependencyKey: string; packageKey: string; symbolKey: string; }
function publicPackageContract(symbol: string, kind: LearningIntegrationKind): string {
    const packageName = packageOfSymbol(symbol).toLowerCase(); if (!packageName) return "";
    if (kind === "nms") return "net.minecraft";
    if (kind === "craftbukkit" || kind === "version_reflection") return "org.bukkit.craftbukkit";
    if (kind === "public_api") {
        const type = symbol.replace(/\.[A-Z][A-Z0-9_]*$/, "").toLowerCase();
        return type || packageName;
    }
    const prefix = EXTERNAL_PLUGIN_PACKAGE_PREFIXES.find((p) => packageName === p || packageName.startsWith(`${p}.`));
    if (prefix) { const suffix = packageName.slice(prefix.length + 1).split(".").filter(Boolean)[0]; return suffix ? `${prefix}.${suffix}` : prefix; }
    return packageName.split(".").filter(Boolean).slice(0, 3).join(".");
}
function diagnosticKnowledgeIdentity(diagnostic: BuildDiagnostic, externalDeps: string[], projectPackage?: string): DiagnosticKnowledgeIdentity | null {
    const text = diagnosticText(diagnostic), dependency = dependencyFromDiagnostic(text, externalDeps), symbol = publicSymbolFromDiagnostic(text, projectPackage), integrationKind = diagnosticIntegrationKind(symbol, dependency, text);
    return integrationKind ? { integrationKind, dependencyKey: normalizeDependencyName(dependency), packageKey: publicPackageContract(symbol, integrationKind), symbolKey: normalizeDependencyName(symbol) } : null;
}
function sameDiagnosticKnowledgeContract(current: DiagnosticKnowledgeIdentity, previous: DiagnosticKnowledgeIdentity): boolean {
    if (current.integrationKind !== previous.integrationKind) return false;
    if (current.integrationKind === "external_plugin") return !!(current.dependencyKey && current.dependencyKey === previous.dependencyKey) || !!current.packageKey && current.packageKey === previous.packageKey;
    if (current.integrationKind === "public_api") return !!current.packageKey && current.packageKey === previous.packageKey;
    const family = (kind: LearningIntegrationKind) => kind === "nms" ? "nms" : "craftbukkit";
    return family(current.integrationKind) === family(previous.integrationKind) && (!!(current.symbolKey && current.symbolKey === previous.symbolKey) || !!current.packageKey && current.packageKey === previous.packageKey);
}

export function buildDiagnosticKnowledgeNeeds(input: { diagnostics: BuildDiagnostic[]; previousDiagnostics?: BuildDiagnostic[]; coreType?: string; mcVersion?: string; projectPackage?: string; externalDeps?: string[]; limit?: number; }): KnowledgeNeed[] {
    const limit = Math.max(0, Math.min(3, Math.floor(input.limit ?? 3)));
    if (!limit || !input.mcVersion || !input.previousDiagnostics?.length || input.diagnostics.some(isBuildInfrastructureDiagnostic)) return [];
    const externalDeps = cleanList(input.externalDeps, 8, 120);
    const previousIdentities = input.previousDiagnostics.filter((d) => !isBuildInfrastructureDiagnostic(d)).map((d) => diagnosticKnowledgeIdentity(d, externalDeps, input.projectPackage)).filter((x): x is DiagnosticKnowledgeIdentity => !!x);
    if (!previousIdentities.length) return [];
    const rawNeeds: KnowledgeNeed[] = [];
    for (const diagnostic of input.diagnostics) {
        if (isBuildInfrastructureDiagnostic(diagnostic)) continue;
        const text = diagnosticText(diagnostic), dependency = dependencyFromDiagnostic(text, externalDeps), symbol = publicSymbolFromDiagnostic(text, input.projectPackage), identity = diagnosticKnowledgeIdentity(diagnostic, externalDeps, input.projectPackage);
        if (!identity || !previousIdentities.some((previous) => sameDiagnosticKnowledgeContract(identity, previous))) continue;
        const integrationKind = identity.integrationKind;
        const coordinateQuestion = integrationKind === "external_plugin" && (diagnostic.category === "dependency" || /\b(?:artifact|dependency|package\s+.+does not exist)\b/i.test(text));
        const subject = symbol || dependency; if (!subject) continue;
        const answerType: KnowledgeAnswerType = coordinateQuestion && dependency ? "coordinate" : "signature";
        const question = answerType === "coordinate" ? `What official Maven coordinate and repository should be used for ${dependency} with ${input.coreType || "Paper"} ${input.mcVersion}?` : `What is the exact ${input.coreType || "Paper"} ${input.mcVersion} API signature and import for ${subject}?`;
        const idSuffix = diagnostic.key.split(":").pop()?.replace(/[^a-z0-9]/gi, "").slice(-16) || String(rawNeeds.length + 1);
        rawNeeds.push({
            id: `fix-${idSuffix}`, kind: "fact", trigger: "diagnostic_repeat", specificity: symbol ? "exact" : "scoped", claim: { subject, question, answerType },
            scope: { coreType: clean(input.coreType, 40) || undefined, mcVersion: clean(input.mcVersion, 80), dependency: dependency || undefined, packageName: symbol ? packageOfSymbol(symbol) || undefined : undefined, symbol: symbol || undefined },
            risk: "medium", sourcePolicy: answerType === "coordinate" ? "dependency" : "api_signature", integrationKind, triggerReason: "persistent_diagnostic_gap",
            searchQueries: answerType === "coordinate" ? [`${dependency} official Maven repository ${input.mcVersion}`, `${dependency} ${input.coreType || "Paper"} dependency documentation`] : [`${subject} ${input.coreType || "Paper"} ${input.mcVersion} official Javadoc`, `${subject} official API source tag ${input.mcVersion}`],
            acceptanceCriteria: answerType === "coordinate" ? ["An official repository or immutable release metadata states the groupId, artifactId, version, and repository URL.", `The artifact is applicable to ${input.coreType || "Paper"} ${input.mcVersion}.`] : ["Versioned official Javadoc, artifact metadata, or an immutable source tag states the exact symbol and signature.", `The signature is applicable to ${input.coreType || "Paper"} ${input.mcVersion}.`],
        });
        if (rawNeeds.length >= limit) break;
    }
    return assessKnowledgeNeeds(rawNeeds, { coreType: input.coreType, mcVersion: input.mcVersion }, limit).accepted;
}
