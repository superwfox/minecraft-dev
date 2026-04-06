import { buildFixPrompt } from "../../_lib/prompts";
import type { FileSummary } from "../../_lib/prompts";
import { getRunJobs, getJobLogs, deleteBranch } from "../../_lib/github";

const DEEPSEEK_URL = "https://api.deepseek.com/v1/chat/completions";

interface Env {
    DEEPSEEK_API_KEY: string;
    GITHUB_PAT: string;
    TASKS: KVNamespace;
}

async function callAIStream(
    key: string, system: string, user: string,
    writer: WritableStreamDefaultWriter<Uint8Array>, encoder: TextEncoder,
) {
    const body = {
        model: "deepseek-chat",
        stream: true,
        messages: [{ role: "system", content: system }, { role: "user", content: user }],
    };

    const resp = await fetch(DEEPSEEK_URL, {
        method: "POST",
        headers: { "Content-Type": "application/json", Authorization: `Bearer ${key}` },
        body: JSON.stringify(body),
    });
    if (!resp.ok) throw new Error(await resp.text());

    const reader = resp.body!.getReader();
    const decoder = new TextDecoder();
    let full = "";
    let buffer = "";

    while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        buffer += decoder.decode(value, { stream: true });
        const lines = buffer.split("\n");
        buffer = lines.pop()!;

        for (const line of lines) {
            const trimmed = line.trim();
            if (!trimmed.startsWith("data:")) continue;
            const payload = trimmed.slice(5).trim();
            if (payload === "[DONE]") continue;
            try {
                const chunk = JSON.parse(payload);
                const delta = chunk.choices?.[0]?.delta?.content;
                if (delta) {
                    full += delta;
                    await writer.write(encoder.encode(`data: ${JSON.stringify({ type: "delta", content: delta })}\n\n`));
                }
            } catch { /* skip */ }
        }
    }
    return full;
}

function stripFences(raw: string): string {
    return raw.replace(/^```[\w]*\n?/, "").replace(/\n?```$/, "");
}

function sseEvent(encoder: TextEncoder, data: any): Uint8Array {
    return encoder.encode(`data: ${JSON.stringify(data)}\n\n`);
}

function extractSummaries(generatedFiles: any[]): FileSummary[] {
    return generatedFiles.map((f: any) => {
        const s: FileSummary = { path: f.path };
        if (f.apiSummary) Object.assign(s, f.apiSummary);
        return s;
    });
}

/** Parse Maven error log to identify which source files have errors */
function parseErrorFiles(log: string): Map<string, string[]> {
    const errors = new Map<string, string[]>();
    const lines = log.split("\n");

    for (let i = 0; i < lines.length; i++) {
        const line = lines[i];
        // Match Maven error lines like: [ERROR] /path/File.java:[line,col] error: ...
        const match = line.match(/\[ERROR\]\s+.*?(src\/main\/java\/\S+\.java):\[?\d+[,\d]*\]?\s*(.*)/);
        if (match) {
            const filePath = match[1];
            const errorMsg = match[2];
            if (!errors.has(filePath)) errors.set(filePath, []);
            errors.get(filePath)!.push(errorMsg);
            // Capture follow-up lines (symbol, location etc.)
            for (let j = i + 1; j < Math.min(i + 4, lines.length); j++) {
                const follow = lines[j].trim();
                if (follow.startsWith("symbol:") || follow.startsWith("location:")) {
                    errors.get(filePath)!.push(follow);
                } else break;
            }
        }
    }
    return errors;
}

export const onRequestPost: PagesFunction<Env> = async (context) => {
    const { taskId } = await context.request.json() as any;
    const key = context.env.DEEPSEEK_API_KEY;
    const token = context.env.GITHUB_PAT;

    const raw = await context.env.TASKS.get(taskId);
    if (!raw) return new Response("Task not found", { status: 404 });
    const state = JSON.parse(raw);

    if (!state.runId) {
        return new Response(JSON.stringify({ error: "No build run to fix" }), {
            status: 400, headers: { "Content-Type": "application/json" },
        });
    }

    const { readable, writable } = new TransformStream<Uint8Array>();
    const encoder = new TextEncoder();
    const writer = writable.getWriter();

    const process = (async () => {
        try {
            // Fetch build log
            await writer.write(sseEvent(encoder, { type: "log", msg: "▸ 正在获取构建错误日志..." }));
            state.logs.push("▸ 正在获取构建错误日志...");

            const jobs = await getRunJobs(token, state.runId);
            const failedJob = jobs.find(j => j.conclusion === "failure") ?? jobs[0];
            if (!failedJob) throw new Error("未找到构建 Job");

            const fullLog = await getJobLogs(token, failedJob.id);

            // Extract only the Maven error section (last ~200 lines or [ERROR] lines)
            const logLines = fullLog.split("\n");
            const errorSection = logLines
                .filter(l => l.includes("[ERROR]") || l.includes("symbol:") || l.includes("location:"))
                .slice(-100)
                .join("\n");

            if (!errorSection.trim()) {
                await writer.write(sseEvent(encoder, { type: "log", msg: "! 未能从日志中提取编译错误" }));
                await writer.write(sseEvent(encoder, { type: "result", fixed: 0 }));
                await writer.write(encoder.encode("data: [DONE]\n\n"));
                return;
            }

            await writer.write(sseEvent(encoder, { type: "log", msg: `▸ 已获取错误日志 (${errorSection.split("\n").length} 行)` }));

            // Parse which files need fixing
            const errorMap = parseErrorFiles(errorSection);
            const filesToFix: string[] = [];

            // Match error file paths against generated files
            for (const gf of state.generatedFiles) {
                for (const [errPath] of errorMap) {
                    if (gf.path === errPath || gf.path.endsWith(errPath) || errPath.endsWith(gf.path)) {
                        filesToFix.push(gf.path);
                        break;
                    }
                }
            }

            // If no specific files matched, try to fix all java files using full error log
            if (filesToFix.length === 0) {
                const javaFiles = state.generatedFiles.filter((f: any) => f.path.endsWith(".java"));
                if (javaFiles.length > 0) {
                    filesToFix.push(...javaFiles.map((f: any) => f.path));
                    await writer.write(sseEvent(encoder, { type: "log", msg: `! 无法精确定位错误文件，将检查所有 ${filesToFix.length} 个 Java 文件` }));
                }
            } else {
                await writer.write(sseEvent(encoder, { type: "log", msg: `▸ 需要修复 ${filesToFix.length} 个文件: ${filesToFix.map(f => f.split("/").pop()).join(", ")}` }));
            }

            const summaries = extractSummaries(state.generatedFiles);
            const ctx = {
                projectName: state.projectName,
                packageName: state.packageName,
                coreType: state.coreType,
                version: state.version,
                javaVersion: state.javaVersion,
            };

            let fixedCount = 0;
            for (const filePath of filesToFix) {
                const fileEntry = state.generatedFiles.find((f: any) => f.path === filePath);
                if (!fileEntry) continue;

                // Gather errors for this file
                let fileErrors = "";
                for (const [errPath, msgs] of errorMap) {
                    if (filePath === errPath || filePath.endsWith(errPath) || errPath.endsWith(filePath)) {
                        fileErrors += msgs.join("\n") + "\n";
                    }
                }
                if (!fileErrors) fileErrors = errorSection; // fallback to full errors

                await writer.write(sseEvent(encoder, { type: "phase", phase: "fixing", file: filePath }));
                await writer.write(sseEvent(encoder, { type: "log", msg: `↻ 修复 ${filePath}...` }));
                state.logs.push(`↻ 修复 ${filePath}...`);

                const prompt = buildFixPrompt(filePath, fileEntry.content, fileErrors, ctx, summaries);
                const fixedContent = stripFences(await callAIStream(key, prompt.system, prompt.user, writer, encoder));

                fileEntry.content = fixedContent;
                fixedCount++;

                const msg = `● ${filePath.split("/").pop()} 修复完成`;
                await writer.write(sseEvent(encoder, { type: "log", msg }));
                state.logs.push(msg);
            }

            // Delete the failed build branch on GitHub so rebuild can create a fresh one
            if (state.buildBranch) {
                try {
                    await deleteBranch(token, state.buildBranch);
                } catch (e: any) {
                    await writer.write(sseEvent(encoder, { type: "log", msg: `! 删除旧分支失败: ${e.message}` }));
                }
            }

            // Clear error state so rebuild can proceed
            state.status = "fixed";
            state.error = null;
            delete state.runId;
            delete state.buildBranch;
            await context.env.TASKS.put(taskId, JSON.stringify(state), { expirationTtl: 3600 });

            await writer.write(sseEvent(encoder, { type: "log", msg: `● 修复完成，共修复 ${fixedCount} 个文件` }));
            state.logs.push(`● 修复完成，共修复 ${fixedCount} 个文件`);

            await writer.write(sseEvent(encoder, { type: "result", fixed: fixedCount }));
            await writer.write(encoder.encode("data: [DONE]\n\n"));
        } catch (e: any) {
            await writer.write(sseEvent(encoder, { type: "log", msg: `× 修复失败: ${e.message}` }));
            await writer.write(sseEvent(encoder, { type: "result", fixed: 0, error: e.message }));
            await writer.write(encoder.encode("data: [DONE]\n\n"));
        } finally {
            await writer.close();
        }
    })();

    context.waitUntil(process);

    return new Response(readable, {
        headers: {
            "Content-Type": "text/event-stream",
            "Cache-Control": "no-cache",
            "Connection": "keep-alive",
        },
    });
};
