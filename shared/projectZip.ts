import JSZip from "jszip";
import { safeProjectPath, type ProjectFile } from "./projectArchive";

const archiveDate = new Date("2000-01-01T00:00:00Z");
export function archiveFolder(name: string) { return String(name || "plugin").replace(/[^a-zA-Z0-9._-]/g, "_").replace(/^\.+/, "").slice(0, 100) || "plugin"; }
/** STORE avoids compression work in Pages. Fixed metadata makes retries deterministic. */
export async function projectZip(files: ProjectFile[], folder = ""): Promise<Uint8Array> {
    const zip = new JSZip(), seen = new Set<string>(), prefix = folder ? `${archiveFolder(folder)}/` : "";
    for (const file of [...files].sort((a, b) => a.path < b.path ? -1 : a.path > b.path ? 1 : 0)) {
        if (!safeProjectPath(file.path) || seen.has(file.path.toLowerCase())) throw new Error("打包文件路径无效或重复");
        seen.add(file.path.toLowerCase());
        zip.file(prefix + file.path, file.content, { base64: file.encoding === "base64", date: archiveDate, createFolders: false });
    }
    return zip.generateAsync({ type: "uint8array", compression: "STORE" });
}
export async function sourceZip(input: { projectName: string; files: ProjectFile[]; treeMarkdown?: string; importReport?: unknown }) {
    const files = input.files.filter(file => file.path !== "PROJECT_TREE.md" && file.path !== "RESOLVE_JAR_REPORT.json");
    if (!files.length) files.push({ path: "README.txt", content: "本次执行尚未生成源码。失败原因和已有执行记录见 diagnostics.zip。\n" });
    if (input.treeMarkdown) files.push({ path: "PROJECT_TREE.md", content: input.treeMarkdown });
    if (input.importReport) files.push({ path: "RESOLVE_JAR_REPORT.json", content: JSON.stringify(input.importReport, null, 2) });
    return projectZip(files, input.projectName);
}
export function bytesBase64(bytes: Uint8Array) {
    let binary = "";
    for (let index = 0; index < bytes.length; index += 8192) binary += String.fromCharCode(...bytes.subarray(index, index + 8192));
    return btoa(binary);
}
