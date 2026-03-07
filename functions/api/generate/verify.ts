interface Env {
    TASKS: KVNamespace;
}

export const onRequestPost: PagesFunction<Env> = async (context) => {
    const { taskId } = await context.request.json() as any;

    const raw = await context.env.TASKS.get(taskId);
    if (!raw) return new Response("Task not found", { status: 404 });
    const state = JSON.parse(raw);

    const planned = new Set(state.plan.map((f: any) => f.path));
    const generated = new Set(state.generatedFiles.map((f: any) => f.path));

    const missing = [...planned].filter(p => !generated.has(p));

    if (missing.length === 0) {
        state.status = "verifying";
        state.logs.push("✅ 文件校验通过，所有文件已生成");
        await context.env.TASKS.put(taskId, JSON.stringify(state), { expirationTtl: 3600 });
    }

    return new Response(JSON.stringify({
        verified: missing.length === 0,
        total: planned.size,
        generated: generated.size,
        missing,
    }), { headers: { "Content-Type": "application/json" } });
};
