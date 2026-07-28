import { getRunStatus, getArtifactInfo, findRunByBranch, deleteBranch } from "../../_lib/github";
import { getTask, putTask } from "../../_lib/taskStore";
import { compareDiagnostics } from "../../_lib/buildDiagnostics";

interface Env {
    GITHUB_PAT: string;
    TASKS: KVNamespace;
}

export const onRequestGet: PagesFunction<Env> = async (context) => {
    const url = new URL(context.request.url);
    const taskId = url.searchParams.get("taskId");
    if (!taskId) return new Response("Missing taskId", { status: 400 });

    const token = context.env.GITHUB_PAT;
    const raw = await getTask(context.env, taskId);
    if (!raw) return new Response("Task not found", { status: 404 });
    const state = JSON.parse(raw);
    let discoveredRun = false;

    if (!state.runId && state.buildBranch) {
        const runId = await findRunByBranch(token, state.buildBranch, "");
        if (runId) {
            state.runId = runId;
            state.logs.push(`构建 run #${runId} 已找到`);
            discoveredRun = true;
        }
    }

    if (!state.runId) {
        return new Response(JSON.stringify({ status: "waiting", message: "等待构建启动..." }), {
            headers: { "Content-Type": "application/json" },
        });
    }

    const { status, conclusion } = await getRunStatus(token, state.runId);

    if (status !== "completed") {
        // 仅在首次发现 runId 时落一次；若本次已完成，则与终态合并为下方一次写入。
        if (discoveredRun) {
            await putTask(context.env, taskId, JSON.stringify(state));
        }
        return new Response(JSON.stringify({ status: "building", runStatus: status }), {
            headers: { "Content-Type": "application/json" },
        });
    }

    if (conclusion === "success") {
        const artifact = await getArtifactInfo(token, state.runId);
        if (artifact) {
            state.artifactId = artifact.id;
            state.status = "done";
            state.logs.push("● 构建成功，JAR 已就绪");
            if (state.pendingFixSnapshot?.diagnostics) {
                const progress = compareDiagnostics(state.pendingFixSnapshot.diagnostics, []);
                const history = Array.isArray(state.buildFixHistory) ? state.buildFixHistory : [];
                for (let i = history.length - 1; i >= 0; i--) {
                    if (history[i]?.attempt === state.pendingFixSnapshot.attempt && !history[i]?.evaluatedRunId) {
                        history[i] = { ...history[i], evaluatedRunId: state.runId, progress, status: "verified" };
                        break;
                    }
                }
                state.buildFixHistory = history.slice(-6);
                state.lastBuildDiagnostics = [];
                state.lastBuildProgress = progress;
                state.fixStagnation = 0;
                delete state.pendingFixSnapshot;
            }
        } else {
            state.status = "error";
            state.error = "构建成功但未找到 artifact";
        }
    } else {
        state.status = "error";
        state.error = `构建失败: ${conclusion}`;
        state.logs.push(`× 构建结果: ${conclusion}`);
    }

    // 成功时删除临时分支；失败时保留以供 fix 端点读取日志
    if (state.buildBranch && state.status === "done") {
        deleteBranch(token, state.buildBranch).catch(() => { });
    }

    await putTask(context.env, taskId, JSON.stringify(state));

    return new Response(JSON.stringify({
        status: state.status,
        conclusion,
        artifactReady: !!state.artifactId,
        error: state.error,
    }), { headers: { "Content-Type": "application/json" } });
};
