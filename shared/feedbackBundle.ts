import { projectFiles, redact, type ProjectFile } from "./projectArchive";
import { bytesBase64, projectZip, sourceZip } from "./projectZip";

export interface FeedbackAttachment { path: string; content: string; encoding?: "base64" }
export interface FeedbackBundle {
    files: FeedbackAttachment[]; sourceBytes: number; diagnosticBytes: number;
    sourceCount: number; imageCount: number; incomplete: boolean; missing: string[];
}
function jsonFile(files: FeedbackAttachment[], path: string, fallback: any) {
    const file = files.find(file => file.path === path);
    if (!file) return fallback;
    try { return JSON.parse(file.content); } catch { throw new Error(`诊断资料 ${path} 无法解析`); }
}
function safeResource(file: ProjectFile, secrets: string[]): ProjectFile {
    if (file.encoding !== "base64") return { ...file, content: redact(file.content, secrets) };
    if (!/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/.test(file.content)) throw new Error("资源编码无效");
    const bytes = Uint8Array.from(atob(file.content), char => char.charCodeAt(0));
    let text: string;
    try { text = new TextDecoder("utf-8", { fatal: true }).decode(bytes); }
    catch { return file; }
    const clean = redact(text, secrets);
    if (clean !== text) return { ...file, content: bytesBase64(new TextEncoder().encode(clean)) };
    return file;
}
/** Transport remains structured so the server can redact before creating public ZIPs. */
export async function feedbackBundle(input: FeedbackAttachment[], secrets: string[] = []): Promise<FeedbackBundle> {
    const files: FeedbackAttachment[] = input.map(file => file.encoding ? { ...file } : { path: file.path, content: redact(file.content, secrets) });
    const project = jsonFile(files, "project.json", {}), manifest = jsonFile(files, "manifest.json", { journalIncomplete: true, missing: ["manifest"] });
    const resources = projectFiles(jsonFile(files, "resources.json", [])).map(file => safeResource(file, secrets));
    const resourceFile = files.find(file => file.path === "resources.json");
    if (resourceFile) resourceFile.content = JSON.stringify(resources, null, 2);
    const source = projectFiles([
        ...files.filter(file => file.path.startsWith("source/")).map(file => ({ ...file, path: file.path.slice(7) })),
        ...resources,
    ]);
    const sourceBytes = await sourceZip({ projectName: project.projectName || project.tree?.project?.projectName || "plugin", files: source,
        treeMarkdown: source.find(file => file.path === "PROJECT_TREE.md")?.content,
        importReport: source.some(file => file.path === "RESOLVE_JAR_REPORT.json") ? jsonFile(source, "RESOLVE_JAR_REPORT.json", undefined) : undefined });
    const sourceEncoded = bytesBase64(sourceBytes);
    const diagnosticBytes = await projectZip(files.filter(file => !file.encoding && !file.path.startsWith("source/")));
    const images = files.filter(file => file.path.startsWith("images/") && file.encoding === "base64");
    return { files: [{ path: "source.zip", content: sourceEncoded, encoding: "base64" }, { path: "diagnostics.zip", content: bytesBase64(diagnosticBytes), encoding: "base64" }, ...images],
        sourceBytes: sourceBytes.byteLength, diagnosticBytes: diagnosticBytes.byteLength,
        sourceCount: source.filter(file => !["PROJECT_TREE.md", "RESOLVE_JAR_REPORT.json"].includes(file.path)).length,
        imageCount: images.length, incomplete: !!manifest.journalIncomplete, missing: Array.isArray(manifest.missing) ? manifest.missing : [] };
}
