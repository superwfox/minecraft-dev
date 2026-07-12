interface Env {
    TASKS: KVNamespace;
}

export const onRequestPost: PagesFunction<Env> = async (context) => {
    const { taskId, fixMissing } = await context.request.json() as any;

    const raw = await context.env.TASKS.get(taskId);
    if (!raw) return new Response("Task not found", { status: 404 });
    const state = JSON.parse(raw);

    const planned = new Set(state.plan.map((f: any) => f.path));
    const generated = new Set(state.generatedFiles.map((f: any) => f.path));
    const missing = [...planned].filter(p => !generated.has(p));

    if (missing.length > 0 && fixMissing) {
        const missingEntries = state.plan.filter((f: any) => missing.includes(f.path));
        for (const entry of missingEntries) {
            state.plan.push({ ...entry });
        }
        state.logs.push(`↻ ${missing.length} 个缺失文件已加入重试队列`);
        await context.env.TASKS.put(taskId, JSON.stringify(state), { expirationTtl: 3600 });
    }

    return new Response(JSON.stringify({
        verified: missing.length === 0,
        total: planned.size,
        generated: generated.size,
        missing,
    }), { headers: { "Content-Type": "application/json" } });
};
