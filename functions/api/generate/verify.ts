import { getOwnedTask, putTask } from "../../_lib/taskStore";

interface Env {
    TASKS: KVNamespace;
}

export const onRequestPost: PagesFunction<Env> = async (context) => {
    const uid: string = (context.data as any)?.uid || "";
    const { taskId, fixMissing } = await context.request.json() as any;

    const raw = await getOwnedTask(context.env, taskId, uid);
    if (!raw) return new Response("Task not found", { status: 404 });
    const state = JSON.parse(raw);
    state.uid = uid;

    const planned = new Set(state.plan.map((f: any) => f.path));
    const generated = new Set(state.generatedFiles.map((f: any) => f.path));
    const missing = [...planned].filter(p => !generated.has(p));

    if (missing.length > 0 && fixMissing) {
        const missingEntries = state.plan.filter((f: any) => missing.includes(f.path));
        for (const entry of missingEntries) {
            state.plan.push({ ...entry });
        }
        state.logs.push(`↻ ${missing.length} 个缺失文件已加入重试队列`);
        await putTask(context.env, taskId, JSON.stringify(state), 3600, uid);
    }

    return new Response(JSON.stringify({
        verified: missing.length === 0,
        total: planned.size,
        generated: generated.size,
        missing,
    }), { headers: { "Content-Type": "application/json" } });
};
