export const ARCHIVE_SCHEMA = 1 as const;
export interface ProjectFile { path: string; content: string; encoding?: "base64"; role?: string; apiSummary?: unknown }
export interface JournalEvent { id: string; at: number; kind: string; data: unknown; incomplete?: boolean }
export const MAX_PROJECT_BYTES = 12 * 1024 * 1024;
export function safeProjectPath(value: unknown): value is string {
    return typeof value === "string" && value.length <= 240 && !/[\\\x00-\x1f:#?]/.test(value)
        && !value.startsWith("/") && !value.split("/").some(p => !p || p === "." || p === "..")
        && !value.split("/").some(p => [".git", ".github"].includes(p.toLowerCase()));
}
export function projectFiles(input: unknown): ProjectFile[] {
    if (!Array.isArray(input) || input.length > 2000) throw new Error("工程文件数量无效");
    const seen = new Set<string>(); let bytes = 0;
    return input.map(file => {
        if (!file || !safeProjectPath(file.path) || typeof file.content !== "string" || seen.has(file.path.toLowerCase())) throw new Error("工程文件路径或内容无效");
        seen.add(file.path.toLowerCase()); bytes += new TextEncoder().encode(file.content).byteLength;
        if (bytes > MAX_PROJECT_BYTES) throw new Error("可编辑工程超过 12 MiB，请减少内嵌依赖或资源");
        return { path: file.path, content: file.content, ...(file.encoding === "base64" ? { encoding: "base64" as const } : {}) };
    });
}
/** Credentials never belong in an archive, even when nested in provider errors. */
export function redact(value: unknown, secrets: string[] = []): any {
    if (typeof value === "string") {
        let result = value.replace(/\b(?:sk-[A-Za-z0-9_-]{12,}|gh[pousr]_[A-Za-z0-9_]{12,}|github_pat_[A-Za-z0-9_]{12,})\b/g, "[REDACTED]")
            .replace(/\bBearer\s+[^\s"<>]+/gi, "Bearer [REDACTED]");
        for (const secret of secrets) if (secret && secret.length >= 6) result = result.split(secret).join("[REDACTED]");
        return result;
    }
    if (Array.isArray(value)) return value.map(item => redact(item, secrets));
    if (value && typeof value === "object") return Object.fromEntries(Object.entries(value)
        .filter(([key]) => !/^(authorization|cookie|set-cookie|api.?key|access.?token|refresh.?token|secret|x-llm-key|reasoning_content)$/i.test(key)
            && !["__proto__", "constructor", "prototype"].includes(key))
        .map(([key, item]) => [key, redact(item, secrets)]));
    return value;
}
export async function digest(value: unknown): Promise<string> {
    const data = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(typeof value === "string" ? value : JSON.stringify(value)));
    return Array.from(new Uint8Array(data), b => b.toString(16).padStart(2, "0")).join("");
}

/** Legacy or interrupted exports must not look complete merely because no error event was saved. */
export function missingBuildLogs(events: Array<{ kind: string; data?: any; incomplete?: boolean }>): string[] {
    const heads = new Set(events.filter(event => event.kind === "build.configuration").map(event => String(event.data?.buildHeadSha || "unknown")));
    return [...heads].filter(head => !events.some(event => event.kind === "build.logs.complete" && !event.incomplete && event.data?.headSha === head
        && Array.isArray(event.data.jobIds) && event.data.jobIds.length > 0
        && event.data.jobIds.every((id: number) => events.some(log => log.kind === "build.logs" && !log.incomplete && log.data?.headSha === head && log.data?.jobId === id
            && (typeof log.data?.content === "string" && log.data.content.length > 0 || log.data?.conclusion === "skipped" && log.data?.noLogReason === "job_not_executed")))))
        .map(head => `build-logs:${head}`);
}
