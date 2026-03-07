import { fileGenPrompt, reCheckerPrompt, reworkPrompt } from "../../_lib/prompts";

const DEEPSEEK_URL = "https://api.deepseek.com/v1/chat/completions";
const MAX_REWORK = 2;

interface Env {
    DEEPSEEK_API_KEY: string;
    TASKS: KVNamespace;
}

async function callAI(key: string, system: string, user: string, jsonMode = false) {
    const body: any = {
        model: "deepseek-chat",
        messages: [{ role: "system", content: system }, { role: "user", content: user }],
    };
    if (jsonMode) body.response_format = { type: "json_object" };

    const resp = await fetch(DEEPSEEK_URL, {
        method: "POST",
        headers: { "Content-Type": "application/json", Authorization: `Bearer ${key}` },
        body: JSON.stringify(body),
    });
    if (!resp.ok) throw new Error(await resp.text());
    const data = await resp.json() as any;
    return data.choices?.[0]?.message?.content ?? "";
}

function stripFences(raw: string): string {
    return raw.replace(/^```[\w]*\n?/, "").replace(/\n?```$/, "");
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
    const ctx = {
        projectName: state.projectName,
        packageName: state.packageName,
        coreType: state.coreType,
        version: state.version,
        javaVersion: state.javaVersion,
    };

    state.status = "generating";
    state.logs.push(`正在生成 ${target.path} (${state.currentFileIndex + 1}/${state.plan.length})`);

    const gen = fileGenPrompt(target.path, target.role, ctx, summaries);
    let content = stripFences(await callAI(key, gen.system, gen.user));
    let reworkCount = 0;

    // reChecker 审查循环
    for (let i = 0; i < MAX_REWORK; i++) {
        state.logs.push(`🔍 审查 ${target.path}...`);
        const check = reCheckerPrompt(target.path, content);
        const reviewRaw = await callAI(key, check.system, check.user, true);

        let review: any;
        try { review = JSON.parse(reviewRaw); } catch { break; }

        if (review.is_ok) {
            state.logs.push(`✅ ${target.path} 审查通过`);
            break;
        }

        reworkCount++;
        state.logs.push(`🔄 ${target.path} 需修正 (${reworkCount}/${MAX_REWORK}): ${review.reason}`);
        const rw = reworkPrompt(target.path, target.role, content, review.reason, ctx);
        content = stripFences(await callAI(key, rw.system, rw.user));
    }

    const summary = content.split("\n").slice(0, 3).join(" ").slice(0, 120);
    state.generatedFiles.push({ path: target.path, content, summary });
    state.currentFileIndex++;
    state.logs.push(`✅ ${target.path} 已完成${reworkCount > 0 ? ` (修正${reworkCount}次)` : ""}`);

    await context.env.TASKS.put(taskId, JSON.stringify(state), { expirationTtl: 3600 });

    return new Response(JSON.stringify({
        done: false,
        fileIndex: state.currentFileIndex - 1,
        path: target.path,
        content,
        remaining: state.plan.length - state.currentFileIndex,
        reworkCount,
    }), { headers: { "Content-Type": "application/json" } });
};
