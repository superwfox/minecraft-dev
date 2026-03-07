import { getRunStatus, getArtifactInfo, findRunByBranch, deleteBranch } from "../../_lib/github";

interface Env {
    GITHUB_PAT: string;
    TASKS: KVNamespace;
}

export const onRequestGet: PagesFunction<Env> = async (context) => {
    const url = new URL(context.request.url);
    const taskId = url.searchParams.get("taskId");
    if (!taskId) return new Response("Missing taskId", { status: 400 });

    const token = context.env.GITHUB_PAT;
    const raw = await context.env.TASKS.get(taskId);
    if (!raw) return new Response("Task not found", { status: 404 });
    const state = JSON.parse(raw);

    if (!state.runId && state.buildBranch) {
        const runId = await findRunByBranch(token, state.buildBranch, "");
        if (runId) {
            state.runId = runId;
            state.logs.push(`构建 run #${runId} 已找到`);
            await context.env.TASKS.put(taskId, JSON.stringify(state), { expirationTtl: 3600 });
        }
    }

    if (!state.runId) {
        return new Response(JSON.stringify({ status: "waiting", message: "等待构建启动..." }), {
            headers: { "Content-Type": "application/json" },
        });
    }

    const { status, conclusion } = await getRunStatus(token, state.runId);

    if (status !== "completed") {
        return new Response(JSON.stringify({ status: "building", runStatus: status }), {
            headers: { "Content-Type": "application/json" },
        });
    }

    if (conclusion === "success") {
        const artifact = await getArtifactInfo(token, state.runId);
        if (artifact) {
            state.artifactId = artifact.id;
            state.status = "done";
            state.logs.push("✅ 构建成功，JAR 已就绪");
        } else {
            state.status = "error";
            state.error = "构建成功但未找到 artifact";
        }
    } else {
        state.status = "error";
        state.error = `构建失败: ${conclusion}`;
        state.logs.push(`❌ 构建结果: ${conclusion}`);
    }

    // 构建结束后始终删除临时分支
    if (state.buildBranch) {
        deleteBranch(token, state.buildBranch).catch(() => { });
    }

    await context.env.TASKS.put(taskId, JSON.stringify(state), { expirationTtl: 3600 });

    return new Response(JSON.stringify({
        status: state.status,
        conclusion,
        artifactReady: !!state.artifactId,
        error: state.error,
    }), { headers: { "Content-Type": "application/json" } });
};
