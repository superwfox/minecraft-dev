import { genTask, resetGenTask } from "./generateState";
import type { GenPhase } from "./generateState";

const MAX_FIX_ATTEMPTS = 2;
const MAX_REPLAN_ATTEMPTS = 2;

function setPhase(phase: GenPhase, log?: string) {
    genTask.phase = phase;
    if (log) genTask.logs.push(log);
}

function isGeneratingPhase(phase: GenPhase) {
    return ["planning", "generating", "verifying", "uploading", "building", "polling", "fixing"].includes(phase);
}

async function post(url: string, body: any, maxRetries = 3) {
    for (let attempt = 0; attempt <= maxRetries; attempt++) {
        try {
            const resp = await fetch(url, {
                method: "POST",
                headers: { "Content-Type": "application/json" },
                body: JSON.stringify(body),
            });
            if (!resp.ok) throw new Error(await resp.text());
            return await resp.json() as any;
        } catch (e: any) {
            if (attempt >= maxRetries) throw e;
            const delay = 2000 * Math.pow(2, attempt);
            genTask.logs.push(`! 请求失败，${delay / 1000}s 后重试 (${attempt + 1}/${maxRetries})...`);
            await new Promise(r => setTimeout(r, delay));
        }
    }
}

async function get(url: string) {
    const resp = await fetch(url);
    if (!resp.ok) throw new Error(await resp.text());
    return resp.json() as any;
}

/** Read an SSE stream, dispatch events to genTask, return the result event */
async function readSSE(resp: Response): Promise<any> {
    const reader = resp.body!.getReader();
    const decoder = new TextDecoder();
    let buffer = "";
    let result: any = null;

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
                const evt = JSON.parse(payload);
                switch (evt.type) {
                    case "phase":
                        genTask.streamingPhase = evt.phase;
                        genTask.streamingFile = evt.file || "";
                        genTask.streamingContent = "";
                        break;
                    case "delta":
                        genTask.streamingContent += evt.content;
                        break;
                    case "log":
                        genTask.logs.push(evt.msg);
                        break;
                    case "new_file":
                        genTask.files.push({
                            path: evt.path, role: evt.role,
                            content: evt.content, status: "done",
                        });
                        break;
                    case "result":
                        result = evt;
                        break;
                }
            } catch { /* skip */ }
        }
    }

    genTask.streamingPhase = "";
    genTask.streamingFile = "";
    genTask.streamingContent = "";
    return result;
}

/** SSE streaming file generation */
async function streamFileGeneration(taskId: string): Promise<any> {
    const resp = await fetch("/api/generate/file", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ taskId }),
    });
    if (!resp.ok) throw new Error(await resp.text());

    const contentType = resp.headers.get("Content-Type") || "";
    if (contentType.includes("application/json")) {
        return await resp.json();
    }

    return readSSE(resp);
}

/** SSE streaming build fix */
async function streamBuildFix(taskId: string): Promise<any> {
    const resp = await fetch("/api/generate/fix", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ taskId }),
    });
    if (!resp.ok) throw new Error(await resp.text());

    const contentType = resp.headers.get("Content-Type") || "";
    if (contentType.includes("application/json")) {
        return await resp.json();
    }

    return readSSE(resp);
}

export async function startGenerate(userPrompt: string, coreType: string, version: string) {
    if (isGeneratingPhase(genTask.phase)) {
        throw new Error("当前已有构建任务正在进行");
    }

    resetGenTask();

    for (let replanAttempt = 0; replanAttempt <= MAX_REPLAN_ATTEMPTS; replanAttempt++) {
        try {
            if (replanAttempt > 0) {
                genTask.logs.push(`↻ 第 ${replanAttempt} 次重新规划，从头开始生成...`);
                genTask.files = [];
                genTask.currentIndex = 0;
                genTask.error = "";
            }

            setPhase("planning", replanAttempt === 0
                ? "正在分析需求，生成项目规划..."
                : `正在重新规划 (第${replanAttempt}次)...`);

            const planResult = await post("/api/generate/plan", { userPrompt, coreType, version });
            genTask.taskId = planResult.taskId;
            genTask.projectName = planResult.projectName;
            genTask.packageName = planResult.packageName;
            genTask.javaVersion = planResult.javaVersion;
            genTask.files = planResult.plan.map((f: any) => ({ path: f.path, role: f.role, status: "pending" }));
            genTask.logs.push(`● 项目规划完成，共 ${genTask.files.length} 个文件`);

            setPhase("generating");
            let remaining = genTask.files.length;
            let needReplan = false;

            for (let i = 0; i < genTask.files.length && remaining > 0; i++) {
                genTask.files[i].status = "generating";
                genTask.currentIndex = i;

                const fileResult = await streamFileGeneration(genTask.taskId);
                if (!fileResult || fileResult.done) break;

                // reChecker exhausted — need to replan from scratch
                if (fileResult.replan) {
                    needReplan = true;
                    break;
                }

                genTask.files[i].content = fileResult.content;
                genTask.files[i].status = "done";
                remaining = fileResult.remaining ?? (genTask.files.length - i - 1);
            }

            if (needReplan) {
                if (replanAttempt >= MAX_REPLAN_ATTEMPTS) {
                    throw new Error("多次重新规划后仍无法通过审查，生成失败");
                }
                continue; // restart from planning
            }

            setPhase("verifying", "正在校验文件完整性...");
            let verifyResult = await post("/api/generate/verify", { taskId: genTask.taskId });

            for (let retry = 0; retry < 2 && !verifyResult.verified; retry++) {
                const missingList = verifyResult.missing as string[];
                genTask.logs.push(`! 缺失 ${missingList.length} 个文件，正在补齐 (第${retry + 1}次)...`);
                await post("/api/generate/verify", { taskId: genTask.taskId, fixMissing: true });

                setPhase("generating");
                for (const mp of missingList) {
                    genTask.logs.push(`↻ 补生成 ${mp}`);
                    const fileResult = await streamFileGeneration(genTask.taskId);
                    if (!fileResult || fileResult.done) break;
                }

                setPhase("verifying", "正在重新校验...");
                verifyResult = await post("/api/generate/verify", { taskId: genTask.taskId });
            }

            if (!verifyResult.verified) {
                throw new Error(`文件校验失败，缺失 ${verifyResult.missing.length} 个文件: ${verifyResult.missing.join(", ")}`);
            }
            genTask.logs.push(`● 文件校验通过 (${verifyResult.generated}/${verifyResult.total})`);

            // Build with fix-retry loop
            await buildWithRetry();
            return; // success — exit replan loop
        } catch (e: any) {
            if (replanAttempt >= MAX_REPLAN_ATTEMPTS) {
                genTask.phase = "error";
                genTask.error = e.message || String(e);
                genTask.logs.push("× " + genTask.error);
                return;
            }
            // If error is not from replan, don't retry
            if (!e.message?.includes("重新规划")) {
                genTask.phase = "error";
                genTask.error = e.message || String(e);
                genTask.logs.push("× " + genTask.error);
                return;
            }
        }
    }
}

async function buildWithRetry() {
    for (let attempt = 0; attempt <= MAX_FIX_ATTEMPTS; attempt++) {
        setPhase("uploading", "正在上传到 GitHub 并触发构建...");
        const buildResult = await post("/api/generate/build", { taskId: genTask.taskId });
        genTask.logs.push(`构建已触发 (run #${buildResult.runId || "pending"})`);

        setPhase("building", "正在等待 GitHub Actions 构建...");
        const buildOk = await pollBuildStatus();

        if (buildOk) return; // success

        // Build failed — attempt fix
        if (attempt < MAX_FIX_ATTEMPTS) {
            genTask.logs.push(`! 构建失败，尝试自动修复 (第${attempt + 1}次)...`);
            setPhase("fixing", "正在分析编译错误并修复...");

            const fixResult = await streamBuildFix(genTask.taskId);
            if (!fixResult || fixResult.fixed === 0) {
                throw new Error("自动修复未能修正任何文件，构建失败");
            }
            genTask.logs.push(`● 已修复 ${fixResult.fixed} 个文件，重新构建...`);
        } else {
            throw new Error("构建失败，已用尽自动修复次数");
        }
    }
}

/** Poll build status. Returns true on success, false on failure. */
async function pollBuildStatus(): Promise<boolean> {
    const maxAttempts = 60;
    for (let i = 0; i < maxAttempts; i++) {
        await new Promise(r => setTimeout(r, 5000));

        const result = await get(`/api/generate/status?taskId=${genTask.taskId}`);

        if (result.status === "done") {
            setPhase("done", "● 构建成功，JAR 已就绪！");
            return true;
        }
        if (result.status === "error") {
            return false;
        }
        if (i % 3 === 0) {
            genTask.logs.push(`构建中... (${result.runStatus || "queued"})`);
        }
    }
    throw new Error("构建超时");
}

export function getDownloadUrl(): string {
    return `/api/generate/download?taskId=${genTask.taskId}`;
}
