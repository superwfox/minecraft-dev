import { injectTahaiAuthor } from "../../_lib/pluginWatermark";
import {
    getDefaultBranchSha,
    createBranch,
    createBlob,
    createTree,
    createCommitAndUpdateRef,
    triggerWorkflow,
    findRunByBranch,
    deleteBranch,
} from "../../_lib/github";
import { protectedBuildPath } from "../../_lib/learning/compileApiEvidence";
import { activePathRepair, sourceFingerprint } from "../../_lib/projectPathReview";
import { MAX_BUILDS_PER_USER_DAY, userBuildCheck, userBuildIncrement } from "../../_lib/quota";
import { checkPom, normalizePomRepositories } from "../../_lib/pomGuard";
import {
    acquireTaskOperationLease,
    getOwnedTask,
    putTaskWithOperationLease,
    releaseTaskOperationLease,
    renewTaskOperationLease,
    taskOperationLeaseFromState,
    TaskOwnershipError,
    type TaskOperationLeaseMode,
} from "../../_lib/taskStore";

interface Env {
    DB?: D1Database;
    GITHUB_PAT: string;
    TASKS: KVNamespace;
}

const BUILD_OPERATION_LEASE_MS = 600_000;
const BUILD_RUN_LOOKBACK_MS = 5_000;
const BUILD_REQUEST_ID = /^build_[a-f0-9]{32}$/;

function json(obj: any, status: number): Response {
    return new Response(JSON.stringify(obj), { status, headers: { "Content-Type": "application/json" } });
}

function buildResponsePayload(state: any): Record<string, unknown> {
    return {
        buildBranch: state.buildBranch || "",
        runId: Number(state.runId) || null,
        projectName: state.projectName,
        packageName: state.packageName,
        javaVersion: state.javaVersion,
    };
}

function replayBuildResponse(state: any, buildRequestId: string): Response | null {
    if (!buildRequestId || state?.buildRequestId !== buildRequestId) return null;
    const startError = typeof state.buildRequestStartError === "string"
        ? state.buildRequestStartError.trim()
        : "";
    if (startError) {
        const status = Number.isInteger(Number(state.buildRequestErrorStatus))
            ? Math.max(400, Math.min(599, Number(state.buildRequestErrorStatus)))
            : 500;
        return json({
            error: startError,
            code: typeof state.buildRequestErrorCode === "string"
                ? state.buildRequestErrorCode
                : "BUILD_START_FAILED",
        }, status);
    }
    return json(buildResponsePayload(state), 200);
}

function buildInProgress(): Response {
    return json({
        error: "Build is already in progress",
        code: "BUILD_IN_PROGRESS",
    }, 409);
}

function buildReconciliationPending(): Response {
    return json({
        error: "构建启动状态暂时无法确认，请使用同一请求重试",
        code: "BUILD_RECONCILIATION_PENDING",
    }, 503);
}

function hasActiveTaskOperation(state: any): boolean {
    const lease = taskOperationLeaseFromState(state);
    return !!lease && lease.leaseUntil > Date.now();
}

export const onRequestPost: PagesFunction<Env> = async (context) => {
    let body: any = {};
    try { body = await context.request.json(); } catch { /* validated below */ }
    const taskId = typeof body.taskId === "string" ? body.taskId : "";
    if (body.files !== undefined || body.meta !== undefined) {
        return json({ error: "本地文件重建功能已停用", code: "FEATURE_DEPRECATED" }, 410);
    }
    const buildRequestId = typeof body.buildRequestId === "string"
        ? body.buildRequestId.trim().toLowerCase()
        : "";
    if (!taskId || !BUILD_REQUEST_ID.test(buildRequestId)) {
        return json({ error: "Invalid build request", code: "INVALID_BUILD_REQUEST" }, 400);
    }

    const token = context.env.GITHUB_PAT;
    if (!token) return json({ error: "GITHUB_PAT not configured" }, 500);

    const uid: string = (context.data as any)?.uid || "";
    if (!uid) return json({ error: "Unauthorized" }, 401);

    const raw = await getOwnedTask(context.env, taskId, uid);
    if (!raw) return json({ error: "Task not found", code: "TASK_NOT_FOUND" }, 404);
    let state = JSON.parse(raw);

    state.uid = uid;
    if (!Array.isArray(state.logs)) state.logs = [];
    const immediateReplay = replayBuildResponse(state, buildRequestId);
    if (immediateReplay && state.status !== "uploading") return immediateReplay;
    if (immediateReplay && hasActiveTaskOperation(state)) return buildReconciliationPending();
    if (!immediateReplay && (
        hasActiveTaskOperation(state)
        || state.status === "uploading"
        || state.status === "building"
        || state.status === "repairing"
    )) {
        return buildInProgress();
    }

    const buildLeaseToken = `build:${buildRequestId}`;
    let buildLeaseMode: TaskOperationLeaseMode | null = null;
    let buildLeaseReleased = false;
    try {
        buildLeaseMode = await acquireTaskOperationLease(
            context.env,
            taskId,
            uid,
            buildLeaseToken,
            BUILD_OPERATION_LEASE_MS,
        );
    } catch (error) {
        console.warn("build lease acquisition failed", error);
        return json({
            error: "构建状态存储暂不可用，请稍后重试",
            code: "BUILD_STORE_UNAVAILABLE",
        }, 503);
    }
    if (!buildLeaseMode) {
        const latestRaw = await getOwnedTask(context.env, taskId, uid);
        if (latestRaw) {
            const replay = replayBuildResponse(JSON.parse(latestRaw), buildRequestId);
            if (replay) return replay;
        }
        return buildInProgress();
    }

    const releaseBuildLease = async () => {
        if (!buildLeaseMode || buildLeaseReleased) return;
        buildLeaseReleased = await releaseTaskOperationLease(
            context.env,
            taskId,
            uid,
            buildLeaseToken,
            buildLeaseMode,
        );
    };
    const persistState = async (releaseLease = false) => {
        const committed = await putTaskWithOperationLease(
            context.env,
            taskId,
            JSON.stringify(state),
            buildLeaseToken,
            buildLeaseMode!,
            3600,
            uid,
            releaseLease,
        );
        if (!committed) throw new TaskOwnershipError();
        if (releaseLease) buildLeaseReleased = true;
    };
    const renewBuildLease = async () => {
        if (!buildLeaseMode || buildLeaseReleased) throw new TaskOwnershipError();
        const renewed = await renewTaskOperationLease(
            context.env,
            taskId,
            uid,
            buildLeaseToken,
            BUILD_OPERATION_LEASE_MS,
        );
        if (!renewed) throw new TaskOwnershipError();
    };

    let userBuildUsed = 0;
    let workflowTriggered = false;
    let resumingRecordedDispatch = false;
    try {
        const latestRaw = await getOwnedTask(context.env, taskId, uid);
        if (!latestRaw) return json({ error: "Task state unavailable", code: "TASK_STATE_UNAVAILABLE" }, 503);
        state = JSON.parse(latestRaw);
        state.uid = uid;
        if (!Array.isArray(state.logs)) state.logs = [];

        const latestReplay = replayBuildResponse(state, buildRequestId);
        const resumingUpload = !!latestReplay && state.status === "uploading";
        resumingRecordedDispatch = resumingUpload
            && typeof state.buildBranch === "string"
            && !!state.buildBranch
            && typeof state.buildRunStartedAfter === "string"
            && !!state.buildRunStartedAfter;
        if (latestReplay && !resumingUpload) return latestReplay;
        if (!latestReplay && (
            state.status === "uploading"
            || state.status === "building"
            || state.status === "repairing"
        )) {
            return buildInProgress();
        }

        const buildLimit = await userBuildCheck(context.env.TASKS, uid);
        if (!buildLimit.ok) {
            return json({
                error: `今日构建次数已达上限 ${MAX_BUILDS_PER_USER_DAY}`,
                code: "BUILD_DAY_LIMIT",
            }, 429);
        }
        userBuildUsed = buildLimit.used;

        if (!resumingUpload) {
            const pomFile = state.generatedFiles.find((file: any) => file.path.endsWith("pom.xml"));
            if (pomFile) {
                const normalized = normalizePomRepositories(pomFile.content);
                if (normalized.changes.length > 0) {
                    pomFile.content = normalized.content;
                    state.logs.push(`▸ 已修正 pom.xml：${normalized.changes.join("；")}`);
                }
                const checked = checkPom(pomFile.content);
                if (!checked.ok) {
                    state.buildRequestId = buildRequestId;
                    state.buildRequestStartError = checked.reason;
                    state.buildRequestErrorCode = "POM_BLOCKED";
                    state.buildRequestErrorStatus = 400;
                    state.status = "error";
                    state.error = checked.reason;
                    state.logs.push(`× 安全校验拦截：${checked.reason}`);
                    await persistState(true);
                    return json({ error: checked.reason, code: "POM_BLOCKED" }, 400);
                }
            }

            // Refuse stale evidence before recording an upload or clearing repair state.
            state.sourceFingerprint = await sourceFingerprint(state);
            if (activePathRepair(state) !== undefined || state.tree?.paths?.some(path => state.pathReviews?.[path.id]?.fingerprint !== state.sourceFingerprint)) {
                await persistState(true);
                return json({ error: "当前代码尚未完成路径静态审查", code: "PATH_REVIEW_REQUIRED" }, 409);
            }

            // 只有 fix 端点刚生成候选后的无文件重建才延续同一轮修复状态。
            const continuingRepair = state.status === "fixed"
                && !!state.pendingFixSnapshot;
            delete state.fixLearningAuthorization;
            delete state.fixRepairAuthorization;
            delete state.fixKnowledgeNeeds;
            delete state.fixDiagnosticsFingerprint;
            delete state.runId;
            delete state.buildBranch;
            delete state.buildRunStartedAfter;
            delete state.artifactId;
            if (!continuingRepair) {
                state.repairAttempts = 0;
                state.fixStagnation = 0;
                state.buildFixHistory = [];
                delete state.pendingFixSnapshot;
                delete state.lastBuildDiagnostics;
                delete state.lastBuildProgress;
            }

            delete state.repairStartedAt;
            delete state.buildRequestStartError;
            delete state.buildRequestErrorCode;
            delete state.buildRequestErrorStatus;
            state.buildRequestId = buildRequestId;
            state.buildRequestStartedAt = Date.now();
            state.status = "uploading";
            state.logs.push("正在上传文件到 GitHub...");
            await persistState();
        }

        if (state.buildBranch && state.buildRunStartedAfter) {
            await renewBuildLease();
            const existingRunId = await findRunByBranch(
                token,
                state.buildBranch,
                state.buildRunStartedAfter,
            );
            if (existingRunId) {
                state.runId = existingRunId;
                state.status = "building";
                state.logs.push(`构建 run #${existingRunId} 已恢复`);
                await persistState(true);
                await userBuildIncrement(context.env.TASKS, uid, userBuildUsed);
                return json(buildResponsePayload(state), 200);
            }
            if (resumingRecordedDispatch) {
                state.status = "uploading";
                state.error = null;
                delete state.buildRequestStartError;
                delete state.buildRequestErrorCode;
                delete state.buildRequestErrorStatus;
                state.logs.push("! 已记录的 workflow 暂未出现 run，将使用同一请求继续对账");
                await persistState(true);
                return buildReconciliationPending();
            }
        }

        if (state.generatedFiles.some((file: any) => protectedBuildPath(file?.path))) {
            throw new Error("生成文件包含无效或受保护的构建路径");
        }
        await renewBuildLease();
        const { sha } = await getDefaultBranchSha(token);
        const branch = `build-${taskId}`;
        await deleteBranch(token, branch);
        await createBranch(token, sha, branch);
        state.buildBranch = branch;
        state.logs.push(`已创建临时分支 ${branch}`);

        const treeFiles: { path: string; blobSha: string }[] = [];
        for (const file of state.generatedFiles) {
            await renewBuildLease();
            const content = file.path.endsWith("plugin.yml")
                ? injectTahaiAuthor(file.content)
                : file.content;
            const blobSha = await createBlob(token, content);
            treeFiles.push({ path: file.path, blobSha });
            state.logs.push(`已创建 blob: ${file.path}`);
        }

        await renewBuildLease();
        const treeSha = await createTree(token, sha, treeFiles);
        state.buildHeadSha = await createCommitAndUpdateRef(token, treeSha, sha, branch, `build ${taskId}: ${treeFiles.length} files`);
        state.buildBaseSha = sha;
        state.compileCheck = { fingerprint: state.sourceFingerprint, status: "pending", headSha: state.buildHeadSha };
        delete state.compileApiEvidence;
        state.logs.push(`已一次性提交 ${treeFiles.length} 个文件`);

        const beforeTrigger = new Date(Date.now() - BUILD_RUN_LOOKBACK_MS).toISOString();
        state.buildRunStartedAfter = beforeTrigger;
        await persistState();
        await renewBuildLease();
        await triggerWorkflow(token, branch, state.javaVersion);
        workflowTriggered = true;
        state.logs.push("已触发 GitHub Actions 构建");

        await new Promise(resolve => setTimeout(resolve, 2_000));
        await renewBuildLease();

        const runId = await findRunByBranch(token, branch, beforeTrigger);
        if (runId) {
            state.runId = runId;
            state.logs.push(`构建 run #${runId} 已启动`);
        } else {
            state.logs.push("构建已触发，等待 run 创建...");
        }

        state.status = "building";
        await persistState(true);
        await userBuildIncrement(context.env.TASKS, uid, userBuildUsed);
        return json(buildResponsePayload(state), 200);
    } catch (error: any) {
        const message = error?.message || "构建启动失败";
        if (!Array.isArray(state.logs)) state.logs = [];
        if (workflowTriggered) {
            state.status = "building";
            state.error = null;
            delete state.buildRequestStartError;
            delete state.buildRequestErrorCode;
            delete state.buildRequestErrorStatus;
            state.logs.push(`! workflow 已触发，后续对账暂未完成: ${message}`);
            try {
                await persistState(true);
            } catch (persistError) {
                console.warn("triggered build recovery persistence failed", persistError);
            }
            return json(buildResponsePayload(state), 200);
        }
        if (resumingRecordedDispatch) {
            state.status = "uploading";
            state.error = null;
            delete state.buildRequestStartError;
            delete state.buildRequestErrorCode;
            delete state.buildRequestErrorStatus;
            state.logs.push("! 已记录的 workflow 启动状态暂时无法对账，将使用同一请求继续恢复");
            try {
                await persistState(true);
            } catch (persistError) {
                console.warn("recorded build reconciliation persistence failed", persistError);
            }
            return buildReconciliationPending();
        }

        state.buildRequestId = buildRequestId;
        state.buildRequestStartError = message;
        state.buildRequestErrorCode = "BUILD_START_FAILED";
        state.buildRequestErrorStatus = 500;
        state.status = "error";
        state.error = message;
        state.logs.push(`× 构建启动失败: ${message}`);
        try {
            await persistState(true);
        } catch (persistError) {
            console.warn("build failure persistence failed", persistError);
        }
        return json({ error: message, code: "BUILD_START_FAILED" }, 500);
    } finally {
        if (!buildLeaseReleased) {
            await releaseBuildLease().catch((error) => console.warn("build lease release failed", error));
        }
    }
};
