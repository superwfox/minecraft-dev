import { graderPrompt, skillClarifyContext } from "../../_lib/prompts";
import { enforceLevelFloor, type ScoreVector, type Level } from "../../_lib/complexity";
import { settleTaskCostQuota, usageCost, type UsageBreakdown } from "../../_lib/quota";
import { deepSeekKeyRequiredResponse, resolveTaskLLM } from "../../_lib/llm";
import { assessKnowledgeNeeds, filterPlannerKnowledgeNeeds } from "../../_lib/learning/assessment";
import {
    acquireTaskOperationLease,
    getOwnedTask,
    markTaskQuotaExhausted,
    putTaskWithOperationLease,
    putTaskWithOperationLeaseAndCost,
    releaseTaskOperationLease,
    renewTaskOperationLease,
    type TaskOperationLeaseMode,
} from "../../_lib/taskStore";
import {
    assertOpenAIResponse,
    consumeOpenAIChatStream,
    OpenAIStreamProtocolError,
    OpenAIUpstreamHttpError,
} from "../../_lib/openAIStream";
import {
    activePreflightOperation,
    appendPreflightOperation,
    findPreflightOperation,
    parsePreflightRequestId,
    preflightInputHash,
    preflightJsonError,
    preflightOperations,
    replayPreflightResult,
} from "../../_lib/preflightOperations";
import {
    abortOnWriteFailure,
    isClientCancelled,
    linkAbortSignal,
    linkClientAbortSignal,
} from "../../_lib/clientAbort";
import {
    assertPreflightActive,
    createPreflightDeadline,
    createPreflightIdleDeadline,
    isPreflightTimeout,
    PREFLIGHT_LEASE_MS,
    PREFLIGHT_LEASE_RENEW_MS,
    PREFLIGHT_OPERATION_MS,
    PREFLIGHT_STATE_FINALIZE_MS,
    PREFLIGHT_TERMINAL_WRITE_MS,
    PREFLIGHT_UPSTREAM_IDLE_MS,
    type PreflightDeadline,
    withPreflightDeadline,
} from "../../_lib/preflightDeadline";

const GRADE_TIMEOUT_MESSAGE = "复杂度分级处理超时";

interface Env {
    DB?: D1Database;
    DEEPSEEK_API_KEY: string;
    TASKS: KVNamespace;
}

class GradeLeaseLostError extends Error {
    constructor() {
        super("Grade execution lease was lost");
        this.name = "GradeLeaseLostError";
    }
}

function stripFences(raw: string): string {
    return raw.replace(/^```[\w]*\n?/, "").replace(/\n?```\s*$/, "").trim();
}

function sseEvent(encoder: TextEncoder, data: any): Uint8Array {
    return encoder.encode(`data: ${JSON.stringify(data)}\n\n`);
}

async function writeSSE(
    writer: WritableStreamDefaultWriter<Uint8Array>,
    encoder: TextEncoder,
    data: any,
    operationAbort: AbortController,
    signal: AbortSignal,
): Promise<void> {
    try {
        await withPreflightDeadline(
            () => writer.write(sseEvent(encoder, data)),
            signal,
            "复杂度分级响应写入超时",
        );
    } catch (error) {
        if (isClientCancelled(error)) throw error;
        if (signal.aborted) assertPreflightActive(signal, "复杂度分级响应写入超时");
        abortOnWriteFailure(operationAbort, error, "Grade client disconnected");
    }
}

function normalizedGradeInput(body: any): Record<string, unknown> {
    const input: Record<string, unknown> = {};
    if (typeof body.correction === "string" && body.correction.trim()) {
        input.correction = body.correction.trim();
    }
    return input;
}

function hasExplicitGradeInput(body: any): boolean {
    return body.correction !== undefined;
}

async function callReasoner(
    url: string,
    key: string,
    model: string,
    system: string,
    user: string,
    parentSignal: AbortSignal,
    requireUsage: boolean,
    onThinking: (content: string) => Promise<void>,
    onOutput: (content: string) => Promise<void>,
): Promise<{ content: string; usage?: UsageBreakdown }> {
    const ctrl = new AbortController();
    const unlinkParent = linkAbortSignal(ctrl, parentSignal);
    const idleDeadline = createPreflightIdleDeadline(
        PREFLIGHT_UPSTREAM_IDLE_MS,
        "复杂度分级模型长时间无有效输出",
        ctrl.signal,
    );
    try {
        const resp = await withPreflightDeadline(() => fetch(url, {
            method: "POST",
            headers: { "Content-Type": "application/json", Authorization: `Bearer ${key}` },
            body: JSON.stringify({
                model,
                reasoning_effort: "high",
                thinking: { type: "enabled" },
                stream: true,
                stream_options: { include_usage: true },
                messages: [{ role: "system", content: system }, { role: "user", content: user }],
            }),
            signal: idleDeadline.signal,
        }), idleDeadline.signal, "复杂度分级模型连接超时");
        await withPreflightDeadline(
            () => assertOpenAIResponse(resp),
            idleDeadline.signal,
            "读取复杂度分级模型错误响应超时",
        );
        idleDeadline.arm();
        const streamed = await withPreflightDeadline(() => consumeOpenAIChatStream(resp, {
            requireUsage,
            onThinking: async content => {
                idleDeadline.arm();
                await onThinking(content);
            },
            onOutput: async content => {
                idleDeadline.arm();
                await onOutput(content);
            },
        }), idleDeadline.signal, "复杂度分级模型长时间无有效输出");
        return { content: streamed.content, usage: streamed.usage };
    } finally {
        idleDeadline.dispose();
        unlinkParent();
    }
}

function gradeError(error: unknown): {
    message: string;
    code: string;
    status: number;
    retryable: boolean;
    retryAfter?: number;
} {
    if (isClientCancelled(error)) {
        return {
            message: "复杂度分级已取消",
            code: "CLIENT_CANCELLED",
            status: 499,
            retryable: false,
        };
    }
    if (error instanceof OpenAIUpstreamHttpError) {
        return {
            message: error.message,
            code: error.code,
            status: error.status,
            retryable: error.status !== 401,
            ...(error.status === 401 ? {} : { retryAfter: 2 }),
        };
    }
    if (error instanceof OpenAIStreamProtocolError) {
        return { message: error.message, code: error.code, status: 502, retryable: true, retryAfter: 2 };
    }
    if (error instanceof GradeLeaseLostError) {
        return {
            message: "复杂度分级执行权已失效，请重试当前请求",
            code: "GRADE_LEASE_LOST",
            status: 409,
            retryable: true,
            retryAfter: 2,
        };
    }
    if (isPreflightTimeout(error)) {
        return {
            message: GRADE_TIMEOUT_MESSAGE,
            code: "GRADE_TIMEOUT",
            status: 504,
            retryable: true,
            retryAfter: 2,
        };
    }
    return {
        message: error instanceof Error ? error.message : String(error),
        code: "GRADE_FAILED",
        status: 500,
        retryable: true,
        retryAfter: 2,
    };
}

function assertGradeOperationActive(signal: AbortSignal): void {
    assertPreflightActive(signal, GRADE_TIMEOUT_MESSAGE);
}

type GradeContext = Parameters<PagesFunction<Env>>[0];

async function handleGradeRequest(
    context: GradeContext,
    operationAbort: AbortController,
    operationDeadline: PreflightDeadline,
    handoffOperation: () => void,
    disposeOperation: () => void,
): Promise<Response> {
    const uid: string = (context.data as any)?.uid || "";
    const body = await withPreflightDeadline(
        () => context.request.json() as Promise<any>,
        operationDeadline.signal,
        "读取复杂度分级请求超时",
    );
    const taskId = typeof body.taskId === "string" ? body.taskId : "";
    const requestId = parsePreflightRequestId("grade", body.gradeRequestId);
    if (!requestId) {
        return preflightJsonError("缺少有效 gradeRequestId", "INVALID_GRADE_REQUEST_ID", 400);
    }

    const suppliedInput = normalizedGradeInput(body);
    const suppliedInputHash = await withPreflightDeadline(
        () => preflightInputHash(suppliedInput),
        operationDeadline.signal,
        "计算复杂度分级请求标识超时",
    );
    const hasExplicitInput = hasExplicitGradeInput(body);
    let raw = await withPreflightDeadline(
        () => getOwnedTask(context.env, taskId, uid),
        operationDeadline.signal,
        "读取复杂度分级任务状态超时",
    );
    if (!raw) return preflightJsonError("Task not found", "TASK_NOT_FOUND", 404);
    let state = JSON.parse(raw);
    const llm = await withPreflightDeadline(
        () => resolveTaskLLM(context, state),
        operationDeadline.signal,
        "解析复杂度分级模型配置超时",
    );
    if (!llm) return deepSeekKeyRequiredResponse();

    const immediateRecord = findPreflightOperation(state, "grade", requestId);
    if (immediateRecord && hasExplicitInput && immediateRecord.inputHash !== suppliedInputHash) {
        return preflightJsonError("同一 gradeRequestId 携带了不同输入", "GRADE_REQUEST_CONFLICT", 409);
    }
    if (immediateRecord?.status === "completed" && immediateRecord.billingSettled) {
        return replayPreflightResult("grade", immediateRecord);
    }
    if (immediateRecord?.status === "cancelled") {
        return preflightJsonError("复杂度分级请求已取消", "GRADE_CANCELLED", 409, undefined, {
            retryable: false,
        });
    }

    const leaseToken = `grade:${requestId}:${crypto.randomUUID().replace(/-/g, "")}`;
    let leaseMode: TaskOperationLeaseMode | null = null;
    let leaseReleased = false;
    let leaseReleasePromise: Promise<void> | null = null;
    let leaseRenewalStopped = true;
    let leaseRenewalTimer: ReturnType<typeof setInterval> | null = null;
    let leaseRenewalPromise: Promise<void> | null = null;
    const renewLease = (): Promise<void> => {
        if (!leaseMode
            || leaseReleased
            || leaseRenewalStopped
            || operationDeadline.signal.aborted) return Promise.resolve();
        if (leaseRenewalPromise) return leaseRenewalPromise;
        const renewalDeadline = createPreflightDeadline(
            PREFLIGHT_STATE_FINALIZE_MS,
            "续订复杂度分级执行权超时",
            operationAbort.signal,
        );
        const renewal = (async () => {
            try {
                const renewed = await withPreflightDeadline(
                    () => renewTaskOperationLease(
                        context.env,
                        taskId,
                        uid,
                        leaseToken,
                        PREFLIGHT_LEASE_MS,
                    ),
                    renewalDeadline.signal,
                    "续订复杂度分级执行权超时",
                );
                if (!renewed) throw new GradeLeaseLostError();
            } catch (error) {
                if (leaseRenewalStopped
                    || operationDeadline.signal.aborted
                    || operationAbort.signal.aborted) return;
                const leaseError = new GradeLeaseLostError();
                console.warn("grade lease renewal failed", error);
                operationAbort.abort(leaseError);
                throw leaseError;
            } finally {
                renewalDeadline.dispose();
            }
        })();
        leaseRenewalPromise = renewal;
        renewal.then(
            () => { if (leaseRenewalPromise === renewal) leaseRenewalPromise = null; },
            () => { if (leaseRenewalPromise === renewal) leaseRenewalPromise = null; },
        );
        return renewal;
    };
    const startLeaseRenewal = async () => {
        if (!leaseMode || leaseReleased) return;
        leaseRenewalStopped = false;
        await renewLease();
        if (leaseRenewalStopped
            || leaseReleased
            || operationDeadline.signal.aborted
            || operationAbort.signal.aborted) return;
        leaseRenewalTimer = setInterval(() => {
            void renewLease().catch(() => { /* operation signal carries lease loss */ });
        }, PREFLIGHT_LEASE_RENEW_MS);
    };
    const stopLeaseRenewal = () => {
        leaseRenewalStopped = true;
        if (leaseRenewalTimer) clearInterval(leaseRenewalTimer);
        leaseRenewalTimer = null;
    };
    const waitForLeaseRenewal = async () => {
        const pending = leaseRenewalPromise;
        if (!pending) return;
        try { await pending; } catch { /* operation signal carries lease loss */ }
    };
    const startLeaseRelease = (): Promise<void> => {
        if (!leaseMode || leaseReleased) return Promise.resolve();
        if (!leaseReleasePromise) {
            leaseReleasePromise = releaseTaskOperationLease(
                context.env,
                taskId,
                uid,
                leaseToken,
                leaseMode,
            ).then(
                released => {
                    leaseReleased = released;
                    if (!released) leaseReleasePromise = null;
                },
                error => {
                    leaseReleasePromise = null;
                    throw error;
                },
            );
        }
        return leaseReleasePromise;
    };
    const scheduleLeaseRelease = () => {
        stopLeaseRenewal();
        if (!leaseMode || leaseReleased) return;
        context.waitUntil((async () => {
            await waitForLeaseRenewal();
            if (leaseReleased) return;
            const cleanupDeadline = createPreflightDeadline(
                PREFLIGHT_STATE_FINALIZE_MS,
                "释放复杂度分级执行权超时",
            );
            try {
                await withPreflightDeadline(
                    startLeaseRelease,
                    cleanupDeadline.signal,
                    "释放复杂度分级执行权超时",
                );
            } catch (error) {
                console.warn("grade lease release failed", error);
            } finally {
                cleanupDeadline.dispose();
            }
        })());
    };
    try {
        leaseMode = await withPreflightDeadline(
            () => acquireTaskOperationLease(
                context.env,
                taskId,
                uid,
                leaseToken,
                PREFLIGHT_LEASE_MS,
            ),
            operationDeadline.signal,
            "获取复杂度分级执行权超时",
        );
    } catch (error) {
        if (isClientCancelled(error) || isPreflightTimeout(error)) throw error;
        console.warn("grade lease acquisition failed", error);
        return preflightJsonError("复杂度分级状态存储暂不可用", "GRADE_STORE_UNAVAILABLE", 503, 2);
    }

    if (!leaseMode) {
        const latestRaw = await withPreflightDeadline(
            () => getOwnedTask(context.env, taskId, uid),
            operationDeadline.signal,
            "读取复杂度分级恢复状态超时",
        );
        const latestState = latestRaw ? JSON.parse(latestRaw) : null;
        const latestRecord = latestState ? findPreflightOperation(latestState, "grade", requestId) : undefined;
        if (latestRecord && hasExplicitInput && latestRecord.inputHash !== suppliedInputHash) {
            return preflightJsonError("同一 gradeRequestId 携带了不同输入", "GRADE_REQUEST_CONFLICT", 409);
        }
        if (latestRecord?.status === "completed" && latestRecord.billingSettled) {
            return replayPreflightResult("grade", latestRecord);
        }
        if (latestRecord?.status === "cancelled") {
            return preflightJsonError("复杂度分级请求已取消", "GRADE_CANCELLED", 409, undefined, {
                retryable: false,
            });
        }
        return preflightJsonError(
            latestRecord ? "复杂度分级仍在执行" : "任务正在执行其他操作",
            latestRecord ? "GRADE_IN_PROGRESS" : "TASK_OPERATION_IN_PROGRESS",
            409,
            2,
        );
    }

    const persistState = async (
        release = false,
        signal = operationDeadline.signal,
    ) => {
        if (release) {
            stopLeaseRenewal();
            await waitForLeaseRenewal();
        }
        const committed = await withPreflightDeadline(
            () => putTaskWithOperationLease(
                context.env,
                taskId,
                JSON.stringify(state),
                leaseToken,
                leaseMode!,
                3600,
                uid,
                release,
            ),
            signal,
            "持久化复杂度分级状态超时",
        );
        if (!committed) throw new GradeLeaseLostError();
        if (release) leaseReleased = true;
    };

    try {
        await startLeaseRenewal();
        assertGradeOperationActive(operationDeadline.signal);
        raw = await withPreflightDeadline(
            () => getOwnedTask(context.env, taskId, uid),
            operationDeadline.signal,
            "重新读取复杂度分级任务状态超时",
        );
        assertGradeOperationActive(operationDeadline.signal);
        if (!raw) {
            scheduleLeaseRelease();
            return preflightJsonError("Task state unavailable", "TASK_STATE_UNAVAILABLE", 503, 2);
        }
        state = JSON.parse(raw);

        let record = findPreflightOperation(state, "grade", requestId);
        if (record && hasExplicitInput && record.inputHash !== suppliedInputHash) {
            scheduleLeaseRelease();
            return preflightJsonError("同一 gradeRequestId 携带了不同输入", "GRADE_REQUEST_CONFLICT", 409);
        }

        if (record?.status === "completed") {
            if (!record.billingSettled) {
                const settlement = await withPreflightDeadline(
                    () => settleTaskCostQuota(context.env, uid, taskId),
                    operationDeadline.signal,
                    "结算复杂度分级用量超时",
                );
                assertGradeOperationActive(operationDeadline.signal);
                state.totalCost = settlement.total;
                state.consumedQuota = settlement.consumed;
                state.quotaExhausted = settlement.outOfQuota || state.quotaExhausted;
                record.billingSettled = true;
                if (settlement.outOfQuota) {
                    await withPreflightDeadline(
                        () => markTaskQuotaExhausted(context.env, taskId, uid),
                        operationDeadline.signal,
                        "持久化复杂度分级配额状态超时",
                    );
                }
                await persistState(true);
                assertGradeOperationActive(operationDeadline.signal);
            } else {
                scheduleLeaseRelease();
            }
            return replayPreflightResult("grade", record);
        }
        if (record?.status === "cancelled") {
            scheduleLeaseRelease();
            return preflightJsonError("复杂度分级请求已取消", "GRADE_CANCELLED", 409, undefined, {
                retryable: false,
            });
        }
        if (record?.status === "retryable" && !record.billingSettled) {
            const settlement = await withPreflightDeadline(
                () => settleTaskCostQuota(context.env, uid, taskId),
                operationDeadline.signal,
                "结算待恢复的复杂度分级用量超时",
            );
            state.totalCost = settlement.total;
            state.consumedQuota = settlement.consumed;
            state.quotaExhausted = settlement.outOfQuota || state.quotaExhausted;
            record.billingSettled = true;
            if (settlement.outOfQuota) {
                await withPreflightDeadline(
                    () => markTaskQuotaExhausted(context.env, taskId, uid),
                    operationDeadline.signal,
                    "持久化待恢复的复杂度分级配额状态超时",
                );
            }
            await persistState(false);
            assertGradeOperationActive(operationDeadline.signal);
        }

        const enforcePreflightProtocol = Number(state.preflightProtocolVersion) >= 1;
        const clarifyOperations = enforcePreflightProtocol
            ? preflightOperations(state, "clarify")
            : [];
        const latestClarify = clarifyOperations[clarifyOperations.length - 1];
        if (latestClarify
            && latestClarify.status !== "cancelled"
            && (latestClarify.status !== "completed" || !latestClarify.billingSettled)) {
            scheduleLeaseRelease();
            return preflightJsonError(
                "存在尚未完成的需求确认请求，请恢复原请求",
                "CLARIFY_RECOVERY_REQUIRED",
                409,
                undefined,
                { activeRequestId: latestClarify.requestId },
            );
        }

        if (state.quotaExhausted && !llm.byok) {
            scheduleLeaseRelease();
            return preflightJsonError("充值额度已用尽", "QUOTA_EXHAUSTED", 402);
        }
        if (!state.clarifyDone || (enforcePreflightProtocol && !latestClarify)) {
            scheduleLeaseRelease();
            return preflightJsonError("澄清阶段尚未完成", "CLARIFY_NOT_COMPLETED", 409, 2);
        }

        const activeRecord = activePreflightOperation(state, "grade");
        if (activeRecord && activeRecord.requestId !== requestId) {
            scheduleLeaseRelease();
            return preflightJsonError(
                "存在尚未完成的复杂度分级请求，请恢复原请求",
                "GRADE_RECOVERY_REQUIRED",
                409,
                undefined,
                { activeRequestId: activeRecord.requestId },
            );
        }

        if (!record) {
            record = appendPreflightOperation(state, "grade", {
                requestId,
                inputHash: suppliedInputHash,
                input: suppliedInput,
                status: "running",
                billingSettled: false,
                startedAt: Date.now(),
            });
        } else {
            record.status = "running";
            delete record.lastError;
        }
        state.grade = null;
        state.knowledgeNeeds = [];
        await persistState(false);
        assertGradeOperationActive(operationDeadline.signal);

        assertGradeOperationActive(operationDeadline.signal);
        if (!llm.apiKey) {
            record.status = "retryable";
            record.lastError = "API key not configured";
            await persistState(true);
            return preflightJsonError(
                "API key not configured",
                "LLM_NOT_CONFIGURED",
                500,
                2,
                { retryable: true },
            );
        }

        const attemptBaselineRaw = JSON.stringify(state);
        const { readable, writable } = new TransformStream<Uint8Array>();
        const encoder = new TextEncoder();
        const writer = writable.getWriter();
        handoffOperation();
        const process = (async () => {
            let terminalDeadline: PreflightDeadline | null = null;
            const terminalSignal = () => {
                if (!terminalDeadline) {
                    terminalDeadline = createPreflightDeadline(
                        PREFLIGHT_TERMINAL_WRITE_MS,
                        "复杂度分级终态发送超时",
                    );
                }
                return terminalDeadline.signal;
            };
            const heartbeat = setInterval(() => {
                writeSSE(
                    writer,
                    encoder,
                    { type: "heartbeat", stage: "grade", t: Date.now() },
                    operationAbort,
                    operationDeadline.signal,
                ).catch(() => { /* operation signal carries timeout or cancellation */ });
            }, 12_000);
            let resultCommitted = false;
            let resultCommitPending = false;
            let usage: UsageBreakdown | undefined;
            const finalizeRetryableAttempt = async (
                lastError: string,
                label: "中断" | "失败",
            ) => {
                state = JSON.parse(attemptBaselineRaw);
                record = findPreflightOperation(state, "grade", requestId);
                if (!record) throw new GradeLeaseLostError();
                record!.status = "retryable";
                delete record!.completedAt;
                record!.lastError = lastError;
                delete record!.result;
                const costDelta = !llm.byok && usage
                    ? usageCost(llm.modelFor("pro"), usage)
                    : 0;
                record!.billingSettled = llm.byok || !usage;
                const finalizeDeadline = createPreflightDeadline(
                    PREFLIGHT_STATE_FINALIZE_MS,
                    `收口复杂度分级${label}状态超时`,
                );
                try {
                    const committed = await withPreflightDeadline(
                        () => putTaskWithOperationLeaseAndCost(
                            context.env,
                            taskId,
                            JSON.stringify(state),
                            leaseToken,
                            leaseMode!,
                            costDelta,
                            3600,
                            uid,
                            false,
                        ),
                        finalizeDeadline.signal,
                        `提交复杂度分级${label}状态超时`,
                    );
                    if (!committed) throw new GradeLeaseLostError();
                    if (!record!.billingSettled) {
                        const settlement = await withPreflightDeadline(
                            () => settleTaskCostQuota(context.env, uid, taskId),
                            finalizeDeadline.signal,
                            `结算复杂度分级${label}用量超时`,
                        );
                        state.totalCost = settlement.total;
                        state.consumedQuota = settlement.consumed;
                        state.quotaExhausted = settlement.outOfQuota || state.quotaExhausted;
                        record!.billingSettled = true;
                        if (settlement.outOfQuota) {
                            await withPreflightDeadline(
                                () => markTaskQuotaExhausted(context.env, taskId, uid),
                                finalizeDeadline.signal,
                                `持久化复杂度分级${label}配额状态超时`,
                            );
                        }
                        await persistState(false, finalizeDeadline.signal);
                    }
                } catch (finalizeError) {
                    const kind = label === "中断" ? "interrupted" : "failure";
                    console.warn(`grade ${kind} state finalization failed`, finalizeError);
                } finally {
                    finalizeDeadline.dispose();
                }
            };
            try {
                await writeSSE(
                    writer,
                    encoder,
                    { type: "phase", stage: "grade", phase: "grading" },
                    operationAbort,
                    operationDeadline.signal,
                );
                const correction = typeof record!.input.correction === "string"
                    ? record!.input.correction
                    : undefined;
                const skillCtx = state.skills?.length ? skillClarifyContext(state.skills) : "";
                const prompt = graderPrompt(
                    state.userPrompt,
                    state.coreType,
                    state.version,
                    state.clarifyRounds,
                    correction,
                    skillCtx,
                );
                const callRes = await callReasoner(
                    llm.url,
                    llm.apiKey,
                    llm.modelFor("pro"),
                    prompt.system,
                    prompt.user,
                    operationDeadline.signal,
                    !llm.byok,
                    content => writeSSE(
                        writer,
                        encoder,
                        { type: "reasoning", stage: "grade", content },
                        operationAbort,
                        operationDeadline.signal,
                    ),
                    content => writeSSE(
                        writer,
                        encoder,
                        { type: "delta", stage: "grade", content },
                        operationAbort,
                        operationDeadline.signal,
                    ),
                );
                usage = callRes.usage;
                assertGradeOperationActive(operationDeadline.signal);

                let parsed: any;
                try {
                    parsed = JSON.parse(stripFences(callRes.content));
                } catch {
                    parsed = null;
                }

                let result: Record<string, unknown>;
                if (!parsed) {
                    state.grade = {
                        vector: null,
                        level: "直接",
                        level_reason: "分级解析失败，按直接级处理",
                        paths: [],
                        gateRequired: false,
                        chosenPathId: null,
                        knowledgeNeeds: [],
                        learningRequired: false,
                        learningNeedCount: 0,
                    };
                    state.knowledgeNeeds = [];
                    state.logs.push("× 分级解析失败，按直接级继续");
                    result = {
                        direct: true,
                        level: "直接",
                        learningRequired: false,
                        learningNeedCount: 0,
                    };
                } else {
                    const seenPathIds = new Set<string>();
                    const paths = (Array.isArray(parsed.paths) ? parsed.paths : []).filter((path: any) => {
                        if (seenPathIds.size >= 3) return false;
                        const id = typeof path?.id === "string" ? path.id.trim() : "";
                        if (!/^[A-Za-z0-9_-]{1,80}$/.test(id) || seenPathIds.has(id)) return false;
                        path.id = id;
                        seenPathIds.add(id);
                        return true;
                    });
                    const assessment = assessKnowledgeNeeds(parsed.knowledgeNeeds, {
                        coreType: state.coreType,
                        mcVersion: state.version,
                        allowedPathIds: [...seenPathIds],
                    });
                    const vector = (parsed.vector ?? {}) as ScoreVector;
                    const plannerAssessment = filterPlannerKnowledgeNeeds(assessment.accepted, {
                        userPrompt: state.userPrompt,
                        externalDeps: Array.isArray(vector.external_deps) ? vector.external_deps : [],
                    });
                    const knowledgeNeeds = plannerAssessment.accepted;
                    const learningRequired = knowledgeNeeds.length > 0;
                    const level: Level = enforceLevelFloor(parsed.level, vector);
                    const gateRequired = level !== "直接" && paths.length > 0;
                    state.grade = {
                        vector,
                        level,
                        level_reason: parsed.level_reason || "",
                        paths,
                        gateRequired,
                        chosenPathId: null,
                        knowledgeNeeds,
                        learningRequired,
                        learningNeedCount: knowledgeNeeds.length,
                    };
                    state.knowledgeNeeds = knowledgeNeeds;
                    state.logs.push(`复杂度分级：${level}${parsed.level_reason ? "（" + parsed.level_reason + "）" : ""}`);
                    const rejectedNeedCount = assessment.rejected.length + plannerAssessment.rejected.length;
                    if (rejectedNeedCount) {
                        state.logs.push(`▸ 已忽略 ${rejectedNeedCount} 个不符合学习边界的知识候选`);
                    }
                    result = gateRequired
                        ? { direct: false, level, paths, learningRequired, learningNeedCount: knowledgeNeeds.length }
                        : { direct: true, level, learningRequired, learningNeedCount: knowledgeNeeds.length };
                }

                assertGradeOperationActive(operationDeadline.signal);
                record!.status = "completed";
                record!.result = result;
                record!.completedAt = Date.now();
                record!.billingSettled = llm.byok;
                delete record!.lastError;
                const costDelta = !llm.byok && usage
                    ? usageCost(llm.modelFor("pro"), usage)
                    : 0;
                const committed = await withPreflightDeadline(
                    () => {
                        resultCommitPending = true;
                        return putTaskWithOperationLeaseAndCost(
                            context.env,
                            taskId,
                            JSON.stringify(state),
                            leaseToken,
                            leaseMode!,
                            costDelta,
                            3600,
                            uid,
                            false,
                        ).then(
                            value => {
                                resultCommitPending = false;
                                if (value) resultCommitted = true;
                                return value;
                            },
                            error => {
                                resultCommitPending = false;
                                throw error;
                            },
                        );
                    },
                    operationDeadline.signal,
                    "提交复杂度分级结果超时",
                );
                if (!committed) throw new GradeLeaseLostError();
                if (!record!.billingSettled) {
                    const settlement = await withPreflightDeadline(
                        () => settleTaskCostQuota(context.env, uid, taskId),
                        operationDeadline.signal,
                        "结算复杂度分级用量超时",
                    );
                    state.totalCost = settlement.total;
                    state.consumedQuota = settlement.consumed;
                    state.quotaExhausted = settlement.outOfQuota || state.quotaExhausted;
                    record!.billingSettled = true;
                    if (settlement.outOfQuota) {
                        await withPreflightDeadline(
                            () => markTaskQuotaExhausted(context.env, taskId, uid),
                            operationDeadline.signal,
                            "持久化复杂度分级配额状态超时",
                        );
                    }
                    await persistState(false);
                }

                await writeSSE(
                    writer,
                    encoder,
                    { type: "result", stage: "grade", ...result },
                    operationAbort,
                    terminalSignal(),
                );
            } catch (error) {
                const cancelled = isClientCancelled(error) || isClientCancelled(operationAbort.signal.reason);
                if (cancelled && !resultCommitted) {
                    if (!resultCommitPending) {
                        await finalizeRetryableAttempt("传输连接已中断，可恢复当前请求", "中断");
                    }
                    return;
                }
                if (cancelled) return;
                const mapped = gradeError(error);
                if (!resultCommitted) {
                    if (resultCommitPending) {
                        mapped.code = "GRADE_FINALIZATION_PENDING";
                        mapped.status = 503;
                        mapped.retryable = true;
                        mapped.retryAfter = 2;
                    } else {
                        await finalizeRetryableAttempt(mapped.message, "失败");
                    }
                } else {
                    mapped.code = "GRADE_SETTLEMENT_PENDING";
                    mapped.status = 503;
                    mapped.retryable = true;
                    mapped.retryAfter = 2;
                }
                const signal = terminalSignal();
                try {
                    await writeSSE(
                        writer,
                        encoder,
                        { type: "log", msg: `× 分级错误: ${mapped.message}` },
                        operationAbort,
                        signal,
                    );
                    await writeSSE(writer, encoder, {
                        type: "error", stage: "grade", error: mapped.message, ...mapped,
                    }, operationAbort, signal);
                    await writeSSE(writer, encoder, {
                        type: "result", stage: "grade", error: mapped.message, ...mapped,
                    }, operationAbort, signal);
                } catch { /* bounded terminal delivery is best effort */ }
            } finally {
                stopLeaseRenewal();
                clearInterval(heartbeat);
                const signal = terminalSignal();
                try {
                    await withPreflightDeadline(
                        () => writer.write(encoder.encode("data: [DONE]\n\n")),
                        signal,
                        "复杂度分级结束标记发送超时",
                    );
                } catch { /* disconnected or terminal budget exhausted */ }
                let streamClosed = false;
                try {
                    await withPreflightDeadline(
                        () => writer.close(),
                        signal,
                        "关闭复杂度分级响应流超时",
                    );
                    streamClosed = true;
                } catch { /* already disconnected */ }
                if (!streamClosed) {
                    const abortDeadline = createPreflightDeadline(
                        PREFLIGHT_TERMINAL_WRITE_MS,
                        "终止复杂度分级响应流超时",
                    );
                    try {
                        await withPreflightDeadline(
                            () => writer.abort(signal.reason),
                            abortDeadline.signal,
                            "终止复杂度分级响应流超时",
                        );
                    } catch { /* stream already terminated */ }
                    finally { abortDeadline.dispose(); }
                }
                await waitForLeaseRenewal();
                terminalDeadline?.dispose();
                disposeOperation();
                scheduleLeaseRelease();
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
    } catch (error) {
        scheduleLeaseRelease();
        const mapped = gradeError(error);
        return preflightJsonError(
            mapped.message,
            mapped.code,
            mapped.status,
            mapped.retryAfter,
            { retryable: mapped.retryable },
        );
    }
}

export const onRequestPost: PagesFunction<Env> = async (context) => {
    const operationAbort = new AbortController();
    const unlinkClientAbort = linkClientAbortSignal(
        operationAbort,
        context.request.signal,
        "Grade client disconnected",
    );
    const operationDeadline = createPreflightDeadline(
        PREFLIGHT_OPERATION_MS,
        GRADE_TIMEOUT_MESSAGE,
        operationAbort.signal,
    );
    let operationHandedOff = false;
    let operationDisposed = false;
    const disposeOperation = () => {
        if (operationDisposed) return;
        operationDisposed = true;
        operationDeadline.dispose();
        unlinkClientAbort();
    };

    try {
        return await handleGradeRequest(
            context,
            operationAbort,
            operationDeadline,
            () => { operationHandedOff = true; },
            disposeOperation,
        );
    } catch (error) {
        const mapped = gradeError(error);
        return preflightJsonError(
            mapped.message,
            mapped.code,
            mapped.status,
            mapped.retryAfter,
            { retryable: mapped.retryable },
        );
    } finally {
        if (!operationHandedOff) disposeOperation();
    }
};
