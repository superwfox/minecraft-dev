import { genTask } from "./generateState";
import { activeProjectKey, currentProject, saveProjectNow, syncProjectCheckpoint } from "./projectSession";
import { dbGet, dbList, dbPut } from "./projectDb";
import { missingBuildLogs, redact } from "../../shared/projectArchive";
import { deepSeekKeyState } from "./byok";
import { renderTreeMarkdown } from "./projectTree";
import { feedbackBundle } from "../../shared/feedbackBundle";
export type FeedbackKind = "implementation" | "failure";
export interface FeedbackFile { path: string; content: string; encoding?: "base64"; selected?: boolean }
export interface FeedbackDraft {
    submissionId: string; description: string; kind?: FeedbackKind; schemaVersion?: 2; revisionId?: string;
    pathId?: string; stepId?: string; files: FeedbackFile[]; issueUrl?: string; submittedPayload?: string;
    expected?: string; actual?: string; steps?: string;
}
export interface FeedbackReview {
    payload: string; description: string; kind: FeedbackKind; projectKey: string; taskId: string;
    sourceBytes: number; diagnosticBytes: number; sourceCount: number; imageCount: number;
    incomplete: boolean; missing: string[]; legacy: boolean;
}
export const feedbackKind = (): FeedbackKind => genTask.phase === "done" ? "implementation" : "failure";
export const newFeedback = (): FeedbackDraft => ({ schemaVersion: 2, submissionId: crypto.randomUUID(), description: "", kind: feedbackKind(), pathId: "", stepId: "", files: [] });
export async function feedbackDraft(): Promise<FeedbackDraft> {
    const key = activeProjectKey(), project = await currentProject(), revisionId = project?.checkpoint?.revisionId;
    const saved = key ? await dbGet<FeedbackDraft>("drafts", `${key}:feedback`) : undefined;
    if (saved?.submittedPayload || saved?.issueUrl) return { ...newFeedback(), ...saved };
    if (saved?.revisionId && revisionId && saved.revisionId !== revisionId) {
        await dbPut("drafts", `${key}:feedback-draft:${saved.revisionId}`, saved);
        return { ...newFeedback(), revisionId };
    }
    if (!saved) return { ...newFeedback(), revisionId };
    const description = saved.schemaVersion === 2 ? saved.description : [saved.description,
        saved.expected && `## 预期行为\n${saved.expected}`, saved.actual && `## 实际表现\n${saved.actual}`, saved.steps && `## 复现步骤\n${saved.steps}`].filter(Boolean).join("\n\n");
    return { ...newFeedback(), ...saved, description, schemaVersion: 2, kind: feedbackKind(), revisionId,
        files: saved.files.filter(file => file.path.startsWith("images/") && file.encoding === "base64" && file.selected !== false) };
}
export async function saveFeedbackDraft(draft: FeedbackDraft, key = activeProjectKey()) { if (key) await dbPut("drafts", `${key}:feedback`, JSON.parse(JSON.stringify(draft))); }
export function feedbackLocation(draft: FeedbackDraft) {
    const tree = genTask.tree, path = tree?.paths?.find(path => path.id === draft.pathId);
    const step = path?.nodes.find(step => step.id === draft.stepId);
    const fileIds = [...new Set((step ? [step] : path?.nodes || []).flatMap(step => step.fileIds))];
    return { pathId: path?.id || "", pathTitle: path?.title || "", stepId: step?.id || "", stepTitle: step?.title || "",
        filePaths: fileIds.map(id => tree?.nodes.find(node => node.id === id)?.path).filter((path): path is string => !!path) };
}
export async function diagnosticFiles(): Promise<FeedbackFile[]> {
    await syncProjectCheckpoint().catch(() => {});
    const project = await currentProject(), key = activeProjectKey();
    if (!project || !key) throw new Error("工程尚未保存，请先保存当前工程");
    const checkpoint = project.checkpoint || { taskId: genTask.taskId, projectName: genTask.projectName, userPrompt: genTask.userPrompt,
        coreType: genTask.coreType, version: genTask.version, tree: genTask.tree,
        generatedFiles: genTask.files.filter(file => typeof file.content === "string").map(file => ({ path: file.path, content: file.content })), resources: [] };
    const rows = await dbList<any>("events", `${key}:`), groups = new Map<string, any[]>();
    for (const { value } of rows) { const parts = groups.get(value.id) || []; parts.push(value); groups.set(value.id, parts); }
    let incomplete = !!project.journalIncomplete || !!project.journalPending;
    const events = [...groups.values()].map(parts => {
        parts.sort((a, b) => a.part - b.part);
        const complete = parts.length === parts[0].parts && parts.every((part, index) => part.part === index);
        if (!complete) { incomplete = true; return { id: parts[0].id, at: parts[0].at, kind: parts[0].kind, incomplete: true, gap: "missing_journal_parts" }; }
        try { const event = JSON.parse(parts.map(part => part.text).join("")); incomplete ||= !!event.incomplete; return { id: parts[0].id, at: parts[0].at, kind: parts[0].kind, ...event }; }
        catch { incomplete = true; return { id: parts[0].id, incomplete: true }; }
    }).sort((a, b) => (a.at || 0) - (b.at || 0));
    const source = [...(checkpoint.generatedFiles || []), ...(checkpoint.resources || [])];
    const missing = [...(!project.checkpoint ? ["server-checkpoint"] : []), ...(!events.length ? ["execution-journal"] : []), ...(!source.length ? ["source-not-generated"] : []), ...missingBuildLogs(events)];
    const secrets = [deepSeekKeyState.key];
    const file = (path: string, value: unknown): FeedbackFile => ({ path, content: typeof value === "string" ? redact(value, secrets) : JSON.stringify(redact(value, secrets), null, 2) });
    const versions = await dbList<any>("versions", `${key}:`);
    const manifest = { schemaVersion: 2, taskId: genTask.taskId, exportedAt: new Date().toISOString(), checkpointRevision: checkpoint.revisionId, journalIncomplete: incomplete || missing.length > 0, missing,
        sourceArchive: "source.zip", binaryResources: "resources.json", reproduction: "Recorded model/tool output playback; live model output and remote dependency availability are not deterministic." };
    return [file("manifest.json", manifest), file("project.json", { ...checkpoint, generatedFiles: undefined, resources: undefined }), file("events.json", events), file("browser-state.json", project.ui),
        file("versions.json", versions.map(v => ({ id: v.value.checkpoint?.revisionId, savedAt: v.value.savedAt, files: v.value.checkpoint?.generatedFiles }))),
        file("resources.json", source.filter(f => f.encoding === "base64")),
        file("REPRODUCE.md", "# 复现\n1. 解压 diagnostics.zip，检查 manifest.json 的缺失记录。\n2. 解压 source.zip，将其中工程目录的内容放入诊断目录的 source/ 下；源码包保留 PROJECT_TREE.md 和可用的 JAR 还原报告。\n3. 使用项目 scripts/replay-project.mjs 读取 events.json，核对模型请求、工具结果与代码版本。resources.json 保留二进制资源路径及 base64 内容。\n4. 在受控环境使用记录的 JDK、依赖和配置编译。不执行归档脚本或导入插件，游戏行为由用户验证。\n重新请求模型不能保证相同输出，远程依赖变化也可能影响编译。"),
        ...source.filter(f => !f.encoding).map(f => file(`source/${f.path}`, f.content)),
        ...(checkpoint.tree ? [file("source/PROJECT_TREE.md", renderTreeMarkdown(checkpoint.tree, project.ui.nodeChecks || {}, project.ui.pathChecks || {}))] : []),
        ...(checkpoint.importReport ? [file("source/RESOLVE_JAR_REPORT.json", checkpoint.importReport)] : [])];
}
export async function feedbackImage(image: File): Promise<FeedbackFile> {
    if (!["image/png", "image/jpeg", "image/webp"].includes(image.type) || image.size > 5 * 1024 * 1024) throw new Error("仅支持不超过 5 MiB 的 PNG、JPEG、WebP 图片");
    const bitmap = await createImageBitmap(image);
    try {
        if (bitmap.width * bitmap.height > 20_000_000) throw new Error("图片分辨率过高，请缩小后重试");
        const canvas = document.createElement("canvas"); canvas.width = bitmap.width; canvas.height = bitmap.height;
        canvas.getContext("2d")!.drawImage(bitmap, 0, 0);
        const url = canvas.toDataURL("image/webp", 0.9), content = url.split(",")[1];
        if (content.length > 7 * 1024 * 1024) throw new Error("图片重新编码后过大");
        return { path: `images/${crypto.randomUUID()}.webp`, encoding: "base64", content, selected: true };
    } finally { bitmap.close(); }
}
export async function reviewFeedbackPayload(payload: string): Promise<FeedbackReview> {
    const parsed = JSON.parse(payload), bundle = await feedbackBundle(parsed.files, [deepSeekKeyState.key]);
    const context = parsed.files.find((file: FeedbackFile) => file.path === "feedback.json"), info = context ? JSON.parse(context.content) : {};
    return { payload, description: parsed.description, kind: info.kind || feedbackKind(), projectKey: activeProjectKey(), taskId: genTask.taskId,
        sourceBytes: bundle.sourceBytes, diagnosticBytes: bundle.diagnosticBytes, sourceCount: bundle.sourceCount,
        imageCount: bundle.imageCount, incomplete: bundle.incomplete, missing: bundle.missing, legacy: parsed.bundleVersion !== 2 };
}
export async function prepareFeedback(draft: FeedbackDraft): Promise<FeedbackReview> {
    if (draft.submittedPayload) return reviewFeedbackPayload(draft.submittedPayload);
    const key = activeProjectKey(), taskId = genTask.taskId;
    if (draft.description.length > 10000) throw new Error("反馈正文不能超过 10000 字");
    const kind = feedbackKind(), images = draft.files.filter(file => file.encoding === "base64" && file.path.startsWith("images/"));
    if (kind === "implementation" && !draft.description.trim() && !images.length) throw new Error("请描述实际与预期的差异，或添加截图");
    const location = feedbackLocation(draft);
    if (draft.pathId && !location.pathId || draft.stepId && !location.stepId) throw new Error("所选路径或节点已变化，请重新选择");
    await saveProjectNow(); const files = await diagnosticFiles(), project = await currentProject();
    if (activeProjectKey() !== key || genTask.taskId !== taskId) throw new Error("当前工程已切换，请重新打开反馈");
    if (draft.revisionId && project?.checkpoint?.revisionId && draft.revisionId !== project.checkpoint.revisionId) throw new Error("工程版本已变化，请重新打开反馈");
    const title = `${kind === "implementation" ? "实现与预期不符" : "生成或编译失败"} · ${genTask.projectName || "插件工程"}`;
    const failure = kind === "failure" ? genTask.error || "本轮执行未完成，具体原因见诊断日志。" : "";
    const description = [title, `目标：${genTask.coreType || "未确定"} ${genTask.version || "未确定"}`,
        location.pathTitle && `相关路径：${location.pathTitle}${location.stepTitle ? `\n相关节点：${location.stepTitle}` : ""}`,
        failure && `## 自动记录的失败信息\n${failure.slice(0, 10000)}`,
        draft.description.trim() ? `## ${kind === "implementation" ? "实际与预期的差异" : "补充说明"}\n${draft.description.trim()}` : kind === "implementation" ? "用户通过截图反馈实现偏差。" : "用户无需重复填写报错；自动附带已有源码与执行诊断。"].filter(Boolean).join("\n\n");
    files.push({ path: "feedback.json", content: JSON.stringify({ schemaVersion: 2, kind, location, taskId, revisionId: project?.checkpoint?.revisionId,
        phase: genTask.phase, projectName: genTask.projectName, failure, description: draft.description }, null, 2) });
    const payload = JSON.stringify(redact({ submissionId: draft.submissionId, bundleVersion: 2, publicConsent: true, description, files: [...files, ...images].map(({ selected, ...file }) => file) }, [deepSeekKeyState.key]));
    if (new TextEncoder().encode(payload).byteLength > 30 * 1024 * 1024) throw new Error("源码、诊断和图片合计超过 30 MiB，请减少图片后重试；已有资料仍保存在本地");
    draft.kind = kind; draft.revisionId = project?.checkpoint?.revisionId;
    return reviewFeedbackPayload(payload);
}
/** Only the public-scope dialog's explicit confirmation calls this function. */
export async function submitFeedback(draft: FeedbackDraft, reviewed: FeedbackReview, publicConfirmed: boolean) {
    if (publicConfirmed !== true) throw new Error("请先确认公开范围");
    if (!reviewed?.payload || reviewed.projectKey !== activeProjectKey()) throw new Error("工程已切换，请重新确认公开范围");
    if (!draft.submittedPayload && reviewed.taskId !== genTask.taskId) throw new Error("任务已变化，请重新确认公开范围");
    const payload = draft.submittedPayload || reviewed.payload;
    if (JSON.parse(payload).submissionId !== draft.submissionId) throw new Error("反馈内容已变化，请重新确认公开范围");
    draft.submittedPayload = payload;
    const key = activeProjectKey(); await saveFeedbackDraft(draft, key);
    const response = await fetch("/api/generate/feedback", { method: "POST", headers: { "Content-Type": "application/json" }, body: draft.submittedPayload });
    const result: any = await response.json();
    if (!response.ok) { if ([401, 413, 429, 503].includes(response.status)) { delete draft.submittedPayload; await saveFeedbackDraft(draft, key); } throw new Error(result.error || "反馈提交失败，草稿已保存"); }
    draft.issueUrl = result.issueUrl; await saveFeedbackDraft(draft, key);
    if (key) await dbPut("drafts", `${key}:feedback-result:${draft.submissionId}`, result);
    return result;
}
