import { getRunStatus, getArtifactInfo, findRunByBranch, deleteBranch } from "../../_lib/github";
import { getOwnedTask, putTaskState, taskOperationLeaseFromState } from "../../_lib/taskStore";
import { compareDiagnostics } from "../../_lib/buildDiagnostics";
import { buildRepairRecoverySnapshot } from "../../_lib/buildRepairRecovery";
import { evaluateKnowledgeUsage } from "../../_lib/learning/store";
import { currentFixRepairAuthorization } from "../../_lib/learning/fixAuthorization";

interface Env {
    DB?: D1Database;
    GITHUB_PAT: string;
    TASKS: KVNamespace;
}

async function evaluateResolvedKnowledgeUsage(
    env: Env,
    taskId: string,
    usages: any[],
): Promise<boolean> {
    if (!env.DB || !Array.isArray(usages) || !usages.length) return true;
    try {
        await Promise.all(usages.map((usage) => evaluateKnowledgeUsage(env, {
            knowledgeId: usage.knowledgeId,
            generationTaskId: taskId,
            stage: usage.stage,
            diagnosticBefore: usage.diagnosticBefore,
            diagnosticAfter: "",
            outcome: "resolved",
        })));
        return true;
    } catch (error) {
        console.warn("knowledge usage success evaluation failed", error);
        return false;
    }
}

export const onRequestGet: PagesFunction<Env> = async (context) => {
    const uid: string = (context.data as any)?.uid || "";
    const url = new URL(context.request.url);
    const taskId = url.searchParams.get("taskId");
    if (!taskId) return new Response("Missing taskId", { status: 400 });

    const token = context.env.GITHUB_PAT;
    const raw = await getOwnedTask(context.env, taskId, uid);
    if (!raw) return new Response("Task not found", { status: 404 });
    const state = JSON.parse(raw);
    const now = Date.now();
    const repairAuthorization = currentFixRepairAuthorization(state);
    const operationLease = context.env.DB ? taskOperationLeaseFromState(state) : null;
    const repairLeaseUntil = operationLease?.token.startsWith("repair:")
        ? operationLease.leaseUntil
        : 0;
    if (state.status === "repairing" && context.env.DB && !operationLease) {
        return new Response(JSON.stringify({
            status: "repairing",
            repairRetryAfterMs: 2_000,
        }), {
            status: 503,
            headers: { "Content-Type": "application/json", "Retry-After": "2" },
        });
    }
    const repairRecovery = buildRepairRecoverySnapshot(state, now, repairLeaseUntil);
    if (repairRecovery) {
        return new Response(JSON.stringify({
            ...repairRecovery,
            ...(repairAuthorization ? { repairAuthorization } : {}),
        }), {
            headers: { "Content-Type": "application/json" },
        });
    }
    if (state.status === "error" && repairAuthorization) {
        return new Response(JSON.stringify({
            status: "error",
            repairPending: true,
            repairAuthorization,
        }), {
            headers: { "Content-Type": "application/json" },
        });
    }

    state.uid = uid;
    let discoveredRun = false;
    const buildRunStartedAfter = typeof state.buildRunStartedAfter === "string"
        && /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{3})?Z$/.test(state.buildRunStartedAfter)
        ? state.buildRunStartedAfter
        : "";

    if (!state.runId && state.buildBranch && buildRunStartedAfter) {
        const runId = await findRunByBranch(token, state.buildBranch, buildRunStartedAfter);
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
            await putTaskState(context.env, taskId, state, 3600, uid);
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
            delete state.fixLearningAuthorization;
            delete state.fixRepairAuthorization;
            delete state.fixKnowledgeNeeds;
            delete state.fixDiagnosticsFingerprint;
            state.logs.push("● 构建成功，JAR 已就绪");
            if (state.pendingFixSnapshot?.diagnostics) {
                const usageEvaluated = await evaluateResolvedKnowledgeUsage(
                    context.env,
                    taskId,
                    state.pendingFixSnapshot.knowledgeUsage,
                );
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
                if (usageEvaluated) delete state.pendingFixSnapshot;
            }
        } else {
            state.status = "error";
            state.error = "构建成功但未找到 artifact";
            delete state.fixLearningAuthorization;
            delete state.fixRepairAuthorization;
            delete state.fixKnowledgeNeeds;
            delete state.fixDiagnosticsFingerprint;
        }
    } else {
        state.status = "error";
        state.error = `构建失败: ${conclusion}`;
        delete state.fixLearningAuthorization;
        delete state.fixRepairAuthorization;
        delete state.fixKnowledgeNeeds;
        delete state.fixDiagnosticsFingerprint;
        state.logs.push(`× 构建结果: ${conclusion}`);
    }

    const completedBranch = state.buildBranch && state.status === "done"
        ? String(state.buildBranch)
        : "";
    await putTaskState(context.env, taskId, state, 3600, uid);

    // 只有任务终态已落库后才清理临时分支；失败时保留以供 fix 端点读取日志。
    if (completedBranch) {
        context.waitUntil(deleteBranch(token, completedBranch).catch((error) => {
            console.warn("completed build branch cleanup failed", error);
        }));
    }

    return new Response(JSON.stringify({
        status: state.status,
        conclusion,
        artifactReady: !!state.artifactId,
        error: state.error,
    }), { headers: { "Content-Type": "application/json" } });
};
