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

const MAX_CLARIFY_ROUNDS = 5;
const CLARIFY_IDLE_MS = 120_000;
const CLARIFY_OPERATION_MS = 350_000;
const CLARIFY_LEASE_MS = 360_000;

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
): Promise<void> {
    try { await writer.write(sseEvent(encoder, data)); } catch { /* keep processing after disconnect */ }
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
    const abortFromParent = () => ctrl.abort(parentSignal.reason);
    if (parentSignal.aborted) abortFromParent();
    else parentSignal.addEventListener("abort", abortFromParent, { once: true });
    let idleTimer: ReturnType<typeof setTimeout> | undefined;
    const armIdle = () => {
        if (idleTimer) clearTimeout(idleTimer);
        idleTimer = setTimeout(() => ctrl.abort(), CLARIFY_IDLE_MS);
    };
    armIdle();
    try {
        const resp = await fetch(url, {
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
            signal: ctrl.signal,
        });
        await assertOpenAIResponse(resp);
        armIdle();
        const streamed = await consumeOpenAIChatStream(resp, {
            onActivity: armIdle,
            requireUsage,
            onThinking,
            onOutput,
        });
        return { content: streamed.content, usage: streamed.usage };
    } finally {
        if (idleTimer) clearTimeout(idleTimer);
        parentSignal.removeEventListener("abort", abortFromParent);
    }
}

function clarifyError(error: unknown): {
    message: string;
    code: string;
    status: number;
    retryable: boolean;
    retryAfter?: number;
} {
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
    if (error && typeof error === "object" && "name" in error && error.name === "AbortError") {
        return {
            message: "需求确认模型响应超时",
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
    if (!signal.aborted) return;
    if (signal.reason instanceof Error) throw signal.reason;
    const error = new Error("Clarify operation timed out");
    error.name = "AbortError";
    throw error;
}

export const onRequestPost: PagesFunction<Env> = async (context) => {
    const uid: string = (context.data as any)?.uid || "";
    const body = await context.request.json() as any;
    const taskId = typeof body.taskId === "string" ? body.taskId : "";
    const requestId = parsePreflightRequestId("clarify", body.clarifyRequestId);
    if (!requestId) {
        return preflightJsonError("缺少有效 clarifyRequestId", "INVALID_CLARIFY_REQUEST_ID", 400);
    }

    const suppliedInput = normalizedClarifyInput(body);
    const suppliedInputHash = await preflightInputHash(suppliedInput);
    const hasExplicitInput = hasExplicitClarifyInput(body);
    let raw = await getOwnedTask(context.env, taskId, uid);
    if (!raw) return preflightJsonError("Task not found", "TASK_NOT_FOUND", 404);
    let state = JSON.parse(raw);
    const llm = await resolveTaskLLM(context, state);
    if (!llm) return deepSeekKeyRequiredResponse();

    const immediateRecord = findPreflightOperation(state, "clarify", requestId);
    if (immediateRecord && hasExplicitInput && immediateRecord.inputHash !== suppliedInputHash) {
        return preflightJsonError("同一 clarifyRequestId 携带了不同输入", "CLARIFY_REQUEST_CONFLICT", 409);
    }
    if (immediateRecord?.status === "completed" && immediateRecord.billingSettled) {
        return replayPreflightResult("clarify", immediateRecord);
    }

    const leaseToken = `clarify:${requestId}:${crypto.randomUUID().replace(/-/g, "")}`;
    let leaseMode: TaskOperationLeaseMode | null = null;
    let leaseReleased = false;
    try {
        leaseMode = await acquireTaskOperationLease(
            context.env,
            taskId,
            uid,
            leaseToken,
            CLARIFY_LEASE_MS,
        );
    } catch (error) {
        console.warn("clarify lease acquisition failed", error);
        return preflightJsonError("需求确认状态存储暂不可用", "CLARIFY_STORE_UNAVAILABLE", 503, 2);
    }

    if (!leaseMode) {
        const latestRaw = await getOwnedTask(context.env, taskId, uid);
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
        return preflightJsonError(
            latestRecord ? "需求确认仍在执行" : "任务正在执行其他操作",
            latestRecord ? "CLARIFY_IN_PROGRESS" : "TASK_OPERATION_IN_PROGRESS",
            409,
            2,
        );
    }

    const operationAbort = new AbortController();
    const operationTimer = setTimeout(() => operationAbort.abort(), CLARIFY_OPERATION_MS);
    let streamOwnsDeadline = false;

    const releaseLease = async () => {
        if (!leaseMode || leaseReleased) return;
        leaseReleased = await releaseTaskOperationLease(
            context.env,
            taskId,
            uid,
            leaseToken,
            leaseMode,
        );
    };
    const persistState = async (release = false) => {
        const committed = await putTaskWithOperationLease(
            context.env,
            taskId,
            JSON.stringify(state),
            leaseToken,
            leaseMode!,
            3600,
            uid,
            release,
        );
        if (!committed) throw new ClarifyLeaseLostError();
        if (release) leaseReleased = true;
    };

    try {
        raw = await getOwnedTask(context.env, taskId, uid);
        assertClarifyOperationActive(operationAbort.signal);
        if (!raw) {
            await releaseLease();
            return preflightJsonError("Task state unavailable", "TASK_STATE_UNAVAILABLE", 503, 2);
        }
        state = JSON.parse(raw);

        let record = findPreflightOperation(state, "clarify", requestId);
        if (record && hasExplicitInput && record.inputHash !== suppliedInputHash) {
            await releaseLease();
            return preflightJsonError("同一 clarifyRequestId 携带了不同输入", "CLARIFY_REQUEST_CONFLICT", 409);
        }

        if (record?.status === "completed") {
            if (!record.billingSettled) {
                const settlement = await settleTaskCostQuota(context.env, uid, taskId);
                assertClarifyOperationActive(operationAbort.signal);
                state.totalCost = settlement.total;
                state.consumedQuota = settlement.consumed;
                state.quotaExhausted = settlement.outOfQuota || state.quotaExhausted;
                record.billingSettled = true;
                if (settlement.outOfQuota) await markTaskQuotaExhausted(context.env, taskId, uid);
                await persistState(true);
                assertClarifyOperationActive(operationAbort.signal);
            } else {
                await releaseLease();
            }
            return replayPreflightResult("clarify", record);
        }

        const activeRecord = activePreflightOperation(state, "clarify");
        if (activeRecord && activeRecord.requestId !== requestId) {
            await releaseLease();
            return preflightJsonError(
                "存在尚未完成的需求确认请求，请恢复原请求",
                "CLARIFY_RECOVERY_REQUIRED",
                409,
                undefined,
                { activeRequestId: activeRecord.requestId },
            );
        }

        if (state.clarifyDone && !record) {
            await releaseLease();
            return preflightJsonError(
                "需求确认已完成，不能以新请求重新开启",
                "CLARIFY_ALREADY_COMPLETED",
                409,
            );
        }

        if (state.quotaExhausted && !llm.byok) {
            await releaseLease();
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
        assertClarifyOperationActive(operationAbort.signal);

        assertClarifyOperationActive(operationAbort.signal);
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

        const { readable, writable } = new TransformStream<Uint8Array>();
        const encoder = new TextEncoder();
        const writer = writable.getWriter();
        streamOwnsDeadline = true;
        const process = (async () => {
            const heartbeat = setInterval(() => {
                writer.write(sseEvent(encoder, { type: "heartbeat", stage: "clarify", t: Date.now() })).catch(() => { });
            }, 12_000);
            let resultCommitted = false;
            try {
                await writeSSE(writer, encoder, {
                    type: "phase",
                    stage: "clarify",
                    phase: "clarifying",
                    round: state.clarifyRounds.length + 1,
                });

                let result: Record<string, unknown> | undefined;
                let usage: UsageBreakdown | undefined;
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
                        operationAbort.signal,
                        !llm.byok,
                        content => writeSSE(writer, encoder, { type: "reasoning", stage: "clarify", content }),
                        content => writeSSE(writer, encoder, { type: "delta", stage: "clarify", content }),
                    );
                    usage = callRes.usage;

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

                record!.status = "completed";
                record!.result = result!;
                record!.completedAt = Date.now();
                record!.billingSettled = llm.byok || !usage;
                delete record!.lastError;
                const costDelta = !llm.byok && usage ? usageCost(llm.modelFor("pro"), usage) : 0;
                const committed = await putTaskWithOperationLeaseAndCost(
                    context.env,
                    taskId,
                    JSON.stringify(state),
                    leaseToken,
                    leaseMode!,
                    costDelta,
                    3600,
                    uid,
                    record!.billingSettled,
                );
                if (!committed) throw new ClarifyLeaseLostError();
                resultCommitted = true;
                if (record!.billingSettled) {
                    leaseReleased = true;
                } else {
                    const settlement = await settleTaskCostQuota(context.env, uid, taskId);
                    state.totalCost = settlement.total;
                    state.consumedQuota = settlement.consumed;
                    state.quotaExhausted = settlement.outOfQuota || state.quotaExhausted;
                    record!.billingSettled = true;
                    if (settlement.outOfQuota) await markTaskQuotaExhausted(context.env, taskId, uid);
                    await persistState(true);
                }

                await writeSSE(writer, encoder, { type: "result", stage: "clarify", ...result! });
            } catch (error) {
                const mapped = clarifyError(error);
                if (!resultCommitted) {
                    record!.status = "retryable";
                    record!.lastError = mapped.message;
                    try { await persistState(true); } catch { /* lease release below */ }
                } else {
                    mapped.code = "CLARIFY_SETTLEMENT_PENDING";
                    mapped.status = 503;
                    mapped.retryable = true;
                    mapped.retryAfter = 2;
                }
                await writeSSE(writer, encoder, { type: "log", msg: `× 澄清错误: ${mapped.message}` });
                await writeSSE(writer, encoder, {
                    type: "error", stage: "clarify", error: mapped.message, ...mapped,
                });
                await writeSSE(writer, encoder, {
                    type: "result", stage: "clarify", error: mapped.message, ...mapped,
                });
            } finally {
                clearTimeout(operationTimer);
                clearInterval(heartbeat);
                if (!leaseReleased) await releaseLease().catch(() => { });
                try { await writer.write(encoder.encode("data: [DONE]\n\n")); } catch { /* disconnected */ }
                try { await writer.close(); } catch { /* already disconnected */ }
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
        await releaseLease().catch(() => { });
        const mapped = clarifyError(error);
        return preflightJsonError(
            mapped.message,
            mapped.code,
            mapped.status,
            mapped.retryAfter,
            { retryable: mapped.retryable },
        );
    } finally {
        if (!streamOwnsDeadline) clearTimeout(operationTimer);
    }
};
