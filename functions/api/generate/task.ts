import { resolveLLM, taskBillingProviderFor } from "../../_lib/llm";
import { ClientCancelledError, isClientCancelled } from "../../_lib/clientAbort";
import { getSkillBundles } from "../../_lib/skills";
import { assertBoundTaskStoreSchema, cleanupExpiredTasks, putTaskState, TASK_STATE_TTL_SECONDS, TaskStoreUnavailableError, deleteTask, hasOwnedTask, renewOwnedTask } from "../../_lib/taskStore";

interface Env {
    DB?: D1Database;
    DEEPSEEK_API_KEY: string;
    TASKS: KVNamespace;
}

function json(data: unknown, status: number): Response {
    return new Response(JSON.stringify(data), {
        status,
        headers: { "Content-Type": "application/json", "Cache-Control": "no-store" },
    });
}

async function requestTaskId(request: Request): Promise<string> {
    const queryTaskId = new URL(request.url).searchParams.get("taskId")?.trim() || "";
    if (queryTaskId) return queryTaskId;
    try {
        const body = await request.json() as { taskId?: unknown };
        return typeof body?.taskId === "string" ? body.taskId.trim() : "";
    } catch {
        return "";
    }
}

export const onRequestDelete: PagesFunction<Env> = async (context) => {
    const uid: string = (context.data as any)?.uid || "";
    if (!uid) return json({ error: "请先登录", code: "AUTH_REQUIRED" }, 401);

    const taskId = await requestTaskId(context.request);
    if (!/^[A-Za-z0-9_-]{1,128}$/.test(taskId)) {
        return json({ error: "缺少有效 taskId", code: "INVALID_TASK_ID" }, 400);
    }

    const owned = await hasOwnedTask(context.env, taskId, uid);
    if (!owned) {
        return json({ error: "Task not found", code: "TASK_NOT_FOUND" }, 404);
    }

    await deleteTask(context.env, taskId, uid);
    return new Response(null, {
        status: 204,
        headers: { "Cache-Control": "no-store" },
    });
};

export const onRequestPatch: PagesFunction<Env> = async (context) => {
    const uid: string = (context.data as any)?.uid || "";
    if (!uid) return json({ error: "请先登录", code: "AUTH_REQUIRED" }, 401);

    const taskId = await requestTaskId(context.request);
    if (!/^[A-Za-z0-9_-]{1,128}$/.test(taskId)) {
        return json({ error: "缺少有效 taskId", code: "INVALID_TASK_ID" }, 400);
    }

    const expiresAt = await renewOwnedTask(context.env, taskId, uid);
    if (!expiresAt) {
        return json({
            error: "任务已超过有效期或不存在，请重新开始生成",
            code: "TASK_NOT_FOUND",
        }, 404);
    }

    return json({ expiresAt }, 200);
};

export const onRequestPost: PagesFunction<Env> = async (context) => {
    const body = await context.request.json() as any;
    const uid: string = (context.data as any)?.uid || "";

    // ─── Mode 1: initialize task, no plan yet ───
    {
        const signal = context.request.signal;
        let persistedTaskId = "";
        const assertClientActive = () => {
            if (signal.aborted) {
                throw new ClientCancelledError("Task creation client disconnected", signal.reason);
            }
        };
        try {
            assertClientActive();
            const llm = await resolveLLM(context);
            assertClientActive();
            if (!llm.apiKey) return new Response("API key not configured", { status: 500 });
            try {
                await assertBoundTaskStoreSchema(context.env);
                assertClientActive();
            } catch (error) {
                if (signal.aborted) throw new ClientCancelledError(
                    "Task creation client disconnected",
                    signal.reason ?? error,
                );
                const message = error instanceof TaskStoreUnavailableError
                    ? error.message
                    : "D1 任务数据库暂不可用，请稍后重试";
                return new Response(JSON.stringify({
                    error: message,
                    code: "TASK_STORE_MIGRATION_REQUIRED",
                }), {
                    status: 503,
                    headers: { "Content-Type": "application/json", "Retry-After": "30" },
                });
            }

            const { userPrompt, coreType, version } = body;
            // 创建任务时加载能力，供需求确认、结构规划与生成复用。
            const skillIds: string[] = Array.isArray(body.skillIds) ? body.skillIds : [];
            const skills = skillIds.length ? await getSkillBundles(context.env, skillIds, { signal }) : [];
            assertClientActive();
            const taskId = `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
            const state = {
                taskId,
                uid,
                billingProvider: taskBillingProviderFor(llm),
                status: "clarifying",
                userPrompt,
                coreType,
                version,
                clarifyRounds: [],
                clarifyDone: false,
                preflightProtocolVersion: 1,
                clarifyOperations: [],
                tree: null,
                treeSession: null,
                treeOperations: [],
                nodeChecks: {},
                projectName: "",
                javaVersion: "",
                packageName: "",
                mainBlueprint: null,
                plan: [],
                buckets: [],
                fileStatuses: {},
                generationCheckpoints: {},
                currentBucket: 0,
                generatedFiles: [],
                currentFileIndex: 0,
                skills,
                logs: ["任务已创建，进入澄清阶段"],
            };
            await putTaskState(context.env, taskId, state, TASK_STATE_TTL_SECONDS, uid);
            persistedTaskId = taskId;
            assertClientActive();
            context.waitUntil(cleanupExpiredTasks(context.env).catch(() => { }));
            const expiresAt = Math.floor(Date.now() / 1000) * 1000
                + TASK_STATE_TTL_SECONDS * 1000;
            return new Response(JSON.stringify({ taskId, expiresAt, skillsLoaded: skills.length }), {
                headers: { "Content-Type": "application/json" },
            });
        } catch (error) {
            if (!isClientCancelled(error) && !signal.aborted) throw error;
            if (persistedTaskId) {
                await deleteTask(context.env, persistedTaskId, uid).catch((cleanupError) => {
                    console.warn("cancelled task cleanup failed", cleanupError);
                });
            }
            return json({ error: "任务创建已取消", code: "CLIENT_CANCELLED", retryable: false }, 499);
        }
    }

};
