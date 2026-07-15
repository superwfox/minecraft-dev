import { buildFixPrompt } from "../../_lib/prompts";
import type { FileSummary } from "../../_lib/prompts";
import { getRunJobs, getJobLogs, deleteBranch } from "../../_lib/github";
import { accumulateCosts, type UsageBreakdown, type UsageCostEntry } from "../../_lib/quota";
import { resolveLLM, type LLMProvider } from "../../_lib/llm";
import { getTask, putTask } from "../../_lib/taskStore";
import { normalizePomRepositories } from "../../_lib/pomGuard";

interface Env {
    DEEPSEEK_API_KEY: string;
    GITHUB_PAT: string;
    TASKS: KVNamespace;
}

interface AICallResult { content: string; model: string; usage?: UsageBreakdown; }

const FIX_IDLE_MS = 120000; // 空闲超时:连续这么久没字节才 abort（推理在持续吐 delta，慢但活着不误杀）

async function callAIStream(
    llm: LLMProvider, system: string, user: string,
    writer: WritableStreamDefaultWriter<Uint8Array>, encoder: TextEncoder,
): Promise<AICallResult> {
    const model = llm.modelFor("pro");
    const body = {
        model,
        stream: true,
        stream_options: { include_usage: true },
        reasoning_effort: "high",
        thinking: { type: "enabled" },
        messages: [{ role: "system", content: system }, { role: "user", content: user }],
    };

    // 空闲超时:每收到一块数据就续命(arm),只掐真正断死的连接，不误杀慢而活着的长思考。
    const ctrl = new AbortController();
    let idle: any;
    const arm = () => { clearTimeout(idle); idle = setTimeout(() => ctrl.abort(), FIX_IDLE_MS); };
    arm();
    try {
        const resp = await fetch(llm.url, {
            method: "POST",
            headers: { "Content-Type": "application/json", Authorization: `Bearer ${llm.apiKey}` },
            body: JSON.stringify(body),
            signal: ctrl.signal,
        });
        if (!resp.ok) throw new Error(await resp.text());

        const reader = resp.body!.getReader();
        const decoder = new TextDecoder();
        let full = "";
        let buffer = "";
        let usage: UsageBreakdown | undefined;

        while (true) {
            const { done, value } = await reader.read();
            if (done) break;
            arm();
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
                    if (chunk.usage) usage = chunk.usage;
                } catch { /* skip */ }
            }
        }
        return { content: full, model, usage };
    } finally {
        clearTimeout(idle);
    }
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

function cleanLogLine(line: string): string {
    return line
        .replace(/^\d{4}-\d{2}-\d{2}T\S+Z\s+/, "")
        .replace(/^\[ERROR\]\s*/, "")
        .trim();
}

function stableErrorFingerprint(log: string): string {
    const stable = log
        .split("\n")
        .map(cleanLogLine)
        .filter(Boolean)
        .join("\n")
        .replace(/\s+/g, " ");
    let hash = 0x811c9dc5;
    for (let i = 0; i < stable.length; i++) {
        hash ^= stable.charCodeAt(i);
        hash = Math.imul(hash, 0x01000193);
    }
    return (hash >>> 0).toString(16).padStart(8, "0");
}

function sameContent(a: string, b: string): boolean {
    const normalize = (value: string) => value.replace(/\r\n/g, "\n").trim();
    return normalize(a) === normalize(b);
}

/** Parse Maven error log to identify the exact generated file that owns each error. */
function parseErrorFiles(log: string): Map<string, string[]> {
    const errors = new Map<string, string[]>();
    const lines = log.split("\n");

    for (let i = 0; i < lines.length; i++) {
        const line = cleanLogLine(lines[i]).replace(/\\/g, "/");
        // Covers Maven compiler paths with GitHub timestamps, Unix/Windows prefixes,
        // and both :[line,col] and :line:col locations.
        const match = line.match(/([^\s]*?src\/main\/(?:java|resources)\/[^:\s]+?\.(?:java|xml|ya?ml|properties))(?::\[?\d+(?:,\d+)?\]?|:\d+(?::\d+)?)(?:\s+(.*))?/i);
        if (match) {
            const srcIndex = match[1].toLowerCase().indexOf("src/main/");
            const filePath = match[1].slice(srcIndex);
            const errorMsg = match[2] || line;
            if (!errors.has(filePath)) errors.set(filePath, []);
            errors.get(filePath)!.push(errorMsg);
            // Capture follow-up lines (symbol, location etc.)
            for (let j = i + 1; j < Math.min(i + 6, lines.length); j++) {
                const follow = cleanLogLine(lines[j]);
                if (/^(symbol|location|required|found):/i.test(follow)) {
                    errors.get(filePath)!.push(follow);
                } else break;
            }
        }
    }

    // Dependency/repository/model resolution failures are owned by pom.xml, not by
    // every Java source file. The supplied debug log hit this branch: the legacy
    // papermc.io repository returned 403 before compilation even started.
    if (/(?:Could not collect dependencies|Failed to read artifact descriptor|Could not transfer artifact|DependencyResolutionException|Non-resolvable parent POM|PluginResolutionException)/i.test(log)) {
        errors.set("pom.xml", lines.map(cleanLogLine).filter(Boolean));
    }
    return errors;
}

export const onRequestPost: PagesFunction<Env> = async (context) => {
    const { taskId } = await context.request.json() as any;
    const llm = await resolveLLM(context);
    const token = context.env.GITHUB_PAT;

    const raw = await getTask(context.env, taskId);
    if (!raw) return new Response("Task not found", { status: 404 });
    const state = JSON.parse(raw);

    if (state.quotaExhausted) {
        return new Response(JSON.stringify({ error: "本月额度已用尽", code: "QUOTA_EXHAUSTED" }), {
            status: 402, headers: { "Content-Type": "application/json" },
        });
    }

    if (!state.runId) {
        return new Response(JSON.stringify({ error: "No build run to fix" }), {
            status: 400, headers: { "Content-Type": "application/json" },
        });
    }

    const uid: string | undefined = (context.data as any)?.uid;
    const pendingUsage: UsageCostEntry[] = [];
    let chargeFlushed = false;
    const charge = async (r: AICallResult) => {
        if (llm.byok || !uid || !r.usage) return; // BYOK 自带 key：跳过计费
        pendingUsage.push({ model: r.model, usage: r.usage });
    };
    const flushCharge = async () => {
        if (chargeFlushed || llm.byok || !uid || pendingUsage.length === 0) return;
        chargeFlushed = true;
        const cost = await accumulateCosts(context.env, uid, taskId, pendingUsage.splice(0));
        state.totalCost = cost.total;
        state.consumedQuota = cost.consumed;
        if (cost.outOfQuota) state.quotaExhausted = true;
    };

    const { readable, writable } = new TransformStream<Uint8Array>();
    const encoder = new TextEncoder();
    const writer = writable.getWriter();

    const process = (async () => {
        // 心跳:拉日志 + 推理首 token 前那段静默期每 12s 写一个,避免被 CF 因长静默切断连接。
        const heartbeat = setInterval(() => {
            writer.write(sseEvent(encoder, { type: "heartbeat", t: Date.now() })).catch(() => { });
        }, 12000);
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
            const fingerprint = stableErrorFingerprint(errorSection);
            await writer.write(sseEvent(encoder, {
                type: "debug",
                scope: "build-fix",
                msg: "fix:error-section",
                runId: state.runId,
                fingerprint,
                lines: errorSection.split("\n").length,
                errorSection: errorSection.slice(0, 8000),
            }));

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

            // Never rewrite every Java file when the build log has no source owner.
            // That fallback caused expensive, unrelated rewrites and repeated builds.
            if (filesToFix.length === 0) {
                const reason = "无法从构建日志定位可安全修改的文件，已停止自动修复；不会重写全部 Java 文件";
                await writer.write(sseEvent(encoder, { type: "log", msg: `! ${reason}` }));
                await writer.write(sseEvent(encoder, {
                    type: "debug", scope: "build-fix", msg: "fix:no-target", fingerprint,
                    parsedPaths: [...errorMap.keys()],
                }));
                state.status = "error";
                state.error = reason;
                state.logs.push(`! ${reason}`);
                await putTask(context.env, taskId, JSON.stringify(state));
                await writer.write(sseEvent(encoder, { type: "result", fixed: 0, reason, fingerprint }));
                await writer.write(encoder.encode("data: [DONE]\n\n"));
                return;
            } else {
                await writer.write(sseEvent(encoder, { type: "log", msg: `▸ 需要修复 ${filesToFix.length} 个文件: ${filesToFix.map(f => f.split("/").pop()).join(", ")}` }));
            }

            const previousFix = Array.isArray(state.buildFixHistory)
                ? state.buildFixHistory[state.buildFixHistory.length - 1]
                : null;
            if (previousFix?.fingerprint === fingerprint) {
                const reason = `构建错误与上轮完全一致 (${fingerprint})，已停止重复返工`;
                await writer.write(sseEvent(encoder, { type: "log", msg: `! ${reason}` }));
                await writer.write(sseEvent(encoder, {
                    type: "debug", scope: "build-fix", msg: "fix:repeated-error",
                    fingerprint, previousRunId: previousFix.runId, targets: filesToFix,
                }));
                state.status = "error";
                state.error = reason;
                state.logs.push(`! ${reason}`);
                await putTask(context.env, taskId, JSON.stringify(state));
                await writer.write(sseEvent(encoder, { type: "result", fixed: 0, reason, fingerprint, repeated: true }));
                await writer.write(encoder.encode("data: [DONE]\n\n"));
                return;
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
            const changedFiles: string[] = [];
            const skippedFiles: string[] = [];
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

                // The common legacy Paper repository failure is deterministic and
                // should not spend an LLM call or risk rewriting unrelated XML.
                if (filePath.endsWith("pom.xml")) {
                    const normalized = normalizePomRepositories(fileEntry.content);
                    if (normalized.changes.length > 0) {
                        fileEntry.content = normalized.content;
                        fixedCount++;
                        changedFiles.push(filePath);
                        const msg = `● pom.xml 已确定性修正：${normalized.changes.join("；")}`;
                        await writer.write(sseEvent(encoder, { type: "log", msg }));
                        state.logs.push(msg);
                        continue;
                    }
                }

                const fileRole = state.plan?.find((f: any) => f.path === filePath)?.role
                    ?? fileEntry.role
                    ?? "";
                const prompt = buildFixPrompt(filePath, fileEntry.content, fileErrors, ctx, summaries, fileRole);
                const fixRes = await callAIStream(llm, prompt.system, prompt.user, writer, encoder);
                await charge(fixRes);
                const fixedContent = stripFences(fixRes.content).trim();

                if (!fixedContent || sameContent(fixedContent, fileEntry.content)) {
                    skippedFiles.push(filePath);
                    const reason = !fixedContent ? "模型返回空内容" : "返回内容与原文件相同";
                    await writer.write(sseEvent(encoder, { type: "log", msg: `! ${filePath.split("/").pop()} 未产生修改：${reason}` }));
                    await writer.write(sseEvent(encoder, {
                        type: "debug", scope: "build-fix", msg: "fix:unchanged",
                        path: filePath, reason, responseLength: fixRes.content.length,
                    }));
                    continue;
                }

                fileEntry.content = fixedContent;
                fixedCount++;
                changedFiles.push(filePath);

                const msg = `● ${filePath.split("/").pop()} 修复完成`;
                await writer.write(sseEvent(encoder, { type: "log", msg }));
                state.logs.push(msg);
            }

            state.buildFixHistory = [
                ...(Array.isArray(state.buildFixHistory) ? state.buildFixHistory : []),
                { fingerprint, runId: state.runId, targets: filesToFix, changedFiles, skippedFiles, at: Date.now() },
            ].slice(-4);

            await writer.write(sseEvent(encoder, {
                type: "debug", scope: "build-fix", msg: "fix:result",
                fingerprint, targets: filesToFix, changedFiles, skippedFiles, fixedCount,
            }));

            if (fixedCount === 0) {
                const reason = "自动修复未产生任何有效文件变更，已停止重新构建";
                state.status = "error";
                state.error = reason;
                state.logs.push(`! ${reason}`);
                await flushCharge();
                await putTask(context.env, taskId, JSON.stringify(state));
                await writer.write(sseEvent(encoder, { type: "log", msg: `! ${reason}` }));
                await writer.write(sseEvent(encoder, { type: "result", fixed: 0, reason, fingerprint, skippedFiles }));
                await writer.write(encoder.encode("data: [DONE]\n\n"));
                return;
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
            await flushCharge();
            await putTask(context.env, taskId, JSON.stringify(state));

            await writer.write(sseEvent(encoder, { type: "log", msg: `● 修复完成，共修复 ${fixedCount} 个文件` }));
            state.logs.push(`● 修复完成，共修复 ${fixedCount} 个文件`);

            await writer.write(sseEvent(encoder, { type: "result", fixed: fixedCount, fingerprint, changedFiles, skippedFiles }));
            await writer.write(encoder.encode("data: [DONE]\n\n"));
        } catch (e: any) {
            await writer.write(sseEvent(encoder, { type: "log", msg: `× 修复失败: ${e.message}` }));
            await writer.write(sseEvent(encoder, { type: "result", fixed: 0, error: e.message }));
            await writer.write(encoder.encode("data: [DONE]\n\n"));
        } finally {
            clearInterval(heartbeat);
            try { await flushCharge(); } catch { /* 计费失败不覆盖修复结果 */ }
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
