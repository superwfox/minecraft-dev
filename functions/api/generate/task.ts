import { deleteTask, hasOwnedTask, renewOwnedTask } from "../../_lib/taskStore";

interface Env {
    DB?: D1Database;
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
