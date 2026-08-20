import {
    genTask,
    resetGenTask,
    waitForClarifyAnswers,
    waitForExtraPrompt,
    waitForPathChoice,
    cancelPendingInput,
    persistGenTaskNow,
    superConcurrency,
    normalizeLearningDebugMeta,
    normalizeLearningProgress,
    normalizeClarifyRequestId,
    normalizeGradeRequestId,
    isUnconfirmedLearningProgress,
    shouldResumeLearningProgress,
    recordLearningDebugEvent,
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
import { parseResponse } from "../ide/composables/useIDEChat";
import { readApiError as readBaseApiError, responseError } from "../api/apiError";
import {actionMessageMetaForError} from "./actionMessages";
import type {ActionMessageKind} from "./actionMessages";

const MAX_FIX_ATTEMPTS = 3;
const MAX_REPLAN_ATTEMPTS = 2;

// ── 当前生成运行域：所有请求共享一个根 signal，离页/中断/重置可一次性终止 ──
let generationAbort: AbortController | null = null;
let generationRunId = 0;

function beginGenerationRun(): AbortSignal {
    generationAbort?.abort(new DOMException("Superseded", "AbortError"));
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

function linkGenerationAbort(controller: AbortController): () => void {
    const root = generationSignal();
    const abort = () => controller.abort(root.reason ?? new DOMException("Aborted", "AbortError"));
    if (root.aborted) abort();
    else root.addEventListener("abort", abort, { once: true });
    return () => root.removeEventListener("abort", abort);
}

function interruptedPhase(): Exclude<GenPhase, "interrupted"> | "" {
    return genTask.phase === "interrupted" ? genTask.interruptedFrom : genTask.phase;
}

function markInterrupted(from: GenPhase | "" = genTask.phase) {
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
    genTask.logs.push("■ 当前任务已中断，返回后不会自动继续");
    persistGenTaskNow();
}

// clarify / grade 保留独立 controller，供现有阶段代码清理引用。
let clarifyAbort: AbortController | null = null;
let gradeAbort: AbortController | null = null;

/** 判断错误是否来自 ESC 中断：fetch abort 抛 AbortError，等待 Promise 被拒抛 InterruptError */
function isInterrupt(e: any): boolean {
    return e?.interrupted === true || e?.name === "AbortError";
}

/** 中断当前 Chat 生成运行域。服务端会通过断连信号同步终止上游模型。 */
export function interruptGenerate(options: { preserve?: boolean } = {}) {
    const from = interruptedPhase();
    generationAbort?.abort(new DOMException("User interrupted", "AbortError"));
    generationRunId++;
    clarifyAbort?.abort(new DOMException("User interrupted", "AbortError"));
    gradeAbort?.abort(new DOMException("User interrupted", "AbortError"));
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

function setGenerateError(
    error: unknown,
    kind?: ActionMessageKind,
    message?: string,
) {
    genTask.phase = "error";
    genTask.error = message || (error instanceof Error ? error.message : String(error));
    genTask.errorMeta = actionMessageMetaForError(error, kind);
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
function setPhase(phase: GenPhase, log?: string) {
    genTask.phase = phase;
    if (phase !== "interrupted") genTask.interruptedFrom = "";
    let preflightStage: PreflightStage | "" = "";
    if (phase === "clarifying" || phase === "awaiting_input") preflightStage = "clarify";
    else if (phase === "grading" || phase === "confirming") preflightStage = "grade";
    else if (phase === "planning" && genTask.taskId) preflightStage = "plan";
    if (preflightStage) {
        if (genTask.preflightStage !== preflightStage) {
            genTask.preflightThinking = "";
            genTask.preflightOutput = "";
        }
        genTask.preflightStage = preflightStage;
    }
    if (log) genTask.logs.push(log);
}

function isGeneratingPhase(phase: GenPhase) {
    return ["planning", "clarifying", "grading", "confirming", "awaiting_input", "generating", "verifying", "uploading", "building", "polling", "fixing"].includes(phase);
}

async function post(url: string, body: any, maxRetries = 3) {
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
                if (resp.status === 400
                    || resp.status === 404
                    || resp.status === 429
                    || apiError.code === "TASK_STORE_MIGRATION_REQUIRED") {
                    throw noRetry(apiError.message, {code: apiError.code, status: resp.status});
                }
                throw new Error(apiError.message);
            }
            const result = await resp.json() as any;
            assertGenerationRun(runId);
            return result;
        } catch (e: any) {
            if (isInterrupt(e) || signal.aborted || runId !== generationRunId) throw generationAbortError();
            if (e?.noRetry || attempt >= maxRetries) throw e;
            const delay = 2000 * Math.pow(2, attempt);
            genTask.logs.push(`! 请求失败，${delay / 1000}s 后重试 (${attempt + 1}/${maxRetries})...`);
            await waitWithAbort(delay, signal);
        }
    }
}

function createPlannerRequestId(): string {
    return `plan_${crypto.randomUUID().replace(/-/g, "")}`;
}

function createClarifyRequestId(): string {
    return `clarify_${crypto.randomUUID().replace(/-/g, "")}`;
}

function createGradeRequestId(): string {
    return `grade_${crypto.randomUUID().replace(/-/g, "")}`;
}

function createBuildRequestId(): string {
    return `build_${crypto.randomUUID().replace(/-/g, "")}`;
}

async function postPlanner(body: any, waitMs = 390_000): Promise<any> {
    const signal = generationSignal();
    const runId = generationRunId;
    const deadline = Date.now() + waitMs;
    let announcedWait = false;
    let failures = 0;
    let timeoutRetries = 0;

    while (true) {
        let resp: Response;
        try {
            resp = await fetchWithByokFallback("/api/generate/plan", {
                method: "POST",
                headers: { "Content-Type": "application/json" },
                body: JSON.stringify(body),
                signal,
            });
        } catch (error) {
            if (signal.aborted || runId !== generationRunId || isInterrupt(error)) throw generationAbortError();
            if (Date.now() >= deadline || failures++ >= 3) throw error;
            await waitWithAbort(2000 * Math.pow(2, failures - 1), signal);
            continue;
        }

        assertGenerationRun(runId);

        await rejectAccessResponse(resp);
        if (resp.status === 429) {
            const payload = await resp.json().catch(() => ({})) as { code?: string; error?: string };
            throw noRetry(payload?.error || "请求过于频繁", {
                code: payload?.code || "RATE_LIMITED",
                status: resp.status,
            });
        }
        if (resp.status === 409) {
            const payload = await resp.json().catch(() => ({})) as { code?: string; error?: string };
            if (payload?.code !== "PLANNER_IN_PROGRESS" || Date.now() >= deadline) {
                const error = new Error(payload?.error || "Planner 状态冲突");
                (error as any).code = payload?.code || "PLANNER_CONFLICT";
                (error as any).status = resp.status;
                (error as any).noRetry = true;
                throw error;
            }
            if (!announcedWait) {
                genTask.logs.push("· Planner 已在服务端执行，等待现有结果...");
                announcedWait = true;
            }
            const retrySeconds = Math.max(1, Number(resp.headers.get("Retry-After")) || 2);
            await waitWithAbort(retrySeconds * 1000, signal);
            continue;
        }
        if (resp.status === 400) {
            const payload = await resp.json().catch(() => ({})) as { code?: string; error?: string };
            throw noRetry(payload?.error || "Planner 请求无效", {
                code: payload?.code || "PLANNER_REQUEST_INVALID",
                status: resp.status,
            });
        }
        if (!resp.ok) {
            const apiError = await readApiError(resp, `Planner 请求失败（HTTP ${resp.status}）`);
            const plannerTimedOut = apiError.code === "PLANNER_TIMEOUT"
                || apiError.code === "CLOUDFLARE_TIMEOUT"
                || resp.status === 524;
            if (plannerTimedOut) {
                if (Date.now() >= deadline || timeoutRetries++ >= 1) {
                    const error = new Error(apiError.message);
                    (error as any).code = apiError.code;
                    (error as any).status = resp.status;
                    throw error;
                }
                const retrySeconds = Math.max(1, Number(resp.headers.get("Retry-After")) || 1);
                genTask.logs.push("! Planner 响应超时，使用同一请求 ID 重试一次...");
                await waitWithAbort(retrySeconds * 1000, signal);
                continue;
            }
            if (Date.now() >= deadline || failures++ >= 3) throw new Error(apiError.message);
            await waitWithAbort(2000 * Math.pow(2, failures - 1), signal);
            continue;
        }
        const contentType = resp.headers.get("Content-Type") || "";
        if (contentType.includes("text/event-stream")) {
            let streamed: any;
            try {
                streamed = await readSSE(resp, { preflightStage: "plan", requireDone: true, runId });
            } catch (error: any) {
                if (isInterrupt(error) || signal.aborted || runId !== generationRunId) {
                    throw generationAbortError();
                }
                if (error?.noRetry || error?.terminal) throw error;
                if (Date.now() >= deadline || failures++ >= 3) throw error;
                const delay = 2000 * Math.pow(2, failures - 1);
                genTask.logs.push(`! Planner 连接中断，${delay / 1000}s 后继续等待 (${failures}/3)...`);
                await waitWithAbort(delay, signal);
                continue;
            }
            if (!streamed) {
                if (Date.now() >= deadline || failures++ >= 3) {
                    throw new Error("Planner 流已结束，但未返回结果");
                }
                await waitWithAbort(2000 * Math.pow(2, failures - 1), signal);
                continue;
            }
            if (streamed.error) {
                const status = Number(streamed.status) || 0;
                const code = typeof streamed.code === "string" ? streamed.code : "";
                if (code === "PLANNER_IN_PROGRESS" && Date.now() < deadline) {
                    if (!announcedWait) {
                        genTask.logs.push("· Planner 已在服务端执行，等待现有结果...");
                        announcedWait = true;
                    }
                    const retrySeconds = Math.max(1, Number(streamed.retryAfter) || 2);
                    await waitWithAbort(retrySeconds * 1000, signal);
                    continue;
                }

                const plannerError = new Error(String(streamed.error));
                (plannerError as any).code = code;
                (plannerError as any).status = status;
                if (status >= 400 && status < 500) {
                    (plannerError as any).noRetry = true;
                    throw plannerError;
                }
                if (Date.now() >= deadline || failures++ >= 3) throw plannerError;
                const delay = 2000 * Math.pow(2, failures - 1);
                genTask.logs.push(`! Planner 请求失败，${delay / 1000}s 后重试 (${failures}/3)...`);
                await waitWithAbort(delay, signal);
                continue;
            }
            assertGenerationRun(runId);
            return streamed;
        }
        const result = await resp.json();
        assertGenerationRun(runId);
        return result;
    }
}

async function get(url: string) {
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
    }
    if (Array.isArray(snapshot?.knowledgeUsed)) {
        for (const item of snapshot.knowledgeUsed) {
            if (!item?.knowledgeId) continue;
            const index = genTask.knowledgeUsed.findIndex(existing => existing.knowledgeId === item.knowledgeId);
            if (index >= 0) genTask.knowledgeUsed[index] = item;
            else genTask.knowledgeUsed.push(item);
        }
    }
    genTask.learningDeferred = !!snapshot?.learningDeferred;
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
    options?: { resumeExisting?: boolean },
): Promise<void> {
    generationSignal();
    const generationId = generationRunId;
    const assertActive = () => assertGenerationRun(generationId);
    const stage: LearningStage = "tool";
    const startedAt = Date.now();
    let jobDeadline = startedAt + LEARNING_JOB_BUDGET_MS;
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
        genTask.learningProgress = normalizeLearningProgress({
            jobId: "",
            status: "queued",
            revision: 0,
            stage,
            startedAt,
            deadlineAt: jobDeadline,
            remainingMs: LEARNING_JOB_BUDGET_MS,
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
            jobDeadline = deadlineAt;
        } else if (remainingMs !== undefined) {
            jobDeadline = Date.now() + remainingMs;
        }
        const message = genTask.learningProgress.message;
        if (message && message !== lastMessage) {
            genTask.logs.push(`▸ ${message}`);
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
            genTask.logs.push(`! ${message}`);
            lastMessage = message;
        }
    };

    if (jobId) {
        await reconcile(jobId, 2);
        if (isTerminal()) return;
        if (stopRetrying && lastFailureHttpStatus === 404) {
            stopRetrying = false;
            lastFailureHttpStatus = 0;
            lastFailureReason = "client_network";
            jobId = "";
            jobDeadline = Date.now() + LEARNING_JOB_BUDGET_MS;
            genTask.learningProgress = normalizeLearningProgress({
                jobId: "",
                status: "queued",
                revision: 0,
                stage,
                startedAt,
                deadlineAt: jobDeadline,
                remainingMs: LEARNING_JOB_BUDGET_MS,
                totalNeeds: 0,
                completedNeeds: 0,
                sourceCount: 0,
                searchedSourceCount: 0,
                message: "准备重新确认联网查证任务",
            });
            persistGenTaskNow();
        } else if (stopRetrying) {
            markClientDeferred(lastFailureReason);
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
            if (isTerminal()) return;
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

    if (isTerminal()) return;
    if (stopRetrying) {
        markClientDeferred(lastFailureReason);
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

    if (isTerminal()) return;
    if (!stopRetrying && Date.now() < outboundDeadline()) {
        await runLearning(toolRequestId, {
            ...options,
            resumeExisting: true,
        });
        return;
    }
    markClientDeferred(Date.now() >= jobDeadline ? "client_deadline" : lastFailureReason);
}

async function runModelLearningToolRequests(
    value: unknown,
    jobIds: Record<string, string>,
): Promise<boolean> {
    if (!Array.isArray(value) || value.length === 0) return false;
    const requests = value
        .filter((item: any) => item && /^learnreq_[a-f0-9]{32}$/i.test(String(item.requestId || "")))
        .slice(0, 3);
    if (!requests.length) return false;

    for (const request of requests) {
        const requestId = String(request.requestId);
        const question = Array.isArray(request.questions)
            ? request.questions.find((item: unknown) => typeof item === "string")
            : "";
        genTask.logs.push(`▸ DS 主动调用 Learning${question ? `：${question}` : ""}`);
        await runLearning(requestId);
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

type PreflightStage = "clarify" | "grade" | "plan";

function normalizePreflightStage(value: unknown): PreflightStage | "" {
    if (value === "clarify" || value === "clarifying") return "clarify";
    if (value === "grade" || value === "grading") return "grade";
    if (value === "plan" || value === "planning") return "plan";
    return "";
}

type SSEReadOptions = {
    preflightStage?: PreflightStage;
    requireDone?: boolean;
    runId?: number;
};

/** Read an SSE stream, dispatch events to genTask, return the result event. */
async function readSSE(resp: Response, opts?: SSEReadOptions): Promise<any> {
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
                if (payload === "[DONE]") {
                    receivedDone = true;
                    continue;
                }

                let evt: any;
                try {
                    evt = JSON.parse(payload);
                } catch {
                    if (opts?.requireDone) throw new Error("流式响应包含无效数据，请重试");
                    continue;
                }
                assertGenerationRun(runId);

                if (evt?.type === "error" || (evt?.type === "result" && evt?.error)) {
                    rejectAccessEvent(evt);
                }

                try {
                    switch (evt.type) {
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
                            genTask.logs.push(evt.msg);
                            break;
                        case "error":
                            streamError = evt;
                            genTask.logs.push(`× ${evt.error || evt.message || "流式阶段出错"}`);
                            break;
                        case "file_done": {
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
                                const existing = findFile(evt.path);
                                if (existing) {
                                    existing.role = evt.role || existing.role;
                                    existing.content = evt.content;
                                    existing.status = "done";
                                    existing.streamingPhase = "";
                                    existing.streamingContent = "";
                                } else {
                                    genTask.files.push({
                                        path: evt.path, role: evt.role,
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
                            result = evt;
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

/** SSE streaming file generation (legacy single-file flow，仅供补缺/重新规划使用) */
async function streamFileGeneration(taskId: string): Promise<any> {
    const signal = generationSignal();
    const runId = generationRunId;
    const resp = await fetchWithByokFallback("/api/generate/file", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ taskId }),
        signal,
    });
    assertGenerationRun(runId);
    await rejectAccessResponse(resp);
    if (!resp.ok) throw await responseError(resp);

    const contentType = resp.headers.get("Content-Type") || "";
    if (contentType.includes("application/json")) {
        const result = await resp.json();
        assertGenerationRun(runId);
        return result;
    }

    return readSSE(resp, { runId });
}

/** SSE streaming bucket generation — 一次推进一批文件的单个持久化阶段。
 *  服务端通过 heartbeat 保持连接，客户端不再因静默时长主动中止。 */
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

const PREFLIGHT_WAIT_MS = 390_000;
const PREFLIGHT_RETRIES = 3;

type PreflightRequestConfig = {
    endpoint: string;
    stage: "clarify" | "grade";
    label: string;
    requestIdField: "clarifyRequestId" | "gradeRequestId";
    requestId: string;
    taskId: string;
    payload: Record<string, unknown>;
    inProgressCode: "CLARIFY_IN_PROGRESS" | "GRADE_IN_PROGRESS";
    recoveryCode: "CLARIFY_RECOVERY_REQUIRED" | "GRADE_RECOVERY_REQUIRED";
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
    generationSignal();
    const runId = generationRunId;
    const deadline = Date.now() + PREFLIGHT_WAIT_MS;
    let failures = 0;
    let announcedWait = false;
    let requestId = config.requestId;
    let payload: Record<string, unknown> | null = config.payload;

    while (true) {
        const controller = new AbortController();
        const unlinkRootAbort = linkGenerationAbort(controller);
        config.setController(controller);

        const retry = async (error: any, reason: string) => {
            if (Date.now() >= deadline || failures >= PREFLIGHT_RETRIES) throw error;
            failures++;
            const delay = 2000 * Math.pow(2, failures - 1);
            genTask.logs.push(`· ${config.label}${reason}，${delay / 1000}s 后继续对账 (${failures}/${PREFLIGHT_RETRIES})...`);
            await waitWithAbort(delay, controller.signal);
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
                if (controller.signal.aborted) {
                    const aborted = new Error("interrupted");
                    aborted.name = "AbortError";
                    throw aborted;
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
                        genTask.logs.push(`↻ ${config.label}已切换到服务端现有 requestId，继续恢复原操作`);
                        continue;
                    }
                }
                if ((apiError.code === config.inProgressCode || apiError.code === "TASK_OPERATION_IN_PROGRESS")
                    && Date.now() < deadline) {
                    if (!announcedWait) {
                        genTask.logs.push(`· ${config.label}已在服务端执行，等待现有结果...`);
                        announcedWait = true;
                    }
                    const retrySeconds = Math.max(1, Number(response.headers.get("Retry-After")) || 2);
                    await waitWithAbort(retrySeconds * 1000, controller.signal);
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
            try {
                result = await readSSE(response, {
                    preflightStage: config.stage,
                    requireDone: true,
                    runId,
                });
            } catch (error: any) {
                if (controller.signal.aborted) {
                    const aborted = new Error("interrupted");
                    aborted.name = "AbortError";
                    throw aborted;
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
                if ((code === config.inProgressCode || code === "TASK_OPERATION_IN_PROGRESS")
                    && Date.now() < deadline) {
                    if (!announcedWait) {
                        genTask.logs.push(`· ${config.label}已在服务端执行，等待现有结果...`);
                        announcedWait = true;
                    }
                    const retrySeconds = Math.max(1, Number(result.retryAfter) || 2);
                    await waitWithAbort(retrySeconds * 1000, controller.signal);
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
                if (((error as any).status >= 400 && (error as any).status < 500)
                    || code.endsWith("_REQUEST_CONFLICT")
                    || code.endsWith("_RECOVERY_REQUIRED")) {
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
        } finally {
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

/** SSE streaming complexity grading. Correction redraws use a new semantic request ID. */
async function streamGrade(taskId: string, gradeRequestId: string, correction?: string): Promise<any> {
    return streamPreflightRequest({
        endpoint: "/api/generate/grade",
        stage: "grade",
        label: "分级",
        requestIdField: "gradeRequestId",
        requestId: gradeRequestId,
        taskId,
        payload: { correction },
        inProgressCode: "GRADE_IN_PROGRESS",
        recoveryCode: "GRADE_RECOVERY_REQUIRED",
        normalizeRequestId: normalizeGradeRequestId,
        onRecoverRequestId: requestId => {
            genTask.gradeRequestId = requestId;
            genTask.gradeRequestCorrection = "";
            persistGenTaskNow();
        },
        setController: controller => { gradeAbort = controller; },
        clearController: controller => {
            if (gradeAbort === controller) gradeAbort = null;
        },
    });
}

/** SSE streaming build fix */
async function streamBuildFix(
    taskId: string,
    mode: "diagnose" | "repair" | "inspect" = "repair",
    repairAuthorization?: FixRepairAuthorization,
    learningToolJobs: Record<string, string> = {},
): Promise<any> {
    const signal = generationSignal();
    const runId = generationRunId;
    const resp = await fetchWithByokFallback("/api/generate/fix", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
            taskId,
            mode,
            ...(mode === "repair" ? { repairAuthorization } : {}),
            ...(mode === "repair" ? { learningToolJobs } : {}),
        }),
        signal,
    });
    assertGenerationRun(runId);
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
        return result;
    }

    return readSSE(resp, { runId });
}

async function repairWithLearningTools(
    taskId: string,
    repairAuthorization: FixRepairAuthorization,
): Promise<any> {
    const learningToolJobs: Record<string, string> = {};
    for (let round = 0; round <= 3; round++) {
        const result = await streamBuildFix(
            taskId,
            "repair",
            repairAuthorization,
            learningToolJobs,
        );
        if (!await runModelLearningToolRequests(result?.learningToolRequests, learningToolJobs)) {
            return result;
        }
    }
    throw new Error("DS 连续请求 Learning 超过安全上限，已停止本轮自动修复");
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
        genTask.logs.push("↻ 页面恢复：继续修复后的重新构建");
        await buildWithRetry();
        return;
    }

    if (stage === "inspecting") {
        genTask.logs.push("↻ 页面恢复：重新读取最终构建诊断");
        const inspection = await streamBuildFix(taskId, "inspect");
        genTask.fixResumeStage = "";
        persistGenTaskNow();
        throw new Error(inspection?.reason || "构建失败，已用尽自动修复次数");
    }

    let fixResult: any;
    if (stage === "repairing") {
        genTask.logs.push("↻ 页面恢复：等待自动修复写回");
        fixResult = await recoverBuildRepair(taskId);
    } else {
        genTask.logs.push("↻ 页面恢复：重新读取构建诊断并复核学习条件");
        const diagnosis = await streamBuildFix(taskId, "diagnose");
        const repairAuthorization = normalizeFixRepairAuthorization(diagnosis?.repairAuthorization);
        if (!repairAuthorization) {
            throw new Error(diagnosis?.reason || "服务端未返回当前构建的修复授权");
        }
        if (stage === "learning") {
            genTask.logs.push("↻ 页面恢复：旧版预判学习阶段已迁移为 DS 工具调用，继续修复");
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
    genTask.logs.push(`● 已恢复 ${changed} 个文件的修复结果，开始重新构建验证...`);
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
            genTask.logs.push("● 澄清阶段完成");
            genTask.clarifyTodos = [];
            setPhase("grading");
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

async function runGradeStage(resumePhase: GenPhase | "" = ""): Promise<string | undefined> {
    generationSignal();
    const stageRunId = generationRunId;
    let correction: string | undefined = resumePhase === "grading"
        ? genTask.gradeRequestCorrection || undefined
        : undefined;

    if (resumePhase === "confirming") {
        if (!genTask.grade) throw new Error("实现路径确认状态已失效，请重试分级");
        const choice = await waitForPathChoice();
        if (choice.correction) {
            correction = choice.correction;
            genTask.grade = null;
        } else {
            genTask.chosenPathId = choice.pathId || "";
            genTask.grade = null;
            setPhase("planning");
            persistGenTaskNow();
            return choice.pathId;
        }
    }

    while (true) {
        genTask.reasoningContent = "";
        setPhase("grading", "正在分析需求复杂度...");

        const gradeRequestId = genTask.gradeRequestId || createGradeRequestId();
        genTask.gradeRequestId = gradeRequestId;
        genTask.gradeRequestCorrection = correction || "";
        persistGenTaskNow();

        let gradeResult: any;
        try {
            gradeResult = await streamGrade(genTask.taskId, gradeRequestId, correction);
        } catch (error: any) {
            if (isInterrupt(error)) throw error;
            assertGenerationRun(stageRunId);
            if (error?.code === "CLARIFY_RECOVERY_REQUIRED") {
                const activeClarifyRequestId = normalizeClarifyRequestId(error.activeRequestId);
                if (!activeClarifyRequestId) {
                    throw new Error("服务端要求恢复需求确认，但未返回有效的 requestId");
                }
                genTask.clarifyRequestId = activeClarifyRequestId;
                genTask.clarifyRequestAnswers = null;
                genTask.clarifyRequestExtraPrompt = "";
                genTask.gradeRequestId = "";
                genTask.gradeRequestCorrection = "";
                genTask.grade = null;
                setPhase("clarifying", "↻ 分级前先恢复尚未结算的需求确认请求");
                persistGenTaskNow();
                await runClarifyStage("clarifying");
                correction = undefined;
                continue;
            }
            if (error?.code === "GRADE_CANCELLED") {
                genTask.gradeRequestId = "";
                persistGenTaskNow();
                continue;
            }
            if (error?.terminal) {
                genTask.gradeRequestId = "";
                persistGenTaskNow();
            }
            throw error;
        }

        genTask.plannerLearningRequired = gradeResult.learningRequired === true;
        genTask.plannerLearningNeedCount = genTask.plannerLearningRequired
            ? Math.max(0, Number(gradeResult.learningNeedCount) || 0)
            : 0;
        correction = undefined;

        if (gradeResult.direct) {
            genTask.grade = null;
            setPhase("planning");
            genTask.gradeRequestId = "";
            genTask.gradeRequestCorrection = "";
            persistGenTaskNow();
            return undefined;
        }

        genTask.grade = { level: gradeResult.level, paths: gradeResult.paths || [] };
        setPhase("confirming", "请确认实现路径");
        genTask.gradeRequestId = "";
        genTask.gradeRequestCorrection = "";
        persistGenTaskNow();
        const choice = await waitForPathChoice();
        if (choice.correction) {
            correction = choice.correction;
            genTask.grade = null;
            continue;
        }
        genTask.chosenPathId = choice.pathId || "";
        genTask.grade = null;
        setPhase("planning");
        persistGenTaskNow();
        return choice.pathId;
    }
}

// 记住上次生成的入参，供失败后「重试」手动重跑。刷新后内存丢失时，改用 genTask 上还原的入参。
let lastGenParams: { userPrompt: string; coreType: string; version: string } | null = null;
export function canRetryGenerate(): boolean {
    const has = !!lastGenParams || !!genTask.userPrompt || !!genTask.taskId;
    return has && (genTask.phase === "error" || genTask.phase === "idle" || genTask.phase === "interrupted");
}

function getPreFileResumePhase(): GenPhase | "" {
    if (genTask.clarifyRequestId) return "clarifying";
    if (genTask.gradeRequestId) return "grading";
    if (genTask.plannerRequestId
        || genTask.preflightStage === "plan"
        || (genTask.learningProgress.stage === "planner" && genTask.learningProgress.status !== "idle")) {
        return "planning";
    }
    if (genTask.grade) return "confirming";
    if (genTask.preflightStage === "clarify") {
        return genTask.moreInputHint ? "awaiting_input" : "clarifying";
    }
    if (genTask.preflightStage === "grade") return "grading";
    return "";
}

/** 手动重试：FileGen 前优先用原 taskId + stage requestId 对账，不重复执行 mode1。 */
export function retryGenerate() {
    const params = lastGenParams
        || (genTask.userPrompt ? { userPrompt: genTask.userPrompt, coreType: genTask.coreType, version: genTask.version } : null);
    if (genTask.phase === "interrupted" && genTask.taskId) {
        resumeGenerate().catch(() => { });
        return;
    }
    const interruptedResume = genTask.phase === "interrupted" ? genTask.interruptedFrom : "";
    const resumePhase = genTask.taskId && genTask.files.length === 0
        ? (interruptedResume || getPreFileResumePhase())
        : "";
    if (params && genTask.taskId && genTask.files.length === 0) {
        if (resumePhase) {
            genTask.phase = resumePhase;
            clearGenerateError();
            genTask.logs.push("↻ 使用现有任务恢复 FileGen 前置阶段，不重复创建任务");
            persistGenTaskNow();
            startGenerate(params.userPrompt, params.coreType, params.version, { resumePrepared: true }).catch(() => { });
        } else {
            setGenerateError(
                new Error("当前任务缺少可恢复的 requestId；为避免重复计费，未自动新建任务。"),
                "warning",
            );
            persistGenTaskNow();
        }
        return;
    }
    if (params) {
        startGenerate(params.userPrompt, params.coreType, params.version).catch(() => { });
    } else if (genTask.taskId) {
        resumeGenerate().catch(() => { });
    }
}

/** 刷新恢复：genTask 已由 restoreGenTask 还原，据当前阶段续跑，避免刷新即失败。 */
export async function resumeGenerate() {
    if (genTask.phase === "interrupted" && !genTask.taskId) {
        const params = lastGenParams
            || (genTask.userPrompt
                ? {userPrompt: genTask.userPrompt, coreType: genTask.coreType, version: genTask.version}
                : null);
        if (!params?.userPrompt || !params.coreType || !params.version) {
            setGenerateError(
                new Error("当前任务缺少重新创建所需的需求信息，请重新提交需求。"),
                "warning",
            );
            persistGenTaskNow();
            return;
        }
        await startGenerate(params.userPrompt, params.coreType, params.version);
        return;
    }
    if (genTask.phase === "interrupted") {
        if (!genTask.interruptedFrom) return;
        genTask.phase = genTask.interruptedFrom;
        genTask.interruptedFrom = "";
    }
    const p = genTask.phase;
    if (!genTask.taskId || ["idle", "done", "error", "interrupted"].includes(p)) return;

    if (!genTask.files.length
        && ["clarifying", "awaiting_input", "grading", "confirming", "planning"].includes(p)
        && genTask.userPrompt) {
        genTask.logs.push(p === "planning"
            ? "↻ 页面恢复：继续联网查证与项目规划"
            : "↻ 页面恢复：使用原 taskId 与前置 requestId 继续对账");
        await startGenerate(genTask.userPrompt, genTask.coreType, genTask.version, { resumePrepared: true });
        return;
    }

    beginGenerationRun();
    const resumeRunId = generationRunId;
    const recordResumeFailure = (error: any) => {
        if (!isGenerationRunCurrent(resumeRunId)) return;
        if (isInterrupt(error)) {
            markInterrupted(genTask.phase === "interrupted" ? genTask.interruptedFrom : genTask.phase);
            return;
        }
        setGenerateError(error);
        genTask.logs.push("× " + genTask.error);
        persistGenTaskNow();
    };

    // 已触发构建的阶段只恢复轮询，避免刷新后重复建分支、重复触发 workflow。
    if (["building", "polling"].includes(p)) {
        try { await buildWithRetry(undefined, undefined, true); }
        catch (e: any) { recordResumeFailure(e); }
        return;
    }
    const hasRecoverableFixLearning = genTask.learningProgress.stage === "fix"
        && !!genTask.learningProgress.jobId
        && (!LEARNING_TERMINAL.has(genTask.learningProgress.status)
            || isUnconfirmedLearningProgress(genTask.learningProgress));
    const restoringFixStage: FixResumeStage = p === "fixing"
        ? genTask.fixResumeStage || (hasRecoverableFixLearning ? "learning" : "")
        : "";
    if (restoringFixStage) {
        try {
            genTask.fixResumeStage = restoringFixStage;
            persistGenTaskNow();
            await resumeFixingStage(genTask.taskId, restoringFixStage);
        } catch (e: any) {
            if (isGenerationRunCurrent(resumeRunId)) genTask.fixResumeStage = "";
            recordResumeFailure(e);
        }
        return;
    }

    // uploading 阶段优先复用已持久化的请求 ID，继续同一次服务端启动流程。
    if (p === "uploading") {
        try { await buildWithRetry(undefined, undefined, !!genTask.buildRequestId); }
        catch (e: any) { recordResumeFailure(e); }
        return;
    }
    if (p === "fixing") {
        try { await buildWithRetry(); }
        catch (e: any) { recordResumeFailure(e); }
        return;
    }

    // 无法识别的旧快照不自动重跑 mode1，避免重复创建并计费。
    if (!genTask.files.length) {
        setGenerateError(
            new Error("当前任务缺少可恢复的前置阶段信息，请重新开始生成。"),
            "warning",
        );
        return;
    }

    // 生成/校验阶段（plan 已完成、有 files）：续跑桶循环（后端 fileStatuses 天然可续）→ 校验 → 构建
    try {
        genTask.logs.push("↻ 从刷新中断处继续生成…");
        setPhase("generating", "从中断处继续生成…");

        const bucketMap = new Map<number, number>();
        for (const f of genTask.files) { const b = f.bucket ?? 0; bucketMap.set(b, (bucketMap.get(b) ?? 0) + 1); }
        const sortedBucketIds = [...bucketMap.keys()].sort((a, b) => a - b);
        const learningToolJobs: Record<string, string> = {};

        for (const bucketIndex of sortedBucketIds) {
            let bucketDone = false, guard = 0, noProgress = 0;
            const guardLimit = Math.max(80, (bucketMap.get(bucketIndex) ?? 1) * 16 + 20);
            const doneCount = () => genTask.files.filter(f => f.status === "done").length;
            while (!bucketDone) {
                if (guard++ > guardLimit) throw new Error("续跑阶段过多，请重试");
                const doneBefore = doneCount();
                let bucketResult: any = null;
                for (let bAttempt = 0; bAttempt < 2 && !bucketResult; bAttempt++) {
                    try {
                        bucketResult = await streamBucketGeneration(genTask.taskId, bucketIndex, learningToolJobs);
                    }
                    catch (error: any) {
                        if (isInterrupt(error)) throw error;
                        if (error?.noRetry || error?.terminal) throw error;
                        bucketResult = null;
                    }
                }
                if (!bucketResult) {
                    if (doneCount() > doneBefore) { noProgress = 0; continue; }
                    if (++noProgress >= 5) throw new Error("续跑连续零进度，请重试");
                    await waitWithAbort(1_500, generationSignal());
                    continue;
                }
                if (bucketResult.replan) throw new Error("续跑仍未通过审查，请重试");
                if (await runModelLearningToolRequests(bucketResult.learningToolRequests, learningToolJobs)) {
                    noProgress = 0;
                    continue;
                }
                for (const c of bucketResult.completed || []) {
                    const f = genTask.files.find(x => x.path === c.path);
                    if (f) { f.content = c.content; f.status = "done"; }
                }
                syncCurrentIndex();
                bucketDone = !!bucketResult.bucketDone;
                const progressed = bucketResult.progressed === true
                    || doneCount() > doneBefore
                    || bucketDone;
                if (!progressed) {
                    if (++noProgress >= 5) {
                        throw new Error("生成服务连续未推进，阶段进度已保存，请稍后重试");
                    }
                    const retryAfterMs = Math.max(500, Math.min(5_000, Number(bucketResult.retryAfterMs) || 1_500));
                    await waitWithAbort(retryAfterMs, generationSignal());
                    continue;
                }
                noProgress = 0;
                if (bucketResult.done) break;
            }
        }

        setPhase("verifying", "正在校验文件完整性…");
        let verifyResult = await post("/api/generate/verify", { taskId: genTask.taskId });
        for (let retry = 0; retry < 2 && !verifyResult.verified; retry++) {
            const missingList = verifyResult.missing as string[];
            await post("/api/generate/verify", { taskId: genTask.taskId, fixMissing: true });
            setPhase("generating");
            for (const mp of missingList) {
                genTask.logs.push(`↻ 补生成 ${mp}`);
                const fileResult = await streamFileGeneration(genTask.taskId);
                if (!fileResult || fileResult.done) break;
            }
            verifyResult = await post("/api/generate/verify", { taskId: genTask.taskId });
        }
        if (!verifyResult.verified) throw new Error(`文件校验失败，缺失 ${verifyResult.missing.length} 个文件`);

        await buildWithRetry();
    } catch (e: any) {
        recordResumeFailure(e);
    }
}

export async function startGenerate(
    userPrompt: string,
    coreType: string,
    version: string,
    options?: { resumePrepared?: boolean },
) {
    const resumePrepared = options?.resumePrepared === true;
    const resumePhase: GenPhase | "" = resumePrepared ? genTask.phase : "";
    if (!resumePrepared && isGeneratingPhase(genTask.phase)) {
        throw new Error("当前已有构建任务正在进行");
    }
    beginGenerationRun();
    const runId = generationRunId;
    let chosenPathId: string | undefined = resumePrepared ? genTask.chosenPathId || undefined : undefined;

    if (!resumePrepared) {
        lastGenParams = { userPrompt, coreType, version };

        resetGenTask();
        genTask.userPrompt = userPrompt;
        genTask.coreType = coreType;
        genTask.version = version;

        // ── Phase 1: create taskId (mode1, only for a genuinely new task) ──
        try {
            setPhase("planning", "正在创建任务...");
            const initResult = await post("/api/generate/plan", { userPrompt, coreType, version, skillIds: [...selected] });
            genTask.taskId = initResult.taskId;
            fetchMe(); // 扣费后刷新顶栏剩余额度
        } catch (e: any) {
            if (!isGenerationRunCurrent(runId)) return;
            if (isInterrupt(e)) {
                markInterrupted("planning");
                return;
            }
            setGenerateError(e);
            genTask.logs.push("× " + genTask.error);
            return;
        }
    }

    const resumeFromClarify = resumePhase === "clarifying" || resumePhase === "awaiting_input";
    if (!resumePrepared || resumeFromClarify) {
        try {
            if (!resumePrepared) setPhase("clarifying", "进入澄清阶段，请回答问题...");
            await runClarifyStage(resumeFromClarify ? resumePhase : "");
        } catch (e: any) {
            if (!isGenerationRunCurrent(runId)) {
                if (isInterrupt(e)) fetchMe();
                return;
            }
            if (isInterrupt(e)) {
                markInterrupted(genTask.phase === "interrupted" ? genTask.interruptedFrom : "clarifying");
                fetchMe();
                return;
            }
            setGenerateError(e);
            genTask.logs.push("× " + genTask.error);
            persistGenTaskNow();
            return;
        }
    }

    const resumeFromGrade = resumePhase === "grading" || resumePhase === "confirming";
    if (!resumePrepared || resumeFromClarify || resumeFromGrade) {
        try {
            const selectedPathId = await runGradeStage(resumeFromGrade ? resumePhase : "");
            if (selectedPathId !== undefined) chosenPathId = selectedPathId;
        } catch (e: any) {
            if (!isGenerationRunCurrent(runId)) {
                if (isInterrupt(e)) fetchMe();
                return;
            }
            if (isInterrupt(e)) {
                markInterrupted(genTask.phase === "interrupted" ? genTask.interruptedFrom : "grading");
                fetchMe();
                return;
            }
            // 未收到明确 terminal result 时禁止静默跳过分级进入 Planner。
            setGenerateError(e);
            genTask.logs.push("× " + genTask.error);
            persistGenTaskNow();
            return;
        }
    }

    chosenPathId = genTask.chosenPathId || chosenPathId;

    // Learning 的触发权交给后续 DS coding agent；这里仅进入规划，不再根据 Grader 结果抢跑。
    setPhase("planning", "开始规划；DS 可在需要精确外部 API 证据时主动调用 Learning...");

    // ── Phase 3: planning + generating + build (with replan loop) ──
    const firstPlannerAttempt = resumePrepared && genTask.plannerRequestId
        ? Math.min(
            MAX_REPLAN_ATTEMPTS,
            genTask.plannerReplan ? Math.max(1, genTask.plannerAttempt) : 0,
        )
        : 0;
    for (let replanAttempt = firstPlannerAttempt; replanAttempt <= MAX_REPLAN_ATTEMPTS; replanAttempt++) {
        try {
            if (replanAttempt > 0) {
                genTask.logs.push(`↻ 第 ${replanAttempt} 次重新规划，从头开始生成...`);
                genTask.files = [];
                genTask.currentIndex = 0;
                clearGenerateError();
            }

            setPhase("planning", replanAttempt === 0
                ? "正在根据澄清结果生成项目规划..."
                : `正在重新规划 (第${replanAttempt}次)...`);

            const plannerReplan = replanAttempt > 0;
            const reusePendingRequest = genTask.plannerRequestId
                && genTask.plannerReplan === plannerReplan
                && genTask.plannerAttempt === replanAttempt;
            const plannerRequestId = reusePendingRequest
                ? genTask.plannerRequestId
                : createPlannerRequestId();
            genTask.plannerRequestId = plannerRequestId;
            genTask.plannerReplan = plannerReplan;
            genTask.plannerAttempt = replanAttempt;
            // 必须在请求发出前同步落盘；刷新后才能复用同一 replan 意图与幂等 ID。
            persistGenTaskNow();

            const plannerLearningToolJobs: Record<string, string> = {};
            let planResult: any;
            for (let plannerToolTurn = 0; ; plannerToolTurn++) {
                if (plannerToolTurn > 4) {
                    throw new Error("Planner Learning 工具恢复次数超过安全上限");
                }
                planResult = await postPlanner({
                    taskId: genTask.taskId,
                    chosenPathId,
                    skillIds: [...selected],
                    replan: plannerReplan,
                    plannerRequestId,
                    learningToolJobs: plannerLearningToolJobs,
                });
                if (!await runModelLearningToolRequests(
                    planResult?.learningToolRequests,
                    plannerLearningToolJobs,
                )) break;
                setPhase("planning", "Learning 已返回，Planner 继续规划...");
            }
            genTask.projectName = planResult.projectName;
            genTask.packageName = planResult.packageName;
            genTask.javaVersion = planResult.javaVersion;
            genTask.files = planResult.plan.map((f: any) => ({
                path: f.path,
                role: f.role,
                status: "pending",
                generatorType: f.generatorType,
                tag: f.tag ?? null,
                pairPath: f.pairPath,
                bucket: f.bucket,
            }));
            syncCurrentIndex();
            genTask.plannerRequestId = "";
            genTask.plannerReplan = false;
            genTask.plannerAttempt = 0;
            genTask.logs.push(`● 项目规划完成，共 ${genTask.files.length} 个文件`);
            persistGenTaskNow();

            setPhase("generating");
            // 收集 buckets：每个 file 自带 bucket 索引；按桶号升序并发
            const bucketMap = new Map<number, number>();
            for (const f of genTask.files) {
                const b = f.bucket ?? 0;
                bucketMap.set(b, (bucketMap.get(b) ?? 0) + 1);
            }
            const sortedBucketIds = [...bucketMap.keys()].sort((a, b) => a - b);
            const learningToolJobs: Record<string, string> = {};
            let needReplan = false;

            let allBucketsDone = false;
            outer: for (const bucketIndex of sortedBucketIds) {
                if (needReplan) break;
                // 桶按持久化阶段推进：每次请求每个目标最多一次模型调用，阶段完成后立即落盘。
                // 流中断时重试同一桶，服务端从 checkpoint 继续。
                let bucketDone = false;
                let guard = 0;
                let noProgress = 0;
                const guardLimit = Math.max(80, (bucketMap.get(bucketIndex) ?? 1) * 16 + 20);
                const doneCount = () => genTask.files.filter(f => f.status === "done").length;
                while (!bucketDone) {
                    if (guard++ > guardLimit) { // 安全阀，防意外死循环
                        throw new Error(`桶 #${bucketIndex} 阶段推进次数异常，已保留当前进度`);
                    }
                    // 单阶段重试一次；服务端会从已持久化检查点继续。
                    const doneBefore = doneCount();
                    let bucketResult: any = null;
                    for (let bAttempt = 0; bAttempt < 2 && !bucketResult; bAttempt++) {
                        try {
                            bucketResult = await streamBucketGeneration(genTask.taskId, bucketIndex, learningToolJobs);
                        } catch (be: any) {
                            if (isInterrupt(be)) throw be;
                            if (be?.noRetry || be?.terminal) throw be;
                            const m = be?.name === "AbortError" ? "超时" : (be?.message || String(be));
                            genTask.logs.push(`× 桶 #${bucketIndex} 批次中断（${m}）${bAttempt === 0 ? "，重试一次..." : ""}`);
                            bucketResult = null;
                        }
                    }
                    if (!bucketResult) {
                        // 流被切断不等于生成失败；直接重试同一阶段，禁止用重新规划覆盖已有进度。
                        if (doneCount() > doneBefore) {
                            noProgress = 0;
                            genTask.logs.push(`· 桶 #${bucketIndex} 连接中断但已落地文件，继续恢复...`);
                            continue;
                        }
                        if (++noProgress >= 5) {
                            throw new Error(`桶 #${bucketIndex} 连续连接中断，阶段进度已保存，请稍后重试`);
                        }
                        genTask.logs.push(`· 桶 #${bucketIndex} 当前阶段无返回（${noProgress}/5），继续恢复...`);
                        await waitWithAbort(1_500, generationSignal());
                        continue;
                    }
                    if (bucketResult.replan) { needReplan = true; break; }
                    if (await runModelLearningToolRequests(bucketResult.learningToolRequests, learningToolJobs)) {
                        noProgress = 0;
                        continue;
                    }
                    // 服务端每次返回该桶已落盘的完成文件，可修复“落盘后断流”造成的前端状态缺口。
                    for (const c of bucketResult.completed || []) {
                        const f = genTask.files.find(x => x.path === c.path);
                        if (f) { f.content = c.content; f.status = "done"; }
                    }
                    syncCurrentIndex();
                    bucketDone = !!bucketResult.bucketDone;
                    const progressed = bucketResult.progressed === true
                        || doneCount() > doneBefore
                        || bucketDone;
                    if (!progressed) {
                        if (++noProgress >= 5) {
                            throw new Error(`桶 #${bucketIndex} 连续未推进，阶段进度已保存，请稍后重试`);
                        }
                        const retryAfterMs = Math.max(500, Math.min(5_000, Number(bucketResult.retryAfterMs) || 1_500));
                        genTask.logs.push(`· 桶 #${bucketIndex} 当前阶段暂未推进（${noProgress}/5），稍后重试...`);
                        await waitWithAbort(retryAfterMs, generationSignal());
                        continue;
                    }
                    noProgress = 0;
                    if (bucketResult.done) { allBucketsDone = true; break outer; }
                }
                if (needReplan) break;
            }
            void allBucketsDone;

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
            if (!isGenerationRunCurrent(runId)) return;
            if (isInterrupt(e)) {
                markInterrupted(genTask.phase === "interrupted" ? genTask.interruptedFrom : genTask.phase);
                return;
            }
            if (replanAttempt >= MAX_REPLAN_ATTEMPTS) {
                setGenerateError(e);
                genTask.logs.push("× " + genTask.error);
                return;
            }
            // If error is not from replan, don't retry
            if (!e.message?.includes("重新规划")) {
                setGenerateError(e);
                genTask.logs.push("× " + genTask.error);
                return;
            }
        }
    }
}

type BuildMeta = {
    javaVersion?: string;
    projectName?: string;
    packageName?: string;
    coreType?: string;
    version?: string;
};

async function buildWithRetry(
    initialFiles?: { path: string; content: string }[],
    meta?: BuildMeta,
    resumeExistingBuild = false,
) {
    for (let attempt = 0; attempt <= MAX_FIX_ATTEMPTS; attempt++) {
        const reuseExisting = resumeExistingBuild && attempt === 0;
        let buildResult: any = null;
        if (reuseExisting && genTask.buildRequestId) {
            setPhase("uploading", "正在恢复已有构建启动请求...");
            genTask.logs.push("↻ 页面恢复：使用原 build request ID 对账，不重复触发 workflow");
            buildResult = await post("/api/generate/build", {
                taskId: genTask.taskId,
                buildRequestId: genTask.buildRequestId,
            });
        } else if (reuseExisting) {
            setPhase("building", "正在恢复已有构建的状态...");
            genTask.logs.push("↻ 页面恢复：继续等待已有构建，不重复触发 workflow");
        } else {
            setPhase("uploading", "正在上传到 GitHub 并触发构建...");
            const buildRequestId = createBuildRequestId();
            genTask.buildRequestId = buildRequestId;
            persistGenTaskNow();
            const payload: any = {
                taskId: genTask.taskId,
                buildRequestId,
            };
            // 首次构建带上 IDE 的最新内容 + 元数据（供 KV 任务过期后重建）；
            // 后续 fix 后重建用 KV 里已被 fix 改过的版本
            if (attempt === 0 && initialFiles) {
                payload.files = initialFiles;
                if (meta) payload.meta = meta;
            }
            buildResult = await post("/api/generate/build", payload);
        }

        if (buildResult) {
            if (genTask.fixResumeStage === "rebuilding") {
                genTask.fixResumeStage = "";
                persistGenTaskNow();
            }
            // 从 IDE 进来的场景：填上 GenerateProgress 头部要展示的 meta
            if (!genTask.projectName && buildResult.projectName) genTask.projectName = buildResult.projectName;
            if (!genTask.packageName && buildResult.packageName) genTask.packageName = buildResult.packageName;
            if (!genTask.javaVersion && buildResult.javaVersion) genTask.javaVersion = buildResult.javaVersion;
            genTask.logs.push(`构建已确认 (run #${buildResult.runId || "pending"})`);
        }

        setPhase("building", "正在等待 GitHub Actions 构建...");
        const buildOk = await pollBuildStatus();

        if (buildOk) return; // success

        // 每次失败都抓取结构化诊断；最后一次只检查、不再调用模型修改。
        const canRepair = attempt < MAX_FIX_ATTEMPTS;
        if (canRepair) {
            genTask.logs.push(`! 构建失败，尝试自动修复 (第${attempt + 1}次)...`);
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
        genTask.logs.push(`● 已修改 ${changed} 个文件，开始重新构建验证...`);
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
            genTask.logs.push(`构建中... (${result.runStatus || "queued"})`);
        }
        i++;
    }
    throw new Error("构建超时");
}

export function getDownloadUrl(): string {
    return `/api/generate/download?taskId=${genTask.taskId}`;
}

/**
 * 从 IDE 直接触发构建（跳过 chat/plan/clarify/file gen 阶段）。
 * 调用者负责先 hydrate genTask（taskId/files/phase），然后此函数走 build + fix 重试链路。
 */
export async function startBuildFromIDE(
    files: { path: string; content: string }[],
    meta?: BuildMeta,
) {
    beginGenerationRun();
    const runId = generationRunId;
    try {
        await buildWithRetry(files, meta);
    } catch (e: any) {
        if (!isGenerationRunCurrent(runId)) return;
        if (isInterrupt(e)) {
            markInterrupted(genTask.phase);
            return;
        }
        setGenerateError(e);
        genTask.logs.push("× " + genTask.error);
    }
}

// ── 增量补充：生成完成后，在现有项目上加功能 / 改需求（单次 LLM + 编译兜底）──
const APPEND_SYSTEM = `你是在【现有 Minecraft Paper/Bukkit 插件项目】上做【增量加功能 / 改需求】的助手。
用户会给出当前项目的全部文件内容与一条追加需求。你只输出需要【新建或修改】的文件，不要输出无关文件。

【输出格式】严格遵守，不要任何解释/标题，直接输出文件块：
FILE create src/main/java/包名/Xxx.java
\`\`\`java
完整文件内容
\`\`\`
（已存在的文件用 FILE edit <原路径> + 代码块）
- content 永远是完整文件，绝不输出 diff 或片段。
- 可同时改多个文件（如：新增命令类 + 编辑 Main 注册 + 编辑 plugin.yml + 必要时编辑 pom.xml）。

【规则】
- 严格沿用现有包名、代码风格、命名；不要顺手重构与追加需求无关的文件。
- 新命令必须在 plugin.yml 的 commands 节点声明，并在 Main.onEnable 注册 Executor/TabCompleter；新监听在 Main 注册 registerEvents。
- 颜色码：yml 用 §，Java 用 ChatColor；不强转主类（用 Bukkit.getPluginManager().getPlugin(名称)）。
- 持久化只用 YAML / PDC，禁止 SQL/数据库；最简实现。
- 若需引入第三方库，必须同时 edit pom.xml 加依赖（compile + maven-shade）。`;

export async function appendFeature(appendText: string) {
    const text = appendText.trim();
    if (!text) return;
    if (genTask.phase !== "done" || !genTask.files.length) return;

    beginGenerationRun();
    const appendRunId = generationRunId;
    try {
        const signal = generationSignal();
        const runId = generationRunId;
        clearGenerateError();
        setPhase("generating", `▸ 增量需求：${text.slice(0, 50)}`);
        genTask.streamingPhase = "generating";
        genTask.streamingFile = "增量分析中";
        genTask.streamingContent = "";

        // 拼现有项目上下文（清单 + 各文件全文）
        const fileList = genTask.files.map(f => `- ${f.path}${f.role ? `  // ${f.role}` : ""}`).join("\n");
        const fileBodies = genTask.files
            .filter(f => f.content)
            .map(f => {
                const ext = f.path.split(".").pop() || "";
                return `FILE ${f.path}\n\`\`\`${ext}\n${f.content}\n\`\`\``;
            }).join("\n\n");
        const user = `【当前项目文件清单】\n${fileList}\n\n【当前所有文件内容】\n${fileBodies}\n\n【追加需求】\n${text}`;

        const resp = await fetchWithByokFallback("/api/stream", {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({
                model: "deepseek-v4-pro",
                taskId: genTask.taskId || undefined,
                purpose: "append",
                projectContext: {
                    coreType: genTask.coreType,
                    version: genTask.version,
                    pomContent: genTask.files.find(f => /(^|\/)pom\.xml$/i.test(f.path))?.content || "",
                },
                messages: [
                    { role: "system", content: APPEND_SYSTEM },
                    { role: "user", content: user },
                ],
                stream: true,
            }),
            signal,
        });
        assertGenerationRun(runId);
        await rejectAccessResponse(resp);
        if (!resp.ok) throw await responseError(resp);
        if (!resp.body) throw new Error("无响应流");

        // 读 DeepSeek 原生 SSE（透传），收集 content
        const reader = resp.body.getReader();
        const decoder = new TextDecoder();
        let buffer = "";
        let full = "";
        outer: while (true) {
            const { value, done } = await reader.read();
            if (done) break;
            buffer += decoder.decode(value, { stream: true });
            const lines = buffer.split("\n");
            buffer = lines.pop() ?? "";
            for (const line of lines) {
                const t = line.trim();
                if (!t.startsWith("data:")) continue;
                const payload = t.slice(5).trim();
                if (payload === "[DONE]") break outer;
                let event: any;
                try {
                    event = JSON.parse(payload);
                } catch { continue; }
                assertGenerationRun(runId);
                if (event?.type === "error" || (event?.type === "result" && event?.error)) {
                    rejectAccessEvent(event);
                    const message = typeof event?.error === "string"
                        ? event.error
                        : (event?.error?.message || event?.message || "流式请求失败");
                    throw new Error(message);
                }
                const chunk = event?.choices?.[0]?.delta?.content ?? "";
                if (chunk) { full += chunk; genTask.streamingContent = full; }
            }
        }
        genTask.streamingPhase = "";
        genTask.streamingContent = "";
        fetchMe(); // 刷新顶栏额度

        // 解析 FILE 块，应用到 genTask.files
        const existing = new Set(genTask.files.map(f => f.path));
        const parsed = parseResponse(full, existing);
        if (!parsed.files.length) {
            genTask.logs.push("! 追加需求未产出文件改动" + (parsed.reply ? `：${parsed.reply.slice(0, 80)}` : ""));
            setPhase("done", "● 无改动");
            return;
        }
        for (const fa of parsed.files) {
            const exist = genTask.files.find(f => f.path === fa.path);
            if (exist) {
                exist.content = fa.content;
                exist.status = "done";
                genTask.logs.push(`✎ 修改 ${fa.path}`);
            } else {
                genTask.files.push({
                    path: fa.path,
                    role: "追加：" + text.slice(0, 16),
                    content: fa.content,
                    status: "done",
                });
                genTask.logs.push(`＋ 新增 ${fa.path}`);
            }
        }

        // 重新编译（startBuildFromIDE 内部驱动 uploading/building/done/error）
        await startBuildFromIDE(
            genTask.files.filter(f => f.content).map(f => ({ path: f.path, content: f.content! })),
            {
                javaVersion: genTask.javaVersion,
                projectName: genTask.projectName,
                packageName: genTask.packageName,
                coreType: genTask.coreType,
                version: genTask.version,
            },
        );
    } catch (e: any) {
        if (!isGenerationRunCurrent(appendRunId)) return;
        if (isInterrupt(e)) {
            markInterrupted(genTask.phase);
            return;
        }
        genTask.streamingPhase = "";
        genTask.streamingContent = "";
        setGenerateError(e);
        genTask.logs.push("× 追加失败：" + genTask.error);
    }
}
