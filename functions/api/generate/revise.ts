import { acquireTaskOperationLease, getOwnedTask, putTaskWithOperationLease, releaseTaskOperationLease } from "../../_lib/taskStore";
import { checkpointView } from "../../_lib/projectArchive";
const json = (value: unknown, status = 200) => new Response(JSON.stringify(value), { status, headers: { "Content-Type": "application/json", "Cache-Control": "no-store" } });
interface Env { DB?: D1Database; TASKS: KVNamespace }
export const onRequestPost: PagesFunction<Env> = async context => {
    const body: any = await context.request.json(), uid = String(context.data.uid ?? "");
    if (typeof body.requirement !== "string" || !body.requirement.trim() || body.requirement.length > 1000 || !/^[a-zA-Z0-9_-]{16,100}$/.test(body.requestId ?? "")) return json({ error: "请输入 1–1000 字修改需求及有效 requestId" }, 400);
    const raw = await getOwnedTask(context.env, body.taskId, uid);
    if (!raw) return json({ error: "任务不存在", code: "TASK_NOT_FOUND" }, 404);
    const token = `revision:${body.requestId}`, mode = await acquireTaskOperationLease(context.env, body.taskId, uid, token, 120000);
    if (!mode) return json({ error: "任务正在执行其他操作" }, 409);
    let released = false;
    try {
        const latest = await getOwnedTask(context.env, body.taskId, uid);
        if (!latest) return json({ error: "任务不存在" }, 404);
        const state = JSON.parse(latest);
        if (state.revisionRequestId === body.requestId) return json({ state: checkpointView(state) });
        if (!state.tree || !["done", "error", "failed", "tree_confirming"].includes(state.status) && !state.restoredFromTerminal) return json({ error: "请等待当前执行结束再提交修改" }, 409);
        if ([...(state.treeOperations ?? []), ...(state.clarifyOperations ?? [])].some(op => op.status !== "cancelled" && (op.status !== "completed" || !op.billingSettled))) return json({ error: "仍有请求待对账，请先继续原任务" }, 409);
        state.revisionBase = { tree: structuredClone(state.tree), fingerprint: state.sourceFingerprint || "", revisionId: state.revisionId || "" };
        state.parentRevisionId = state.revisionId || ""; state.revisionId = crypto.randomUUID(); state.revisionRequestId = body.requestId;
        state.changeRequest = body.requirement.trim(); state.treeContext = `已有工程的增量修改需求：${state.changeRequest}\n保留未受影响文件及其契约，基于已有源码修改。`;
        state.userPrompt += `\n\n追加修改需求：${state.changeRequest}`;
        state.tree.status = "ready"; state.tree.lockedRevision = null;
        state.treeSession = null; state.treeOperations = []; state.status = "tree_confirming";
        const ok = await putTaskWithOperationLease(context.env, body.taskId, JSON.stringify(state), token, mode, 3600, uid, true);
        if (!ok) return json({ error: "任务状态已更新，请刷新后继续" }, 409);
        released = true; return json({ state: checkpointView(state) });
    } finally { if (!released) await releaseTaskOperationLease(context.env, body.taskId, uid, token, mode).catch(() => {}); }
};
