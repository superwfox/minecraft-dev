import { getOwnedTask, putTaskState } from "../../_lib/taskStore";
import { nodePath, planItemForNode, type ProjectTree } from "../../_lib/projectTree";
import type { PlanFileItem } from "../../_lib/prompts";

interface Env { DB?: D1Database; TASKS: KVNamespace }
interface VerifyState {
    tree: ProjectTree; generatedFiles: { path: string; content: string }[];
    fileStatuses: Record<string, string>; generationCheckpoints: Record<string, unknown>;
    buckets: PlanFileItem[][]; currentBucket: number; logs: string[];
}
export const onRequestPost: PagesFunction<Env> = async context => {
    const uid = String(context.data.uid ?? "");
    const { taskId, fixMissing } = await context.request.json() as { taskId: string; fixMissing?: boolean };
    const raw = await getOwnedTask(context.env, taskId, uid);
    if (!raw) return new Response("Task not found", { status: 404 });
    const state: VerifyState = JSON.parse(raw);
    const json = (value: unknown, status = 200) => new Response(JSON.stringify(value), { status, headers: { "Content-Type": "application/json" } });
    if (state.tree?.status !== "locked") return json({ error: "请先确认结构树", code: "TREE_NOT_LOCKED" }, 409);
    const planned = state.tree.nodes.map(node => nodePath(state.tree, node));
    const generated = new Set(state.generatedFiles.map(file => file.path));
    const missing = planned.filter(path => !generated.has(path));
    let repairBucketIndex: number | undefined;
    if (missing.length && fixMissing) {
        repairBucketIndex = state.buckets.length;
        const repair = state.tree.nodes.filter(node => missing.includes(nodePath(state.tree, node)))
            .sort((a, b) => Number(a.id === "Main") - Number(b.id === "Main"))
            .map((node, index) => planItemForNode(state.tree, node, repairBucketIndex, index + 1));
        state.fileStatuses ??= {}; state.generationCheckpoints ??= {};
        for (const file of repair) { state.fileStatuses[file.path] = "pending"; delete state.generationCheckpoints[file.path]; }
        state.buckets.push(repair); state.currentBucket = repairBucketIndex;
        state.logs.push(`↻ ${missing.length} 个缺失文件已加入修补桶`);
        await putTaskState(context.env, taskId, state, 3600, uid);
    }
    return json({ verified: !missing.length, total: planned.length, generated: planned.filter(path => generated.has(path)).length, missing, ...(repairBucketIndex === undefined ? {} : { repairBucketIndex }) });
};
