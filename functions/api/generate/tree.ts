import { treeBuilderPrompt, skillTreeContext } from "../../_lib/prompts";
import { applyTreeToolCalls, createInitialTree, deriveGenerationPlan, MAX_TREE_ROUNDS, publicTreeView, treePromptSnapshot, treeToolDefinitions, validateProjectTree, type ProjectTree, type TreeSession } from "../../_lib/projectTree";
import { consumeChatStream } from "../../_lib/modelStream";
import { getSkillBundles } from "../../_lib/skills";
import { buildApiContractContext } from "../../_lib/apiContracts";
import { loadKnowledgeContext, mergeKnowledgeUsed } from "../../_lib/learning/context";
import { deduplicateKnowledgeNeeds } from "../../_lib/learning/assessment";
import { createModelLearningRequest, LEARNING_TOOL_NAME, learningToolDefinition, putModelLearningRequest, removeModelLearningRequest, type ModelChatMessage } from "../../_lib/learning/tool";
import { resolveModelLearningRequest, type ModelLearningResolution } from "../../_lib/learning/toolRuntime";
import { settleTaskCostQuota, usageCost, type UsageBreakdown } from "../../_lib/quota";
import { publicPathChecks } from "../../_lib/projectPathReview";
import { deepSeekKeyRequiredResponse, resolveTaskLLM, thinkingFor } from "../../_lib/llm";
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
    PREFLIGHT_STATE_FINALIZE_MS,
    PREFLIGHT_TERMINAL_WRITE_MS,
    PREFLIGHT_HEARTBEAT_MS,
    PREFLIGHT_UPSTREAM_FIRST_CHUNK_MS,
    PREFLIGHT_UPSTREAM_IDLE_MS,
    type PreflightDeadline,
    withPreflightDeadline,
} from "../../_lib/preflightDeadline";

const TREE_TIMEOUT_MESSAGE = "结构规划处理超时";

interface Env {
    DB?: D1Database;
    DEEPSEEK_API_KEY: string;
    TASKS: KVNamespace;
}

class TreeLeaseLostError extends Error {
    constructor() {
        super("Tree execution lease was lost");
        this.name = "TreeLeaseLostError";
    }
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
            "结构规划响应写入超时",
        );
    } catch (error) {
        if (isClientCancelled(error)) throw error;
        if (signal.aborted) assertPreflightActive(signal, "结构规划响应写入超时");
        abortOnWriteFailure(operationAbort, error, "Tree client disconnected");
    }
}

function normalizedTreeInput(body: Record<string, unknown>): Record<string, unknown> {
    return { action: body.action, correction: typeof body.correction === "string" ? body.correction.trim() : "", focusIds: Array.isArray(body.focusIds) ? body.focusIds : [], skillIds: Array.isArray(body.skillIds) ? body.skillIds : [] };
}
function hasExplicitTreeInput(body: Record<string, unknown>): boolean { return ["action", "correction", "focusIds", "skillIds"].some(key => Object.prototype.hasOwnProperty.call(body, key)); }

function treeError(error: unknown): {
    message: string;
    code: string;
    status: number;
    retryable: boolean;
    retryAfter?: number;
} {
    if (isClientCancelled(error)) {
        return {
            message: "结构规划已取消",
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
    if (error instanceof TreeLeaseLostError) {
        return {
            message: "结构规划执行权已失效，请重试当前请求",
            code: "TREE_LEASE_LOST",
            status: 409,
            retryable: true,
            retryAfter: 2,
        };
    }
    if (isPreflightTimeout(error)) {
        return {
            message: TREE_TIMEOUT_MESSAGE,
            code: "TREE_TIMEOUT",
            status: 504,
            retryable: true,
            retryAfter: 2,
        };
    }
    return {
        message: error instanceof Error ? error.message : String(error),
        code: "TREE_FAILED",
        status: 500,
        retryable: true,
        retryAfter: 2,
    };
}

function assertTreeOperationActive(signal: AbortSignal): void {
    assertPreflightActive(signal, TREE_TIMEOUT_MESSAGE);
}

type TreeContext = Parameters<PagesFunction<Env>>[0];

async function handleTreeRequest(
    context: TreeContext,
    operationAbort: AbortController,
    operationDeadline: PreflightDeadline,
    handoffOperation: () => void,
    disposeOperation: () => void,
): Promise<Response> {
    const uid: string = (context.data as any)?.uid || "";
    const body = await withPreflightDeadline(
        () => context.request.json() as Promise<any>,
        operationDeadline.signal,
        "读取结构规划请求超时",
    );
    const taskId = typeof body.taskId === "string" ? body.taskId : "";
    const requestId = parsePreflightRequestId("tree", body.treeRequestId);
    if (!requestId) {
        return preflightJsonError("缺少有效 treeRequestId", "INVALID_TREE_REQUEST_ID", 400);
    }

    const hasExplicitInput = hasExplicitTreeInput(body);
    let raw = await withPreflightDeadline(
        () => getOwnedTask(context.env, taskId, uid),
        operationDeadline.signal,
        "读取结构规划任务状态超时",
    );
    if (!raw) return preflightJsonError("Task not found", "TASK_NOT_FOUND", 404);
    let state = JSON.parse(raw);
    if (!state.clarifyDone) return preflightJsonError("请先完成需求确认", "CLARIFY_REQUIRED", 409);
    if (state.tree?.status === "locked") return preflightJsonError("结构树已锁定", "TREE_LOCKED", 409);
    const immediateRecord = findPreflightOperation(state, "tree", requestId);
    if (!hasExplicitInput && immediateRecord) Object.assign(body, immediateRecord.input);
    const suppliedInput = normalizedTreeInput(body);
    const suppliedInputHash = await withPreflightDeadline(() => preflightInputHash(suppliedInput), operationDeadline.signal, "计算结构规划请求标识超时");
    if (!["build", "refine", "continue"].includes(body.action)) return preflightJsonError("无效的结构规划操作", "INVALID_TREE_ACTION", 400);
    const llm = await withPreflightDeadline(
        () => resolveTaskLLM(context, state),
        operationDeadline.signal,
        "解析结构规划模型配置超时",
    );
    if (!llm) return deepSeekKeyRequiredResponse();

    if (immediateRecord && hasExplicitInput && immediateRecord.inputHash !== suppliedInputHash) {
        return preflightJsonError("同一 treeRequestId 携带了不同输入", "TREE_REQUEST_CONFLICT", 409);
    }
    if (immediateRecord?.status === "completed" && immediateRecord.billingSettled) {
        return replayPreflightResult("tree", immediateRecord);
    }
    if (immediateRecord?.status === "cancelled") {
        return preflightJsonError("结构规划请求已取消", "TREE_CANCELLED", 409, undefined, {
            retryable: false,
        });
    }

    let learningResolution: ModelLearningResolution | null = null;
    const learningId = state.treeSession?.status === "learning" ? state.treeSession.learningRequestId : "";
    // Resolve before acquiring the task fence, as learning authorization uses that fence.
    if (learningId && body.action === "continue") {
        learningResolution = await resolveModelLearningRequest({ env: context.env, state, uid, taskId, requestId: learningId, jobId: body.learningToolJobs?.[learningId], maxCharacters: 4800 });
        if (learningResolution.status === "pending") return new Response(`data: ${JSON.stringify({ type: "result", stage: "tree", status: "learning", round: state.treeSession.round, tree: publicTreeView(state.tree), issues: state.treeSession.issues, results: [], learningToolRequests: [learningResolution.request] })}\n\ndata: [DONE]\n\n`, { headers: { "Content-Type": "text/event-stream", "Cache-Control": "no-cache" } });
    }
    const leaseToken = `tree:${requestId}:${crypto.randomUUID().replace(/-/g, "")}`;
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
            "续订结构规划执行权超时",
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
                    "续订结构规划执行权超时",
                );
                if (!renewed) throw new TreeLeaseLostError();
            } catch (error) {
                if (leaseRenewalStopped
                    || operationDeadline.signal.aborted
                    || operationAbort.signal.aborted) return;
                const leaseError = new TreeLeaseLostError();
                console.warn("tree lease renewal failed", error);
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
                "释放结构规划执行权超时",
            );
            try {
                await withPreflightDeadline(
                    startLeaseRelease,
                    cleanupDeadline.signal,
                    "释放结构规划执行权超时",
                );
            } catch (error) {
                console.warn("tree lease release failed", error);
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
            "获取结构规划执行权超时",
        );
    } catch (error) {
        if (isClientCancelled(error) || isPreflightTimeout(error)) throw error;
        console.warn("tree lease acquisition failed", error);
        return preflightJsonError("结构规划状态存储暂不可用", "TREE_STORE_UNAVAILABLE", 503, 2);
    }

    if (!leaseMode) {
        const latestRaw = await withPreflightDeadline(
            () => getOwnedTask(context.env, taskId, uid),
            operationDeadline.signal,
            "读取结构规划恢复状态超时",
        );
        const latestState = latestRaw ? JSON.parse(latestRaw) : null;
        const latestRecord = latestState
            ? findPreflightOperation(latestState, "tree", requestId)
            : undefined;
        if (latestRecord && hasExplicitInput && latestRecord.inputHash !== suppliedInputHash) {
            return preflightJsonError("同一 treeRequestId 携带了不同输入", "TREE_REQUEST_CONFLICT", 409);
        }
        if (latestRecord?.status === "completed" && latestRecord.billingSettled) {
            return replayPreflightResult("tree", latestRecord);
        }
        if (latestRecord?.status === "cancelled") {
            return preflightJsonError("结构规划请求已取消", "TREE_CANCELLED", 409, undefined, {
                retryable: false,
            });
        }
        return preflightJsonError(
            latestRecord ? "结构规划仍在执行" : "任务正在执行其他操作",
            "TREE_IN_PROGRESS",
            409,
            2,
            { activeRequestId: activePreflightOperation(latestState ?? {}, "tree")?.requestId ?? requestId },
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
            "持久化结构规划状态超时",
        );
        if (!committed) throw new TreeLeaseLostError();
        if (release) leaseReleased = true;
    };

    try {
        await startLeaseRenewal();
        assertTreeOperationActive(operationDeadline.signal);
        raw = await withPreflightDeadline(
            () => getOwnedTask(context.env, taskId, uid),
            operationDeadline.signal,
            "重新读取结构规划任务状态超时",
        );
        assertTreeOperationActive(operationDeadline.signal);
        if (!raw) {
            scheduleLeaseRelease();
            return preflightJsonError("Task state unavailable", "TASK_STATE_UNAVAILABLE", 503, 2);
        }
        state = JSON.parse(raw);

        let record = findPreflightOperation(state, "tree", requestId);
        if (record && hasExplicitInput && record.inputHash !== suppliedInputHash) {
            scheduleLeaseRelease();
            return preflightJsonError("同一 treeRequestId 携带了不同输入", "TREE_REQUEST_CONFLICT", 409);
        }

        if (record?.status === "completed") {
            if (!record.billingSettled) {
                const settlement = await withPreflightDeadline(
                    () => settleTaskCostQuota(context.env, uid, taskId),
                    operationDeadline.signal,
                    "结算结构规划用量超时",
                );
                assertTreeOperationActive(operationDeadline.signal);
                state.totalCost = settlement.total;
                state.consumedQuota = settlement.consumed;
                state.quotaExhausted = settlement.outOfQuota || state.quotaExhausted;
                record.billingSettled = true;
                if (settlement.outOfQuota) {
                    await withPreflightDeadline(
                        () => markTaskQuotaExhausted(context.env, taskId, uid),
                        operationDeadline.signal,
                        "持久化结构规划配额状态超时",
                    );
                }
                await persistState(true);
                assertTreeOperationActive(operationDeadline.signal);
            } else {
                scheduleLeaseRelease();
            }
            return replayPreflightResult("tree", record);
        }
        if (record?.status === "cancelled") {
            scheduleLeaseRelease();
            return preflightJsonError("结构规划请求已取消", "TREE_CANCELLED", 409, undefined, {
                retryable: false,
            });
        }
        if (record?.status === "retryable" && !record.billingSettled) {
            const settlement = await withPreflightDeadline(
                () => settleTaskCostQuota(context.env, uid, taskId),
                operationDeadline.signal,
                "结算待恢复的结构规划用量超时",
            );
            state.totalCost = settlement.total;
            state.consumedQuota = settlement.consumed;
            state.quotaExhausted = settlement.outOfQuota || state.quotaExhausted;
            record.billingSettled = true;
            if (settlement.outOfQuota) {
                await withPreflightDeadline(
                    () => markTaskQuotaExhausted(context.env, taskId, uid),
                    operationDeadline.signal,
                    "持久化待恢复的结构规划配额状态超时",
                );
            }
            await persistState(false);
            assertTreeOperationActive(operationDeadline.signal);
        }

        const activeRecord = activePreflightOperation(state, "tree");
        if (activeRecord && activeRecord.requestId !== requestId) {
            scheduleLeaseRelease();
            return preflightJsonError(
                "存在尚未完成的结构规划请求，请恢复原请求",
                "TREE_RECOVERY_REQUIRED",
                409,
                undefined,
                { activeRequestId: activeRecord.requestId },
            );
        }

        if (state.quotaExhausted && !llm.byok) {
            scheduleLeaseRelease();
            return preflightJsonError("充值额度已用尽", "QUOTA_EXHAUSTED", 402);
        }

        if (!record) {
            const session = state.treeSession as TreeSession | null;
            const currentTree = state.tree as ProjectTree | null;
            let invalid = "";
            if (body.action === "build") {
                if (session && session.status !== "failed") invalid = "已有结构规划会话，请继续或修正";
            } else if (body.action === "refine") {
                const correction = String(suppliedInput.correction);
                if (!correction || correction.length > 1000) invalid = "修正意见须为 1–1000 字";
                else if (currentTree?.status !== "ready" && !(session?.status === "failed" && currentTree)) invalid = "当前结构树不能修正";
            } else if (!session || !["continue", "learning"].includes(session.status)) invalid = "当前没有可续接的规划会话";
            if (invalid) { scheduleLeaseRelease(); return preflightJsonError(invalid, "INVALID_TREE_ACTION", 400); }
            if (body.action !== "continue") {
                if (body.action === "build") state.tree = createInitialTree(state.coreType, state.version);
                else state.tree.status = "drafting";
                const focusIds = (suppliedInput.focusIds as unknown[]).filter((id): id is string => typeof id === "string" && [...state.tree.nodes, ...state.tree.modules].some(item => item.id === id));
                state.treeSession = { mode: body.action, round: 0, status: "continue", correction: String(suppliedInput.correction), focusIds, issues: [], lastResults: [], emptyRounds: 0, learningRequestId: null } satisfies TreeSession;
            }
            record = appendPreflightOperation(state, "tree", {
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
        assertTreeOperationActive(operationDeadline.signal);

        assertTreeOperationActive(operationDeadline.signal);
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
                        "结构规划终态发送超时",
                    );
                }
                return terminalDeadline.signal;
            };
            const heartbeat = setInterval(() => {
                writeSSE(
                    writer,
                    encoder,
                    { type: "heartbeat", stage: "tree", t: Date.now() },
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
                record = findPreflightOperation(state, "tree", requestId);
                if (!record) throw new TreeLeaseLostError();
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
                    `收口结构规划${label}状态超时`,
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
                        `提交结构规划${label}状态超时`,
                    );
                    if (!committed) throw new TreeLeaseLostError();
                    if (!record!.billingSettled) {
                        const settlement = await withPreflightDeadline(
                            () => settleTaskCostQuota(context.env, uid, taskId),
                            finalizeDeadline.signal,
                            `结算结构规划${label}用量超时`,
                        );
                        state.totalCost = settlement.total;
                        state.consumedQuota = settlement.consumed;
                        state.quotaExhausted = settlement.outOfQuota || state.quotaExhausted;
                        record!.billingSettled = true;
                        if (settlement.outOfQuota) {
                            await withPreflightDeadline(
                                () => markTaskQuotaExhausted(context.env, taskId, uid),
                                finalizeDeadline.signal,
                                `持久化结构规划${label}配额状态超时`,
                            );
                        }
                        await persistState(false, finalizeDeadline.signal);
                    }
                } catch (finalizeError) {
                    const kind = label === "中断" ? "interrupted" : "failure";
                    console.warn(`tree ${kind} state finalization failed`, finalizeError);
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
                        stage: "tree",
                        phase: "tree_planning",
                        round: state.treeSession.round + 1,
                    },
                    operationAbort,
                    operationDeadline.signal,
                );

                const session = state.treeSession as TreeSession;
                let tree = state.tree as ProjectTree;
                const round = session.round + 1;
                const externalDeps = tree.project.externalDeps;
                if (Array.isArray(body.skillIds)) {
                    if (body.skillIds.length) await writeSSE(writer, encoder,
                        { type: "skill_context", status: "started", requested: body.skillIds.length }, operationAbort, operationDeadline.signal);
                    state.skills = body.skillIds.length
                        ? await getSkillBundles(context.env, body.skillIds, { signal: operationDeadline.signal }) : [];
                    if (body.skillIds.length) await writeSSE(writer, encoder,
                        { type: "skill_context", status: "completed", requested: body.skillIds.length, loaded: state.skills.length }, operationAbort, operationDeadline.signal);
                }
                if (learningResolution?.status === "resolved" && session.learningRequestId === learningResolution.request.requestId) {
                    tree.knowledgeNeeds = deduplicateKnowledgeNeeds([...tree.knowledgeNeeds, ...learningResolution.request.needs]).slice(0, 8);
                    state.knowledgeUsed = mergeKnowledgeUsed(state.knowledgeUsed, learningResolution.knowledgeUsed);
                }
                const knowledge = await loadKnowledgeContext({ env: context.env, needs: tree.knowledgeNeeds, maxCharacters: 4800, title: "结构规划已验证公共技术知识" });
                state.knowledgeUsed = mergeKnowledgeUsed(state.knowledgeUsed, knowledge.used);
                const prompt = treeBuilderPrompt({
                    userPrompt: state.userPrompt, coreType: state.coreType, version: state.version,
                    clarifyRounds: state.clarifyRounds, treeSnapshot: treePromptSnapshot(tree),
                    issues: session.issues, lastResults: session.lastResults, mode: session.mode,
                    correction: session.correction, focusIds: session.focusIds.map(id => {
                        const target = tree.nodes.find(n => n.id === id) ?? tree.modules.find(m => m.id === id);
                        return target ? `${id}（${target.title}）` : id;
                    }), round, maxRounds: MAX_TREE_ROUNDS,
                    apiContractContext: buildApiContractContext({ coreType: state.coreType, version: state.version, externalDeps, generatedFiles: [] }),
                    knowledgeContext: knowledge.context, skillContext: state.skills?.length ? skillTreeContext(state.skills) : "",
                });
                const messages: ModelChatMessage[] = learningResolution?.status === "resolved"
                    && session.learningRequestId === learningResolution.request.requestId
                    ? learningResolution.messages : [{ role: "system", content: prompt.system }, { role: "user", content: prompt.user }];
                const idle = createPreflightIdleDeadline(PREFLIGHT_UPSTREAM_FIRST_CHUNK_MS, PREFLIGHT_UPSTREAM_IDLE_MS, "结构规划模型长时间无有效输出", operationDeadline.signal);
                let modelResult: Awaited<ReturnType<typeof consumeChatStream>>;
                try {
                    const response = await withPreflightDeadline(() => fetch(llm.url, {
                        method: "POST", headers: { "Content-Type": "application/json", Authorization: `Bearer ${llm.apiKey}` },
                        body: JSON.stringify({ model: llm.modelFor("pro"), ...thinkingFor(llm, "pro", "high"), stream: true, stream_options: { include_usage: true }, messages, tools: [...treeToolDefinitions(), ...learningToolDefinition(llm)] }),
                        signal: idle.signal,
                    }), idle.signal, "结构规划模型连接超时");
                    modelResult = await withPreflightDeadline(() => consumeChatStream(response, {
                        requireUsage: !llm.byok, onActivity: () => idle.arm(), onUsage: value => { usage = value; },
                        onThinking: content => writeSSE(writer, encoder, { type: "reasoning", stage: "tree", content }, operationAbort, operationDeadline.signal),
                        onOutput: content => writeSSE(writer, encoder, { type: "delta", stage: "tree", content }, operationAbort, operationDeadline.signal),
                        onToolCall: (index, name) => writeSSE(writer, encoder, { type: "tool_call", stage: "tree", index, name }, operationAbort, operationDeadline.signal),
                    }), idle.signal, "结构规划模型长时间无有效输出");
                } finally { idle.dispose(); }
                usage = modelResult.usage;
                assertTreeOperationActive(operationDeadline.signal);
                const calls = modelResult.message.tool_calls ?? [];
                const hasLearning = calls.some(call => call.function.name === LEARNING_TOOL_NAME);
                if (session.learningRequestId) removeModelLearningRequest(state, session.learningRequestId);
                session.learningRequestId = null;
                let learningToolRequests: unknown[] | undefined;
                if (hasLearning) {
                    const request = await createModelLearningRequest({ message: modelResult.message, messages, origin: "tree", originKey: `tree:${round}`, round, coreType: state.coreType, mcVersion: state.version, allowedDependencies: externalDeps });
                    if (!request || !llm.canAutoLearn || llm.providerId !== "deepseek") throw new Error("本次模型配置不支持公共 API 学习");
                    putModelLearningRequest(state, request);
                    session.learningRequestId = request.requestId;
                    session.status = "learning";
                    session.lastResults = calls.filter(c => c.function.name !== LEARNING_TOOL_NAME).map((call, index) => ({ index, tool: call.function.name, ok: false, summary: "操作已忽略", error: "已忽略：与学习调用混用" }));
                    learningToolRequests = [request];
                } else {
                    const applied = applyTreeToolCalls(tree, calls);
                    tree = applied.tree;
                    state.tree = tree;
                    session.lastResults = applied.results;
                    session.status = "continue";
                    session.emptyRounds = applied.results.some(result => result.changed) ? 0 : session.emptyRounds + 1;
                    session.issues = [
                        ...validateProjectTree(tree),
                        ...applied.results.filter(result => !result.ok).map(result => ({ code: result.errorCode ?? "TREE_TOOL_FAILED", message: `${result.tool}：${result.error ?? "操作失败"}` })),
                    ];
                    if (applied.finishRequested || !calls.length) {
                        if (!session.issues.length) { tree.status = "ready"; session.status = "ready"; }
                    }
                    if (session.status !== "ready" && (session.emptyRounds >= 2 || round >= MAX_TREE_ROUNDS)) {
                        session.status = "failed";
                        session.issues.push(session.emptyRounds >= 2
                            ? { code: "TREE_NO_PROGRESS", message: "连续两轮未产生有效结构变更，已停止继续调用；请查看工具错误后重试修正" }
                            : { code: "TREE_ROUND_LIMIT", message: "本次规划已达到轮数上限，尚未通过的结构和工具问题已保留" });
                    }
                }
                session.round = round;
                if (session.status === "learning" && round >= MAX_TREE_ROUNDS) session.status = "failed";
                state.status = session.status === "ready" || session.status === "failed" ? "tree_confirming" : "tree_planning";
                const result: Record<string, unknown> = { status: session.status, round, tree: publicTreeView(tree), issues: session.issues, results: session.lastResults, ...(learningToolRequests ? { learningToolRequests } : {}) };

                assertTreeOperationActive(operationDeadline.signal);
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
                    "提交结构规划结果超时",
                );
                if (!committed) throw new TreeLeaseLostError();
                if (!record!.billingSettled) {
                    const settlement = await withPreflightDeadline(
                        () => settleTaskCostQuota(context.env, uid, taskId),
                        operationDeadline.signal,
                        "结算结构规划用量超时",
                    );
                    state.totalCost = settlement.total;
                    state.consumedQuota = settlement.consumed;
                    state.quotaExhausted = settlement.outOfQuota || state.quotaExhausted;
                    record!.billingSettled = true;
                    if (settlement.outOfQuota) {
                        await withPreflightDeadline(
                            () => markTaskQuotaExhausted(context.env, taskId, uid),
                            operationDeadline.signal,
                            "持久化结构规划配额状态超时",
                        );
                    }
                    await persistState(false);
                }

                await writeSSE(writer, encoder, { type: "tree_ops", stage: "tree", round: state.treeSession.round, results: state.treeSession.lastResults }, operationAbort, terminalSignal());
                await writeSSE(
                    writer,
                    encoder,
                    { type: "result", stage: "tree", ...result! },
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
                const mapped = treeError(error);
                if (!resultCommitted) {
                    if (resultCommitPending) {
                        mapped.code = "TREE_FINALIZATION_PENDING";
                        mapped.status = 503;
                        mapped.retryable = true;
                        mapped.retryAfter = 2;
                    } else {
                        await finalizeRetryableAttempt(mapped.message, "失败");
                    }
                } else {
                    mapped.code = "TREE_SETTLEMENT_PENDING";
                    mapped.status = 503;
                    mapped.retryable = true;
                    mapped.retryAfter = 2;
                }
                const signal = terminalSignal();
                try {
                    await writeSSE(
                        writer,
                        encoder,
                        { type: "log", msg: `× 结构规划错误: ${mapped.message}` },
                        operationAbort,
                        signal,
                    );
                    await writeSSE(writer, encoder, {
                        type: "error", stage: "tree", error: mapped.message, ...mapped,
                    }, operationAbort, signal);
                    await writeSSE(writer, encoder, {
                        type: "result", stage: "tree", error: mapped.message, ...mapped,
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
                        "结构规划结束标记发送超时",
                    );
                } catch { /* disconnected or terminal budget exhausted */ }
                let streamClosed = false;
                try {
                    await withPreflightDeadline(
                        () => writer.close(),
                        signal,
                        "关闭结构规划响应流超时",
                    );
                    streamClosed = true;
                } catch { /* already disconnected */ }
                if (!streamClosed) {
                    const abortDeadline = createPreflightDeadline(
                        PREFLIGHT_TERMINAL_WRITE_MS,
                        "终止结构规划响应流超时",
                    );
                    try {
                        await withPreflightDeadline(
                            () => writer.abort(signal.reason),
                            abortDeadline.signal,
                            "终止结构规划响应流超时",
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
        const mapped = treeError(error);
        return preflightJsonError(
            mapped.message,
            mapped.code,
            mapped.status,
            mapped.retryAfter,
            { retryable: mapped.retryable },
        );
    }
}

const onTreeRound: PagesFunction<Env> = async (context) => {
    const operationAbort = new AbortController();
    const unlinkClientAbort = linkClientAbortSignal(
        operationAbort,
        context.request.signal,
        "Tree client disconnected",
    );
    const operationDeadline: PreflightDeadline = {
        signal: operationAbort.signal,
        dispose() { /* lifetime is owned by operationAbort */ },
    };
    let operationHandedOff = false;
    let operationDisposed = false;
    const disposeOperation = () => {
        if (operationDisposed) return;
        operationDisposed = true;
        operationDeadline.dispose();
        unlinkClientAbort();
    };

    try {
        return await handleTreeRequest(
            context,
            operationAbort,
            operationDeadline,
            () => { operationHandedOff = true; },
            disposeOperation,
        );
    } catch (error) {
        const mapped = treeError(error);
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

function json(data: unknown, status = 200): Response {
    return new Response(JSON.stringify(data), { status, headers: { "Content-Type": "application/json", "Cache-Control": "no-store" } });
}
function pendingTreeOperation(state: { treeOperations?: { requestId: string; status: string; billingSettled: boolean; input: Record<string, unknown> }[] }) {
    return [...(state.treeOperations ?? [])].reverse().find(operation => operation.status !== "cancelled" && (operation.status !== "completed" || !operation.billingSettled));
}
export const onRequestGet: PagesFunction<Env> = async context => {
    const taskId = new URL(context.request.url).searchParams.get("taskId") ?? "";
    const raw = await getOwnedTask(context.env, taskId, String(context.data.uid ?? ""));
    if (!raw) return preflightJsonError("任务不存在", "TASK_NOT_FOUND", 404);
    const state = JSON.parse(raw);
    const pending = pendingTreeOperation(state);
    return json({ tree: state.tree ? publicTreeView(state.tree) : null, session: state.treeSession ?? null, pendingOperation: pending ? { requestId: pending.requestId, input: pending.input } : null, nodeChecks: state.nodeChecks ?? {}, pathChecks: publicPathChecks(state), generation: { plan: state.plan ?? [], currentBucket: state.currentBucket ?? 0, fileStatuses: state.fileStatuses ?? {} } });
};
export const onRequestPost: PagesFunction<Env> = async context => {
    let body: { taskId?: string; action?: string; revision?: number };
    try { body = await context.request.clone().json(); }
    catch { return preflightJsonError("请求体必须为 JSON", "INVALID_TREE_ACTION", 400); }
    if (body.action !== "confirm") return onTreeRound(context);
    const taskId = body.taskId ?? "", uid = String(context.data.uid ?? "");
    let raw = await getOwnedTask(context.env, taskId, uid);
    if (!raw) return preflightJsonError("任务不存在", "TASK_NOT_FOUND", 404);
    const token = `tree:confirm:${crypto.randomUUID()}`;
    const mode = await acquireTaskOperationLease(context.env, taskId, uid, token, PREFLIGHT_LEASE_MS);
    if (!mode) return preflightJsonError("任务正在执行其他操作", "TREE_IN_PROGRESS", 409, 2);
    let released = false;
    try {
        raw = await getOwnedTask(context.env, taskId, uid);
        if (!raw) return preflightJsonError("任务不存在", "TASK_NOT_FOUND", 404);
        const state = JSON.parse(raw);
        const tree = state.tree as ProjectTree | null;
        if (!tree) return preflightJsonError("结构树尚未就绪", "TREE_NOT_READY", 409);
        const result = () => ({ ok: true, tree: publicTreeView(tree), plan: state.plan, bucketPaths: state.buckets.map((bucket: { path: string }[]) => bucket.map(file => file.path)) });
        if (tree.status === "locked" && tree.lockedRevision === body.revision) return json(result());
        if (pendingTreeOperation(state)) return preflightJsonError("结构规划仍有待恢复或结算的请求，请先恢复原操作", "TREE_SETTLEMENT_PENDING", 409);
        if (tree.revision !== body.revision) return preflightJsonError("结构树已更新，请重新确认", "TREE_REVISION_MISMATCH", 409, undefined, { tree: publicTreeView(tree) });
        if (tree.status !== "ready") return preflightJsonError("结构树尚未就绪", "TREE_NOT_READY", 409);
        const issues = validateProjectTree(tree);
        if (issues.length) return preflightJsonError("结构树仍有待处理问题", "TREE_INVALID", 409, undefined, { issues });
        const derived = deriveGenerationPlan(tree);
        Object.assign(state, derived, tree.project, { status: "generating", fileStatuses: Object.fromEntries(derived.plan.map(file => [file.path, "pending"])), generationCheckpoints: {}, currentBucket: 0, generatedFiles: [], currentFileIndex: 0, nodeChecks: {}, pathReviews: {}, sourceFingerprint: "", compileCheck: null });
        tree.status = "locked"; tree.lockedRevision = tree.revision;
        const committed = await putTaskWithOperationLease(context.env, taskId, JSON.stringify(state), token, mode, 3600, uid, true);
        if (!committed) throw new TreeLeaseLostError();
        released = true;
        return json(result());
    } finally {
        if (!released) await releaseTaskOperationLease(context.env, taskId, uid, token, mode).catch(error => console.warn("tree confirm lease release failed", error));
    }
};
