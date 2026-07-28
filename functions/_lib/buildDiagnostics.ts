export type DiagnosticCategory = "compile" | "dependency" | "build";

export interface BuildDiagnostic {
    key: string;
    path: string;
    line?: number;
    column?: number;
    message: string;
    details: string[];
    category: DiagnosticCategory;
}

export interface DiagnosticProgress {
    resolved: string[];
    persisted: string[];
    introduced: string[];
    status: "initial" | "progress" | "mixed" | "regression" | "stagnant";
}

const DEPENDENCY_ERROR = /(?:Could not collect dependencies|Failed to read artifact descriptor|Could not transfer artifact|DependencyResolutionException|Non-resolvable parent POM|PluginResolutionException)/i;

export function cleanBuildLogLine(line: string): string {
    return line
        .replace(/^\d{4}-\d{2}-\d{2}T\S+Z\s+/, "")
        .replace(/^\[ERROR]\s*/, "")
        .trim();
}

function normalizeDiagnosticText(value: string): string {
    return value
        .replace(/\\/g, "/")
        .replace(/[^\s]*src\/main\//gi, "src/main/")
        .replace(/:\[?\d+(?:,\d+)?]?/g, ":<loc>")
        .replace(/\s+/g, " ")
        .trim();
}

function diagnosticKey(path: string, message: string, details: string[]): string {
    void details;
    const stable = [path.toLowerCase(), normalizeDiagnosticText(message)].join("|");
    let hash = 0x811c9dc5;
    for (let i = 0; i < stable.length; i++) {
        hash ^= stable.charCodeAt(i);
        hash = Math.imul(hash, 0x01000193);
    }
    return `${path}:${(hash >>> 0).toString(16).padStart(8, "0")}`;
}

function sourcePath(rawPath: string): string {
    const normalized = rawPath.replace(/\\/g, "/");
    const index = normalized.toLowerCase().indexOf("src/main/");
    return index >= 0 ? normalized.slice(index) : normalized;
}

function addUnique(target: Map<string, BuildDiagnostic>, diagnostic: Omit<BuildDiagnostic, "key">) {
    const key = diagnosticKey(diagnostic.path, diagnostic.message, diagnostic.details);
    const existing = target.get(key);
    if (!existing) {
        target.set(key, { ...diagnostic, key });
    } else if (diagnostic.details.length > existing.details.length) {
        existing.details = diagnostic.details;
    }
}

export function parseBuildDiagnostics(fullLog: string): BuildDiagnostic[] {
    const diagnostics = new Map<string, BuildDiagnostic>();
    const lines = fullLog.split(/\r?\n/);

    for (let i = 0; i < lines.length; i++) {
        const line = cleanBuildLogLine(lines[i]).replace(/\\/g, "/");
        const match = line.match(/([^\s]*?src\/main\/(?:java|resources)\/[^:\s]+?\.(?:java|xml|ya?ml|properties)):\[?(\d+)(?:,(\d+))?\]?[\s:]*(.*)/i);
        if (!match) continue;
        const details: string[] = [];
        for (let j = i + 1; j < Math.min(i + 8, lines.length); j++) {
            const follow = cleanBuildLogLine(lines[j]);
            if (/^(?:symbol|location|required|found|reason):/i.test(follow)
                || /^method\s+.+\s+is not applicable$/i.test(follow)
                || /^\(argument mismatch;/i.test(follow)) {
                details.push(follow);
            } else if (follow) {
                break;
            }
        }
        addUnique(diagnostics, {
            path: sourcePath(match[1]),
            line: Number(match[2]),
            column: match[3] ? Number(match[3]) : undefined,
            message: match[4]?.trim() || line,
            details,
            category: "compile",
        });
    }

    if (diagnostics.size === 0 && DEPENDENCY_ERROR.test(fullLog)) {
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
    const stable = diagnostics.map((item) => item.key).sort().join("|");
    let hash = 0x811c9dc5;
    for (let i = 0; i < stable.length; i++) {
        hash ^= stable.charCodeAt(i);
        hash = Math.imul(hash, 0x01000193);
    }
    return (hash >>> 0).toString(16).padStart(8, "0");
}

export function compareDiagnostics(previous: BuildDiagnostic[] | undefined, current: BuildDiagnostic[]): DiagnosticProgress {
    if (!previous?.length) {
        return { resolved: [], persisted: [], introduced: current.map((item) => item.key), status: "initial" };
    }
    const previousKeys = new Set(previous.map((item) => item.key));
    const currentKeys = new Set(current.map((item) => item.key));
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
        const afterKeys = new Set(current.filter((item) => item.path === path).map((item) => item.key));
        return before.every((item) => afterKeys.has(item.key));
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
        .filter((line) => /\[ERROR]|symbol:|location:|required:|found:|reason:/i.test(line))
        .slice(-maxLines)
        .join("\n");
}
