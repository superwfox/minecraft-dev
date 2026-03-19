import { fileGenPrompt, reCheckerPrompt, reworkPrompt, summaryExtractPrompt } from "../../_lib/prompts";
import type { FileSummary } from "../../_lib/prompts";

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

/** 从 state.generatedFiles 中提取结构化摘要列表 */
function extractSummaries(generatedFiles: any[]): FileSummary[] {
    return generatedFiles.map((f: any) => {
        const s: FileSummary = { path: f.path };
        if (f.apiSummary) {
            Object.assign(s, f.apiSummary);
        }
        return s;
    });
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
    const summaries = extractSummaries(state.generatedFiles);
    const ctx = {
        projectName: state.projectName,
        packageName: state.packageName,
        coreType: state.coreType,
        version: state.version,
        javaVersion: state.javaVersion,
    };

    state.status = "generating";
    state.logs.push(`正在生成 ${target.path} (${state.currentFileIndex + 1}/${state.plan.length})`);

    // 生成文件内容
    const gen = fileGenPrompt(target.path, target.role, ctx, summaries);
    let content = stripFences(await callAI(key, gen.system, gen.user));
    let reworkCount = 0;

    // reChecker 审查循环（传入跨文件上下文）
    for (let i = 0; i < MAX_REWORK; i++) {
        state.logs.push(`🔍 审查 ${target.path}...`);
        const check = reCheckerPrompt(target.path, content, summaries);
        const reviewRaw = await callAI(key, check.system, check.user, true);

        let review: any;
        try { review = JSON.parse(reviewRaw); } catch { break; }

        if (review.is_ok) {
            state.logs.push(`✅ ${target.path} 审查通过`);
            break;
        }

        reworkCount++;
        state.logs.push(`🔄 ${target.path} 需修正 (${reworkCount}/${MAX_REWORK}): ${review.reason}`);
        const rw = reworkPrompt(target.path, target.role, content, review.reason, ctx, summaries);
        content = stripFences(await callAI(key, rw.system, rw.user));
    }

    // 提取结构化 API 摘要（替代原来的前3行截断）
    let apiSummary: any = null;
    try {
        state.logs.push(`📋 提取 ${target.path} 的 API 摘要...`);
        const ext = summaryExtractPrompt(target.path, content);
        const summaryRaw = await callAI(key, ext.system, ext.user, true);
        apiSummary = JSON.parse(summaryRaw);
    } catch {
        // 摘要提取失败时降级为简单描述
        apiSummary = { description: content.split("\n").slice(0, 3).join(" ").slice(0, 120) };
    }

    state.generatedFiles.push({ path: target.path, content, apiSummary });
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
