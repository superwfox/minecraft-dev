import { fileGenPrompt } from "../../_lib/prompts";

const DEEPSEEK_URL = "https://api.deepseek.com/v1/chat/completions";

interface Env {
    DEEPSEEK_API_KEY: string;
    TASKS: KVNamespace;
}

export const onRequestPost: PagesFunction<Env> = async (context) => {
    const { taskId } = await context.request.json() as any;
    const key = context.env.DEEPSEEK_API_KEY;

    const raw = await context.env.TASKS.get(taskId);
    if (!raw) return new Response("Task not found", { status: 404 });
    const state = JSON.parse(raw);

    if (state.currentFileIndex >= state.plan.length) {
        return new Response(JSON.stringify({ done: true, fileIndex: state.currentFileIndex }), {
            headers: { "Content-Type": "application/json" },
        });
    }

    const target = state.plan[state.currentFileIndex];
    const summaries = state.generatedFiles.map((f: any) => ({ path: f.path, summary: f.summary }));

    const { system, user } = fileGenPrompt(target.path, target.role, {
        projectName: state.projectName,
        packageName: state.packageName,
        coreType: state.coreType,
        version: state.version,
        javaVersion: state.javaVersion,
    }, summaries);

    state.status = "generating";
    state.logs.push(`正在生成 ${target.path} (${state.currentFileIndex + 1}/${state.plan.length})`);

    const resp = await fetch(DEEPSEEK_URL, {
        method: "POST",
        headers: { "Content-Type": "application/json", Authorization: `Bearer ${key}` },
        body: JSON.stringify({
            model: "deepseek-chat",
            messages: [{ role: "system", content: system }, { role: "user", content: user }],
        }),
    });
    if (!resp.ok) {
        state.status = "error";
        state.error = `生成 ${target.path} 失败`;
        await context.env.TASKS.put(taskId, JSON.stringify(state), { expirationTtl: 3600 });
        return new Response(await resp.text(), { status: resp.status });
    }

    const data = await resp.json() as any;
    let content = data.choices?.[0]?.message?.content ?? "";
    content = content.replace(/^```[\w]*\n?/, "").replace(/\n?```$/, "");

    const summary = content.split("\n").slice(0, 3).join(" ").slice(0, 120);

    state.generatedFiles.push({ path: target.path, content, summary });
    state.currentFileIndex++;
    state.logs.push(`✅ ${target.path} 已生成`);

    await context.env.TASKS.put(taskId, JSON.stringify(state), { expirationTtl: 3600 });

    return new Response(JSON.stringify({
        done: false,
        fileIndex: state.currentFileIndex - 1,
        path: target.path,
        content,
        remaining: state.plan.length - state.currentFileIndex,
    }), { headers: { "Content-Type": "application/json" } });
};
