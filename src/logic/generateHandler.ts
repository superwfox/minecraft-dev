import { genTask } from "./generateState";
import type { GenPhase } from "./generateState";

function setPhase(phase: GenPhase, log?: string) {
    genTask.phase = phase;
    if (log) genTask.logs.push(log);
}

async function post(url: string, body: any) {
    const resp = await fetch(url, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(body),
    });
    if (!resp.ok) throw new Error(await resp.text());
    return resp.json() as any;
}

async function get(url: string) {
    const resp = await fetch(url);
    if (!resp.ok) throw new Error(await resp.text());
    return resp.json() as any;
}

export async function startGenerate(userPrompt: string, coreType: string, version: string) {
    try {
        setPhase("planning", "正在分析需求，生成项目规划...");

        const planResult = await post("/api/generate/plan", { userPrompt, coreType, version });
        genTask.taskId = planResult.taskId;
        genTask.projectName = planResult.projectName;
        genTask.packageName = planResult.packageName;
        genTask.javaVersion = planResult.javaVersion;
        genTask.files = planResult.plan.map((f: any) => ({ path: f.path, role: f.role, status: "pending" }));
        genTask.logs.push(`✅ 项目规划完成，共 ${genTask.files.length} 个文件`);

        setPhase("generating");
        for (let i = 0; i < genTask.files.length; i++) {
            genTask.files[i].status = "generating";
            genTask.currentIndex = i;
            genTask.logs.push(`正在生成 ${genTask.files[i].path}...`);

            const fileResult = await post("/api/generate/file", { taskId: genTask.taskId });
            genTask.files[i].content = fileResult.content;
            genTask.files[i].status = "done";
            genTask.logs.push(`✅ ${genTask.files[i].path}`);
        }

        setPhase("verifying", "正在校验文件完整性...");
        const verifyResult = await post("/api/generate/verify", { taskId: genTask.taskId });
        if (!verifyResult.verified) {
            throw new Error(`文件校验失败，缺失: ${verifyResult.missing.join(", ")}`);
        }
        genTask.logs.push("✅ 文件校验通过");

        setPhase("uploading", "正在上传到 GitHub 并触发构建...");
        const buildResult = await post("/api/generate/build", { taskId: genTask.taskId });
        genTask.logs.push(`构建已触发 (run #${buildResult.runId || "pending"})`);

        setPhase("building", "正在等待 GitHub Actions 构建...");
        await pollBuildStatus();
    } catch (e: any) {
        genTask.phase = "error";
        genTask.error = e.message || String(e);
        genTask.logs.push("❌ " + genTask.error);
    }
}

async function pollBuildStatus() {
    const maxAttempts = 60; // 最多等待 5 分钟
    for (let i = 0; i < maxAttempts; i++) {
        await new Promise(r => setTimeout(r, 5000));

        const result = await get(`/api/generate/status?taskId=${genTask.taskId}`);

        if (result.status === "done") {
            setPhase("done", "✅ 构建成功，JAR 已就绪！");
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
