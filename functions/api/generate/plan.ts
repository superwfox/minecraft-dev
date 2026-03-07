import { plannerPrompt } from "../../_lib/prompts";

const DEEPSEEK_URL = "https://api.deepseek.com/v1/chat/completions";

interface Env {
    DEEPSEEK_API_KEY: string;
    TASKS: KVNamespace;
}

export const onRequestPost: PagesFunction<Env> = async (context) => {
    const { userPrompt, coreType, version } = await context.request.json() as any;
    const key = context.env.DEEPSEEK_API_KEY;
    if (!key) return new Response("API key not configured", { status: 500 });

    const { system, user } = plannerPrompt(userPrompt, coreType, version);

    const resp = await fetch(DEEPSEEK_URL, {
        method: "POST",
        headers: { "Content-Type": "application/json", Authorization: `Bearer ${key}` },
        body: JSON.stringify({
            model: "deepseek-chat",
            messages: [{ role: "system", content: system }, { role: "user", content: user }],
            response_format: { type: "json_object" },
        }),
    });
    if (!resp.ok) return new Response(await resp.text(), { status: resp.status });

    const raw = await resp.json() as any;
    const content = raw.choices?.[0]?.message?.content ?? "";

    let plan: any;
    try {
        plan = JSON.parse(content);
    } catch {
        return new Response(JSON.stringify({ error: "Planner 返回非 JSON", raw: content }), { status: 422 });
    }

    const taskId = `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
    const state = {
        taskId,
        status: "planning",
        projectName: plan.projectName,
        javaVersion: plan.javaVersion,
        packageName: plan.packageName,
        coreType,
        version,
        plan: plan.files,
        generatedFiles: [],
        currentFileIndex: 0,
        logs: ["Planner 完成，文件树已生成"],
    };

    await context.env.TASKS.put(taskId, JSON.stringify(state), { expirationTtl: 3600 });

    return new Response(JSON.stringify({ taskId, plan: state.plan, projectName: plan.projectName, packageName: plan.packageName, javaVersion: plan.javaVersion }), {
        headers: { "Content-Type": "application/json" },
    });
};
