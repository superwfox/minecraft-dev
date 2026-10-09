export type DiagnosticCategory = "compile" | "dependency" | "build";

export interface BuildDiagnostic {
    key: string;
    path: string;
    line?: number;
    column?: number;
    message: string;
    details: string[];
    category: DiagnosticCategory;
    errorKind?: "missing_symbol" | "missing_package" | "signature_mismatch" | "compile_error";
    symbol?: string;
    symbolKind?: string;
    location?: string;
    packageName?: string;
    qualifiedSymbol?: string;
    symbolResolution?: "resolved" | "unresolved";
}

export interface DiagnosticProgress {
    resolved: string[];
    persisted: string[];
    introduced: string[];
    status: "initial" | "progress" | "mixed" | "regression" | "stagnant";
}

const DEPENDENCY_ERROR = /(?:Could not collect dependencies|Failed to read artifact descriptor|Could not transfer artifact|DependencyResolutionException|Non-resolvable parent POM|PluginResolutionException)/i;
const MAVEN_INFRASTRUCTURE_ERROR = /(?:Could not transfer artifact|Non-resolvable parent POM|PluginResolutionException|org\.apache\.maven\.plugins|maven-default-http-blocker|Connection (?:timed out|refused|reset)|Read timed out|UnknownHostException|Unknown host|Name or service not known|Temporary failure in name resolution|Network is unreachable|SSLHandshakeException|PKIX path building failed|status code:\s*(?:429|5\d\d)|HTTP\s+(?:429|5\d\d))/i;

export function isBuildInfrastructureDiagnostic(diagnostic: BuildDiagnostic): boolean {
    if (diagnostic.category !== "dependency") return false;
    return MAVEN_INFRASTRUCTURE_ERROR.test([
        diagnostic.message,
        ...diagnostic.details,
    ].join(" "));
}

export function cleanBuildLogLine(line: string): string {
    return line
        .replace(/\x1b\[[0-9;]*m/g, "")
        .replace(/^\d{4}-\d{2}-\d{2}T\S+(?:Z|[+-]\d{2}:?\d{2})\s+/, "")
        .replace(/^\[ERROR]\s*/, "")
        .trim();
}

function normalizeDiagnosticText(value: string): string {
    return value
        .replace(/^error:\s*/i, "")
        .replace(/\\/g, "/")
        .replace(/[^\s]*src\/main\//gi, "src/main/")
        .replace(/:\[?\d+(?:,\d+)?]?/g, ":<loc>")
        .replace(/\s+/g, " ")
        .trim();
}

function hashText(stable: string): string {
    let hash = 0x811c9dc5;
    for (let i = 0; i < stable.length; i++) {
        hash ^= stable.charCodeAt(i);
        hash = Math.imul(hash, 0x01000193);
    }
    return (hash >>> 0).toString(16).padStart(8, "0");
}

function sourcePath(rawPath: string): string {
    const normalized = rawPath.replace(/\\/g, "/");
    const index = normalized.toLowerCase().indexOf("src/main/");
    return index >= 0 ? normalized.slice(index) : normalized;
}

type SymbolDetails = Pick<BuildDiagnostic, "symbol" | "symbolKind" | "location" | "packageName" | "qualifiedSymbol" | "symbolResolution">;

// Only a package location or a qualified receiver proves a symbol's namespace.
// A simple receiver such as Particle is resolved by the learning layer's known type map.
function symbolDetails(message: string, details: string[]): SymbolDetails {
    const symbolLine = details.find((line) => /^symbol\s*:/i.test(line));
    const symbolMatch = symbolLine?.match(/^symbol\s*:\s*(class|interface|enum|variable|method|constructor)\s+(.+)$/i);
    const symbol = symbolMatch?.[2].trim();
    const symbolKind = symbolMatch?.[1].toLowerCase();
    const location = details.find((line) => /^location\s*:/i.test(line))?.replace(/^location\s*:\s*/i, "").trim();
    const packageName = location?.match(/^package\s+([A-Za-z_$][\w$]*(?:\.[A-Za-z_$][\w$]*)*)$/i)?.[1];
    const owner = location?.match(/^(?:class|interface|enum)\s+([A-Za-z_$][\w$]*(?:\.[A-Za-z_$][\w$]*)+)/i)?.[1]
        ?? location?.match(/^variable\s+\S+\s+of type\s+([A-Za-z_$][\w$]*(?:\.[A-Za-z_$][\w$]*)+)/i)?.[1];
    const simpleSymbol = symbol?.match(/^[A-Za-z_$][\w$]*/)?.[0];
    const missingPackage = message.match(/\bpackage\s+([A-Za-z_$][\w$]*(?:\.[A-Za-z_$][\w$]*)+)\s+does not exist\b/i)?.[1];
    const qualifiedSymbol = packageName && simpleSymbol ? `${packageName}.${simpleSymbol}`
        : owner && simpleSymbol ? (owner.endsWith(`.${simpleSymbol}`) ? owner : `${owner}.${simpleSymbol}`)
            : missingPackage;
    if (!symbol && !missingPackage) return {};
    return {
        ...(symbol ? { symbol, symbolKind } : {}),
        ...(location ? { location } : {}),
        ...(packageName || missingPackage ? { packageName: packageName || missingPackage } : {}),
        ...(qualifiedSymbol ? { qualifiedSymbol } : {}),
        symbolResolution: qualifiedSymbol ? "resolved" : "unresolved",
    };
}

/** Rebuild identity from diagnostic content, including older records whose stored key omitted the symbol. */
export function diagnosticIdentityKey(diagnostic: Omit<BuildDiagnostic, "key">): string {
    const path = sourcePath(diagnostic.path);
    const parsedSymbol = symbolDetails(diagnostic.message, diagnostic.details);
    const symbolIdentity = diagnostic.qualifiedSymbol || parsedSymbol.qualifiedSymbol
        || [diagnostic.symbol || parsedSymbol.symbol, diagnostic.location || parsedSymbol.location].filter(Boolean).join("@");
    const symbolKind = diagnostic.symbolKind || parsedSymbol.symbolKind;
    const missingSignature = /^(?:method|constructor)$/.test(symbolKind || "") ? diagnostic.symbol || parsedSymbol.symbol : "";
    const signatureDetails = /cannot be applied|no suitable|incompatible types|is not applicable/i.test(diagnostic.message)
        ? diagnostic.details.map(normalizeDiagnosticText).join("|") : "";
    const stable = [path.toLowerCase(), normalizeDiagnosticText(diagnostic.message), symbolKind, symbolIdentity, missingSignature, signatureDetails]
        .filter(Boolean).map((part) => normalizeDiagnosticText(part!)).join("|");
    return `${path}:${hashText(stable)}`;
}

function addUnique(target: Map<string, BuildDiagnostic>, diagnostic: Omit<BuildDiagnostic, "key">) {
    const key = diagnosticIdentityKey(diagnostic);
    // A semantic key ignores location, while parser deduplication retains every original occurrence.
    const occurrenceKey = `${key}|${diagnostic.line ?? ""}|${diagnostic.column ?? ""}`;
    const existing = target.get(occurrenceKey);
    if (!existing) {
        target.set(occurrenceKey, { ...diagnostic, key });
    } else if (diagnostic.details.length > existing.details.length) {
        existing.details = diagnostic.details;
    }
}

function diagnosticHeader(line: string): { path: string; line: number; column?: number; message: string } | null {
    const match = line.match(/^((?:[A-Za-z]:)?(?:[^\s:]+\/)*[A-Za-z0-9_$.-]+\.(?:java|xml|ya?ml|properties)):(?:\[(\d+)(?:,(\d+))?\]|(\d+)(?::(\d+))?):?\s+(.+)$/i);
    if (!match) return null;
    return { path: sourcePath(match[1]), line: Number(match[2] || match[4]), column: match[3] || match[5] ? Number(match[3] || match[5]) : undefined, message: match[6].replace(/^error:\s*/i, "").trim() };
}

const MAX_DIAGNOSTIC_BLOCK_LINES = 64;
const SEMANTIC_DETAIL = /^(?:symbol|location|required|found|reason)\s*:|^method\s+.+\s+is not applicable$|^\(argument mismatch;/i;
const DIAGNOSTIC_BOUNDARY = /^\[(?:INFO|WARNING|WARN|DEBUG)]|^##\[|^(?:BUILD (?:SUCCESS|FAILURE)|COMPILATION ERROR|\d+ (?:errors?|warnings?)\b|Failed to execute goal|Caused by:|Exception in thread|Note:|For more information|To see the full stack trace|Re-run Maven|-> \[Help|---)/i;

export function parseBuildDiagnostics(fullLog: string): BuildDiagnostic[] {
    const diagnostics = new Map<string, BuildDiagnostic>();
    const lines = fullLog.split(/\r?\n/);

    for (let i = 0; i < lines.length; i++) {
        const line = cleanBuildLogLine(lines[i]).replace(/\\/g, "/");
        const header = diagnosticHeader(line);
        if (!header) continue;
        const details: string[] = [];
        for (let j = i + 1; j < Math.min(i + MAX_DIAGNOSTIC_BLOCK_LINES + 1, lines.length); j++) {
            const follow = cleanBuildLogLine(lines[j]);
            if (diagnosticHeader(follow.replace(/\\/g, "/")) || DIAGNOSTIC_BOUNDARY.test(follow) || DEPENDENCY_ERROR.test(follow)) break;
            if (SEMANTIC_DETAIL.test(follow)) details.push(follow.slice(0, 4000));
            // javac inserts source excerpts and caret markers before its semantic fields.
        }
        const errorKind: BuildDiagnostic["errorKind"] = /cannot find symbol/i.test(header.message) ? "missing_symbol"
            : /package\s+.+does not exist/i.test(header.message) ? "missing_package"
                : /cannot be applied|no suitable|incompatible types|is not applicable/i.test(header.message) ? "signature_mismatch" : "compile_error";
        addUnique(diagnostics, {
            ...header,
            details,
            category: "compile",
            errorKind,
            ...(errorKind === "missing_symbol" ? { symbolResolution: "unresolved" as const } : {}),
            ...symbolDetails(header.message, details),
        });
    }

    if (DEPENDENCY_ERROR.test(fullLog)) {
        const dependencyLines = lines
            .map(cleanBuildLogLine)
            .filter((line) => DEPENDENCY_ERROR.test(line))
            .slice(-12);
        addUnique(diagnostics, {
            path: "pom.xml",
            message: dependencyLines[0] || "Maven dependency resolution failed",
            details: dependencyLines.slice(1),
            category: "dependency",
        });
    }

    return [...diagnostics.values()];
}

export function diagnosticsFingerprint(diagnostics: BuildDiagnostic[]): string {
    return hashText([...new Set(diagnostics.map(diagnosticIdentityKey))].sort().join("|"));
}

export function compareDiagnostics(previous: BuildDiagnostic[] | undefined, current: BuildDiagnostic[]): DiagnosticProgress {
    if (!previous?.length) {
        return { resolved: [], persisted: [], introduced: [...new Set(current.map(diagnosticIdentityKey))], status: "initial" };
    }
    const previousKeys = new Set(previous.map(diagnosticIdentityKey));
    const currentKeys = new Set(current.map(diagnosticIdentityKey));
    const resolved = [...previousKeys].filter((key) => !currentKeys.has(key));
    const persisted = [...previousKeys].filter((key) => currentKeys.has(key));
    const introduced = [...currentKeys].filter((key) => !previousKeys.has(key));
    let status: DiagnosticProgress["status"];
    if (resolved.length && introduced.length) status = "mixed";
    else if (resolved.length) status = "progress";
    else if (introduced.length) status = "regression";
    else status = "stagnant";
    return { resolved, persisted, introduced, status };
}

export function rollbackCandidates(
    previous: BuildDiagnostic[] | undefined,
    current: BuildDiagnostic[],
    changedFiles: string[],
): string[] {
    if (!previous?.length) return [];
    return changedFiles.filter((path) => {
        if (path.endsWith("pom.xml")) return false;
        const before = previous.filter((item) => item.path === path);
        if (!before.length) return false;
        const afterKeys = new Set(current.filter((item) => item.path === path).map(diagnosticIdentityKey));
        return before.every((item) => afterKeys.has(diagnosticIdentityKey(item)));
    });
}

export function formatDiagnostics(diagnostics: BuildDiagnostic[]): string {
    return diagnostics.map((item) => {
        const location = item.line ? `${item.path}:${item.line}${item.column ? `:${item.column}` : ""}` : item.path;
        const details = item.details.length ? `\n${item.details.map((line) => `  ${line}`).join("\n")}` : "";
        return `[${item.key}] ${location} ${item.message}${details}`;
    }).join("\n");
}

export function errorLogExcerpt(fullLog: string, maxLines = 100): string {
    return fullLog.split(/\r?\n/)
        .filter((line) => /\[ERROR]|symbol:|location:|required:|found:|reason:/i.test(line) || diagnosticHeader(cleanBuildLogLine(line).replace(/\\/g, "/")))
        .slice(-maxLines)
        .join("\n");
}
