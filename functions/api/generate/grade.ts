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

const GRADE_IDLE_MS = 120_000;
const GRADE_OPERATION_MS = 350_000;
const GRADE_LEASE_MS = 360_000;

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
): Promise<void> {
    try { await writer.write(sseEvent(encoder, data)); } catch { /* keep processing after disconnect */ }
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
    const abortFromParent = () => ctrl.abort(parentSignal.reason);
    if (parentSignal.aborted) abortFromParent();
    else parentSignal.addEventListener("abort", abortFromParent, { once: true });
    let idleTimer: ReturnType<typeof setTimeout> | undefined;
    const armIdle = () => {
        if (idleTimer) clearTimeout(idleTimer);
        idleTimer = setTimeout(() => ctrl.abort(), GRADE_IDLE_MS);
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

function gradeError(error: unknown): {
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
    if (error instanceof GradeLeaseLostError) {
        return {
            message: "复杂度分级执行权已失效，请重试当前请求",
            code: "GRADE_LEASE_LOST",
            status: 409,
            retryable: true,
            retryAfter: 2,
        };
    }
    if (error && typeof error === "object" && "name" in error && error.name === "AbortError") {
        return {
            message: "复杂度分级模型响应超时",
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
    if (!signal.aborted) return;
    if (signal.reason instanceof Error) throw signal.reason;
    const error = new Error("Grade operation timed out");
    error.name = "AbortError";
    throw error;
}

export const onRequestPost: PagesFunction<Env> = async (context) => {
    const uid: string = (context.data as any)?.uid || "";
    const body = await context.request.json() as any;
    const taskId = typeof body.taskId === "string" ? body.taskId : "";
    const requestId = parsePreflightRequestId("grade", body.gradeRequestId);
    if (!requestId) {
        return preflightJsonError("缺少有效 gradeRequestId", "INVALID_GRADE_REQUEST_ID", 400);
    }

    const suppliedInput = normalizedGradeInput(body);
    const suppliedInputHash = await preflightInputHash(suppliedInput);
    const hasExplicitInput = hasExplicitGradeInput(body);
    let raw = await getOwnedTask(context.env, taskId, uid);
    if (!raw) return preflightJsonError("Task not found", "TASK_NOT_FOUND", 404);
    let state = JSON.parse(raw);
    const llm = await resolveTaskLLM(context, state);
    if (!llm) return deepSeekKeyRequiredResponse();

    const immediateRecord = findPreflightOperation(state, "grade", requestId);
    if (immediateRecord && hasExplicitInput && immediateRecord.inputHash !== suppliedInputHash) {
        return preflightJsonError("同一 gradeRequestId 携带了不同输入", "GRADE_REQUEST_CONFLICT", 409);
    }
    if (immediateRecord?.status === "completed" && immediateRecord.billingSettled) {
        return replayPreflightResult("grade", immediateRecord);
    }

    const leaseToken = `grade:${requestId}:${crypto.randomUUID().replace(/-/g, "")}`;
    let leaseMode: TaskOperationLeaseMode | null = null;
    let leaseReleased = false;
    try {
        leaseMode = await acquireTaskOperationLease(
            context.env,
            taskId,
            uid,
            leaseToken,
            GRADE_LEASE_MS,
        );
    } catch (error) {
        console.warn("grade lease acquisition failed", error);
        return preflightJsonError("复杂度分级状态存储暂不可用", "GRADE_STORE_UNAVAILABLE", 503, 2);
    }

    if (!leaseMode) {
        const latestRaw = await getOwnedTask(context.env, taskId, uid);
        const latestState = latestRaw ? JSON.parse(latestRaw) : null;
        const latestRecord = latestState ? findPreflightOperation(latestState, "grade", requestId) : undefined;
        if (latestRecord && hasExplicitInput && latestRecord.inputHash !== suppliedInputHash) {
            return preflightJsonError("同一 gradeRequestId 携带了不同输入", "GRADE_REQUEST_CONFLICT", 409);
        }
        if (latestRecord?.status === "completed" && latestRecord.billingSettled) {
            return replayPreflightResult("grade", latestRecord);
        }
        return preflightJsonError(
            latestRecord ? "复杂度分级仍在执行" : "任务正在执行其他操作",
            latestRecord ? "GRADE_IN_PROGRESS" : "TASK_OPERATION_IN_PROGRESS",
            409,
            2,
        );
    }

    const operationAbort = new AbortController();
    const operationTimer = setTimeout(() => operationAbort.abort(), GRADE_OPERATION_MS);
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
        if (!committed) throw new GradeLeaseLostError();
        if (release) leaseReleased = true;
    };

    try {
        raw = await getOwnedTask(context.env, taskId, uid);
        assertGradeOperationActive(operationAbort.signal);
        if (!raw) {
            await releaseLease();
            return preflightJsonError("Task state unavailable", "TASK_STATE_UNAVAILABLE", 503, 2);
        }
        state = JSON.parse(raw);

        let record = findPreflightOperation(state, "grade", requestId);
        if (record && hasExplicitInput && record.inputHash !== suppliedInputHash) {
            await releaseLease();
            return preflightJsonError("同一 gradeRequestId 携带了不同输入", "GRADE_REQUEST_CONFLICT", 409);
        }

        if (record?.status === "completed") {
            if (!record.billingSettled) {
                const settlement = await settleTaskCostQuota(context.env, uid, taskId);
                assertGradeOperationActive(operationAbort.signal);
                state.totalCost = settlement.total;
                state.consumedQuota = settlement.consumed;
                state.quotaExhausted = settlement.outOfQuota || state.quotaExhausted;
                record.billingSettled = true;
                if (settlement.outOfQuota) await markTaskQuotaExhausted(context.env, taskId, uid);
                await persistState(true);
                assertGradeOperationActive(operationAbort.signal);
            } else {
                await releaseLease();
            }
            return replayPreflightResult("grade", record);
        }

        const enforcePreflightProtocol = Number(state.preflightProtocolVersion) >= 1;
        const clarifyOperations = enforcePreflightProtocol
            ? preflightOperations(state, "clarify")
            : [];
        const latestClarify = clarifyOperations[clarifyOperations.length - 1];
        if (latestClarify
            && (latestClarify.status !== "completed" || !latestClarify.billingSettled)) {
            await releaseLease();
            return preflightJsonError(
                "存在尚未完成的需求确认请求，请恢复原请求",
                "CLARIFY_RECOVERY_REQUIRED",
                409,
                undefined,
                { activeRequestId: latestClarify.requestId },
            );
        }

        if (state.quotaExhausted && !llm.byok) {
            await releaseLease();
            return preflightJsonError("充值额度已用尽", "QUOTA_EXHAUSTED", 402);
        }
        if (!state.clarifyDone || (enforcePreflightProtocol && !latestClarify)) {
            await releaseLease();
            return preflightJsonError("澄清阶段尚未完成", "CLARIFY_NOT_COMPLETED", 409, 2);
        }

        const activeRecord = activePreflightOperation(state, "grade");
        if (activeRecord && activeRecord.requestId !== requestId) {
            await releaseLease();
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
        assertGradeOperationActive(operationAbort.signal);

        assertGradeOperationActive(operationAbort.signal);
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
                writer.write(sseEvent(encoder, { type: "heartbeat", stage: "grade", t: Date.now() })).catch(() => { });
            }, 12_000);
            let resultCommitted = false;
            try {
                await writeSSE(writer, encoder, { type: "phase", stage: "grade", phase: "grading" });
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
                    operationAbort.signal,
                    !llm.byok,
                    content => writeSSE(writer, encoder, { type: "reasoning", stage: "grade", content }),
                    content => writeSSE(writer, encoder, { type: "delta", stage: "grade", content }),
                );

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

                record!.status = "completed";
                record!.result = result;
                record!.completedAt = Date.now();
                record!.billingSettled = llm.byok;
                delete record!.lastError;
                const costDelta = !llm.byok && callRes.usage
                    ? usageCost(llm.modelFor("pro"), callRes.usage)
                    : 0;
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
                if (!committed) throw new GradeLeaseLostError();
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

                await writeSSE(writer, encoder, { type: "result", stage: "grade", ...result });
            } catch (error) {
                const mapped = gradeError(error);
                if (!resultCommitted) {
                    record!.status = "retryable";
                    record!.lastError = mapped.message;
                    try { await persistState(true); } catch { /* lease release below */ }
                } else {
                    mapped.code = "GRADE_SETTLEMENT_PENDING";
                    mapped.status = 503;
                    mapped.retryable = true;
                    mapped.retryAfter = 2;
                }
                await writeSSE(writer, encoder, { type: "log", msg: `× 分级错误: ${mapped.message}` });
                await writeSSE(writer, encoder, {
                    type: "error", stage: "grade", error: mapped.message, ...mapped,
                });
                await writeSSE(writer, encoder, {
                    type: "result", stage: "grade", error: mapped.message, ...mapped,
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
        const mapped = gradeError(error);
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
