import { getOwnedTask } from "../../_lib/taskStore";
import { findNodeByPath, nodePath, publicTreeView, type ProjectTree } from "../../_lib/projectTree";
import { injectTahaiAuthor } from "../../_lib/pluginWatermark";
import { publicPathChecks, type PathReviewState } from "../../_lib/projectPathReview";

interface Env { DB?: D1Database; TASKS: KVNamespace }
interface SourceState extends PathReviewState { projectName: string; tree: ProjectTree | null; importReport?: unknown; generatedFiles: { path: string; content: string; encoding?: string }[] }
const json = (value: unknown, status = 200) => new Response(JSON.stringify(value), { status, headers: { "Content-Type": "application/json", "Cache-Control": "no-store" } });
export const onRequestGet: PagesFunction<Env> = async context => {
    const url = new URL(context.request.url), taskId = url.searchParams.get("taskId") ?? "";
    const raw = await getOwnedTask(context.env, taskId, String(context.data.uid ?? ""));
    if (!raw) return json({ error: "任务不存在", code: "TASK_NOT_FOUND" }, 404);
    const state: SourceState = JSON.parse(raw);
    const path = url.searchParams.get("path");
    const files = [...new Map([...(state.resources ?? []), ...(state.generatedFiles ?? [])].map(file => [file.path, file])).values()];
    const view = (file: { path: string; content: string; encoding?: string }) => ({ path: file.path, ...(file.encoding === "base64" ? { encoding: "base64" } : {}), content: file.path === "src/main/resources/plugin.yml" ? injectTahaiAuthor(file.content) : file.content });
    if (path !== null) {
        const file = state.tree && (findNodeByPath(state.tree, path) || state.resources?.some(file => file.path === path)) ? files.find(file => file.path === path) : undefined;
        return file ? json(view(file)) : json({ error: "文件尚未生成", code: "SOURCE_NOT_FOUND" }, 404);
    }
    const tree = state.tree;
    if (tree?.status !== "locked" || tree.nodes.some(node => !files.some(file => file.path === nodePath(tree, node)))) return json({ error: "全部节点生成完成后可下载源码", code: "SOURCE_NOT_READY" }, 409);
    return json({ projectName: tree.project.projectName, files: files.map(view), importReport: state.importReport, tree: publicTreeView(tree), nodeChecks: (state as SourceState & { nodeChecks?: unknown }).nodeChecks ?? {}, pathChecks: publicPathChecks(state) });
};
