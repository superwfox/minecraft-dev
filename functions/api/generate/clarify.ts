import { plannerClarifyPrompt, skillClarifyContext } from "../../_lib/prompts";
import { settleTaskCostQuota, usageCost, type UsageBreakdown } from "../../_lib/quota";
import { deepSeekKeyRequiredResponse, resolveTaskLLM } from "../../_lib/llm";
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
    PREFLIGHT_HEARTBEAT_MS,
    PREFLIGHT_UPSTREAM_FIRST_CHUNK_MS,
    PREFLIGHT_UPSTREAM_IDLE_MS,
    type PreflightDeadline,
    withPreflightDeadline,
} from "../../_lib/preflightDeadline";

const MAX_CLARIFY_ROUNDS = 5;
const CLARIFY_TIMEOUT_MESSAGE = "需求确认处理超时";

interface Env {
    DB?: D1Database;
    DEEPSEEK_API_KEY: string;
    TASKS: KVNamespace;
}

class ClarifyLeaseLostError extends Error {
    constructor() {
        super("Clarify execution lease was lost");
        this.name = "ClarifyLeaseLostError";
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
            "需求确认响应写入超时",
        );
    } catch (error) {
        if (isClientCancelled(error)) throw error;
        if (signal.aborted) assertPreflightActive(signal, "需求确认响应写入超时");
        abortOnWriteFailure(operationAbort, error, "Clarify client disconnected");
    }
}

function normalizedClarifyInput(body: any): Record<string, unknown> {
    const input: Record<string, unknown> = {};
    if (body.answers && typeof body.answers === "object" && !Array.isArray(body.answers)) {
        input.answers = body.answers;
    }
    if (typeof body.extraPrompt === "string" && body.extraPrompt.trim()) {
        input.extraPrompt = body.extraPrompt.trim();
    }
    return input;
}

function hasExplicitClarifyInput(body: any): boolean {
    return body.answers !== undefined || body.extraPrompt !== undefined;
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
        PREFLIGHT_UPSTREAM_FIRST_CHUNK_MS,
        PREFLIGHT_UPSTREAM_IDLE_MS,
        "需求确认模型长时间无有效输出",
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
        }), idleDeadline.signal, "需求确认模型连接超时");
        await withPreflightDeadline(
            () => assertOpenAIResponse(resp),
            idleDeadline.signal,
            "读取需求确认模型错误响应超时",
        );
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
        }), idleDeadline.signal, "需求确认模型长时间无有效输出");
        return { content: streamed.content, usage: streamed.usage };
    } finally {
        idleDeadline.dispose();
        unlinkParent();
    }
}

function clarifyError(error: unknown): {
    message: string;
    code: string;
    status: number;
    retryable: boolean;
    retryAfter?: number;
} {
    if (isClientCancelled(error)) {
        return {
            message: "需求确认已取消",
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
    if (error instanceof ClarifyLeaseLostError) {
        return {
            message: "需求确认执行权已失效，请重试当前请求",
            code: "CLARIFY_LEASE_LOST",
            status: 409,
            retryable: true,
            retryAfter: 2,
        };
    }
    if (isPreflightTimeout(error)) {
        return {
            message: CLARIFY_TIMEOUT_MESSAGE,
            code: "CLARIFY_TIMEOUT",
            status: 504,
            retryable: true,
            retryAfter: 2,
        };
    }
    return {
        message: error instanceof Error ? error.message : String(error),
        code: "CLARIFY_FAILED",
        status: 500,
        retryable: true,
        retryAfter: 2,
    };
}

function assertClarifyOperationActive(signal: AbortSignal): void {
    assertPreflightActive(signal, CLARIFY_TIMEOUT_MESSAGE);
}

type ClarifyContext = Parameters<PagesFunction<Env>>[0];

async function handleClarifyRequest(
    context: ClarifyContext,
    operationAbort: AbortController,
    operationDeadline: PreflightDeadline,
    handoffOperation: () => void,
    disposeOperation: () => void,
): Promise<Response> {
    const uid: string = (context.data as any)?.uid || "";
    const body = await withPreflightDeadline(
        () => context.request.json() as Promise<any>,
        operationDeadline.signal,
        "读取需求确认请求超时",
    );
    const taskId = typeof body.taskId === "string" ? body.taskId : "";
    const requestId = parsePreflightRequestId("clarify", body.clarifyRequestId);
    if (!requestId) {
        return preflightJsonError("缺少有效 clarifyRequestId", "INVALID_CLARIFY_REQUEST_ID", 400);
    }

    const suppliedInput = normalizedClarifyInput(body);
    const suppliedInputHash = await withPreflightDeadline(
        () => preflightInputHash(suppliedInput),
        operationDeadline.signal,
        "计算需求确认请求标识超时",
    );
    const hasExplicitInput = hasExplicitClarifyInput(body);
    let raw = await withPreflightDeadline(
        () => getOwnedTask(context.env, taskId, uid),
        operationDeadline.signal,
        "读取需求确认任务状态超时",
    );
    if (!raw) return preflightJsonError("Task not found", "TASK_NOT_FOUND", 404);
    let state = JSON.parse(raw);
    const llm = await withPreflightDeadline(
        () => resolveTaskLLM(context, state),
        operationDeadline.signal,
        "解析需求确认模型配置超时",
    );
    if (!llm) return deepSeekKeyRequiredResponse();

    const immediateRecord = findPreflightOperation(state, "clarify", requestId);
    if (immediateRecord && hasExplicitInput && immediateRecord.inputHash !== suppliedInputHash) {
        return preflightJsonError("同一 clarifyRequestId 携带了不同输入", "CLARIFY_REQUEST_CONFLICT", 409);
    }
    if (immediateRecord?.status === "completed" && immediateRecord.billingSettled) {
        return replayPreflightResult("clarify", immediateRecord);
    }
    if (immediateRecord?.status === "cancelled") {
        return preflightJsonError("需求确认请求已取消", "CLARIFY_CANCELLED", 409, undefined, {
            retryable: false,
        });
    }

    const leaseToken = `clarify:${requestId}:${crypto.randomUUID().replace(/-/g, "")}`;
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
            "续订需求确认执行权超时",
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
                    "续订需求确认执行权超时",
                );
                if (!renewed) throw new ClarifyLeaseLostError();
            } catch (error) {
                if (leaseRenewalStopped
                    || operationDeadline.signal.aborted
                    || operationAbort.signal.aborted) return;
                const leaseError = new ClarifyLeaseLostError();
                console.warn("clarify lease renewal failed", error);
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
                "释放需求确认执行权超时",
            );
            try {
                await withPreflightDeadline(
                    startLeaseRelease,
                    cleanupDeadline.signal,
                    "释放需求确认执行权超时",
                );
            } catch (error) {
                console.warn("clarify lease release failed", error);
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
            "获取需求确认执行权超时",
        );
    } catch (error) {
        if (isClientCancelled(error) || isPreflightTimeout(error)) throw error;
        console.warn("clarify lease acquisition failed", error);
        return preflightJsonError("需求确认状态存储暂不可用", "CLARIFY_STORE_UNAVAILABLE", 503, 2);
    }

    if (!leaseMode) {
        const latestRaw = await withPreflightDeadline(
            () => getOwnedTask(context.env, taskId, uid),
            operationDeadline.signal,
            "读取需求确认恢复状态超时",
        );
        const latestState = latestRaw ? JSON.parse(latestRaw) : null;
        const latestRecord = latestState
            ? findPreflightOperation(latestState, "clarify", requestId)
            : undefined;
        if (latestRecord && hasExplicitInput && latestRecord.inputHash !== suppliedInputHash) {
            return preflightJsonError("同一 clarifyRequestId 携带了不同输入", "CLARIFY_REQUEST_CONFLICT", 409);
        }
        if (latestRecord?.status === "completed" && latestRecord.billingSettled) {
            return replayPreflightResult("clarify", latestRecord);
        }
        if (latestRecord?.status === "cancelled") {
            return preflightJsonError("需求确认请求已取消", "CLARIFY_CANCELLED", 409, undefined, {
                retryable: false,
            });
        }
        return preflightJsonError(
            latestRecord ? "需求确认仍在执行" : "任务正在执行其他操作",
            latestRecord ? "CLARIFY_IN_PROGRESS" : "TASK_OPERATION_IN_PROGRESS",
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
            "持久化需求确认状态超时",
        );
        if (!committed) throw new ClarifyLeaseLostError();
        if (release) leaseReleased = true;
    };

    try {
        await startLeaseRenewal();
        assertClarifyOperationActive(operationDeadline.signal);
        raw = await withPreflightDeadline(
            () => getOwnedTask(context.env, taskId, uid),
            operationDeadline.signal,
            "重新读取需求确认任务状态超时",
        );
        assertClarifyOperationActive(operationDeadline.signal);
        if (!raw) {
            scheduleLeaseRelease();
            return preflightJsonError("Task state unavailable", "TASK_STATE_UNAVAILABLE", 503, 2);
        }
        state = JSON.parse(raw);

        let record = findPreflightOperation(state, "clarify", requestId);
        if (record && hasExplicitInput && record.inputHash !== suppliedInputHash) {
            scheduleLeaseRelease();
            return preflightJsonError("同一 clarifyRequestId 携带了不同输入", "CLARIFY_REQUEST_CONFLICT", 409);
        }

        if (record?.status === "completed") {
            if (!record.billingSettled) {
                const settlement = await withPreflightDeadline(
                    () => settleTaskCostQuota(context.env, uid, taskId),
                    operationDeadline.signal,
                    "结算需求确认用量超时",
                );
                assertClarifyOperationActive(operationDeadline.signal);
                state.totalCost = settlement.total;
                state.consumedQuota = settlement.consumed;
                state.quotaExhausted = settlement.outOfQuota || state.quotaExhausted;
                record.billingSettled = true;
                if (settlement.outOfQuota) {
                    await withPreflightDeadline(
                        () => markTaskQuotaExhausted(context.env, taskId, uid),
                        operationDeadline.signal,
                        "持久化需求确认配额状态超时",
                    );
                }
                await persistState(true);
                assertClarifyOperationActive(operationDeadline.signal);
            } else {
                scheduleLeaseRelease();
            }
            return replayPreflightResult("clarify", record);
        }
        if (record?.status === "cancelled") {
            scheduleLeaseRelease();
            return preflightJsonError("需求确认请求已取消", "CLARIFY_CANCELLED", 409, undefined, {
                retryable: false,
            });
        }
        if (record?.status === "retryable" && !record.billingSettled) {
            const settlement = await withPreflightDeadline(
                () => settleTaskCostQuota(context.env, uid, taskId),
                operationDeadline.signal,
                "结算待恢复的需求确认用量超时",
            );
            state.totalCost = settlement.total;
            state.consumedQuota = settlement.consumed;
            state.quotaExhausted = settlement.outOfQuota || state.quotaExhausted;
            record.billingSettled = true;
            if (settlement.outOfQuota) {
                await withPreflightDeadline(
                    () => markTaskQuotaExhausted(context.env, taskId, uid),
                    operationDeadline.signal,
                    "持久化待恢复的需求确认配额状态超时",
                );
            }
            await persistState(false);
            assertClarifyOperationActive(operationDeadline.signal);
        }

        const activeRecord = activePreflightOperation(state, "clarify");
        if (activeRecord && activeRecord.requestId !== requestId) {
            scheduleLeaseRelease();
            return preflightJsonError(
                "存在尚未完成的需求确认请求，请恢复原请求",
                "CLARIFY_RECOVERY_REQUIRED",
                409,
                undefined,
                { activeRequestId: activeRecord.requestId },
            );
        }

        if (state.clarifyDone && !record) {
            scheduleLeaseRelease();
            return preflightJsonError(
                "需求确认已完成，不能以新请求重新开启",
                "CLARIFY_ALREADY_COMPLETED",
                409,
            );
        }

        if (state.quotaExhausted && !llm.byok) {
            scheduleLeaseRelease();
            return preflightJsonError("充值额度已用尽", "QUOTA_EXHAUSTED", 402);
        }

        if (!record) {
            const answers = suppliedInput.answers as Record<string, string | string[]> | undefined;
            const extraPrompt = suppliedInput.extraPrompt as string | undefined;
            if (answers && state.clarifyRounds.length > 0) {
                state.clarifyRounds[state.clarifyRounds.length - 1].answers = answers;
            }
            if (extraPrompt) state.userPrompt = `${state.userPrompt}\n\n补充说明：${extraPrompt}`;
            record = appendPreflightOperation(state, "clarify", {
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
        await persistState(false);
        assertClarifyOperationActive(operationDeadline.signal);

        assertClarifyOperationActive(operationDeadline.signal);
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
                        "需求确认终态发送超时",
                    );
                }
                return terminalDeadline.signal;
            };
            const heartbeat = setInterval(() => {
                writeSSE(
                    writer,
                    encoder,
                    { type: "heartbeat", stage: "clarify", t: Date.now() },
                    operationAbort,
                    operationDeadline.signal,
                ).catch(() => { /* operation signal carries timeout or cancellation */ });
            }, PREFLIGHT_HEARTBEAT_MS);
            let resultCommitted = false;
            let resultCommitPending = false;
            let usage: UsageBreakdown | undefined;
            const finalizeRetryableAttempt = async (
                lastError: string,
                label: "中断" | "失败",
            ) => {
                state = JSON.parse(attemptBaselineRaw);
                record = findPreflightOperation(state, "clarify", requestId);
                if (!record) throw new ClarifyLeaseLostError();
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
                    `收口需求确认${label}状态超时`,
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
                        `提交需求确认${label}状态超时`,
                    );
                    if (!committed) throw new ClarifyLeaseLostError();
                    if (!record!.billingSettled) {
                        const settlement = await withPreflightDeadline(
                            () => settleTaskCostQuota(context.env, uid, taskId),
                            finalizeDeadline.signal,
                            `结算需求确认${label}用量超时`,
                        );
                        state.totalCost = settlement.total;
                        state.consumedQuota = settlement.consumed;
                        state.quotaExhausted = settlement.outOfQuota || state.quotaExhausted;
                        record!.billingSettled = true;
                        if (settlement.outOfQuota) {
                            await withPreflightDeadline(
                                () => markTaskQuotaExhausted(context.env, taskId, uid),
                                finalizeDeadline.signal,
                                `持久化需求确认${label}配额状态超时`,
                            );
                        }
                        await persistState(false, finalizeDeadline.signal);
                    }
                } catch (finalizeError) {
                    const kind = label === "中断" ? "interrupted" : "failure";
                    console.warn(`clarify ${kind} state finalization failed`, finalizeError);
                } finally {
                    finalizeDeadline.dispose();
                }
            };
            try {
                await writeSSE(
                    writer,
                    encoder,
                    {
                        type: "phase",
                        stage: "clarify",
                        phase: "clarifying",
                        round: state.clarifyRounds.length + 1,
                    },
                    operationAbort,
                    operationDeadline.signal,
                );

                let result: Record<string, unknown> | undefined;
                if (state.clarifyRounds.length >= MAX_CLARIFY_ROUNDS) {
                    state.clarifyDone = true;
                    state.logs.push(`● 澄清轮次达到上限 ${MAX_CLARIFY_ROUNDS}，强制结束`);
                    result = { done: true, todos: [] };
                } else {
                    const skillCtx = state.skills?.length ? skillClarifyContext(state.skills) : "";
                    const prompt = plannerClarifyPrompt(
                        state.userPrompt,
                        state.coreType,
                        state.version,
                        state.clarifyRounds,
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
                            { type: "reasoning", stage: "clarify", content },
                            operationAbort,
                            operationDeadline.signal,
                        ),
                        content => writeSSE(
                            writer,
                            encoder,
                            { type: "delta", stage: "clarify", content },
                            operationAbort,
                            operationDeadline.signal,
                        ),
                    );
                    usage = callRes.usage;
                    assertClarifyOperationActive(operationDeadline.signal);

                    let parsed: { done?: boolean; todos?: any[]; needMoreInput?: boolean; hint?: string } = {};
                    try {
                        parsed = JSON.parse(stripFences(callRes.content));
                    } catch {
                        state.clarifyDone = true;
                        state.logs.push("× 澄清阶段解析失败，强制进入规划");
                        result = { done: true, todos: [] };
                    }

                    if (!result) {
                        if (parsed.needMoreInput) {
                            state.logs.push("! 需求过于模糊，请求用户补充");
                            result = {
                                needMoreInput: true,
                                hint: parsed.hint || "请补充更具体的功能描述",
                            };
                        } else {
                            const todos = Array.isArray(parsed.todos) ? parsed.todos : [];
                            const done = parsed.done === true || todos.length === 0;
                            if (!done) {
                                state.clarifyRounds.push({ todos, answers: {} });
                                state.logs.push(`▸ 澄清第 ${state.clarifyRounds.length} 轮：${todos.length} 项待确认`);
                            } else {
                                state.clarifyDone = true;
                                state.logs.push(`● 澄清完成，共 ${state.clarifyRounds.length} 轮`);
                            }
                            result = { done, todos };
                        }
                    }
                }

                assertClarifyOperationActive(operationDeadline.signal);
                record!.status = "completed";
                record!.result = result!;
                record!.completedAt = Date.now();
                record!.billingSettled = llm.byok || !usage;
                delete record!.lastError;
                const costDelta = !llm.byok && usage ? usageCost(llm.modelFor("pro"), usage) : 0;
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
                    "提交需求确认结果超时",
                );
                if (!committed) throw new ClarifyLeaseLostError();
                if (!record!.billingSettled) {
                    const settlement = await withPreflightDeadline(
                        () => settleTaskCostQuota(context.env, uid, taskId),
                        operationDeadline.signal,
                        "结算需求确认用量超时",
                    );
                    state.totalCost = settlement.total;
                    state.consumedQuota = settlement.consumed;
                    state.quotaExhausted = settlement.outOfQuota || state.quotaExhausted;
                    record!.billingSettled = true;
                    if (settlement.outOfQuota) {
                        await withPreflightDeadline(
                            () => markTaskQuotaExhausted(context.env, taskId, uid),
                            operationDeadline.signal,
                            "持久化需求确认配额状态超时",
                        );
                    }
                    await persistState(false);
                }

                await writeSSE(
                    writer,
                    encoder,
                    { type: "result", stage: "clarify", ...result! },
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
                const mapped = clarifyError(error);
                if (!resultCommitted) {
                    if (resultCommitPending) {
                        mapped.code = "CLARIFY_FINALIZATION_PENDING";
                        mapped.status = 503;
                        mapped.retryable = true;
                        mapped.retryAfter = 2;
                    } else {
                        await finalizeRetryableAttempt(mapped.message, "失败");
                    }
                } else {
                    mapped.code = "CLARIFY_SETTLEMENT_PENDING";
                    mapped.status = 503;
                    mapped.retryable = true;
                    mapped.retryAfter = 2;
                }
                const signal = terminalSignal();
                try {
                    await writeSSE(
                        writer,
                        encoder,
                        { type: "log", msg: `× 澄清错误: ${mapped.message}` },
                        operationAbort,
                        signal,
                    );
                    await writeSSE(writer, encoder, {
                        type: "error", stage: "clarify", error: mapped.message, ...mapped,
                    }, operationAbort, signal);
                    await writeSSE(writer, encoder, {
                        type: "result", stage: "clarify", error: mapped.message, ...mapped,
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
                        "需求确认结束标记发送超时",
                    );
                } catch { /* disconnected or terminal budget exhausted */ }
                let streamClosed = false;
                try {
                    await withPreflightDeadline(
                        () => writer.close(),
                        signal,
                        "关闭需求确认响应流超时",
                    );
                    streamClosed = true;
                } catch { /* already disconnected */ }
                if (!streamClosed) {
                    const abortDeadline = createPreflightDeadline(
                        PREFLIGHT_TERMINAL_WRITE_MS,
                        "终止需求确认响应流超时",
                    );
                    try {
                        await withPreflightDeadline(
                            () => writer.abort(signal.reason),
                            abortDeadline.signal,
                            "终止需求确认响应流超时",
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
        const mapped = clarifyError(error);
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
        "Clarify client disconnected",
    );
    const operationDeadline = createPreflightDeadline(
        PREFLIGHT_OPERATION_MS,
        CLARIFY_TIMEOUT_MESSAGE,
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
        return await handleClarifyRequest(
            context,
            operationAbort,
            operationDeadline,
            () => { operationHandedOff = true; },
            disposeOperation,
        );
    } catch (error) {
        const mapped = clarifyError(error);
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
