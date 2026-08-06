import type { KnowledgeNeed, LearningSourceRecord } from "./types";

const GENERIC_PROJECT_NAMES = new Set([
    "minecraft",
    "paper",
    "spigot",
    "bukkit",
    "plugin",
    "server",
]);

const GENERIC_CLASS_NAMES = new Set([
    "main",
    "plugin",
    "config",
    "command",
    "listener",
    "manager",
    "service",
    "util",
    "utils",
]);

const GENERIC_IDENTIFIERS = new Set([
    ...GENERIC_PROJECT_NAMES,
    ...GENERIC_CLASS_NAMES,
    "api",
    "class",
    "craftbukkit",
    "field",
    "gradle",
    "java",
    "javadoc",
    "maven",
    "method",
    "nms",
    "object",
    "paperapi",
    "player",
    "serverapi",
    "spigotapi",
    "string",
    "version",
]);

const CORE_PUBLIC_NAMESPACE_PREFIXES = [
    "com.destroystokyo.paper",
    "com.mojang",
    "io.papermc",
    "java",
    "javax",
    "net.kyori",
    "net.minecraft",
    "org.bukkit",
    "org.spigotmc",
];

const MAX_FORBIDDEN_TERMS = 256;
const MAX_COLLECTED_STRINGS = 256;
const MAX_SCANNED_TEXT_LENGTH = 50_000;
const EXTRACTION_OVERFLOW = "__shared_knowledge_private_term_overflow__";

function normalizedTerm(value: unknown): string {
    return typeof value === "string" ? value.trim().replace(/\s+/g, " ").toLowerCase() : "";
}

function storeTerm(terms: Set<string>, term: string): void {
    if (!term || terms.has(term) || terms.has(EXTRACTION_OVERFLOW)) return;
    if (terms.size >= MAX_FORBIDDEN_TERMS) {
        terms.add(EXTRACTION_OVERFLOW);
        return;
    }
    terms.add(term);
}

function addTerm(terms: Set<string>, value: unknown, minLength = 5): void {
    const term = normalizedTerm(value);
    if (term.length >= minLength) storeTerm(terms, term);
}

function normalizedIdentifierKey(value: string): string {
    return value.toLowerCase().replace(/[^a-z0-9]/g, "");
}

function isCorePublicNamespace(value: string): boolean {
    const normalized = value.toLowerCase().replace(/\\/g, "/").replace(/\//g, ".");
    return CORE_PUBLIC_NAMESPACE_PREFIXES.some((prefix) =>
        normalized === prefix || normalized.startsWith(`${prefix}.`)
    );
}

function addCandidateTerm(terms: Set<string>, value: unknown, minLength = 5): void {
    const term = normalizedTerm(value)
        .replace(/^[`'"“”‘’([{<]+/, "")
        .replace(/[`'"“”‘’\])}>.,;!?，。；！？]+$/, "");
    if (term.length < minLength) return;
    const key = normalizedIdentifierKey(term);
    if (!key || GENERIC_IDENTIFIERS.has(term) || GENERIC_IDENTIFIERS.has(key)) return;
    storeTerm(terms, term);
}

function addQualifiedIdentifier(terms: Set<string>, value: string): void {
    const normalized = value.trim().replace(/\\/g, "/").replace(/[.#:]+$/, "");
    if (!normalized || isCorePublicNamespace(normalized)) return;
    addCandidateTerm(terms, normalized);
    if (normalized.includes("/")) addCandidateTerm(terms, normalized.replace(/\//g, "."));

    const parts = normalized.split(/[./]/).filter(Boolean);
    const firstClass = parts.findIndex((part) => /^[A-Z_$]/.test(part));
    const packageParts = firstClass > 1
        ? parts.slice(0, firstClass)
        : parts.every((part) => /^[a-z_$]/.test(part)) ? parts : [];
    if (packageParts.length >= 2) {
        addCandidateTerm(terms, packageParts.join("."));
        addCandidateTerm(terms, packageParts.join("/"));
    }
    for (const part of firstClass >= 0 ? parts.slice(firstClass) : []) {
        addCandidateTerm(terms, part);
    }
}

function scanCandidateIdentifiers(terms: Set<string>, value: unknown): void {
    if (typeof value !== "string" || !value) return;
    if (value.length > MAX_SCANNED_TEXT_LENGTH) storeTerm(terms, EXTRACTION_OVERFLOW);
    const text = value.slice(0, MAX_SCANNED_TEXT_LENGTH);
    const standaloneText = text.replace(
        /\b[A-Za-z_$][A-Za-z0-9_$]*(?:(?:\.|\/)[A-Za-z_$][A-Za-z0-9_$]*){2,}\b/g,
        (identifier) => {
            addQualifiedIdentifier(terms, identifier);
            return " ".repeat(identifier.length);
        },
    );

    for (const match of standaloneText.matchAll(/\b[A-Z][A-Za-z0-9_$]{4,}\b/g)) {
        addCandidateTerm(terms, match[0]);
    }
    for (const match of standaloneText.matchAll(/\b[a-z][A-Za-z0-9_$]{3,}[A-Z][A-Za-z0-9_$]*\b/g)) {
        addCandidateTerm(terms, match[0]);
    }
    for (const match of text.matchAll(/(?:项目名|插件名|包名|类名|project\s+name|plugin\s+name|package\s+name|class\s+name)\s*(?:是|为|叫|[:：=])?\s*[`'"“”‘’]?([A-Za-z_$][A-Za-z0-9_.$:/-]{3,})/gi)) {
        const identifier = match[1];
        addTerm(terms, identifier, 4);
        if (identifier.includes(".")) addTerm(terms, identifier.replace(/\./g, "/"), 4);
    }
}

function addDependencyTerms(terms: Set<string>, value: unknown): void {
    if (typeof value !== "string") return;
    const dependency = value.trim();
    if (!dependency) return;
    const coordinate = dependency.split(":").map((part) => part.trim());
    if (coordinate.length >= 2 && coordinate[0] && coordinate[1]) {
        addQualifiedIdentifier(terms, coordinate[0]);
        addCandidateTerm(terms, coordinate[1], 4);
    } else if (dependency.includes(".") || dependency.includes("/")) {
        addQualifiedIdentifier(terms, dependency.replace(/[#:].*$/, ""));
    } else {
        addCandidateTerm(terms, dependency, 4);
    }
    scanCandidateIdentifiers(terms, dependency);
}

function collectStrings(value: unknown, out: string[], depth = 0): boolean {
    if (value == null) return false;
    if (depth > 5) return typeof value === "string" || typeof value === "object";
    if (typeof value === "string") {
        if (out.length >= MAX_COLLECTED_STRINGS) return true;
        out.push(value);
        return false;
    }
    if (Array.isArray(value)) {
        for (const item of value) {
            if (collectStrings(item, out, depth + 1)) return true;
        }
        return false;
    }
    if (typeof value === "object") {
        for (const key of Object.keys(value as Record<string, unknown>)) {
            if (collectStrings((value as Record<string, unknown>)[key], out, depth + 1)) {
                return true;
            }
        }
    }
    return false;
}

function addKnowledgeNeedTerms(terms: Set<string>, need: KnowledgeNeed): void {
    addDependencyTerms(terms, need.scope.dependency);
    if (need.scope.packageName) addQualifiedIdentifier(terms, need.scope.packageName);
    if (need.scope.symbol) {
        addQualifiedIdentifier(terms, need.scope.symbol.replace(/[#:].*$/, ""));
        scanCandidateIdentifiers(terms, need.scope.symbol);
    }
    if (/^[A-Za-z_$][A-Za-z0-9_$./:-]{3,}$/.test(need.claim.subject.trim())) {
        addDependencyTerms(terms, need.claim.subject);
    }
    const strings: string[] = [];
    const extractionOverflow = collectStrings({
        claim: need.claim,
        scope: need.scope,
        searchQueries: need.searchQueries,
        acceptanceCriteria: need.acceptanceCriteria,
    }, strings);
    if (extractionOverflow) storeTerm(terms, EXTRACTION_OVERFLOW);
    for (const value of strings) scanCandidateIdentifiers(terms, value);
}

export function sharedKnowledgeForbiddenTerms(input: {
    taskId?: string;
    projectName?: string;
    packageName?: string;
    generatedFilePaths?: string[];
    userPrompt?: string;
    clarifyRounds?: unknown[];
    externalDeps?: string[];
    knowledgeNeeds?: KnowledgeNeed[];
}): string[] {
    const terms = new Set<string>();
    addTerm(terms, input.taskId, 8);

    const packageName = normalizedTerm(input.packageName);
    if (packageName.length >= 5) {
        storeTerm(terms, packageName);
        storeTerm(terms, packageName.replace(/\./g, "/"));
    }

    const projectName = normalizedTerm(input.projectName);
    if (projectName.length >= 6 && !GENERIC_PROJECT_NAMES.has(projectName)) {
        storeTerm(terms, projectName);
    }

    for (const rawPath of input.generatedFilePaths ?? []) {
        const path = normalizedTerm(rawPath).replace(/\\/g, "/");
        if (!path) continue;
        if (path.length >= 12 && !/^(?:pom\.xml|build\.gradle(?:\.kts)?|settings\.gradle(?:\.kts)?|src\/main\/resources\/plugin\.yml)$/.test(path)) {
            storeTerm(terms, path);
        }
        const fileName = path.split("/").pop() ?? "";
        const className = fileName.replace(/\.(?:java|kt|groovy)$/i, "");
        if (className.length >= 6 && !GENERIC_CLASS_NAMES.has(className)) {
            storeTerm(terms, className);
        }
    }

    scanCandidateIdentifiers(terms, input.userPrompt);
    for (const round of input.clarifyRounds ?? []) {
        const record = round && typeof round === "object"
            ? round as Record<string, unknown>
            : {};
        const answers = record.answers && typeof record.answers === "object"
            ? record.answers as Record<string, unknown>
            : {};
        const todos = Array.isArray(record.todos) ? record.todos : [];
        for (const todo of todos) {
            if (!todo || typeof todo !== "object") continue;
            const item = todo as Record<string, unknown>;
            const question = typeof item.question === "string" ? item.question : "";
            const id = typeof item.id === "string" ? item.id : "";
            if (!id || !/(?:项目|插件|包|类|project|plugin|package|class).{0,12}(?:名|名称|name)/i.test(question)) {
                continue;
            }
            const answerStrings: string[] = [];
            if (collectStrings(answers[id], answerStrings)) {
                storeTerm(terms, EXTRACTION_OVERFLOW);
            }
            for (const value of answerStrings) {
                addTerm(terms, value, 4);
                if (value.includes(".")) addTerm(terms, value.replace(/\./g, "/"), 4);
            }
        }
        const strings: string[] = [];
        if (collectStrings(answers, strings)) storeTerm(terms, EXTRACTION_OVERFLOW);
        for (const value of strings) scanCandidateIdentifiers(terms, value);
    }
    for (const dependency of input.externalDeps ?? []) addDependencyTerms(terms, dependency);
    for (const need of input.knowledgeNeeds ?? []) addKnowledgeNeedTerms(terms, need);

    return [...terms].sort();
}

function normalizedProofText(value: string): string {
    return value.toLowerCase().replace(/\\/g, "/").replace(/\s+/g, " ");
}

function proofVariants(value: string): string[] {
    const normalized = normalizedProofText(value);
    const namespace = normalized.replace(/\//g, ".");
    return namespace === normalized ? [normalized] : [normalized, namespace];
}

function containsExplicitIdentifier(text: string, term: string): boolean {
    if (!term) return false;
    let from = 0;
    while (from <= text.length - term.length) {
        const index = text.indexOf(term, from);
        if (index < 0) return false;
        const before = index > 0 ? text[index - 1] : "";
        const afterIndex = index + term.length;
        const after = afterIndex < text.length ? text[afterIndex] : "";
        const identifierChar = /[a-z0-9_$]/;
        if ((!before || !identifierChar.test(before)) && (!after || !identifierChar.test(after))) {
            return true;
        }
        from = index + 1;
    }
    return false;
}

export function unprovenSharedKnowledgeForbiddenTerms(
    forbiddenTerms: string[],
    sources: Array<Pick<LearningSourceRecord, "excerpt">>,
): string[] {
    if (!forbiddenTerms.length || !sources.length) return forbiddenTerms.slice();
    const excerpts = sources.flatMap((source) => proofVariants(source.excerpt));
    return forbiddenTerms.filter((term) => {
        if (term === EXTRACTION_OVERFLOW) return true;
        return !proofVariants(term).some((variant) =>
            excerpts.some((excerpt) => containsExplicitIdentifier(excerpt, variant))
        );
    });
}

export function containsSharedKnowledgeForbiddenTerm(
    value: unknown,
    forbiddenTerms: string[],
): boolean {
    if (!forbiddenTerms.length) return false;
    if (forbiddenTerms.includes(EXTRACTION_OVERFLOW)) return true;
    let text = "";
    try {
        text = typeof value === "string" ? value : JSON.stringify(value);
    } catch {
        return true;
    }
    const normalized = normalizedProofText(text);
    return forbiddenTerms.some((term) => normalized.includes(normalizedProofText(term)));
}
