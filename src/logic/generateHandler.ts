import JSZip from "jszip";
import { renderTreeMarkdown, type ProjectTreeView, type TreeIssue } from "./projectTree";
import type { GenFile } from "./generateState";
import {
    genTask,
    resetGenTask,
    waitForClarifyAnswers,
    waitForExtraPrompt,
    waitForTreeDecision,
    cancelPendingInput,
    persistGenTaskNow,
    superConcurrency,
    normalizeLearningDebugMeta,
    normalizeLearningProgress,
    normalizeClarifyRequestId,
    normalizeTreeRequestId,
    isUnconfirmedLearningProgress,
    shouldResumeLearningProgress,
    recordLearningDebugEvent,
    appendGenLog,
    discardExpiredGenTask,
    GEN_TASK_TTL_MS,
} from "./generateState";
import type {
    FixResumeStage,
    GenPhase,
    LearningDebugMeta,
    LearningReasonCode,
    LearningStage,
    LearningStatus,
} from "./generateState";
import { showSponsorModal, login, fetchMe } from "./auth";
import {
    fetchWithByokFallback,
    handleDeepSeekAccessFailure,
    handleDeepSeekAccessResponse,
    hasDeepSeekKey,
    openDeepSeekKeyModal,
} from "./byok";
import type { DeepSeekAccessFailure } from "./byok";
import { selected } from "./skills";
import { beginToolActivity, cancelToolActivities, withToolActivity, type ToolActivityHandle } from "./toolActivity";
import { createToolActivityStream } from "./toolActivityStream";
import { readApiError as readBaseApiError, responseError } from "../api/apiError";
import {actionMessageMetaForError} from "./actionMessages";
import type {ActionMessageKind} from "./actionMessages";
import {recordPromptHistory} from "./promptHistory";
import {
    createLearningContinuationDeadline,
    type LearningContinuationDeadline,
} from "./learningContinuation";

const MAX_FIX_ATTEMPTS = 3;

// ── 当前生成运行域：所有请求共享一个根 signal，离页/中断/重置可一次性终止 ──
let generationAbort: AbortController | null = null;
let generationRunId = 0;
let taskKeepaliveTimer: ReturnType<typeof setTimeout> | undefined;

const TASK_KEEPALIVE_INTERVAL_MS = 10 * 60_000;
const TASK_KEEPALIVE_RETRY_MS = 60_000;
const TASK_UNAVAILABLE_MESSAGE = "任务已超过服务端有效期或已被清理，请重新开始生成";

function stopTaskKeepalive() {
    if (taskKeepaliveTimer) clearTimeout(taskKeepaliveTimer);
    taskKeepaliveTimer = undefined;
}

function beginGenerationRun(): AbortSignal {
    stopTaskKeepalive();
    treeRecoveryInput = null;
    generationAbort?.abort(new DOMException("Superseded", "AbortError"));
    cancelToolActivities(true);
    generationAbort = new AbortController();
    generationRunId++;
    return generationAbort.signal;
}

function generationSignal(): AbortSignal {
    if (!generationAbort) {
        generationAbort = new AbortController();
        generationRunId++;
    }
    return generationAbort.signal;
}

function generationAbortError(): Error {
    const error = new Error("interrupted");
    error.name = "AbortError";
    return error;
}

function assertGenerationRun(runId: number) {
    if (runId !== generationRunId || generationAbort?.signal.aborted) throw generationAbortError();
}

function isGenerationRunCurrent(runId: number): boolean {
    return runId === generationRunId && !!generationAbort && !generationAbort.signal.aborted;
}

function linkAbortSignal(controller: AbortController, source: AbortSignal): () => void {
    const abort = () => controller.abort(source.reason ?? new DOMException("Aborted", "AbortError"));
    if (source.aborted) abort();
    else source.addEventListener("abort", abort, { once: true });
    return () => source.removeEventListener("abort", abort);
}

function linkGenerationAbort(controller: AbortController): () => void {
    return linkAbortSignal(controller, generationSignal());
}

function interruptedPhase(): Exclude<GenPhase, "interrupted"> | "" {
    return genTask.phase === "interrupted" ? genTask.interruptedFrom : genTask.phase;
}

function markInterrupted(from: GenPhase | "" = genTask.phase) {
    stopTaskKeepalive();
    if (genTask.phase === "interrupted") return;
    if (!from || ["idle", "done", "error", "interrupted"].includes(from)) return;
    genTask.interruptedFrom = from as Exclude<GenPhase, "interrupted">;
    genTask.phase = "interrupted";
    genTask.error = "";
    genTask.errorMeta = null;
    genTask.preflightActive = false;
    genTask.streamingPhase = "";
    genTask.streamingFile = "";
    genTask.streamingContent = "";
    appendGenLog("■ 当前任务已中断，返回后不会自动继续");
    persistGenTaskNow();
}

// clarify / tree 保留独立 controller，供现有阶段代码清理引用。
let clarifyAbort: AbortController | null = null;
let treeAbort: AbortController | null = null;

/** 判断错误是否来自 ESC 中断：fetch abort 抛 AbortError，等待 Promise 被拒抛 InterruptError */
function isInterrupt(e: any): boolean {
    return e?.interrupted === true || e?.name === "AbortError";
}

/** 中断当前 Chat 生成运行域。服务端会通过断连信号同步终止上游模型。 */
export function interruptGenerate(options: { preserve?: boolean } = {}) {
    stopTaskKeepalive();
    const from = interruptedPhase();
    generationAbort?.abort(new DOMException("User interrupted", "AbortError"));
    generationRunId++;
    clarifyAbort?.abort(new DOMException("User interrupted", "AbortError"));
    treeAbort?.abort(new DOMException("User interrupted", "AbortError"));
    cancelPendingInput();
    if (options.preserve !== false) markInterrupted(from);
}

/** 不可重试错误（鉴权 / 额度 / 请求状态），跳过自动重试。 */
function noRetry(msg: string, meta: {code?: string; status?: number} = {}): Error {
    const e = new Error(msg);
    (e as any).noRetry = true;
    if (meta.code) (e as any).code = meta.code;
    if (meta.status) (e as any).status = meta.status;
    return e;
}

function clearGenerateError() {
    genTask.error = "";
    genTask.errorMeta = null;
}

function isTaskUnavailableError(error: unknown): boolean {
    if (!error || typeof error !== "object") return false;
    const record = error as Record<string, unknown>;
    const code = typeof record.code === "string" ? record.code : "";
    const status = Number(record.status) || 0;
    const message = error instanceof Error ? error.message.trim() : "";
    return code === "TASK_NOT_FOUND"
        || (status === 404 && /^Task not found$/i.test(message));
}

function setGenerateError(
    error: unknown,
    kind?: ActionMessageKind,
    message?: string,
) {
    stopTaskKeepalive();
    const taskUnavailable = isTaskUnavailableError(error);
    if (taskUnavailable) discardExpiredGenTask();
    genTask.phase = "error";
    genTask.error = message
        || (taskUnavailable ? TASK_UNAVAILABLE_MESSAGE : (error instanceof Error ? error.message : String(error)));
    genTask.errorMeta = actionMessageMetaForError(error, kind || (taskUnavailable ? "warning" : undefined));
}

function deepSeekAccessError(failure: DeepSeekAccessFailure): Error {
    const error = noRetry(failure.message);
    (error as any).code = failure.code;
    (error as any).status = failure.status;
    (error as any).retryable = false;
    (error as any).terminal = true;
    return error;
}

function quotaAccessError(): Error {
    const usingKey = hasDeepSeekKey();
    if (usingKey) {
        openDeepSeekKeyModal(
            "billing",
            "当前 DeepSeek 账户余额不足。请前往 DeepSeek 平台充值，或清除 Key 后改用踏海充值额度。",
        );
    } else {
        showSponsorModal.value = true;
        fetchMe();
    }

    const error = noRetry(
        usingKey
            ? "DeepSeek 账户余额不足，请充值后重试"
            : "充值额度已用尽，请充值或填写 DeepSeek API Key",
        {code: usingKey ? "INSUFFICIENT_QUOTA" : "QUOTA_REQUIRED", status: 402},
    );
    (error as any).retryable = false;
    (error as any).terminal = true;
    return error;
}

function rejectAccessEvent(payload: any): void {
    const rawError = payload?.error;
    const code = payload?.code ?? (typeof rawError === "object" ? rawError?.code : "");
    const status = payload?.status ?? (typeof rawError === "object" ? rawError?.status : 0);
    const failure = handleDeepSeekAccessFailure(status, code, {
        allowBare401: hasDeepSeekKey(),
    });
    if (failure) throw deepSeekAccessError(failure);
    if (Number(status) === 402) throw quotaAccessError();
}

async function rejectAccessResponse(response: Response): Promise<void> {
    const deepSeekFailure = await handleDeepSeekAccessResponse(response, {
        allowBare401: hasDeepSeekKey(),
    });
    if (deepSeekFailure) throw deepSeekAccessError(deepSeekFailure);

    if (response.status === 401) {
        login();
        throw noRetry("请先登录后再使用", {code: "AUTH_REQUIRED", status: 401});
    }

    if (response.status === 402) {
        throw quotaAccessError();
    }
}

async function readApiError(
    response: Response,
    fallback = `请求失败（HTTP ${response.status}）`,
): Promise<{ message: string; code: string; activeRequestId: string }> {
    const raw = await response.clone().text().catch(() => "");
    let activeRequestId = "";
    try {
        const payload = JSON.parse(raw) as { activeRequestId?: unknown };
        activeRequestId = typeof payload.activeRequestId === "string" ? payload.activeRequestId : "";
    } catch { /* apiError handles non-JSON and Cloudflare responses */ }
    const info = await readBaseApiError(response, fallback);
    return { ...info, activeRequestId };
}

function applyTaskExpiration(taskId: string, value: unknown): number {
    const candidate = Number(value);
    const expiresAt = Number.isFinite(candidate) && candidate > Date.now()
        ? Math.floor(candidate)
        : Date.now() + GEN_TASK_TTL_MS;
    if (genTask.taskId === taskId) {
        genTask.taskExpiresAt = expiresAt;
        persistGenTaskNow();
    }
    return expiresAt;
}

async function renewClientTask(taskId: string, signal: AbortSignal): Promise<number> {
    const response = await fetchWithByokFallback("/api/generate/task", {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ taskId }),
        signal,
    });
    await rejectAccessResponse(response);
    if (!response.ok) {
        const apiError = await readApiError(response, "任务状态续期失败");
        const error = response.status === 404
            ? noRetry(apiError.message || TASK_UNAVAILABLE_MESSAGE, {
                code: apiError.code || "TASK_NOT_FOUND",
                status: response.status,
            })
            : new Error(apiError.message);
        (error as any).code = apiError.code || (response.status === 404 ? "TASK_NOT_FOUND" : "");
        (error as any).status = response.status;
        if (response.status === 404) (error as any).terminal = true;
        throw error;
    }
    const result = await response.json().catch(() => ({})) as { expiresAt?: unknown };
    return applyTaskExpiration(taskId, result.expiresAt);
}

function scheduleTaskKeepalive(taskId: string, runId: number, delayMs = TASK_KEEPALIVE_INTERVAL_MS) {
    stopTaskKeepalive();
    taskKeepaliveTimer = setTimeout(async () => {
        taskKeepaliveTimer = undefined;
        if (runId !== generationRunId
            || taskId !== genTask.taskId
            || !isGeneratingPhase(genTask.phase)
            || !generationAbort
            || generationAbort.signal.aborted) return;
        try {
            await renewClientTask(taskId, generationAbort.signal);
            if (runId === generationRunId && taskId === genTask.taskId) {
                scheduleTaskKeepalive(taskId, runId);
            }
        } catch (error: any) {
            if (runId !== generationRunId || taskId !== genTask.taskId || isInterrupt(error)) return;
            if (isTaskUnavailableError(error)) {
                generationAbort?.abort(new DOMException("Task expired", "AbortError"));
                generationRunId++;
                setGenerateError(error, "warning");
                appendGenLog(`× ${genTask.error}`);
                persistGenTaskNow();
                return;
            }
            scheduleTaskKeepalive(taskId, runId, TASK_KEEPALIVE_RETRY_MS);
        }
    }, delayMs);
}

async function ensureTaskAlive(taskId: string, runId: number): Promise<void> {
    await renewClientTask(taskId, generationSignal());
    assertGenerationRun(runId);
    scheduleTaskKeepalive(taskId, runId);
}

function setPhase(phase: GenPhase, log?: string) {
    genTask.phase = phase;
    if (phase !== "interrupted") genTask.interruptedFrom = "";
    let preflightStage: PreflightStage | "" = "";
    if (phase === "clarifying" || phase === "awaiting_input") preflightStage = "clarify";
    else if (phase === "tree_planning" || phase === "tree_confirming") preflightStage = "tree";
    if (preflightStage) {
        if (genTask.preflightStage !== preflightStage) {
            genTask.preflightThinking = "";
            genTask.preflightOutput = "";
        }
        genTask.preflightStage = preflightStage;
    }
    if (log) appendGenLog(log);
}

function isGeneratingPhase(phase: GenPhase) {
    return ["creating", "clarifying", "tree_planning", "tree_confirming", "awaiting_input", "generating", "verifying", "uploading", "building", "fixing"].includes(phase);
}

async function post(url: string, body: any, maxRetries = 3) {
    const signal = generationSignal();
    if (url === "/api/generate/build") return withToolActivity({ kind: "build", title: "启动编译", detail: "提交构建请求，等待服务端确认", context: genTask.projectName, signal },
        () => postRequest(url, body, maxRetries), result => `构建请求已确认 · ${result?.runId ? `Run #${result.runId}` : "等待构建结果"}`);
    if (url === "/api/generate/tree" && body.action === "confirm") return withToolActivity({ kind: "tree", title: "确认项目结构", detail: "锁定结构版本，准备生成实现文件", context: genTask.projectName, signal },
        () => postRequest(url, body, maxRetries), () => "结构已锁定，进入文件生成");
    if (url === "/api/generate/task" && body.skillIds?.length) {
        const activity = beginToolActivity({ kind: "skill", title: "装载 Skill 上下文", detail: "为任务载入所选 Skill 的能力说明", context: `${body.skillIds.length} 个 Skill`, signal });
        try {
            const result = await postRequest(url, body, maxRetries);
            const count = Number(result?.skillsLoaded) || 0;
            activity.finish(count === body.skillIds.length ? "success" : "notice", `已装载 ${count}/${body.skillIds.length} 个 Skill`);
            return result;
        } catch (error) { activity.fail(error); throw error; }
    }
    return postRequest(url, body, maxRetries);
}

async function postRequest(url: string, body: any, maxRetries = 3) {
    const signal = generationSignal();
    const runId = generationRunId;
    for (let attempt = 0; attempt <= maxRetries; attempt++) {
        try {
            const resp = await fetchWithByokFallback(url, {
                method: "POST",
                headers: { "Content-Type": "application/json" },
                body: JSON.stringify(body),
                signal,
            });
            assertGenerationRun(runId);
            await rejectAccessResponse(resp);
            if (!resp.ok) {
                const apiError = await readApiError(resp);
                if (apiError.code === "POM_BLOCKED") {
                    throw noRetry(`pom.xml 安全校验未通过：${apiError.message}`, {
                        code: apiError.code,
                        status: resp.status,
                    });
                }
                if (apiError.code === "BUILD_START_FAILED") {
                    throw noRetry(apiError.message, {code: apiError.code, status: resp.status});
                }
                if (["PATH_REVIEW_REQUIRED", "TREE_REVISION_MISMATCH", "TREE_INVALID", "TREE_NOT_READY", "TREE_SETTLEMENT_PENDING"].includes(apiError.code || "")) {
                    throw noRetry(apiError.message, {code: apiError.code, status: resp.status});
                }
                if (resp.status === 400
                    || resp.status === 404
                    || resp.status === 429
                    || apiError.code === "TASK_STORE_MIGRATION_REQUIRED") {
                    throw noRetry(apiError.message, {code: apiError.code, status: resp.status});
                }
                throw Object.assign(new Error(apiError.message), { code: apiError.code, status: resp.status });
            }
            const result = await resp.json() as any;
            assertGenerationRun(runId);
            return result;
        } catch (e: any) {
            if (isInterrupt(e) || signal.aborted || runId !== generationRunId) throw generationAbortError();
            if (e?.noRetry || attempt >= maxRetries) throw e;
            const delay = 2000 * Math.pow(2, attempt);
            appendGenLog(`! 请求失败，${delay / 1000}s 后重试 (${attempt + 1}/${maxRetries})...`);
            await waitWithAbort(delay, signal);
        }
    }
}

function createClarifyRequestId(): string { return `clarify_${crypto.randomUUID().replace(/-/g, "")}`; }
function createBuildRequestId(): string { return `build_${crypto.randomUUID().replace(/-/g, "")}`; }

async function get(url: string) {
    if (!/^\/api\/generate\/(status|tree)\?/.test(url)) return getRequest(url);
    const activity = beginToolActivity({ kind: "refresh", title: "刷新任务状态", detail: "同步服务端的最新进度", context: genTask.projectName,
        signal: generationSignal(), refreshKey: url.split("?")[0] });
    try {
        const result = await getRequest(url);
        const failed = result.status === "error";
        activity.finish(failed ? "error" : "success", failed ? "状态已同步 · 构建未通过"
            : result.status === "done" ? "构建已通过，产物已就绪"
            : result.tree ? "项目结构状态已同步" : `状态已同步 · ${result.runStatus || result.status || "等待更新"}`);
        return result;
    } catch (error) { activity.fail(error); throw error; }
}

async function getRequest(url: string) {
    const signal = generationSignal();
    const runId = generationRunId;
    const resp = await fetchWithByokFallback(url, { signal });
    assertGenerationRun(runId);
    await rejectAccessResponse(resp);
    if (!resp.ok) throw await responseError(resp);
    const result = await resp.json() as any;
    assertGenerationRun(runId);
    return result;
}

const LEARNING_TERMINAL = new Set<LearningStatus>([
    "ready", "deferred", "needs_review", "failed", "cancelled",
]);

const LEARNING_JOB_BUDGET_MS = 300_000;
const LEARNING_FINAL_RECONCILE_MS = 12_000;
const LEARNING_REQUEST_LIMIT_MS = 126_000;
const LEARNING_FINALIZE_REQUEST_MS = 1_500;
const LEARNING_STATUS_REQUEST_MS = 2_500;
const LEARNING_STEP_INTERVAL_MS = 250;
const LEARNING_START_BACKOFF_MS = [1_000, 2_000, 4_000] as const;
const LEARNING_LEASE_BACKOFF_MS = [1_000, 2_000, 4_000] as const;
const LEARNING_RATE_BACKOFF_MS = [2_000, 4_000, 8_000] as const;
const LEARNING_STATUS_BACKOFF_MS = [750, 1_500] as const;

type LearningEndpoint = "start" | "step" | "status";
type LearningConflictReason = "revision" | "lease";

type LearningCallResult = {
    snapshot: any;
    httpStatus: number;
    debugMeta?: LearningDebugMeta;
    conflictReason?: LearningConflictReason;
    retryAfterMs?: number;
};

let learningActivity: ToolActivityHandle | undefined;
function applyLearningSnapshot(snapshot: any) {
    if (snapshot?.learningProgress) {
        const receivedAt = Date.now();
        const progress = normalizeLearningProgress(snapshot.learningProgress);
        if (progress.remainingMs !== undefined) {
            const serverBudgetMs = progress.startedAt !== undefined && progress.deadlineAt !== undefined
                ? Math.max(1, Math.min(LEARNING_JOB_BUDGET_MS, progress.deadlineAt - progress.startedAt))
                : LEARNING_JOB_BUDGET_MS;
            progress.deadlineAt = receivedAt + progress.remainingMs;
            progress.startedAt = progress.deadlineAt - serverBudgetMs;
        }
        genTask.learningProgress = progress;
        learningActivity?.update(progress.currentNeed || progress.message || "检索并验证公共 API", `${progress.completedNeeds}/${progress.totalNeeds} 项查证 · ${progress.sourceCount} 条证据`);
    }
    if (Array.isArray(snapshot?.knowledgeUsed)) {
        for (const item of snapshot.knowledgeUsed) {
            if (!item?.knowledgeId) continue;
            const index = genTask.knowledgeUsed.findIndex(existing => existing.knowledgeId === item.knowledgeId);
            if (index >= 0) genTask.knowledgeUsed[index] = item;
            else genTask.knowledgeUsed.push(item);
        }
    }
    if (Array.isArray(snapshot?.negativeFactsUsed)) {
        genTask.negativeFactsUsed = snapshot.negativeFactsUsed.filter((item: any) => item
            && typeof item.factId === "string" && typeof item.symbol === "string"
            && typeof item.dependencyIdentity === "string" && ["verified", "cache"].includes(item.source)).slice(0, 64);
    }
    if (typeof snapshot?.learningDeferred === "boolean") genTask.learningDeferred = snapshot.learningDeferred;
}

function learningRetryAfterMs(response: Response): number | undefined {
    const raw = response.headers.get("Retry-After")?.trim();
    if (!raw) return undefined;
    const seconds = Number(raw);
    const delay = Number.isFinite(seconds)
        ? seconds * 1_000
        : Date.parse(raw) - Date.now();
    return Number.isFinite(delay) && delay >= 0
        ? Math.max(250, Math.min(8_000, Math.floor(delay)))
        : undefined;
}

function learningScheduledDelay(schedule: readonly number[], attempt: number): number {
    return schedule[Math.min(Math.max(0, attempt), schedule.length - 1)] ?? 0;
}

async function waitForLearningDelay(deadline: number, delayMs: number): Promise<boolean> {
    const remainingMs = deadline - Date.now();
    if (remainingMs <= 0) return false;
    await waitWithAbort(Math.max(1, Math.min(delayMs, remainingMs)), generationSignal());
    return Date.now() < deadline;
}

function learningAbortError(reasonCode: "client_deadline" | "client_network"): Error {
    const error = new Error("learning deadline");
    error.name = "AbortError";
    (error as any).learningFailureReason = reasonCode;
    return error;
}

function learningFailure(error: any): {
    reasonCode: LearningReasonCode;
    retryable: boolean;
} {
    if (error?.noRetry === true) {
        return { reasonCode: "internal_error", retryable: false };
    }
    const markedReason = error?.learningFailureReason;
    if (markedReason === "client_deadline" || markedReason === "client_network") {
        return { reasonCode: markedReason, retryable: markedReason === "client_network" };
    }
    if (error?.name === "AbortError") {
        return { reasonCode: "client_deadline", retryable: false };
    }
    if (error?.learningHttpRecorded === true) {
        return { reasonCode: "internal_error", retryable: error?.learningRetryable !== false };
    }
    return { reasonCode: "client_network", retryable: true };
}

async function learningRequest(input: {
    stage: LearningStage;
    endpoint: LearningEndpoint;
    url: string;
    method: "GET" | "POST";
    body?: any;
    signal: AbortSignal;
    abortReason: "client_deadline" | "client_network";
    attempt: number;
}): Promise<LearningCallResult> {
    const startedAt = Date.now();
    const fromStatus = genTask.learningProgress.status;
    let httpEventRecorded = false;
    const requestRevision = Number.isInteger(Number(input.body?.revision))
        ? Number(input.body.revision)
        : undefined;
    try {
        const resp = await fetchWithByokFallback(input.url, {
            method: input.method,
            headers: input.method === "POST" ? { "Content-Type": "application/json" } : undefined,
            body: input.method === "POST" ? JSON.stringify(input.body ?? {}) : undefined,
            signal: input.signal,
        });
        await rejectAccessResponse(resp);
        let payload: any;
        try {
            payload = await resp.json();
        } catch (error: any) {
            if (error?.name !== "SyntaxError") throw error;
            recordLearningDebugEvent({
                kind: "http",
                stage: input.stage,
                endpoint: input.endpoint,
                attempt: input.attempt,
                httpStatus: resp.status,
                elapsedMs: Date.now() - startedAt,
                jobId: input.body?.jobId || genTask.learningProgress.jobId,
                requestRevision,
                fromStatus,
                toStatus: genTask.learningProgress.status,
                reasonCode: "internal_error",
            });
            httpEventRecorded = true;
            const message = `联网查证响应格式无效（HTTP ${resp.status}）`;
            if (resp.status >= 400 && resp.status < 500 && resp.status !== 408 && resp.status !== 429) {
                throw noRetry(message, {code: "LEARNING_INVALID_RESPONSE", status: resp.status});
            }
            const invalidResponse = new Error(message);
            (invalidResponse as any).learningRetryable = true;
            throw invalidResponse;
        }
        const debugMeta = normalizeLearningDebugMeta(payload?.debugMeta);
        const progress = payload?.learningProgress;
        const reasonCode = typeof progress?.reasonCode === "string"
            ? progress.reasonCode as LearningReasonCode
            : undefined;
        const conflictReason = payload?.conflictReason === "revision" || payload?.conflictReason === "lease"
            ? payload.conflictReason as LearningConflictReason
            : undefined;
        recordLearningDebugEvent({
            kind: resp.status === 409 ? "conflict" : "http",
            stage: input.stage,
            endpoint: input.endpoint,
            attempt: input.attempt,
            httpStatus: resp.status,
            elapsedMs: Date.now() - startedAt,
            jobId: debugMeta?.jobId || progress?.jobId || input.body?.jobId,
            requestRevision,
            responseRevision: Number.isInteger(Number(progress?.revision))
                ? Number(progress.revision)
                : undefined,
            fromStatus,
            toStatus: progress?.status,
            reasonCode,
            conflictReason,
            telemetry: debugMeta?.telemetry,
        });
        httpEventRecorded = true;
        if (!progress && resp.status !== 429) {
            const message = resp.ok
                ? "联网查证响应缺少状态"
                : `联网查证请求失败（HTTP ${resp.status}）`;
            if (resp.status >= 400 && resp.status < 500 && resp.status !== 408) {
                const deterministicError = noRetry(message, {
                    code: typeof payload?.code === "string" ? payload.code : "LEARNING_REQUEST_FAILED",
                    status: resp.status,
                });
                (deterministicError as any).learningHttpStatus = resp.status;
                throw deterministicError;
            }
            const responseError = new Error(message);
            (responseError as any).learningRetryable = true;
            throw responseError;
        }
        return {
            snapshot: payload,
            httpStatus: resp.status,
            debugMeta,
            conflictReason,
            retryAfterMs: resp.status === 429 ? learningRetryAfterMs(resp) : undefined,
        };
    } catch (error: any) {
        if (generationAbort?.signal.aborted) throw generationAbortError();
        if (httpEventRecorded && error && typeof error === "object") {
            error.learningHttpRecorded = true;
            error.learningEventRecorded = true;
        }
        if (!httpEventRecorded) {
            const timedOut = error?.name === "AbortError" || input.signal.aborted;
            const failureReason = timedOut ? input.abortReason : "client_network";
            recordLearningDebugEvent({
                kind: "client",
                stage: input.stage,
                endpoint: input.endpoint,
                attempt: input.attempt,
                httpStatus: 0,
                elapsedMs: Date.now() - startedAt,
                jobId: input.body?.jobId || genTask.learningProgress.jobId,
                requestRevision,
                fromStatus,
                toStatus: genTask.learningProgress.status,
                reasonCode: failureReason,
            });
            if (error && typeof error === "object") {
                error.learningFailureReason = failureReason;
                error.learningEventRecorded = true;
            }
        }
        throw error;
    }
}

async function learningRequestBefore(input: {
    stage: LearningStage;
    endpoint: LearningEndpoint;
    url: string;
    method: "GET" | "POST";
    body?: any;
    deadline: number;
    deadlineReason?: "client_deadline" | "client_network";
    attempt: number;
    maxWaitMs?: number;
}): Promise<LearningCallResult> {
    const remainingMs = input.deadline - Date.now();
    const deadlineReason = input.deadlineReason ?? "client_deadline";
    if (remainingMs <= 0) throw learningAbortError(deadlineReason);
    const requestLimitMs = Math.max(1, Math.min(
        LEARNING_REQUEST_LIMIT_MS,
        input.maxWaitMs ?? LEARNING_REQUEST_LIMIT_MS,
    ));
    const reachesDeadline = requestLimitMs >= remainingMs;
    const timeoutMs = Math.max(1, Math.min(remainingMs, requestLimitMs));
    const abortReason = reachesDeadline ? deadlineReason : "client_network";
    const ctrl = new AbortController();
    const unlinkRootAbort = linkGenerationAbort(ctrl);
    const timer = setTimeout(() => ctrl.abort(), timeoutMs);
    try {
        return await learningRequest({ ...input, signal: ctrl.signal, abortReason });
    } finally {
        clearTimeout(timer);
        unlinkRootAbort();
    }
}

interface FixRepairAuthorization {
    runId: number;
    diagnosticsFingerprint: string;
    repairAttempts: number;
}

function boundedLearningLogText(value: unknown, max = 600): string {
    return typeof value === "string"
        ? value.replace(/[\x00-\x1f]+/g, " ").replace(/\s+/g, " ").trim().slice(0, max)
        : "";
}

function learningDiagnosticUrl(value: unknown): string {
    const raw = boundedLearningLogText(value, 2_000);
    if (!raw) return "";
    try {
        const url = new URL(raw);
        return url.protocol === "https:" && !url.username && !url.password ? url.href : "";
    } catch {
        return "";
    }
}

function learningDiagnosticMeta(value: any): string {
    const values = [
        Number.isFinite(Number(value?.httpStatus)) ? `HTTP ${Math.max(0, Math.floor(Number(value.httpStatus)))}` : "",
        boundedLearningLogText(value?.contentType, 120),
        Number.isFinite(Number(value?.byteCount)) ? `${Math.max(0, Math.floor(Number(value.byteCount)))} B` : "",
        Number.isFinite(Number(value?.elapsedMs)) ? `${Math.max(0, Math.floor(Number(value.elapsedMs)))} ms` : "",
    ].filter(Boolean);
    return values.length ? ` | ${values.join(" | ")}` : "";
}

async function appendLearningTerminalDiagnostics(stage: LearningStage): Promise<void> {
    const progress = genTask.learningProgress;
    if (!genTask.taskId || !progress.jobId || progress.stage !== stage) return;
    const identity = {
        taskId: genTask.taskId,
        jobId: progress.jobId,
        revision: progress.revision,
    };
    const identityStillCurrent = () => {
        const current = genTask.learningProgress;
        return genTask.taskId === identity.taskId
            && current.jobId === identity.jobId
            && current.stage === stage
            && current.revision === identity.revision;
    };
    const marker = `Learning 详细诊断 ${progress.jobId}@${progress.revision}`;
    if (genTask.logs.some((line) => line.includes(`▸ ${marker} | status=`))) return;
    try {
        const params = new URLSearchParams({
            taskId: identity.taskId,
            jobId: identity.jobId,
            stage,
            revision: String(identity.revision),
        });
        const response = await fetchWithByokFallback(`/api/learning/evidence?${params.toString()}`);
        await rejectAccessResponse(response);
        if (!identityStillCurrent()) return;
        if (!response.ok) {
            appendGenLog(`! ${marker}读取失败 | HTTP ${response.status}`);
            return;
        }
        const payload = await response.json() as any;
        if (!identityStillCurrent()) return;
        appendGenLog(`▸ ${marker} | status=${progress.status}${progress.reasonCode ? ` | reason=${progress.reasonCode}` : ""}`);
        for (const event of (Array.isArray(payload?.diagnostics) ? payload.diagnostics : []).slice(-40)) {
            const stageLabel = boundedLearningLogText(event?.stage, 30) || "unknown";
            const code = boundedLearningLogText(event?.code, 100) || "unknown";
            const message = boundedLearningLogText(event?.message, 600);
            const query = boundedLearningLogText(event?.query, 500);
            const url = learningDiagnosticUrl(event?.url);
            appendGenLog(`· Learning [${stageLabel}/${code}] ${message || "无说明"}${query ? ` | query=${query}` : ""}${url ? ` | ${url}` : ""}${learningDiagnosticMeta(event)}`);
        }
        for (const source of (Array.isArray(payload?.searchedSources) ? payload.searchedSources : []).slice(0, 20)) {
            const url = learningDiagnosticUrl(source?.canonicalUrl || source?.url);
            const status = boundedLearningLogText(source?.status, 30) || "unknown";
            const code = boundedLearningLogText(source?.detailCode || source?.rejectionCode, 100);
            appendGenLog(`· Learning URL [${status}${code ? `/${code}` : ""}] ${url || "URL 未通过公开展示校验"}${learningDiagnosticMeta(source)}`);
        }
    } catch (error: any) {
        appendGenLog(`! ${marker}读取失败 | ${boundedLearningLogText(error?.message, 240) || "client_error"}`);
    }
}

function normalizeFixRepairAuthorization(value: any): FixRepairAuthorization | null {
    const runId = Number(value?.runId);
    const repairAttempts = Number(value?.repairAttempts);
    const diagnosticsFingerprint = typeof value?.diagnosticsFingerprint === "string"
        ? value.diagnosticsFingerprint.trim().toLowerCase()
        : "";
    if (!Number.isInteger(runId)
        || runId <= 0
        || !Number.isInteger(repairAttempts)
        || repairAttempts < 0
        || !/^[a-f0-9]{8,128}$/.test(diagnosticsFingerprint)) return null;
    return { runId, diagnosticsFingerprint, repairAttempts };
}

async function runLearning(
    toolRequestId: string,
    options?: { resumeExisting?: boolean; continuation?: LearningContinuationDeadline },
): Promise<void> {
    const activity = beginToolActivity({ kind: "learning", title: "Learning 公共 API 查证", detail: "检索来源并验证当前技术缺口", signal: generationSignal() });
    const previous = learningActivity;
    learningActivity = activity;
    try {
        await runLearningRequest(toolRequestId, options);
        const progress = genTask.learningProgress;
        activity.finish(progress.status === "ready" ? "success" : progress.status === "failed" ? "error" : progress.status === "cancelled" ? "cancelled" : "notice",
            progress.status === "ready" ? `查证完成 · ${progress.sourceCount} 条证据`
            : progress.message || (progress.status === "needs_review" ? "查证结果等待审核" : "查证已降级，继续生成"));
    } catch (error) { activity.fail(error); throw error; }
    finally { learningActivity = previous; }
}

async function runLearningRequest(
    toolRequestId: string,
    options?: {
        resumeExisting?: boolean;
        continuation?: LearningContinuationDeadline;
    },
): Promise<void> {
    generationSignal();
    const generationId = generationRunId;
    const assertActive = () => {
        assertGenerationRun(generationId);
        options?.continuation?.assertActive();
    };
    const stage: LearningStage = "tool";
    const startedAt = Date.now();
    let jobDeadline = Math.min(
        startedAt + LEARNING_JOB_BUDGET_MS,
        options?.continuation?.deadlineAt ?? Number.POSITIVE_INFINITY,
    );
    let lastMessage = "";
    let lastEndpoint: LearningEndpoint = "start";
    let lastFailureReason: LearningReasonCode = "client_network";
    let lastFailureHttpStatus = 0;
    let stopRetrying = false;
    let statusAttempt = 0;
    let stepAttempt = 0;
    const restoredProgress = genTask.learningProgress;
    const resumeRequested = options?.resumeExisting === true
        && restoredProgress.stage === stage;
    const unconfirmedLocalLearning = isUnconfirmedLearningProgress(restoredProgress);
    if (resumeRequested
        && LEARNING_TERMINAL.has(restoredProgress.status)
        && !unconfirmedLocalLearning) {
        await appendLearningTerminalDiagnostics(stage);
        return;
    }
    const canResumeExactJob = shouldResumeLearningProgress(
        restoredProgress,
        stage,
        options?.resumeExisting === true,
    );
    let jobId = canResumeExactJob ? restoredProgress.jobId : "";

    assertActive();
    genTask.learningDeferred = false;
    if (canResumeExactJob) {
        genTask.learningProgress = normalizeLearningProgress({
            ...restoredProgress,
            status: unconfirmedLocalLearning ? "queued" : restoredProgress.status,
            startedAt: undefined,
            deadlineAt: undefined,
            remainingMs: undefined,
            reasonCode: unconfirmedLocalLearning ? undefined : restoredProgress.reasonCode,
            message: "正在恢复联网查证状态",
        });
    } else {
        const remainingMs = Math.max(1, jobDeadline - startedAt);
        genTask.learningProgress = normalizeLearningProgress({
            jobId: "",
            status: "queued",
            revision: 0,
            stage,
            startedAt,
            deadlineAt: jobDeadline,
            remainingMs,
            totalNeeds: 0,
            completedNeeds: 0,
            sourceCount: 0,
            searchedSourceCount: 0,
            message: "准备查证公开技术资料",
        });
    }
    persistGenTaskNow();

    const outboundDeadline = () => jobDeadline - LEARNING_FINAL_RECONCILE_MS;
    const isTerminal = () => LEARNING_TERMINAL.has(genTask.learningProgress.status);
    const rememberFailure = (error: any): boolean => {
        assertActive();
        const failure = learningFailure(error);
        lastFailureReason = failure.reasonCode;
        lastFailureHttpStatus = Number(error?.learningHttpStatus) || 0;
        if (!failure.retryable) stopRetrying = true;
        if (error?.terminal === true) throw error;
        return failure.retryable;
    };
    const announce = (snapshot: any) => {
        assertActive();
        applyLearningSnapshot(snapshot);
        const deadlineAt = genTask.learningProgress.deadlineAt;
        const remainingMs = genTask.learningProgress.remainingMs;
        if (deadlineAt !== undefined) {
            jobDeadline = Math.min(
                deadlineAt,
                options?.continuation?.deadlineAt ?? Number.POSITIVE_INFINITY,
            );
        } else if (remainingMs !== undefined) {
            jobDeadline = Math.min(
                Date.now() + remainingMs,
                options?.continuation?.deadlineAt ?? Number.POSITIVE_INFINITY,
            );
        }
        if (options?.continuation) {
            genTask.learningProgress.deadlineAt = jobDeadline;
            genTask.learningProgress.remainingMs = Math.max(0, jobDeadline - Date.now());
        }
        const message = genTask.learningProgress.message;
        if (message && message !== lastMessage) {
            appendGenLog(`▸ ${message}`);
            lastMessage = message;
        }
    };
    const statusUrl = (exactJobId: string) => {
        const params = new URLSearchParams({ taskId: genTask.taskId, stage, jobId: exactJobId });
        return `/api/learning/status?${params.toString()}`;
    };
    const reconcile = async (
        exactJobId: string,
        maxAttempts: number,
        deadline = jobDeadline,
    ): Promise<{ snapshot: any | null; confirmed: boolean }> => {
        let latest: any = null;
        let confirmed = false;
        for (let index = 0; index < maxAttempts && Date.now() < deadline && !stopRetrying; index++) {
            try {
                lastEndpoint = "status";
                const result = await learningRequestBefore({
                    stage,
                    endpoint: "status",
                    url: statusUrl(exactJobId),
                    method: "GET",
                    deadline,
                    deadlineReason: deadline < jobDeadline ? "client_network" : "client_deadline",
                    maxWaitMs: LEARNING_STATUS_REQUEST_MS,
                    attempt: ++statusAttempt,
                });
                if (result.snapshot?.learningProgress) {
                    latest = result.snapshot;
                    confirmed = true;
                    announce(latest);
                    if (isTerminal()) return { snapshot: latest, confirmed };
                }
                if (result.httpStatus === 429) {
                    const delayMs = result.retryAfterMs
                        ?? learningScheduledDelay(LEARNING_RATE_BACKOFF_MS, index);
                    if (!await waitForLearningDelay(deadline, delayMs)) break;
                    continue;
                }
            } catch (error: any) {
                if (!rememberFailure(error)) break;
            }
            if (index < maxAttempts - 1) {
                const delayMs = learningScheduledDelay(LEARNING_STATUS_BACKOFF_MS, index);
                if (!await waitForLearningDelay(deadline, delayMs)) break;
            }
        }
        return { snapshot: latest, confirmed };
    };
    const markClientDeferred = (reasonCode: LearningReasonCode) => {
        assertActive();
        const message = reasonCode === "client_network"
            ? "浏览器暂时无法确认联网查证状态，已按现有知识继续"
            : reasonCode === "client_deadline"
                ? "连续 5 分钟没有可确认的联网查证进展，已按现有知识继续"
                : "联网学习未完成，已按现有知识继续";
        const fromStatus = genTask.learningProgress.status;
        const lastActiveStatus = fromStatus === "queued" || fromStatus === "discovering"
            || fromStatus === "fetching" || fromStatus === "verifying"
            ? fromStatus
            : genTask.learningProgress.lastActiveStatus;
        genTask.learningDeferred = true;
        genTask.learningProgress = normalizeLearningProgress({
            ...genTask.learningProgress,
            status: "deferred",
            lastActiveStatus,
            reasonCode,
            message,
        });
        recordLearningDebugEvent({
            kind: "transition",
            stage,
            endpoint: lastEndpoint,
            attempt: 0,
            httpStatus: 0,
            elapsedMs: Math.max(0, Date.now() - startedAt),
            jobId: jobId || genTask.learningProgress.jobId,
            responseRevision: genTask.learningProgress.revision,
            fromStatus,
            toStatus: "deferred",
            reasonCode,
        });
        if (message !== lastMessage) {
            appendGenLog(`! ${message}`);
            lastMessage = message;
        }
    };

    if (jobId) {
        await reconcile(jobId, 2);
        if (isTerminal()) {
            await appendLearningTerminalDiagnostics(stage);
            return;
        }
        if (stopRetrying && lastFailureHttpStatus === 404) {
            stopRetrying = false;
            lastFailureHttpStatus = 0;
            lastFailureReason = "client_network";
            jobId = "";
            jobDeadline = Math.min(
                Date.now() + LEARNING_JOB_BUDGET_MS,
                options?.continuation?.deadlineAt ?? Number.POSITIVE_INFINITY,
            );
            genTask.learningProgress = normalizeLearningProgress({
                jobId: "",
                status: "queued",
                revision: 0,
                stage,
                startedAt,
                deadlineAt: jobDeadline,
                remainingMs: Math.max(1, jobDeadline - Date.now()),
                totalNeeds: 0,
                completedNeeds: 0,
                sourceCount: 0,
                searchedSourceCount: 0,
                message: "准备重新确认联网查证任务",
            });
            persistGenTaskNow();
        } else if (stopRetrying) {
            markClientDeferred(lastFailureReason);
            await appendLearningTerminalDiagnostics(stage);
            return;
        }
    }

    let startAttempt = 0;
    while (!jobId && !stopRetrying && Date.now() < outboundDeadline()) {
        const attempt = ++startAttempt;
        try {
            lastEndpoint = "start";
            const result = await learningRequestBefore({
                stage,
                endpoint: "start",
                url: "/api/learning/start",
                method: "POST",
                body: {
                    taskId: genTask.taskId,
                    stage,
                    toolRequestId,
                    remainingMs: Math.max(1, jobDeadline - Date.now()),
                },
                deadline: outboundDeadline(),
                deadlineReason: "client_network",
                maxWaitMs: LEARNING_REQUEST_LIMIT_MS,
                attempt,
            });
            if (result.snapshot?.learningProgress) announce(result.snapshot);
            if (isTerminal()) {
                await appendLearningTerminalDiagnostics(stage);
                return;
            }
            jobId = genTask.learningProgress.jobId;
            if (jobId) break;
            if (result.httpStatus === 429) {
                const delayMs = result.retryAfterMs
                    ?? learningScheduledDelay(LEARNING_RATE_BACKOFF_MS, attempt - 1);
                if (!await waitForLearningDelay(outboundDeadline(), delayMs)) break;
                continue;
            }
            lastFailureReason = "internal_error";
        } catch (error: any) {
            rememberFailure(error);
        }
        if (!stopRetrying) {
            const delayMs = learningScheduledDelay(LEARNING_START_BACKOFF_MS, attempt - 1);
            if (!await waitForLearningDelay(outboundDeadline(), delayMs)) break;
        }
    }

    if (!jobId) {
        markClientDeferred(Date.now() >= jobDeadline ? "client_deadline" : lastFailureReason);
        return;
    }

    let leaseConflictAttempt = 0;
    let rateLimitAttempt = 0;
    let consecutiveUnknownFailures = 0;
    while (!isTerminal() && !stopRetrying && Date.now() < outboundDeadline()) {
        try {
            lastEndpoint = "step";
            const result = await learningRequestBefore({
                stage,
                endpoint: "step",
                url: "/api/learning/step",
                method: "POST",
                body: {
                    taskId: genTask.taskId,
                    jobId,
                    revision: genTask.learningProgress.revision,
                },
                deadline: outboundDeadline(),
                deadlineReason: "client_network",
                maxWaitMs: LEARNING_REQUEST_LIMIT_MS,
                attempt: ++stepAttempt,
            });
            if (result.snapshot?.learningProgress) announce(result.snapshot);
            if (isTerminal()) break;

            consecutiveUnknownFailures = 0;
            if (result.httpStatus === 409) {
                rateLimitAttempt = 0;
                if (result.conflictReason === "lease") {
                    const delayMs = learningScheduledDelay(
                        LEARNING_LEASE_BACKOFF_MS,
                        leaseConflictAttempt++,
                    );
                    if (!await waitForLearningDelay(outboundDeadline(), delayMs)) break;
                } else {
                    leaseConflictAttempt = 0;
                }
                continue;
            }
            if (result.httpStatus === 429) {
                leaseConflictAttempt = 0;
                const delayMs = result.retryAfterMs
                    ?? learningScheduledDelay(LEARNING_RATE_BACKOFF_MS, rateLimitAttempt++);
                if (!await waitForLearningDelay(outboundDeadline(), delayMs)) break;
                continue;
            }

            leaseConflictAttempt = 0;
            rateLimitAttempt = 0;
            if (!await waitForLearningDelay(outboundDeadline(), LEARNING_STEP_INTERVAL_MS)) break;
        } catch (error: any) {
            if (!rememberFailure(error)) break;
            const reconciled = await reconcile(jobId, 1, outboundDeadline());
            if (isTerminal() || stopRetrying) break;
            if (reconciled.confirmed) {
                consecutiveUnknownFailures = 0;
                if (!await waitForLearningDelay(outboundDeadline(), LEARNING_STEP_INTERVAL_MS)) break;
                continue;
            }
            consecutiveUnknownFailures = Math.min(1_000, consecutiveUnknownFailures + 1);
            const delayMs = learningScheduledDelay(
                LEARNING_START_BACKOFF_MS,
                consecutiveUnknownFailures - 1,
            );
            if (!await waitForLearningDelay(outboundDeadline(), delayMs)) break;
        }
    }

    if (isTerminal()) {
        await appendLearningTerminalDiagnostics(stage);
        return;
    }
    if (stopRetrying) {
        markClientDeferred(lastFailureReason);
        await appendLearningTerminalDiagnostics(stage);
        return;
    }

    let finalAttempt = 0;
    const finalDeadline = () => jobDeadline;
    while (!isTerminal() && !stopRetrying && Date.now() < finalDeadline()) {
        let delayMs = LEARNING_STEP_INTERVAL_MS;
        const requestDeadline = finalDeadline();
        try {
            lastEndpoint = "step";
            const result = await learningRequestBefore({
                stage,
                endpoint: "step",
                url: "/api/learning/step",
                method: "POST",
                body: {
                    taskId: genTask.taskId,
                    jobId,
                    revision: genTask.learningProgress.revision,
                },
                deadline: requestDeadline,
                deadlineReason: "client_deadline",
                maxWaitMs: LEARNING_FINALIZE_REQUEST_MS,
                attempt: ++stepAttempt,
            });
            if (result.snapshot?.learningProgress) announce(result.snapshot);
            if (result.httpStatus === 409 && result.conflictReason === "lease") {
                delayMs = learningScheduledDelay(LEARNING_LEASE_BACKOFF_MS, finalAttempt);
            } else if (result.httpStatus === 429) {
                delayMs = result.retryAfterMs
                    ?? learningScheduledDelay(LEARNING_RATE_BACKOFF_MS, finalAttempt);
            }
        } catch (error: any) {
            if (!rememberFailure(error)) break;
            delayMs = learningScheduledDelay(LEARNING_STATUS_BACKOFF_MS, finalAttempt);
        }
        if (isTerminal() || stopRetrying) break;

        const reconciled = await reconcile(jobId, 1, finalDeadline());
        if (isTerminal() || stopRetrying) break;
        if (!reconciled.confirmed) {
            delayMs = Math.max(
                delayMs,
                learningScheduledDelay(LEARNING_STATUS_BACKOFF_MS, finalAttempt),
            );
        }
        finalAttempt = Math.min(1_000, finalAttempt + 1);
        if (!await waitForLearningDelay(finalDeadline(), delayMs)) break;
    }

    if (isTerminal()) {
        await appendLearningTerminalDiagnostics(stage);
        return;
    }
    if (!stopRetrying && Date.now() < outboundDeadline()) {
        await runLearning(toolRequestId, {
            ...options,
            resumeExisting: true,
        });
        return;
    }
    markClientDeferred(Date.now() >= jobDeadline ? "client_deadline" : lastFailureReason);
    await appendLearningTerminalDiagnostics(stage);
}

function modelLearningToolRequests(value: unknown): any[] {
    if (!Array.isArray(value) || value.length === 0) return [];
    return value
        .filter((item: any) => item && /^learnreq_[a-f0-9]{32}$/i.test(String(item.requestId || "")))
        .slice(0, 3);
}

async function runModelLearningToolRequests(
    value: unknown,
    jobIds: Record<string, string>,
    continuation?: LearningContinuationDeadline,
): Promise<boolean> {
    const requests = modelLearningToolRequests(value);
    if (!requests.length) return false;

    for (const request of requests) {
        continuation?.assertActive();
        const requestId = String(request.requestId);
        const question = Array.isArray(request.questions)
            ? request.questions.find((item: unknown) => typeof item === "string")
            : "";
        appendGenLog(`▸ ${request.trigger === "compile_diagnostic" ? "首次修复前查证公共 API" : "DS 主动调用 Learning"}${question ? `：${question}` : ""}`);
        await runLearning(requestId, { continuation });
        continuation?.assertActive();
        if (genTask.learningProgress.jobId) {
            jobIds[requestId] = genTask.learningProgress.jobId;
        }
    }
    return true;
}

/** 从流式 JSON 文本中提取 "todos":[...] 数组里已完整闭合的对象 */
function extractCompletedTodos(text: string): any[] {
    const key = "\"todos\"";
    const keyIdx = text.indexOf(key);
    if (keyIdx < 0) return [];
    let i = text.indexOf("[", keyIdx);
    if (i < 0) return [];
    i++;
    const out: any[] = [];
    while (i < text.length) {
        while (i < text.length && /\s|,/.test(text[i])) i++;
        if (i >= text.length || text[i] === "]") break;
        if (text[i] !== "{") { i++; continue; }
        const start = i;
        let depth = 0, inStr = false, esc = false;
        for (; i < text.length; i++) {
            const c = text[i];
            if (esc) { esc = false; continue; }
            if (c === "\\") { esc = true; continue; }
            if (c === "\"") { inStr = !inStr; continue; }
            if (inStr) continue;
            if (c === "{") depth++;
            else if (c === "}") {
                depth--;
                if (depth === 0) { i++; break; }
            }
        }
        if (depth !== 0) break; // 未闭合，等下次
        try {
            out.push(JSON.parse(text.slice(start, i)));
        } catch { /* 忽略解析失败 */ }
    }
    return out;
}

function findFile(path: string) {
    return genTask.files.find(f => f.path === path);
}

function syncCurrentIndex() {
    genTask.currentIndex = genTask.files.filter(f => f.status === "done").length;
}

type PreflightStage = "clarify" | "tree";

function normalizePreflightStage(value: unknown): PreflightStage | "" {
    if (value === "clarify" || value === "clarifying") return "clarify";
    if (value === "tree" || value === "tree_planning" || value === "tree_confirming") return "tree";
    return "";
}

type SSEReadOptions = {
    preflightStage?: PreflightStage;
    requireDone?: boolean;
    runId?: number;
    onActivity?: () => void;
    treeActivity?: ToolActivityHandle;
    onToolEvent?: (event: any) => void;
};

/** Read an SSE stream, dispatch events to genTask, return the result event. */
async function readSSE(resp: Response, opts?: SSEReadOptions): Promise<any> {
    const tracker = createToolActivityStream(generationSignal(), opts?.treeActivity);
    try {
        const result = await readSSEEvents(resp, { ...opts, onToolEvent: event => tracker.event(event) });
        tracker.finish();
        return result;
    } catch (error) { tracker.fail(error); throw error; }
}

async function readSSEEvents(resp: Response, opts?: SSEReadOptions): Promise<any> {
    const runId = opts?.runId ?? generationRunId;
    assertGenerationRun(runId);
    const reader = resp.body!.getReader();
    const decoder = new TextDecoder();
    let buffer = "";
    let result: any = null;
    let streamedTodoCount = 0;
    let receivedDone = false;
    let streamError: any = null;

    const activatePreflight = (rawStage?: unknown) => {
        const stage = normalizePreflightStage(rawStage) || opts?.preflightStage || "";
        if (!stage) return "";
        if (genTask.preflightStage !== stage) {
            genTask.preflightThinking = "";
            genTask.preflightOutput = "";
        }
        genTask.preflightStage = stage;
        genTask.preflightActive = true;
        return stage;
    };

    if (opts?.preflightStage) {
        genTask.preflightStage = opts.preflightStage;
        genTask.preflightThinking = "";
        genTask.preflightOutput = "";
        genTask.preflightActive = true;
    }

    try {
        readLoop: while (true) {
            const { done, value } = await reader.read();
            if (done) break;
            if (value.byteLength > 0) opts?.onActivity?.();
            buffer += decoder.decode(value, { stream: true });
            const lines = buffer.split("\n");
            buffer = lines.pop()!;

            for (const line of lines) {
                const trimmed = line.trim();
                if (!trimmed.startsWith("data:")) continue;
                const payload = trimmed.slice(5).trim();
                if (payload === "[DONE]") {
                    receivedDone = true;
                    break readLoop;
                }

                let evt: any;
                try {
                    evt = JSON.parse(payload);
                } catch {
                    if (opts?.requireDone) throw new Error("流式响应包含无效数据，请重试");
                    continue;
                }
                assertGenerationRun(runId);

                opts?.onToolEvent?.(evt);

                if (evt?.type === "error" || (evt?.type === "result" && evt?.error)) {
                    rejectAccessEvent(evt);
                }

                try {
                    switch (evt.type) {
                        case "tool_call":
                            genTask.treeToolCallCount++;
                            break;
                        case "tree_ops":
                            genTask.treeOpsLog.push(...(evt.results ?? []).map((result: { ok: boolean; summary: string; error?: string }) => result.ok ? result.summary : result.error || result.summary));
                            genTask.treeOpsLog = genTask.treeOpsLog.slice(-100);
                            break;
                        case "tree_patch":
                            if (genTask.tree && evt.node) {
                                const index = genTask.tree.nodes.findIndex(node => node.id === evt.node.id);
                                if (index >= 0) genTask.tree.nodes[index] = evt.node; else genTask.tree.nodes.push(evt.node);
                                if (evt.module && !genTask.tree.modules.some(module => module.id === evt.module.id)) genTask.tree.modules.push(evt.module);
                                genTask.tree.revision++;
                                if (!findFile(evt.node.path)) genTask.files.push({ path: evt.node.path, nodeId: evt.node.id, moduleId: evt.node.moduleId, origin: evt.node.origin, role: evt.node.responsibility, generatorType: evt.node.kind, status: "pending" });
                            }
                            break;
                        case "learning_snapshot":
                            applyLearningSnapshot(evt.snapshot);
                            break;
                        case "phase":
                            if (opts?.preflightStage || evt.stage) activatePreflight(evt.stage || evt.phase);
                            // 桶模式：path 字段表示具体文件；非桶模式：file 字段表示当前文件
                            if (evt.path) {
                                const f = findFile(evt.path);
                                if (f) {
                                    f.streamingPhase = evt.phase;
                                    if (evt.phase === "generating" || evt.phase === "reworking") {
                                        f.streamingContent = "";
                                        f.status = "generating";
                                    }
                                }
                            } else {
                                genTask.streamingPhase = evt.phase;
                                genTask.streamingFile = evt.file || "";
                                genTask.streamingContent = "";
                                streamedTodoCount = 0;
                                if (evt.phase === "clarifying") genTask.clarifyTodos = [];
                                if (evt.round) genTask.clarifyRound = evt.round;
                            }
                            break;
                        case "thinking":
                        case "reasoning": {
                            const content = typeof evt.content === "string" ? evt.content : "";
                            genTask.reasoningContent += content;
                            if (activatePreflight(evt.stage)) genTask.preflightThinking += content;
                            break;
                        }
                        case "output":
                        case "delta": {
                            const content = typeof evt.content === "string" ? evt.content : "";
                            if (evt.path) {
                                const f = findFile(evt.path);
                                if (f) {
                                    f.streamingContent = (f.streamingContent || "") + content;
                                }
                                break;
                            }

                            genTask.streamingContent += content;
                            const stage = activatePreflight(evt.stage);
                            if (stage) genTask.preflightOutput += content;
                            if (stage === "clarify" || genTask.streamingPhase === "clarifying") {
                                const todoSource = stage === "clarify"
                                    ? genTask.preflightOutput
                                    : genTask.streamingContent;
                                const todos = extractCompletedTodos(todoSource);
                                if (todos.length > streamedTodoCount) {
                                    for (let k = streamedTodoCount; k < todos.length; k++) {
                                        genTask.clarifyTodos.push(todos[k]);
                                    }
                                    streamedTodoCount = todos.length;
                                }
                            }
                            break;
                        }
                        case "log":
                            appendGenLog(evt.msg);
                            break;
                        case "error":
                            streamError = evt;
                            appendGenLog(`× ${evt.error || evt.message || "流式阶段出错"}`);
                            break;
                        case "file_done": {
                            if (evt.contractCheck) genTask.nodeChecks[evt.contractCheck.nodeId] = evt.contractCheck;
                            const f = findFile(evt.path);
                            if (f) {
                                f.content = evt.content;
                                f.status = "done";
                                f.streamingPhase = "";
                                f.streamingContent = "";
                                syncCurrentIndex();
                            }
                            break;
                        }
                        case "file_error": {
                            const f = findFile(evt.path);
                            if (f) {
                                f.status = "error";
                                f.streamingPhase = "";
                            }
                            break;
                        }
                        case "new_file":
                            // 动态生成的缺失类：插入或更新
                            {
                                if (evt.contractCheck) genTask.nodeChecks[evt.contractCheck.nodeId] = evt.contractCheck;
                                const existing = findFile(evt.path);
                                if (existing) {
                                    existing.nodeId = evt.nodeId || existing.nodeId;
                                    existing.role = evt.role || existing.role;
                                    existing.content = evt.content;
                                    existing.status = "done";
                                    existing.streamingPhase = "";
                                    existing.streamingContent = "";
                                } else {
                                    genTask.files.push({
                                        path: evt.path, role: evt.role, nodeId: evt.nodeId,
                                        content: evt.content, status: "done",
                                    });
                                }
                                syncCurrentIndex();
                            }
                            break;
                        case "bucket_start":
                            for (const p of evt.paths || []) {
                                const f = findFile(p);
                                if (f && f.status !== "done") f.status = "generating";
                            }
                            break;
                        case "result":
                            if (evt.nodeChecks) Object.assign(genTask.nodeChecks, evt.nodeChecks);
                            if (evt.pathChecks) genTask.pathChecks = evt.pathChecks;
                            if (Array.isArray(evt.changedFiles)) for (const path of evt.changedFiles) {
                                const file = findFile(path);
                                if (file) { delete file.content; file.streamingContent = ""; }
                            }
                            result = evt;
                            break;
                        case "heartbeat":
                            // Transport activity is recorded before parsing the event.
                            break;
                        case "debug":
                            genTask.debugLog.push(evt);
                            if (genTask.debugLog.length > 5000) genTask.debugLog.shift();
                            if (evt.scope === "build-fix" && evt.msg === "fix:diagnostics") {
                                genTask.buildDiagnostics = Array.isArray(evt.diagnostics) ? evt.diagnostics : [];
                                const entry = {
                                    runId: evt.runId,
                                    mode: evt.mode,
                                    fingerprint: evt.fingerprint,
                                    diagnostics: genTask.buildDiagnostics,
                                    progress: evt.progress ?? null,
                                    rolledBackFiles: evt.rolledBackFiles ?? [],
                                };
                                const index = genTask.buildHistory.findIndex(item => item.runId === evt.runId);
                                if (index >= 0) genTask.buildHistory[index] = entry;
                                else genTask.buildHistory.push(entry);
                                if (genTask.buildHistory.length > 6) genTask.buildHistory.shift();
                            }
                            break;
                    }
                } catch (error) {
                    if (opts?.requireDone) throw error;
                }
            }
        }
    } finally {
        try { await reader.cancel(); } catch { /* stream already closed */ }
        try { reader.releaseLock(); } catch { /* lock already released */ }
        if (runId === generationRunId) {
            if (opts?.preflightStage) genTask.preflightActive = false;
            genTask.streamingPhase = "";
            genTask.streamingFile = "";
            genTask.streamingContent = "";
        }
    }

    if (opts?.requireDone && !receivedDone) {
        throw new Error("流式连接提前结束，请重试");
    }
    assertGenerationRun(runId);
    if (!result && streamError) {
        const error = new Error(streamError.error || streamError.message || "流式阶段出错");
        (error as any).code = typeof streamError.code === "string" ? streamError.code : "";
        (error as any).status = Number(streamError.status) || 0;
        (error as any).retryAfter = Number(streamError.retryAfter) || 0;
        (error as any).retryable = streamError.retryable !== false;
        (error as any).terminal = streamError.retryable === false;
        throw error;
    }

    return result;
}

async function streamBucketGeneration(
    taskId: string,
    bucketIndex: number,
    learningToolJobs: Record<string, string> = {},
): Promise<any> {
    const signal = generationSignal();
    const runId = generationRunId;
    const resp = await fetchWithByokFallback("/api/generate/bucket", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
            taskId,
            bucketIndex,
            superConcurrency: superConcurrency.value,
            learningToolJobs,
        }),
        signal,
    });
    assertGenerationRun(runId);
    await rejectAccessResponse(resp);
    if (!resp.ok) throw await responseError(resp);
    return await readSSE(resp, { runId });
}

// 仅按 SSE 传输活动判断连接是否失活；服务端负责上游首块和内容空闲检测。
const PREFLIGHT_TRANSPORT_IDLE_MS = 5_000;
const PREFLIGHT_RETRIES = 3;

class PreflightTimeoutError extends Error {
    readonly code = "PREFLIGHT_TRANSPORT_TIMEOUT";
    readonly retryable = true;

    constructor(label: string) {
        super(`${label}连接长时间未收到数据`);
        this.name = "PreflightTimeoutError";
    }
}

function preflightAbortError(controller: AbortController): Error | null {
    if (!controller.signal.aborted) return null;
    const reason = controller.signal.reason;
    if (reason instanceof PreflightTimeoutError) return reason;
    return generationAbortError();
}

type PreflightRequestConfig = {
    endpoint: string;
    stage: "clarify" | "tree";
    label: string;
    treeActivity?: ToolActivityHandle;
    requestIdField: "clarifyRequestId" | "treeRequestId";
    requestId: string;
    taskId: string;
    payload: Record<string, unknown>;
    inProgressCode: "CLARIFY_IN_PROGRESS" | "TREE_IN_PROGRESS";
    recoveryCode: "CLARIFY_RECOVERY_REQUIRED" | "TREE_RECOVERY_REQUIRED";
    normalizeRequestId: (value: unknown) => string;
    onRecoverRequestId: (requestId: string) => void;
    setController: (controller: AbortController) => void;
    clearController: (controller: AbortController) => void;
};

function waitWithAbort(ms: number, signal: AbortSignal): Promise<void> {
    if (signal.aborted) {
        const error = new Error("interrupted");
        error.name = "AbortError";
        return Promise.reject(error);
    }
    return new Promise((resolve, reject) => {
        let timer: ReturnType<typeof setTimeout>;
        const onAbort = () => {
            clearTimeout(timer);
            const error = new Error("interrupted");
            error.name = "AbortError";
            reject(error);
        };
        timer = setTimeout(() => {
            signal.removeEventListener("abort", onAbort);
            resolve();
        }, ms);
        signal.addEventListener("abort", onAbort, { once: true });
    });
}

function attachApiError(
    message: string,
    details: {
        code?: unknown;
        status?: unknown;
        retryAfter?: unknown;
        activeRequestId?: unknown;
        terminal?: boolean;
    },
): Error {
    const error = new Error(message);
    (error as any).code = typeof details.code === "string" ? details.code : "";
    (error as any).status = Number(details.status) || 0;
    (error as any).retryAfter = Number(details.retryAfter) || 0;
    (error as any).activeRequestId = typeof details.activeRequestId === "string"
        ? details.activeRequestId
        : "";
    (error as any).terminal = details.terminal === true;
    return error;
}

async function streamPreflightRequest(config: PreflightRequestConfig): Promise<any> {
    const rootSignal = generationSignal();
    const runId = generationRunId;
    const leaseLostCode = config.stage === "clarify" ? "CLARIFY_LEASE_LOST" : "TREE_LEASE_LOST";
    let failures = 0;
    let announcedWait = false;
    let requestId = config.requestId;
    let payload: Record<string, unknown> | null = config.payload;

    while (true) {
        const controller = new AbortController();
        const unlinkRootAbort = linkGenerationAbort(controller);
        config.setController(controller);
        let transportIdleTimer: ReturnType<typeof setTimeout> | undefined;

        const clearAttemptTimers = () => {
            if (transportIdleTimer) clearTimeout(transportIdleTimer);
            transportIdleTimer = undefined;
        };
        const abortForTransportIdle = () => {
            if (!controller.signal.aborted) {
                controller.abort(new PreflightTimeoutError(config.label));
            }
        };
        const recordTransportActivity = () => {
            if (controller.signal.aborted) return;
            if (transportIdleTimer) clearTimeout(transportIdleTimer);
            transportIdleTimer = setTimeout(
                abortForTransportIdle,
                PREFLIGHT_TRANSPORT_IDLE_MS,
            );
        };
        const waitForNextAttempt = async (delayMs: number) => {
            clearAttemptTimers();
            await waitWithAbort(delayMs, rootSignal);
        };

        const retry = async (error: any, reason: string) => {
            if (rootSignal.aborted || runId !== generationRunId) throw generationAbortError();
            if (failures >= PREFLIGHT_RETRIES) throw error;
            failures++;
            const delay = 2000 * Math.pow(2, failures - 1);
            appendGenLog(`· ${config.label}${reason}，${delay / 1000}s 后继续对账 (${failures}/${PREFLIGHT_RETRIES})...`);
            await waitForNextAttempt(delay);
        };
        try {
            let response: Response;
            try {
                response = await fetchWithByokFallback(config.endpoint, {
                    method: "POST",
                    headers: { "Content-Type": "application/json" },
                    body: JSON.stringify({
                        taskId: config.taskId,
                        ...(payload || {}),
                        [config.requestIdField]: requestId,
                    }),
                    signal: controller.signal,
                });
                assertGenerationRun(runId);
            } catch (error: any) {
                if (rootSignal.aborted || runId !== generationRunId) throw generationAbortError();
                const abortError = preflightAbortError(controller);
                if (abortError) {
                    if (abortError instanceof PreflightTimeoutError) {
                        await retry(abortError, "连接静默");
                        continue;
                    }
                    throw abortError;
                }
                if (isInterrupt(error)) throw error;
                await retry(error, "连接中断");
                continue;
            }

            await rejectAccessResponse(response);

            if (response.status === 409) {
                const apiError = await readApiError(response, `${config.label}状态冲突`);
                assertGenerationRun(runId);
                if (apiError.code === config.recoveryCode) {
                    const activeRequestId = config.normalizeRequestId(apiError.activeRequestId);
                    if (activeRequestId && (activeRequestId !== requestId || payload !== null)) {
                        requestId = activeRequestId;
                        payload = null;
                        config.onRecoverRequestId(activeRequestId);
                        appendGenLog(`↻ ${config.label}已切换到服务端现有 requestId，继续恢复原操作`);
                        continue;
                    }
                }
                if (apiError.code === config.inProgressCode || apiError.code === "TASK_OPERATION_IN_PROGRESS") {
                    if (!announcedWait) {
                        appendGenLog(`· ${config.label}已在服务端执行，等待现有结果...`);
                        announcedWait = true;
                    }
                    const retrySeconds = Math.max(1, Number(response.headers.get("Retry-After")) || 2);
                    await waitForNextAttempt(retrySeconds * 1000);
                    continue;
                }
                if (apiError.code === leaseLostCode) {
                    const leaseError = attachApiError(apiError.message, {
                        code: apiError.code,
                        status: response.status,
                    });
                    await retry(leaseError, "执行权失效");
                    continue;
                }
                const conflict = attachApiError(apiError.message, {
                    code: apiError.code,
                    status: response.status,
                    activeRequestId: apiError.activeRequestId,
                });
                (conflict as any).noRetry = true;
                throw conflict;
            }

            if (!response.ok) {
                const apiError = await readApiError(response, `${config.label}请求失败`);
                const error = attachApiError(apiError.message, {
                    code: apiError.code,
                    status: response.status,
                    activeRequestId: apiError.activeRequestId,
                });
                if (response.status === 400 || response.status === 404 || response.status === 429
                    || apiError.code.endsWith("_REQUEST_CONFLICT")
                    || apiError.code.endsWith("_RECOVERY_REQUIRED")) {
                    (error as any).noRetry = true;
                    throw error;
                }
                await retry(error, "请求失败");
                continue;
            }

            let result: any;
            recordTransportActivity();
            try {
                result = await readSSE(response, {
                    preflightStage: config.stage,
                    requireDone: true,
                    runId,
                    onActivity: recordTransportActivity,
                    treeActivity: config.treeActivity,
                });
            } catch (error: any) {
                if (rootSignal.aborted || runId !== generationRunId) throw generationAbortError();
                const abortError = preflightAbortError(controller);
                if (abortError) {
                    if (abortError instanceof PreflightTimeoutError) {
                        await retry(abortError, "连接静默");
                        continue;
                    }
                    throw abortError;
                }
                if (isInterrupt(error) || error?.terminal) throw error;
                await retry(error, "连接中断");
                continue;
            }

            if (!result) {
                const error = new Error(`${config.label}流已结束，但未返回结果`);
                await retry(error, "未返回结果");
                continue;
            }
            if (result.error) {
                const code = typeof result.code === "string" ? result.code : "";
                if (code === config.inProgressCode || code === "TASK_OPERATION_IN_PROGRESS") {
                    if (!announcedWait) {
                        appendGenLog(`· ${config.label}已在服务端执行，等待现有结果...`);
                        announcedWait = true;
                    }
                    const retrySeconds = Math.max(1, Number(result.retryAfter) || 2);
                    await waitForNextAttempt(retrySeconds * 1000);
                    continue;
                }
                const error = attachApiError(String(result.error), {
                    code,
                    status: result.status,
                    retryAfter: result.retryAfter,
                    activeRequestId: result.activeRequestId,
                    terminal: result.retryable === false,
                });
                (error as any).retryable = result.retryable !== false;
                const retryableLeaseLoss = code === leaseLostCode && result.retryable !== false;
                if (!retryableLeaseLoss && (((error as any).status >= 400 && (error as any).status < 500)
                    || code.endsWith("_REQUEST_CONFLICT")
                    || code.endsWith("_RECOVERY_REQUIRED"))) {
                    (error as any).noRetry = true;
                    throw error;
                }
                if (result.retryable !== false) {
                    await retry(error, "执行失败");
                    continue;
                }
                throw error;
            }
            return result;
        } catch (error: any) {
            if (rootSignal.aborted || runId !== generationRunId) throw generationAbortError();
            const abortError = preflightAbortError(controller);
            if (abortError instanceof PreflightTimeoutError) {
                await retry(abortError, "连接静默");
                continue;
            }
            if (abortError) throw abortError;
            throw error;
        } finally {
            clearAttemptTimers();
            unlinkRootAbort();
            config.clearController(controller);
        }
    }
}

/** SSE streaming clarify round. Network retries and 409 polling reuse the same semantic request ID. */
async function streamClarify(
    taskId: string,
    clarifyRequestId: string,
    answers?: Record<string, string | string[]>,
    extraPrompt?: string,
): Promise<any> {
    return streamPreflightRequest({
        endpoint: "/api/generate/clarify",
        stage: "clarify",
        label: "澄清",
        requestIdField: "clarifyRequestId",
        requestId: clarifyRequestId,
        taskId,
        payload: { answers, extraPrompt },
        inProgressCode: "CLARIFY_IN_PROGRESS",
        recoveryCode: "CLARIFY_RECOVERY_REQUIRED",
        normalizeRequestId: normalizeClarifyRequestId,
        onRecoverRequestId: requestId => {
            genTask.clarifyRequestId = requestId;
            genTask.clarifyRequestAnswers = null;
            genTask.clarifyRequestExtraPrompt = "";
            persistGenTaskNow();
        },
        setController: controller => { clarifyAbort = controller; },
        clearController: controller => {
            if (clarifyAbort === controller) clarifyAbort = null;
        },
    });
}

/** SSE streaming build fix */
async function streamBuildFix(
    taskId: string,
    mode: "diagnose" | "repair" | "inspect" = "repair",
    repairAuthorization?: FixRepairAuthorization,
    learningToolJobs: Record<string, string> = {},
    learningContinuation?: LearningContinuationDeadline,
    learningToolFailures: Record<string, string> = {},
): Promise<any> {
    const rootSignal = generationSignal();
    const signal = learningContinuation?.signal ?? rootSignal;
    const runId = generationRunId;
    learningContinuation?.assertActive();
    try {
        const resp = await fetchWithByokFallback("/api/generate/fix", {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({
                taskId,
                mode,
                ...(mode === "repair" ? { repairAuthorization } : {}),
                ...(mode === "repair" ? { learningToolJobs } : {}),
                ...(mode === "repair" ? { learningToolFailures } : {}),
            }),
            signal,
        });
        assertGenerationRun(runId);
        learningContinuation?.assertActive();
        await rejectAccessResponse(resp);
        if (!resp.ok) {
            const apiError = await readApiError(resp, "自动修复请求失败");
            const error = new Error(apiError.message);
            (error as any).code = apiError.code;
            throw error;
        }

        const contentType = resp.headers.get("Content-Type") || "";
        if (contentType.includes("application/json")) {
            const result = await resp.json();
            assertGenerationRun(runId);
            learningContinuation?.assertActive();
            return result;
        }

        const result = await readSSE(resp, { runId });
        assertGenerationRun(runId);
        learningContinuation?.assertActive();
        return result;
    } catch (error) {
        if (rootSignal.aborted || runId !== generationRunId) throw generationAbortError();
        learningContinuation?.assertActive();
        throw error;
    }
}

async function repairWithLearningTools(
    taskId: string,
    repairAuthorization: FixRepairAuthorization,
): Promise<any> {
    const learningToolJobs: Record<string, string> = {};
    const learningToolFailures: Record<string, string> = {};
    let learningContinuation: LearningContinuationDeadline | undefined;
    try {
        while (true) {
            learningContinuation?.assertActive();
            const result = await streamBuildFix(
                taskId,
                "repair",
                repairAuthorization,
                learningToolJobs,
                learningContinuation,
                learningToolFailures,
            );
            if (!modelLearningToolRequests(result?.learningToolRequests).length) {
                return result;
            }
            learningContinuation ??= createLearningContinuationDeadline(
                GEN_TASK_TTL_MS,
                "自动修复的 Learning 对话超过任务时限，已停止继续调用工具",
                generationSignal(),
            );
            if (!await runModelLearningToolRequests(
                result?.learningToolRequests,
                learningToolJobs,
                learningContinuation,
            )) {
                return result;
            }
            // A local networking/deadline failure supplies no facts, but may safely release the Fixer.
            const reason = genTask.learningProgress.reasonCode;
            if (genTask.learningProgress.status === "deferred"
                && ["client_deadline", "client_network", "storage_unavailable", "internal_error"].includes(reason)) {
                for (const request of modelLearningToolRequests(result?.learningToolRequests)) {
                    learningToolFailures[String(request.requestId)] = reason;
                }
            }
        }
    } finally {
        learningContinuation?.dispose();
    }
}

async function recoverBuildRepair(taskId: string): Promise<any> {
    const startGraceDeadline = Date.now() + 5_000;
    const statusDeadline = Date.now() + 10 * 60_000;
    while (Date.now() < statusDeadline) {
        let status: any;
        try {
            status = await get(`/api/generate/status?taskId=${taskId}`);
        } catch (error: any) {
            if (isInterrupt(error)) throw error;
            if (error?.noRetry || error?.terminal) throw error;
            if (Date.now() >= statusDeadline) throw error;
            await waitWithAbort(2_000, generationSignal());
            continue;
        }
        if (status.status === "fixed") {
            return { changed: Math.max(0, Number(status.repairChanged) || 0) };
        }
        const repairAuthorization = normalizeFixRepairAuthorization(status.repairAuthorization);
        if (status.status === "repairing") {
            const remainingMs = Math.max(0, Number(status.repairRetryAfterMs) || 0);
            if (remainingMs <= 0) {
                if (!repairAuthorization) {
                    throw new Error("现有自动修复缺少可恢复授权，请重新读取构建诊断");
                }
                return repairWithLearningTools(taskId, repairAuthorization);
            }
            await waitWithAbort(Math.min(2_000, remainingMs), generationSignal());
            continue;
        }
        if (status.status === "error" && status.repairStarted) {
            throw new Error(status.error || "自动修复失败");
        }
        if (status.status === "error" && status.repairPending && repairAuthorization) {
            return repairWithLearningTools(taskId, repairAuthorization);
        }
        if (Date.now() >= startGraceDeadline) {
            const diagnosis = await streamBuildFix(taskId, "diagnose");
            const recoveredAuthorization = normalizeFixRepairAuthorization(diagnosis?.repairAuthorization);
            if (!recoveredAuthorization) {
                throw new Error(diagnosis?.reason || "未能恢复当前构建的修复授权");
            }
            return repairWithLearningTools(taskId, recoveredAuthorization);
        }
        await waitWithAbort(1_000, generationSignal());
    }
    throw new Error("等待自动修复结果超时，请稍后恢复任务状态");
}

function repairedFileCount(result: any): number {
    return Math.max(0, Number(result?.changed ?? result?.fixed ?? 0) || 0);
}

async function resumeFixingStage(taskId: string, stage: FixResumeStage): Promise<void> {
    if (stage === "rebuilding") {
        appendGenLog("↻ 页面恢复：继续修复后的重新构建");
        await buildWithRetry();
        return;
    }

    if (stage === "inspecting") {
        appendGenLog("↻ 页面恢复：重新读取最终构建诊断");
        const inspection = await streamBuildFix(taskId, "inspect");
        genTask.fixResumeStage = "";
        persistGenTaskNow();
        throw new Error(inspection?.reason || "构建失败，已用尽自动修复次数");
    }

    let fixResult: any;
    if (stage === "repairing") {
        appendGenLog("↻ 页面恢复：等待自动修复写回");
        fixResult = await recoverBuildRepair(taskId);
    } else {
        appendGenLog("↻ 页面恢复：重新读取构建诊断并复核学习条件");
        const diagnosis = await streamBuildFix(taskId, "diagnose");
        const repairAuthorization = normalizeFixRepairAuthorization(diagnosis?.repairAuthorization);
        if (!repairAuthorization) {
            throw new Error(diagnosis?.reason || "服务端未返回当前构建的修复授权");
        }
        if (stage === "learning") {
            appendGenLog("↻ 页面恢复：继续当前 API 查证请求并恢复修复");
        }

        genTask.fixResumeStage = "repairing";
        persistGenTaskNow();
        fixResult = await repairWithLearningTools(taskId, repairAuthorization);
    }

    const changed = repairedFileCount(fixResult);
    if (!fixResult || changed === 0) {
        throw new Error(fixResult?.reason || fixResult?.error || "自动修复未产生可重新验证的文件变更，构建失败");
    }
    genTask.fixResumeStage = "rebuilding";
    persistGenTaskNow();
    appendGenLog(`● 已恢复 ${changed} 个文件的修复结果，开始重新构建验证...`);
    await buildWithRetry();
}

async function runClarifyStage(resumePhase: GenPhase | "" = ""): Promise<void> {
    generationSignal();
    const stageRunId = generationRunId;
    let answers: Record<string, string | string[]> | undefined = resumePhase
        ? genTask.clarifyRequestAnswers || undefined
        : undefined;
    let extraPrompt: string | undefined = resumePhase
        ? genTask.clarifyRequestExtraPrompt || undefined
        : undefined;

    if (resumePhase === "awaiting_input") {
        const extra = await waitForExtraPrompt();
        genTask.moreInputHint = "";
        extraPrompt = extra;
        setPhase("clarifying", "已收到补充，继续分析...");
    } else if (resumePhase === "clarifying"
        && !genTask.clarifyRequestId
        && genTask.clarifyTodos.length > 0) {
        const todos = [...genTask.clarifyTodos];
        const userAnswers = await waitForClarifyAnswers();
        genTask.clarifyHistory.push({ todos, answers: userAnswers });
        genTask.clarifyTodos = [];
        answers = userAnswers;
    }

    while (true) {
        genTask.reasoningContent = "";
        setPhase("clarifying");

        const clarifyRequestId = genTask.clarifyRequestId || createClarifyRequestId();
        genTask.clarifyRequestId = clarifyRequestId;
        genTask.clarifyRequestAnswers = answers || null;
        genTask.clarifyRequestExtraPrompt = extraPrompt || "";
        genTask.clarifyTodos = [];
        // 请求发出前同步保存 ID 与原始 payload；断流、刷新和手动重试都必须复用它们。
        persistGenTaskNow();

        let clarifyResult: any;
        try {
            clarifyResult = await streamClarify(
                genTask.taskId,
                clarifyRequestId,
                answers,
                extraPrompt,
            );
        } catch (error: any) {
            if (isInterrupt(error)) throw error;
            assertGenerationRun(stageRunId);
            if (error?.code === "CLARIFY_CANCELLED") {
                genTask.clarifyRequestId = "";
                persistGenTaskNow();
                continue;
            }
            if (error?.terminal) {
                genTask.clarifyRequestId = "";
                persistGenTaskNow();
            }
            throw error;
        }

        // 收到带 [DONE] 的 terminal result 后才能释放该 ID。payload 一并清理，下一轮会创建新 ID。
        genTask.clarifyRequestId = "";
        genTask.clarifyRequestAnswers = null;
        genTask.clarifyRequestExtraPrompt = "";
        answers = undefined;
        extraPrompt = undefined;

        if (clarifyResult.needMoreInput) {
            genTask.moreInputHint = clarifyResult.hint || "请补充更多需求描述";
            setPhase("awaiting_input", "! 需求过于模糊，请补充描述");
            persistGenTaskNow();
            const extra = await waitForExtraPrompt();
            genTask.moreInputHint = "";
            extraPrompt = extra;
            setPhase("clarifying", "已收到补充，继续分析...");
            continue;
        }

        if (clarifyResult.done) {
            appendGenLog("● 澄清阶段完成");
            genTask.clarifyTodos = [];
            setPhase("tree_planning");
            persistGenTaskNow();
            return;
        }

        const todos = Array.isArray(clarifyResult.todos) ? clarifyResult.todos : [];
        if (!todos.length) throw new Error("澄清阶段返回了无效的待确认项");
        genTask.clarifyTodos = todos;
        persistGenTaskNow();
        const userAnswers = await waitForClarifyAnswers();

        genTask.clarifyHistory.push({ todos, answers: userAnswers });
        genTask.clarifyTodos = [];
        answers = userAnswers;
    }
}

interface TreeRoundResult {
    status: "continue" | "learning" | "ready" | "failed";
    round: number; tree: ProjectTreeView; issues: TreeIssue[];
    results: { ok: boolean; summary: string; error?: string }[];
    learningToolRequests?: unknown[];
}
let treeRecoveryInput: Record<string, unknown> | null = null;
function applyTreeView(tree: ProjectTreeView | null) {
    if (!tree) return;
    genTask.tree = { ...tree, project: { ...tree.project, coreType: genTask.coreType, version: genTask.version } };
    genTask.projectName = tree.project.projectName; genTask.packageName = tree.project.packageName; genTask.javaVersion = tree.project.javaVersion;
}
async function refreshTree() {
    const result = await get(`/api/generate/tree?taskId=${encodeURIComponent(genTask.taskId)}`);
    applyTreeView(result.tree);
    Object.assign(genTask.nodeChecks, result.nodeChecks ?? {});
    genTask.pathChecks = result.pathChecks ?? {};
    const pending = result.pendingOperation;
    genTask.treeRequestId = pending?.requestId ?? "";
    treeRecoveryInput = pending?.input ?? null;
    if (["build", "refine", "continue"].includes(pending?.input?.action)) genTask.treeMode = pending.input.action;
    if (genTask.tree?.status === "locked" && result.generation) {
        const existing = new Map(genTask.files.map(file => [file.path, file]));
        genTask.files = result.generation.plan.map((item: GenFile) => ({ ...existing.get(item.path), ...item, status: result.generation.fileStatuses[item.path] ?? "pending", origin: genTask.tree?.nodes.find(node => node.id === item.nodeId)?.origin }));
        genTask.currentBucket = result.generation.currentBucket;
        syncCurrentIndex();
    }
    if (result.session) {
        genTask.treeSessionStatus = result.session.status;
        genTask.treeRound = result.session.round;
        genTask.treeIssues = result.session.issues ?? [];
    }
    return result;
}
async function streamTreeRound(action: "build" | "refine" | "continue", learningToolJobs: Record<string, string>): Promise<TreeRoundResult> {
    if (!genTask.treeRequestId) {
        genTask.treeRequestId = `tree_${crypto.randomUUID().replace(/-/g, "")}`;
        genTask.treeMode = action;
    }
    genTask.treeToolCallCount = 0;
    persistGenTaskNow();
    const activity = beginToolActivity({ kind: "tree", title: action === "refine" ? "修正结构树" : "规划项目结构", detail: action === "refine" ? genTask.treeCorrection : "组织行为路径，绑定实现文件", context: genTask.projectName, signal: generationSignal() });
    try {
        const result = await streamPreflightRequest({
            endpoint: "/api/generate/tree", stage: "tree", label: "结构树规划", requestIdField: "treeRequestId",
            treeActivity: activity,
            requestId: genTask.treeRequestId, taskId: genTask.taskId,
            payload: { ...(treeRecoveryInput ?? { action: genTask.treeMode, correction: genTask.treeCorrection, focusIds: genTask.treeFocusIds, skillIds: [...selected] }), learningToolJobs },
            inProgressCode: "TREE_IN_PROGRESS", recoveryCode: "TREE_RECOVERY_REQUIRED", normalizeRequestId: normalizeTreeRequestId,
            onRecoverRequestId: requestId => { genTask.treeRequestId = requestId; persistGenTaskNow(); },
            setController: controller => { treeAbort = controller; }, clearController: controller => { if (treeAbort === controller) treeAbort = null; },
        });
        activity.finish(result.status === "failed" ? "error" : result.status === "learning" ? "notice" : "success",
            result.status === "failed" ? "本轮结构校验未通过，可继续修正" : result.status === "learning" ? "本轮暂停，转入 Learning 查证"
            : result.status === "ready" ? "结构已就绪，等待确认" : `本轮规划完成 · ${genTask.treeToolCallCount} 项工具调用`);
        return result;
    } catch (error) { activity.fail(error); throw error; }
}
export async function confirmTree(): Promise<void> {
    if (!genTask.tree) throw new Error("结构树尚未就绪");
    const result = await post("/api/generate/tree", { taskId: genTask.taskId, action: "confirm", revision: genTask.tree.revision });
    applyTreeView(result.tree);
    genTask.files = result.plan.map((file: GenFile) => ({ ...file, status: "pending", origin: genTask.tree?.nodes.find(node => node.id === file.nodeId)?.origin }));
    genTask.currentBucket = 0; syncCurrentIndex(); setPhase("generating"); persistGenTaskNow();
}
export async function runTreeStage(initialAction: "build" | "refine" | "continue" | "gate"): Promise<void> {
    let action = initialAction;
    const learningToolJobs: Record<string, string> = {};
    while (true) {
        if (action === "gate") {
            setPhase("tree_confirming", genTask.treeSessionStatus === "failed" ? "结构规划未完成，可提交修正意见继续" : "请确认项目结构树");
            const decision = await waitForTreeDecision();
            if (decision.action === "confirm") {
                try { await confirmTree(); return; }
                catch (error) {
                    if (!["TREE_REVISION_MISMATCH", "TREE_INVALID", "TREE_NOT_READY", "TREE_SETTLEMENT_PENDING"].includes((error as { code?: string }).code ?? "")) throw error;
                    await refreshTree();
                    if (genTask.tree?.status === "locked") return;
                    appendGenLog("结构状态已更新，请核对最新结构后再次确认");
                    action = genTask.treeRequestId ? genTask.treeMode : "gate"; continue;
                }
            }
            genTask.treeCorrection = decision.correction; genTask.treeFocusIds = decision.focusIds; action = "refine";
        }
        setPhase("tree_planning", "正在规划项目结构树…");
        const result = await streamTreeRound(action, learningToolJobs);
        applyTreeView(result.tree);
        genTask.treeSessionStatus = result.status; genTask.treeRound = result.round; genTask.treeIssues = result.issues ?? [];
        genTask.treeRequestId = ""; treeRecoveryInput = null; persistGenTaskNow();
        if (result.status === "learning") {
            await runModelLearningToolRequests(result.learningToolRequests, learningToolJobs);
            action = "continue";
        } else action = result.status === "continue" ? "continue" : "gate";
    }
}
async function createTask(userPrompt: string, coreType: string, version: string, runId: number) {
    setPhase("creating", "正在创建任务…");
    const result = await post("/api/generate/task", { userPrompt, coreType, version, skillIds: [...selected] });
    genTask.taskId = result.taskId; applyTaskExpiration(result.taskId, result.expiresAt);
    scheduleTaskKeepalive(result.taskId, runId); fetchMe(); persistGenTaskNow();
}
async function runBucket(bucketIndex: number): Promise<void> {
    const learningToolJobs: Record<string, string> = {};
    let noProgress = 0;
    for (let guard = 0; guard < 1000; guard++) {
        let result: Awaited<ReturnType<typeof streamBucketGeneration>>;
        try { result = await streamBucketGeneration(genTask.taskId, bucketIndex, learningToolJobs); }
        catch (error) {
            if (isInterrupt(error) || (error as { noRetry?: boolean; terminal?: boolean }).noRetry || (error as { terminal?: boolean }).terminal) throw error;
            if (++noProgress >= 5) throw error;
            await waitWithAbort(1500, generationSignal()); continue;
        }
        if (!result) { if (++noProgress >= 5) throw new Error("生成服务连续未返回进度，请稍后继续"); continue; }
        for (const completed of [...(result.completed ?? []), ...(result.newFiles ?? [])]) {
            const file = findFile(completed.path);
            if (file) { file.status = "done"; if (typeof completed.content === "string") file.content = completed.content; }
            if (completed.contractCheck) genTask.nodeChecks[completed.contractCheck.nodeId] = completed.contractCheck;
        }
        syncCurrentIndex();
        if (await runModelLearningToolRequests(result.learningToolRequests, learningToolJobs)) { noProgress = 0; continue; }
        if (result.bucketDone) return;
        if (result.progressed) noProgress = 0;
        else {
            if (++noProgress >= 5) throw new Error("生成服务连续未推进，已保留阶段进度");
            await waitWithAbort(Math.max(500, Math.min(5000, Number(result.retryAfterMs) || 1500)), generationSignal());
        }
    }
    throw new Error("单桶推进次数超出上限，已保留当前进度");
}
export async function runBucketsVerifyBuild(): Promise<void> {
    const bucketIds = [...new Set(genTask.files.map(file => file.bucket ?? 0))].sort((a, b) => a - b);
    setPhase("generating");
    for (const bucket of bucketIds.filter(bucket => bucket >= genTask.currentBucket)) {
        await runBucket(bucket); genTask.currentBucket = bucket + 1; persistGenTaskNow();
    }
    setPhase("verifying", "正在校验树节点完整性…");
    let result = await post("/api/generate/verify", { taskId: genTask.taskId });
    for (let retry = 0; retry < 2 && !result.verified; retry++) {
        const repair = await post("/api/generate/verify", { taskId: genTask.taskId, fixMissing: true });
        if (!Number.isInteger(repair.repairBucketIndex)) throw new Error("服务端未返回修补桶");
        genTask.currentBucket = repair.repairBucketIndex;
        for (const file of genTask.files) if (repair.missing.includes(file.path)) file.status = "pending";
        setPhase("generating", "正在补齐缺失的树节点…");
        await runBucket(repair.repairBucketIndex); genTask.currentBucket = repair.repairBucketIndex + 1;
        setPhase("verifying"); result = await post("/api/generate/verify", { taskId: genTask.taskId });
    }
    if (!result.verified) throw new Error(`文件校验失败，仍缺失 ${result.missing.length} 个节点`);
    await buildWithRetry();
}
let lastGenParams: { userPrompt: string; coreType: string; version: string } | null = null;
export function canRetryGenerate(): boolean {
    return (!!genTask.taskId || !!genTask.userPrompt || !!lastGenParams) && ["error", "idle", "interrupted"].includes(genTask.phase);
}
function getPreFileResumePhase(): GenPhase | "" {
    if (genTask.tree?.status === "locked") return "generating";
    if (genTask.tree || genTask.treeRequestId || genTask.preflightStage === "tree") return genTask.treeSessionStatus === "ready" || genTask.treeSessionStatus === "failed" ? "tree_confirming" : "tree_planning";
    return genTask.moreInputHint ? "awaiting_input" : genTask.taskId ? "clarifying" : "creating";
}
export function retryGenerate() {
    if (genTask.taskId) {
        if (genTask.phase !== "interrupted") { genTask.interruptedFrom = genTask.files.length ? "generating" : getPreFileResumePhase() as Exclude<GenPhase, "interrupted"> | ""; genTask.phase = "interrupted"; }
        resumeGenerate().catch(() => {}); return;
    }
    const params = lastGenParams ?? genTask;
    if (params.userPrompt) startGenerate(params.userPrompt, params.coreType, params.version).catch(() => {});
}
export async function resumeGenerate(): Promise<void> {
    if (!genTask.taskId) {
        if (genTask.userPrompt) await startGenerate(genTask.userPrompt, genTask.coreType, genTask.version);
        return;
    }
    const from = genTask.phase === "interrupted" ? genTask.interruptedFrom || getPreFileResumePhase() : genTask.phase;
    if (["idle", "done", "error"].includes(from)) return;
    beginGenerationRun(); const runId = generationRunId;
    genTask.phase = from as GenPhase; genTask.interruptedFrom = ""; clearGenerateError();
    try {
        await ensureTaskAlive(genTask.taskId, runId);
        if (["uploading", "building"].includes(from)) { await buildWithRetry(true); return; }
        if (from === "fixing") { await resumeFixingStage(genTask.taskId, genTask.fixResumeStage); return; }
        if (["clarifying", "awaiting_input", "creating"].includes(from)) { await runClarifyStage(from === "awaiting_input" ? "awaiting_input" : "clarifying"); await runTreeStage("build"); }
        else {
            const restored = await refreshTree();
            if (genTask.tree?.status !== "locked") {
                const status = restored.session?.status;
                await runTreeStage(genTask.treeRequestId ? genTask.treeMode : status === "ready" || status === "failed" ? "gate" : status ? "continue" : "build");
            }
        }
        await runBucketsVerifyBuild();
    } catch (error) {
        if (!isGenerationRunCurrent(runId)) return;
        if (isInterrupt(error)) markInterrupted(genTask.phase);
        else { setGenerateError(error); appendGenLog(`× ${genTask.error}`); persistGenTaskNow(); }
    }
}
export async function startGenerate(userPrompt: string, coreType: string, version: string, options?: { resumePrepared?: boolean }): Promise<void> {
    if (options?.resumePrepared) { await resumeGenerate(); return; }
    if (isGeneratingPhase(genTask.phase)) throw new Error("当前已有构建任务正在进行");
    beginGenerationRun(); const runId = generationRunId;
    lastGenParams = { userPrompt, coreType, version };
    recordPromptHistory({ prompt: userPrompt, coreType, version, skillIds: [...selected] });
    resetGenTask(); Object.assign(genTask, { userPrompt, coreType, version });
    try {
        await createTask(userPrompt, coreType, version, runId);
        await runClarifyStage(); await runTreeStage("build"); await runBucketsVerifyBuild();
    } catch (error) {
        if (!isGenerationRunCurrent(runId)) return;
        if (isInterrupt(error)) markInterrupted(genTask.phase);
        else { setGenerateError(error); appendGenLog(`× ${genTask.error}`); persistGenTaskNow(); }
    }
}
export async function loadNodeContent(path: string): Promise<string> {
    const file = findFile(path); if (file?.content !== undefined) return file.content;
    const taskId = genTask.taskId;
    const controller = new AbortController(), timer = setTimeout(() => controller.abort(), 30_000);
    try {
        const response = await fetchWithByokFallback(`/api/generate/source?taskId=${encodeURIComponent(taskId)}&path=${encodeURIComponent(path)}`, { signal: controller.signal });
        await rejectAccessResponse(response);
        if (!response.ok) throw await responseError(response, "源码读取失败");
        const result = await response.json() as { content: string };
        if (genTask.taskId !== taskId) throw generationAbortError();
        if (typeof result.content !== "string") throw new Error("源码响应不完整");
        const current = findFile(path);
        if (current) current.content = result.content;
        return result.content;
    } finally { clearTimeout(timer); }
}
export async function downloadSourceZip(): Promise<void> {
    const taskId = genTask.taskId;
    const response = await fetchWithByokFallback(`/api/generate/source?taskId=${encodeURIComponent(taskId)}`);
    if (!response.ok) throw await responseError(response, "源码下载失败");
    const result = await response.json() as { projectName: string; tree: ProjectTreeView; files: { path: string; content: string }[]; nodeChecks: typeof genTask.nodeChecks; pathChecks: typeof genTask.pathChecks };
    const zip = new JSZip(), root = zip.folder(result.projectName)!;
    for (const file of result.files) root.file(file.path, file.content);
    result.tree.project.coreType = genTask.coreType; result.tree.project.version = genTask.version;
    root.file("PROJECT_TREE.md", renderTreeMarkdown(result.tree, result.nodeChecks, result.pathChecks));
    const blob = await zip.generateAsync({ type: "blob" }), url = URL.createObjectURL(blob);
    const link = document.createElement("a"); link.href = url; link.download = `${result.projectName}-source.zip`; link.click();
    setTimeout(() => URL.revokeObjectURL(url), 1000);
}

async function ensurePathsReviewed(): Promise<void> {
    setPhase("verifying", "正在沿需求路径静态审查实现代码…");
    for (let round = 0; round < 15; round++) {
        const result = await post("/api/generate/verify", { taskId: genTask.taskId, reviewPaths: true });
        genTask.pathChecks = result.pathChecks ?? {};
        for (const path of result.changedFiles ?? []) {
            const file = findFile(path);
            if (file) { delete file.content; file.streamingContent = ""; }
        }
        if (!result.verified) throw new Error("路径检查前发现实现文件缺失，请恢复生成阶段");
        if (!Number.isInteger(result.reviewBucketIndex)) { persistGenTaskNow(); return; }
        genTask.currentBucket = result.reviewBucketIndex;
        persistGenTaskNow();
        await runBucket(result.reviewBucketIndex);
        genTask.currentBucket = result.reviewBucketIndex + 1;
    }
    throw new Error("路径审查推进次数超出上限，已保留当前进度");
}
async function startReviewedBuild(buildRequestId: string) {
    const payload = { taskId: genTask.taskId, buildRequestId };
    try { return await post("/api/generate/build", payload); }
    catch (error) {
        if ((error as { code?: string }).code !== "PATH_REVIEW_REQUIRED") throw error;
        await ensurePathsReviewed();
        setPhase("uploading", "路径审查已同步，正在启动构建…");
        return post("/api/generate/build", payload);
    }
}
async function buildWithRetry(resumeExistingBuild = false) {
    for (let attempt = 0; attempt <= MAX_FIX_ATTEMPTS; attempt++) {
        const reuseExisting = resumeExistingBuild && attempt === 0;
        let buildResult: any = null;
        if (reuseExisting && genTask.buildRequestId) {
            setPhase("uploading", "正在恢复已有构建启动请求...");
            appendGenLog("↻ 页面恢复：使用原 build request ID 对账，不重复触发 workflow");
            buildResult = await startReviewedBuild(genTask.buildRequestId);
        } else if (reuseExisting) {
            setPhase("building", "正在恢复已有构建的状态...");
            appendGenLog("↻ 页面恢复：继续等待已有构建，不重复触发 workflow");
        } else {
            await ensurePathsReviewed();
            setPhase("uploading", "正在上传到 GitHub 并触发构建...");
            const buildRequestId = createBuildRequestId();
            genTask.buildRequestId = buildRequestId;
            persistGenTaskNow();
            buildResult = await startReviewedBuild(buildRequestId);
        }

        if (buildResult) {
            if (genTask.fixResumeStage === "rebuilding") {
                genTask.fixResumeStage = "";
                persistGenTaskNow();
            }
            // 恢复构建时补齐进度面板需要的项目信息
            if (!genTask.projectName && buildResult.projectName) genTask.projectName = buildResult.projectName;
            if (!genTask.packageName && buildResult.packageName) genTask.packageName = buildResult.packageName;
            if (!genTask.javaVersion && buildResult.javaVersion) genTask.javaVersion = buildResult.javaVersion;
            appendGenLog(`构建已确认 (run #${buildResult.runId || "pending"})`);
        }

        setPhase("building", "正在等待 GitHub Actions 构建...");
        const buildOk = await pollBuildStatus();

        if (buildOk) return; // success

        // 每次失败都抓取结构化诊断；最后一次只检查、不再调用模型修改。
        const canRepair = attempt < MAX_FIX_ATTEMPTS;
        if (canRepair) {
            appendGenLog(`! 构建失败，尝试自动修复 (第${attempt + 1}次)...`);
            setPhase("fixing", "正在分析编译错误并修复...");
        } else {
            setPhase("fixing", "正在获取最终构建诊断...");
        }

        let repairAuthorization: FixRepairAuthorization | null = null;
        if (canRepair) {
            genTask.fixResumeStage = "diagnosing";
            persistGenTaskNow();
            const diagnosis = await streamBuildFix(genTask.taskId, "diagnose");
            repairAuthorization = normalizeFixRepairAuthorization(diagnosis?.repairAuthorization);
            if (!repairAuthorization) {
                throw new Error(diagnosis?.reason || "服务端未返回当前构建的修复授权");
            }
            genTask.fixResumeStage = "repairing";
            persistGenTaskNow();
        } else {
            genTask.fixResumeStage = "inspecting";
            persistGenTaskNow();
        }

        const fixResult = canRepair && repairAuthorization
            ? await repairWithLearningTools(genTask.taskId, repairAuthorization)
            : await streamBuildFix(genTask.taskId, "inspect");
        if (!canRepair) {
            genTask.fixResumeStage = "";
            persistGenTaskNow();
            throw new Error(fixResult?.reason || "构建失败，已用尽自动修复次数");
        }
        const changed = repairedFileCount(fixResult);
        if (!fixResult || changed === 0) {
            throw new Error(fixResult?.reason || fixResult?.error || "自动修复未产生可重新验证的文件变更，构建失败");
        }
        genTask.fixResumeStage = "rebuilding";
        persistGenTaskNow();
        appendGenLog(`● 已修改 ${changed} 个文件，开始重新构建验证...`);
    }
}

/** Poll build status. Returns true on success, false on failure. */
async function pollBuildStatus(): Promise<boolean> {
    const deadline = Date.now() + 10 * 60_000;
    let i = 0;
    while (Date.now() < deadline) {
        // 前三次快速感知启动，随后逐步退避；隐藏标签页进一步降频。
        const delay = document.hidden ? 30_000 : i < 3 ? 5_000 : i < 9 ? 10_000 : 15_000;
        await waitWithAbort(delay, generationSignal());

        const result = await get(`/api/generate/status?taskId=${genTask.taskId}`);

        if (result.pathChecks) genTask.pathChecks = result.pathChecks;
        if (result.status === "done") {
            genTask.buildRequestId = "";
            genTask.fixResumeStage = "";
            setPhase("done", "● 构建成功，JAR 已就绪！");
            persistGenTaskNow();
            return true;
        }
        if (result.status === "error") {
            return false;
        }
        if (i % 3 === 0) {
            appendGenLog(`构建中... (${result.runStatus || "queued"})`);
        }
        i++;
    }
    throw new Error("构建超时");
}

export function getDownloadUrl(): string {
    return `/api/generate/download?taskId=${genTask.taskId}`;
}
