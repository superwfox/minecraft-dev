import { checkpointSeal, checkpointView, restoredProject, validCheckpointSeal } from "../../_lib/projectArchive";
import { getOwnedTask, putTaskState, TASK_STATE_TTL_SECONDS } from "../../_lib/taskStore";
import { resolveLLM, taskBillingProviderFor } from "../../_lib/llm";
import { digest, redact } from "../../../shared/projectArchive";

interface Env { DB?: D1Database; TASKS: KVNamespace; SESSION_SECRET: string; DEEPSEEK_API_KEY: string }
const json = (value: unknown, status = 200) => new Response(JSON.stringify(value), { status, headers: { "Content-Type": "application/json", "Cache-Control": "no-store" } });
export const onRequestGet: PagesFunction<Env> = async context => {
    const taskId = new URL(context.request.url).searchParams.get("taskId") ?? "";
    const uid = String(context.data.uid ?? ""), raw = await getOwnedTask(context.env, taskId, uid);
    if (!raw) return json({ error: "任务不存在", code: "TASK_NOT_FOUND" }, 404);
    const checkpoint = redact(checkpointView(JSON.parse(raw)), [context.env.DEEPSEEK_API_KEY, context.request.headers.get("X-LLM-Key") || ""]);
    return json({ checkpoint, seal: await checkpointSeal(context.env.SESSION_SECRET, uid, checkpoint), schemaVersion: 1 });
};
export const onRequestPost: PagesFunction<Env> = async context => {
    if (Number(context.request.headers.get("Content-Length")) > 18 * 1024 * 1024) return json({ error: "工程快照过大" }, 413);
    try {
        const body: any = await context.request.json(), uid = String(context.data.uid ?? "");
        if (!await validCheckpointSeal(context.env.SESSION_SECRET, uid, body.checkpoint, body.seal)) return json({ error: "工程恢复凭证无效或不属于当前用户", code: "CHECKPOINT_INVALID" }, 403);
        const existingId = String(body.checkpoint.taskId ?? "");
        const existing = await getOwnedTask(context.env, existingId, uid);
        if (existing) return json({ taskId: existingId, state: checkpointView(JSON.parse(existing)), existing: true });
        // Stable successor ID makes retrying the same checkpoint idempotent. Billing is never imported.
        const taskId = `restored_${(await digest([uid, body.seal])).slice(0, 40)}`;
        const restored = await getOwnedTask(context.env, taskId, uid);
        if (restored) return json({ taskId, state: checkpointView(JSON.parse(restored)), existing: true });
        const state = restoredProject(body.checkpoint, taskId, uid);
        const llm = await resolveLLM(context);
        state.billingProvider = taskBillingProviderFor(llm);
        await putTaskState(context.env, taskId, state, TASK_STATE_TTL_SECONDS, uid);
        return json({ taskId, state: checkpointView(state), expiresAt: Date.now() + TASK_STATE_TTL_SECONDS * 1000 });
    } catch (error) { return json({ error: error instanceof Error ? error.message : "无法恢复工程", code: "CHECKPOINT_INVALID" }, 400); }
};
