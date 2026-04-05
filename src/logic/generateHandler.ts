import { genTask, resetGenTask } from "./generateState";
import type { GenPhase } from "./generateState";

function setPhase(phase: GenPhase, log?: string) {
    genTask.phase = phase;
    if (log) genTask.logs.push(log);
}

function isGeneratingPhase(phase: GenPhase) {
    return ["planning", "generating", "verifying", "uploading", "building", "polling"].includes(phase);
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

/** SSE streaming file generation — reads events and updates genTask reactively */
async function streamFileGeneration(taskId: string): Promise<any> {
    const resp = await fetch("/api/generate/file", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ taskId }),
    });

    if (!resp.ok) throw new Error(await resp.text());

    // If response is JSON (e.g. done:true), handle directly
    const contentType = resp.headers.get("Content-Type") || "";
    if (contentType.includes("application/json")) {
        return await resp.json();
    }

    // SSE stream
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
                    case "result":
                        result = evt;
                        break;
                }
            } catch { /* skip malformed */ }
        }
    }

    // Clear streaming state after stream ends
    genTask.streamingPhase = "";
    genTask.streamingFile = "";
    genTask.streamingContent = "";

    return result;
}

export async function startGenerate(userPrompt: string, coreType: string, version: string) {
    if (isGeneratingPhase(genTask.phase)) {
        throw new Error("当前已有构建任务正在进行");
    }

    resetGenTask();

    try {
        setPhase("planning", "正在分析需求，生成项目规划...");

        const planResult = await post("/api/generate/plan", { userPrompt, coreType, version });
        genTask.taskId = planResult.taskId;
        genTask.projectName = planResult.projectName;
        genTask.packageName = planResult.packageName;
        genTask.javaVersion = planResult.javaVersion;
        genTask.files = planResult.plan.map((f: any) => ({ path: f.path, role: f.role, status: "pending" }));
        genTask.logs.push(`● 项目规划完成，共 ${genTask.files.length} 个文件`);

        setPhase("generating");
        let remaining = genTask.files.length;
        for (let i = 0; i < genTask.files.length && remaining > 0; i++) {
            genTask.files[i].status = "generating";
            genTask.currentIndex = i;

            const fileResult = await streamFileGeneration(genTask.taskId);
            if (!fileResult || fileResult.done) break;

            genTask.files[i].content = fileResult.content;
            genTask.files[i].status = "done";
            remaining = fileResult.remaining ?? (genTask.files.length - i - 1);
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

        setPhase("uploading", "正在上传到 GitHub 并触发构建...");
        const buildResult = await post("/api/generate/build", { taskId: genTask.taskId });
        genTask.logs.push(`构建已触发 (run #${buildResult.runId || "pending"})`);

        setPhase("building", "正在等待 GitHub Actions 构建...");
        await pollBuildStatus();
    } catch (e: any) {
        genTask.phase = "error";
        genTask.error = e.message || String(e);
        genTask.logs.push("× " + genTask.error);
    }
}

async function pollBuildStatus() {
    const maxAttempts = 60;
    for (let i = 0; i < maxAttempts; i++) {
        await new Promise(r => setTimeout(r, 5000));

        const result = await get(`/api/generate/status?taskId=${genTask.taskId}`);

        if (result.status === "done") {
            setPhase("done", "● 构建成功，JAR 已就绪！");
            return;
        }
        if (result.status === "error") {
            throw new Error(result.error || "构建失败");
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
