import { plannerPrompt, skillPlannerContext, GENERATOR_TYPES, type GeneratorType, type MainBlueprint, type PlanFileItem, type PlannerGradeContext } from "../../_lib/prompts";
import { getSkillBundles } from "../../_lib/skills";
import { litAxes } from "../../_lib/complexity";
import { settleTaskCostQuota, usageCost, type UsageBreakdown } from "../../_lib/quota";
import {
    deepSeekKeyRequiredResponse,
    resolveLLM,
    resolveTaskLLM,
    taskBillingProviderFor,
} from "../../_lib/llm";
import {
    assertOpenAIResponse,
    OpenAIStreamProtocolError,
    type OpenAIStreamResult,
} from "../../_lib/openAIStream";
import { buildApiContractContext } from "../../_lib/apiContracts";
import { loadKnowledgeContext, mergeKnowledgeUsed, recordKnowledgeContextUsage } from "../../_lib/learning/context";
import {
    createModelLearningRequest,
    getModelLearningRequest,
    learningToolDefinition,
    MAX_LEARNING_TOOL_ROUNDS,
    putModelLearningRequest,
    removeModelLearningRequest,
    type ModelChatMessage,
    type ModelLearningRequest,
} from "../../_lib/learning/tool";
import {
    resolveModelLearningRequest,
    type ModelLearningResolution,
} from "../../_lib/learning/toolRuntime";
import {
    assessPlannerLearningAuthorization,
    assessPlannerResultAuthorization,
    samePlannerResultAuthorization,
    type PlannerResultAuthorization,
} from "../../_lib/learning/plannerAuthorization";
import {
    acquireTaskPlannerLease,
    assertBoundTaskStoreSchema,
    cleanupExpiredTasks,
    getOwnedTask,
    markTaskQuotaExhausted,
    putTaskWithOperationLease,
    putTaskWithOperationLeaseAndCost,
    putTaskState,
    putTaskWithPlannerLease,
    releaseTaskPlannerLease,
    renewTaskPlannerLease,
    TaskStoreUnavailableError,
} from "../../_lib/taskStore";
import { preflightOperations } from "../../_lib/preflightOperations";

export const PLANNER_PREPARATION_TIMEOUT_MS = 20_000;
export const PLANNER_UPSTREAM_TIMEOUT_MS = 100_000;
// Cloudflare 代理默认约 125s 无响应会返回 524；整体 deadline 需预留足够时间返回结构化 504。
export const PLANNER_OPERATION_TIMEOUT_MS = 110_000;
// 整段 deadline 必须短于租约；即使后台释放失败，重试也只需等待短暂的剩余租期。
export const PLANNER_LEASE_MS = 120_000;
const PLANNER_UPSTREAM_IDLE_MS = PLANNER_UPSTREAM_TIMEOUT_MS;

interface Env {
    DB?: D1Database;
    DEEPSEEK_API_KEY: string;
    TASKS: KVNamespace;
    GITHUB_TOKEN?: string;
}

/**
 * 对文件列表进行拓扑排序，确保被依赖的文件先生成。
 * depends 中的值是文件名（不含路径前缀），如 "EconomyManager.java"。
 * 如果 AI 返回的 depends 有误（引用不存在的文件），忽略该依赖，退回 order 排序。
 */
function topoSort(files: PlanFileItem[]): PlanFileItem[] {
    const nameToPath = new Map<string, string>();
    for (const f of files) {
        const fileName = f.path.split("/").pop() ?? f.path;
        nameToPath.set(fileName, f.path);
    }

    const inDegree = new Map<string, number>();
    const adj = new Map<string, string[]>();
    for (const f of files) {
        inDegree.set(f.path, 0);
        adj.set(f.path, []);
    }

    for (const f of files) {
        for (const dep of f.depends ?? []) {
            const depPath = nameToPath.get(dep);
            if (depPath && depPath !== f.path) {
                adj.get(depPath)!.push(f.path);
                inDegree.set(f.path, (inDegree.get(f.path) ?? 0) + 1);
            }
        }
    }

    const pathToFile = new Map(files.map(f => [f.path, f]));
    const queue = files
        .filter(f => inDegree.get(f.path) === 0)
        .sort((a, b) => a.order - b.order);
    const sorted: PlanFileItem[] = [];

    while (queue.length > 0) {
        const current = queue.shift()!;
        sorted.push(current);
        for (const next of adj.get(current.path) ?? []) {
            const deg = (inDegree.get(next) ?? 1) - 1;
            inDegree.set(next, deg);
            if (deg === 0) {
                queue.push(pathToFile.get(next)!);
                queue.sort((a, b) => a.order - b.order);
            }
        }
    }

    if (sorted.length < files.length) {
        const sortedPaths = new Set(sorted.map(f => f.path));
        const remaining = files.filter(f => !sortedPaths.has(f.path)).sort((a, b) => a.order - b.order);
        sorted.push(...remaining);
    }

    sorted.forEach((f, i) => { f.order = i + 1; });
    return sorted;
}

/**
 * 基于 depends 的可解析关系计算每个文件的深度。
 * depth(f) = 0 if 没有可解析的 depends
 *          = 1 + max(depth(dep)) 否则
 * 不可解析的依赖（引用不存在的文件名）会被忽略。
 * 检测到循环依赖时，对参与循环的节点返回 0（与 topoSort 的兜底一致）。
 */
function computeDepths(files: PlanFileItem[]): Map<string, number> {
    const nameToPath = new Map<string, string>();
    for (const f of files) {
        const fileName = f.path.split("/").pop() ?? f.path;
        nameToPath.set(fileName, f.path);
    }
    const pathToFile = new Map(files.map(f => [f.path, f]));
    const depthCache = new Map<string, number>();
    const visiting = new Set<string>();

    function depthOf(path: string): number {
        if (depthCache.has(path)) return depthCache.get(path)!;
        if (visiting.has(path)) return 0; // 循环依赖兜底
        visiting.add(path);
        const f = pathToFile.get(path);
        if (!f) { visiting.delete(path); return 0; }
        const deps = (f.depends ?? [])
            .map(d => nameToPath.get(d))
            .filter((p): p is string => !!p && p !== path);
        let d = 0;
        if (deps.length > 0) {
            d = 1 + Math.max(...deps.map(depthOf));
        }
        visiting.delete(path);
        depthCache.set(path, d);
        return d;
    }

    for (const f of files) depthOf(f.path);
    return depthCache;
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

interface PlannerStreamCallbacks {
    onActivity?: () => void;
    onThinking?: (content: string) => void | Promise<void>;
    onOutput?: (content: string) => void | Promise<void>;
    requireUsage?: boolean;
}

interface PlannerStreamResult extends OpenAIStreamResult {
    message: ModelChatMessage;
}

function plannerStreamText(value: unknown): string {
    if (typeof value === "string") return value;
    if (value && typeof value === "object" && !Array.isArray(value)) {
        const part = value as { text?: unknown; content?: unknown };
        if (typeof part.text === "string") return part.text;
        if (typeof part.content === "string") return part.content;
        return "";
    }
    if (!Array.isArray(value)) return "";
    return value.map((part: any) => {
        if (typeof part === "string") return part;
        if (typeof part?.text === "string") return part.text;
        if (typeof part?.content === "string") return part.content;
        return "";
    }).join("");
}

/** Consume one streamed planner response while preserving incremental tool calls. */
async function consumePlannerChatStream(
    response: Response,
    callbacks: PlannerStreamCallbacks = {},
): Promise<PlannerStreamResult> {
    await assertOpenAIResponse(response);
    if (!response.body) throw new Error("Model service returned an empty stream");

    type ToolCall = NonNullable<ModelChatMessage["tool_calls"]>[number];
    const toolCalls = new Map<number, ToolCall>();
    const reader = response.body.getReader();
    const decoder = new TextDecoder();
    let buffer = "";
    let content = "";
    let thinking = "";
    let usage: UsageBreakdown | undefined;
    let upstreamDone = false;

    const consumeEvent = async (eventText: string): Promise<void> => {
        const payload = eventText
            .split(/\r?\n/)
            .map(line => line.trimStart())
            .filter(line => line.startsWith("data:"))
            .map(line => line.slice(5).trimStart())
            .join("\n")
            .trim();
        if (!payload) return;
        if (payload === "[DONE]") {
            upstreamDone = true;
            return;
        }

        let chunk: any;
        try {
            chunk = JSON.parse(payload);
        } catch {
            throw new OpenAIStreamProtocolError(
                "STREAM_INVALID_EVENT",
                "Model stream contained an invalid JSON event",
            );
        }
        if (chunk?.error) {
            const message = typeof chunk.error === "string"
                ? chunk.error
                : chunk.error?.message || chunk.error?.code;
            throw new Error(message || "Model stream failed");
        }
        if (chunk?.usage) usage = chunk.usage as UsageBreakdown;

        const delta = chunk?.choices?.[0]?.delta ?? chunk?.choices?.[0]?.message ?? {};
        const thinkingDelta = plannerStreamText(
            delta.reasoning_content
            ?? delta.reasoning
            ?? delta.thinking_content
            ?? delta.thinking,
        );
        const outputDelta = plannerStreamText(delta.content);
        if (thinkingDelta) {
            thinking += thinkingDelta;
            await callbacks.onThinking?.(thinkingDelta);
        }
        if (outputDelta) {
            content += outputDelta;
            await callbacks.onOutput?.(outputDelta);
        }

        const rawCalls = Array.isArray(delta.tool_calls) ? delta.tool_calls : [];
        for (let fallbackIndex = 0; fallbackIndex < rawCalls.length; fallbackIndex++) {
            const rawCall = rawCalls[fallbackIndex];
            const parsedIndex = Number(rawCall?.index);
            const index = Number.isFinite(parsedIndex) && parsedIndex >= 0
                ? Math.floor(parsedIndex)
                : fallbackIndex;
            const current = toolCalls.get(index) ?? {
                id: "",
                type: "function" as const,
                function: { name: "", arguments: "" },
            };
            if (typeof rawCall?.id === "string") current.id += rawCall.id;
            if (typeof rawCall?.function?.name === "string") current.function.name += rawCall.function.name;
            if (typeof rawCall?.function?.arguments === "string") {
                current.function.arguments += rawCall.function.arguments;
            }
            toolCalls.set(index, current);
        }
    };

    const consumeBufferedEvents = async (flush = false): Promise<void> => {
        while (true) {
            const boundary = /\r?\n\r?\n/.exec(buffer);
            if (!boundary) break;
            const eventText = buffer.slice(0, boundary.index);
            buffer = buffer.slice(boundary.index + boundary[0].length);
            await consumeEvent(eventText);
            if (upstreamDone) return;
        }
        if (flush && buffer.trim()) {
            const eventText = buffer;
            buffer = "";
            await consumeEvent(eventText);
        }
    };

    try {
        while (!upstreamDone) {
            const { value, done } = await reader.read();
            if (done) break;
            callbacks.onActivity?.();
            buffer += decoder.decode(value, { stream: true });
            await consumeBufferedEvents();
        }
        buffer += decoder.decode();
        if (!upstreamDone) await consumeBufferedEvents(true);
    } finally {
        try { await reader.cancel(); } catch { /* best effort */ }
        reader.releaseLock();
    }

    if (!upstreamDone) {
        throw new OpenAIStreamProtocolError("STREAM_TRUNCATED", "Model stream ended before [DONE]");
    }
    if (callbacks.requireUsage && !usage) {
        throw new OpenAIStreamProtocolError("STREAM_USAGE_MISSING", "Model stream completed without usage");
    }

    const orderedToolCalls = [...toolCalls.entries()]
        .sort(([left], [right]) => left - right)
        .map(([, call]) => call);
    return {
        content,
        thinking,
        usage,
        message: {
            role: "assistant",
            content,
            ...(thinking ? { reasoning_content: thinking } : {}),
            ...(orderedToolCalls.length ? { tool_calls: orderedToolCalls } : {}),
        },
    };
}

function plannerResultPayload(taskId: string, state: any): any {
    return {
        taskId,
        plan: state.plan,
        projectName: state.projectName,
        packageName: state.packageName,
        javaVersion: state.javaVersion,
        mainBlueprint: state.mainBlueprint,
        buckets: state.buckets,
    };
}

async function writePlannerError(
    writer: WritableStreamDefaultWriter<Uint8Array>,
    encoder: TextEncoder,
    error: string,
    code: string,
    status: number,
    details: Record<string, unknown> = {},
): Promise<void> {
    const payload = { stage: "plan", error, code, status, ...details };
    await writeSSE(writer, encoder, { type: "error", ...payload });
    await writeSSE(writer, encoder, { type: "result", ...payload });
}

function isValidBlueprint(bp: any): bp is MainBlueprint {
    if (!bp || typeof bp !== "object") return false;
    if (!Array.isArray(bp.events)) return false;
    if (!Array.isArray(bp.commands)) return false;
    if (!Array.isArray(bp.tasks)) return false;
    if (!Array.isArray(bp.services)) return false;
    if (!bp.config || typeof bp.config !== "object") return false;
    if (!Array.isArray(bp.config.files)) return false;
    return true;
}

function isRecord(value: unknown): value is Record<string, any> {
    return !!value && typeof value === "object" && !Array.isArray(value);
}

export function shouldReusePersistedPlannerResult(
    state: any,
    replan: unknown,
    plannerRequestId = "",
    expectedAuthorization?: PlannerResultAuthorization,
): boolean {
    const sameExplicitReplan = replan === true
        && !!plannerRequestId
        && state?.plannerRequestId === plannerRequestId;
    const authorizationMatches = !expectedAuthorization || samePlannerResultAuthorization(
        state?.plannerResultAuthorization,
        expectedAuthorization,
    );
    return authorizationMatches
        && (replan !== true || sameExplicitReplan)
        && state?.status === "planning"
        && isValidBlueprint(state.mainBlueprint)
        && Array.isArray(state.plan)
        && state.plan.length > 0
        && Array.isArray(state.buckets)
        && state.buckets.length > 0;
}

function plannerResultResponse(taskId: string, state: any): Response {
    return new Response(JSON.stringify(plannerResultPayload(taskId, state)), {
        headers: { "Content-Type": "application/json" },
    });
}

function plannerLearningResponse(
    taskId: string,
    plannerRequestId: string,
    request: ModelLearningRequest,
): Response {
    return new Response(JSON.stringify({
        taskId,
        plannerRequestId,
        learningToolRequests: [{
            requestId: request.requestId,
            origin: request.origin,
            targetPath: request.targetPath,
            questions: request.needs.map((need) => need.claim.question),
        }],
    }), {
        headers: { "Content-Type": "application/json" },
    });
}

function parsePlannerRequestId(value: unknown): string {
    return typeof value === "string" && /^plan_[a-z0-9]{16,64}$/i.test(value)
        ? value
        : "";
}

function plannerBusyResponse(): Response {
    return new Response(JSON.stringify({
        error: "Planner 正在执行，请等待现有结果",
        code: "PLANNER_IN_PROGRESS",
    }), {
        status: 409,
        headers: {
            "Content-Type": "application/json",
            "Retry-After": "2",
        },
    });
}

class PlannerTimeoutError extends Error {
    constructor(message: string) {
        super(message);
        this.name = "PlannerTimeoutError";
    }
}

function plannerTimeoutResponse(): Response {
    return new Response(JSON.stringify({
        error: "Planner 处理超时，请重试",
        code: "PLANNER_TIMEOUT",
    }), {
        status: 504,
        headers: {
            "Content-Type": "application/json",
            "Cache-Control": "no-store",
            "Retry-After": "1",
        },
    });
}

function plannerSettlementPendingResponse(): Response {
    return new Response(JSON.stringify({
        error: "Planner 结果已生成，额度结算暂未完成，请重试当前请求",
        code: "PLANNER_SETTLEMENT_PENDING",
        retryable: true,
    }), {
        status: 503,
        headers: {
            "Content-Type": "application/json",
            "Retry-After": "2",
        },
    });
}

function createPlannerDeadline(timeoutMs: number, message: string, parent?: AbortSignal) {
    const controller = new AbortController();
    const abortFromParent = () => {
        if (!controller.signal.aborted) {
            controller.abort(parent?.reason instanceof Error ? parent.reason : new PlannerTimeoutError(message));
        }
    };
    if (parent?.aborted) abortFromParent();
    else parent?.addEventListener("abort", abortFromParent, { once: true });
    const timer = setTimeout(() => {
        if (!controller.signal.aborted) controller.abort(new PlannerTimeoutError(message));
    }, timeoutMs);
    return {
        signal: controller.signal,
        dispose() {
            clearTimeout(timer);
            parent?.removeEventListener("abort", abortFromParent);
        },
    };
}

function createPlannerIdleDeadline(timeoutMs: number, message: string, parent?: AbortSignal) {
    const controller = new AbortController();
    let timer: ReturnType<typeof setTimeout> | undefined;
    const abortFromParent = () => {
        if (!controller.signal.aborted) {
            controller.abort(parent?.reason instanceof Error ? parent.reason : new PlannerTimeoutError(message));
        }
    };
    const arm = () => {
        if (timer) clearTimeout(timer);
        timer = setTimeout(() => {
            if (!controller.signal.aborted) controller.abort(new PlannerTimeoutError(message));
        }, timeoutMs);
    };
    if (parent?.aborted) abortFromParent();
    else parent?.addEventListener("abort", abortFromParent, { once: true });
    arm();
    return {
        signal: controller.signal,
        arm,
        dispose() {
            if (timer) clearTimeout(timer);
            parent?.removeEventListener("abort", abortFromParent);
        },
    };
}

function plannerAbortReason(signal: AbortSignal, message: string): Error {
    return signal.reason instanceof Error ? signal.reason : new PlannerTimeoutError(message);
}

function withPlannerDeadline<T>(operation: () => Promise<T>, signal: AbortSignal, message: string): Promise<T> {
    if (signal.aborted) return Promise.reject(plannerAbortReason(signal, message));
    return new Promise<T>((resolve, reject) => {
        const abort = () => reject(plannerAbortReason(signal, message));
        signal.addEventListener("abort", abort, { once: true });
        let promise: Promise<T>;
        try {
            promise = operation();
        } catch (error) {
            signal.removeEventListener("abort", abort);
            reject(error);
            return;
        }
        promise.then(
            (value) => {
                signal.removeEventListener("abort", abort);
                resolve(value);
            },
            (error) => {
                signal.removeEventListener("abort", abort);
                reject(error);
            },
        );
    });
}

function isPlannerTimeout(error: unknown): boolean {
    return error instanceof PlannerTimeoutError
        || !!error && typeof error === "object" && "name" in error && error.name === "AbortError";
}

export const onRequestPost: PagesFunction<Env> = async (context) => {
    const body = await context.request.json() as any;
    const uid: string = (context.data as any)?.uid || "";

    // ─── Mode 1: initialize task, no plan yet ───
    if (!body.taskId) {
        const llm = await resolveLLM(context);
        if (!llm.apiKey) return new Response("API key not configured", { status: 500 });
        try {
            await assertBoundTaskStoreSchema(context.env);
        } catch (error) {
            const message = error instanceof TaskStoreUnavailableError
                ? error.message
                : "D1 任务数据库暂不可用，请稍后重试";
            return new Response(JSON.stringify({
                error: message,
                code: "TASK_STORE_MIGRATION_REQUIRED",
            }), {
                status: 503,
                headers: { "Content-Type": "application/json", "Retry-After": "30" },
            });
        }

        const { userPrompt, coreType, version } = body;
        // 建任务即拉取已挂载 skill，让 clarify / grade / plan / fileGen 全程都能感知能力
        const skillIds: string[] = Array.isArray(body.skillIds) ? body.skillIds : [];
        const skills = skillIds.length ? await getSkillBundles(context.env, skillIds) : [];
        const taskId = `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
        const state = {
            taskId,
            uid,
            billingProvider: taskBillingProviderFor(llm),
            status: "clarifying",
            userPrompt,
            coreType,
            version,
            clarifyRounds: [],
            clarifyDone: false,
            preflightProtocolVersion: 1,
            clarifyOperations: [],
            gradeOperations: [],
            projectName: "",
            javaVersion: "",
            packageName: "",
            mainBlueprint: null,
            plan: [],
            buckets: [],
            fileStatuses: {},
            generationCheckpoints: {},
            currentBucket: 0,
            generatedFiles: [],
            currentFileIndex: 0,
            skills,
            logs: ["任务已创建，进入澄清阶段"],
        };
        await putTaskState(context.env, taskId, state, 3600, uid);
        context.waitUntil(cleanupExpiredTasks(context.env).catch(() => { }));
        return new Response(JSON.stringify({ taskId }), {
            headers: { "Content-Type": "application/json" },
        });
    }

    // ─── Mode 2: finalize plan using reasoner + clarify answers ───
    const taskId = body.taskId as string;
    const raw = await getOwnedTask(context.env, taskId, uid);
    if (!raw) return new Response("Task not found", { status: 404 });
    const llm = await resolveTaskLLM(context, JSON.parse(raw));
    if (!llm) return deepSeekKeyRequiredResponse();
    if (!llm.apiKey) return new Response("API key not configured", { status: 500 });
    const suppliedPlannerRequestId = parsePlannerRequestId(body.plannerRequestId);
    if (body.replan === true && !suppliedPlannerRequestId) {
        return new Response(JSON.stringify({ error: "重新规划请求缺少有效 plannerRequestId" }), {
            status: 400,
            headers: { "Content-Type": "application/json" },
        });
    }
    const plannerRequestId = suppliedPlannerRequestId
        || `plan_${crypto.randomUUID().replace(/-/g, "")}`;
    const learningToolJobs = body.learningToolJobs && typeof body.learningToolJobs === "object"
        ? body.learningToolJobs as Record<string, string>
        : {};
    const plannerLearningOriginKey = `planner:${plannerRequestId}`;
    const initialState = JSON.parse(raw);
    const storedPlannerLearningRequestId = typeof initialState.plannerLearningRequestId === "string"
        && /^learnreq_[a-f0-9]{32}$/i.test(initialState.plannerLearningRequestId)
        ? initialState.plannerLearningRequestId
        : "";
    let plannerLearningResolution: ModelLearningResolution | null = null;
    if (storedPlannerLearningRequestId) {
        plannerLearningResolution = await resolveModelLearningRequest({
            env: context.env,
            state: initialState,
            uid,
            taskId,
            requestId: storedPlannerLearningRequestId,
            jobId: learningToolJobs[storedPlannerLearningRequestId],
            maxCharacters: 6_000,
        });
        if (plannerLearningResolution.status === "pending"
            && plannerLearningResolution.request.originKey === plannerLearningOriginKey) {
            return plannerLearningResponse(
                taskId,
                plannerRequestId,
                plannerLearningResolution.request,
            );
        }
    }
    const leaseToken = `planner_${crypto.randomUUID().replace(/-/g, "")}`;
    let leaseMode;
    try {
        leaseMode = await acquireTaskPlannerLease(
            context.env,
            taskId,
            uid,
            leaseToken,
            PLANNER_LEASE_MS,
        );
    } catch (error) {
        console.warn("planner lease acquisition failed", error);
        return new Response(JSON.stringify({
            error: "Planner 状态存储暂不可用，请稍后重试",
            code: "PLANNER_STORE_UNAVAILABLE",
        }), {
            status: 503,
            headers: { "Content-Type": "application/json", "Retry-After": "2" },
        });
    }
    if (!leaseMode) return plannerBusyResponse();

    const operationDeadline = createPlannerDeadline(
        PLANNER_OPERATION_TIMEOUT_MS,
        "Planner 整体处理超时",
    );
    const preparationDeadline = createPlannerDeadline(
        PLANNER_PREPARATION_TIMEOUT_MS,
        "Planner 上下文准备超时",
        operationDeadline.signal,
    );
    let streamOwnsLease = false;
    let leaseReleased = false;

    try {
        const latestAfterLeaseRaw = await withPlannerDeadline(
            () => getOwnedTask(context.env, taskId, uid),
            preparationDeadline.signal,
            "读取 Planner 状态超时",
        );
        if (!latestAfterLeaseRaw) {
            return new Response("Task state unavailable", { status: 503 });
        }
        const state = JSON.parse(latestAfterLeaseRaw);
        const currentPlannerLearningRequestId = typeof state.plannerLearningRequestId === "string"
            && /^learnreq_[a-f0-9]{32}$/i.test(state.plannerLearningRequestId)
            ? state.plannerLearningRequestId
            : "";
        const currentPlannerLearningRequest = currentPlannerLearningRequestId
            ? getModelLearningRequest(state, currentPlannerLearningRequestId)
            : null;
        let previousPlannerLearningRequest: ModelLearningRequest | null = null;
        let plannerContinuationMessages: ModelChatMessage[] | null = null;
        if (plannerLearningResolution?.status === "resolved"
            && currentPlannerLearningRequest?.requestId === plannerLearningResolution.request.requestId
            && currentPlannerLearningRequest.originKey === plannerLearningOriginKey) {
            previousPlannerLearningRequest = plannerLearningResolution.request;
            plannerContinuationMessages = plannerLearningResolution.messages;
        } else if (currentPlannerLearningRequest?.originKey === plannerLearningOriginKey) {
            return plannerLearningResponse(taskId, plannerRequestId, currentPlannerLearningRequest);
        } else if (currentPlannerLearningRequestId) {
            removeModelLearningRequest(state, currentPlannerLearningRequestId);
            delete state.plannerLearningRequestId;
        }

        // 已原子入账但未完成额度结算的结果或失败 attempt 必须优先恢复。
        const attemptBillingPending = !!state.plannerAttemptBillingPending;
        if (state.plannerBillingSettled === false || attemptBillingPending) {
            try {
                const settlement = await withPlannerDeadline(
                    () => settleTaskCostQuota(context.env, uid, taskId),
                    preparationDeadline.signal,
                    "结算 Planner 用量超时",
                );
                state.totalCost = settlement.total;
                state.consumedQuota = settlement.consumed;
                state.quotaExhausted = settlement.outOfQuota || state.quotaExhausted;
                if (state.plannerBillingSettled === false) state.plannerBillingSettled = true;
                if (attemptBillingPending) delete state.plannerAttemptBillingPending;
                if (settlement.outOfQuota) {
                    await withPlannerDeadline(
                        () => markTaskQuotaExhausted(context.env, taskId, uid),
                        preparationDeadline.signal,
                        "持久化 Planner 配额状态超时",
                    );
                }
                const settled = await withPlannerDeadline(
                    () => putTaskWithOperationLease(
                        context.env,
                        taskId,
                        JSON.stringify(state),
                        leaseToken,
                        leaseMode,
                        3600,
                        uid,
                        false,
                    ),
                    preparationDeadline.signal,
                    "提交 Planner 结算状态超时",
                );
                if (!settled) return plannerSettlementPendingResponse();
            } catch (error) {
                console.warn("planner result settlement recovery failed", error);
                return plannerSettlementPendingResponse();
            }
        }

        if (!state.clarifyDone) {
            return new Response(JSON.stringify({ error: "澄清阶段尚未完成" }), {
                status: 400, headers: { "Content-Type": "application/json" },
            });
        }
        if (Number(state.preflightProtocolVersion) >= 1) {
            const clarifyOperations = preflightOperations(state, "clarify");
            const latestClarify = clarifyOperations[clarifyOperations.length - 1];
            if (latestClarify?.status !== "completed" || !latestClarify.billingSettled) {
                return new Response(JSON.stringify({
                    error: "澄清阶段用量尚未结算，请恢复原请求",
                    code: "CLARIFY_RECOVERY_REQUIRED",
                    ...(latestClarify?.requestId ? { activeRequestId: latestClarify.requestId } : {}),
                }), {
                    status: 409,
                    headers: {
                        "Content-Type": "application/json",
                        "Retry-After": "2",
                    },
                });
            }
            const gradeOperations = preflightOperations(state, "grade");
            const latestGrade = gradeOperations[gradeOperations.length - 1];
            if (!state.grade || latestGrade?.status !== "completed" || !latestGrade.billingSettled) {
                return new Response(JSON.stringify({
                    error: "复杂度分级尚未完成",
                    code: "GRADE_NOT_COMPLETED",
                }), {
                    status: 409,
                    headers: {
                        "Content-Type": "application/json",
                        "Retry-After": "2",
                    },
                });
            }
        }

        // ─── 分级确认门：非直接级须先选定实现路径，否则不消耗全量 plan 调用 ───
        const chosenPathId = typeof body.chosenPathId === "string" ? body.chosenPathId.trim() : "";
        const gradePaths = Array.isArray(state.grade?.paths) ? state.grade.paths : [];
        const effectivePathId = chosenPathId || state.grade?.chosenPathId || "";
        const validPath = !!effectivePathId && gradePaths.some((path: any) => path?.id === effectivePathId);
        if (chosenPathId && !validPath) {
            return new Response(JSON.stringify({ error: "无效的实现路径", code: "INVALID_PATH" }), {
                status: 400, headers: { "Content-Type": "application/json" },
            });
        }
        if (state.grade?.gateRequired && !effectivePathId) {
            return new Response(JSON.stringify({ error: "请先在确认门选择实现路径", code: "PATH_NOT_CONFIRMED" }), {
                status: 400, headers: { "Content-Type": "application/json" },
            });
        }
        if (effectivePathId && !validPath) {
            return new Response(JSON.stringify({ error: "已选实现路径不再有效", code: "INVALID_PATH" }), {
                status: 409, headers: { "Content-Type": "application/json" },
            });
        }
        if (chosenPathId && state.grade) state.grade.chosenPathId = chosenPathId;

        const [plannerAssessment, plannerResultAuthorization] = await Promise.all([
            assessPlannerLearningAuthorization(state),
            assessPlannerResultAuthorization(state),
        ]);
        if (!plannerAssessment || !plannerResultAuthorization) {
            return new Response(JSON.stringify({
                error: "Planner 路径授权已失效，请重新确认实现路径",
                code: "PLANNER_AUTHORIZATION_EXPIRED",
            }), {
                status: 409,
                headers: { "Content-Type": "application/json" },
            });
        }

        // 所有结果复用都在租约内读取最新状态，并绑定生成该结果时的路径与 need 集合。
        if (shouldReusePersistedPlannerResult(
            state,
            body.replan,
            plannerRequestId,
            plannerResultAuthorization,
        )) {
            return plannerResultResponse(taskId, state);
        }

        if (state.quotaExhausted && !llm.byok) {
            return new Response(JSON.stringify({ error: "充值额度已用尽", code: "QUOTA_EXHAUSTED" }), {
                status: 402, headers: { "Content-Type": "application/json" },
            });
        }

        // 据分级结果构建 plannerPrompt 的 gradeContext（点亮轴 + 所选路径）
        let gradeContext: PlannerGradeContext | undefined;
        if (state.grade?.vector) {
            const axes = litAxes(state.grade.vector);
            let chosenPath: PlannerGradeContext["chosenPath"];
            const pid = state.grade.chosenPathId;
            if (pid && Array.isArray(state.grade.paths)) {
                const p = state.grade.paths.find((x: any) => x.id === pid);
                if (p) chosenPath = { title: p.title, summary: p.summary, mermaid: p.mermaid };
            }
            if (axes.length || chosenPath) gradeContext = { axes, chosenPath };
        }

        // 据 body.skillIds 拉取用户挂载的 skill（KV 缓存 30min），存入 state 供逐文件生成复用
        const skillIds: string[] = Array.isArray(body.skillIds) ? body.skillIds : [];
        const loadedSkillIds = Array.isArray(state.skills) ? state.skills.map((s: any) => s.id) : [];
        const sameSkills = skillIds.length === loadedSkillIds.length
            && skillIds.every((id, i) => id === loadedSkillIds[i]);
        if (!sameSkills) {
            state.skills = skillIds.length
                ? await withPlannerDeadline(
                    () => getSkillBundles(context.env, skillIds, { signal: preparationDeadline.signal }),
                    preparationDeadline.signal,
                    "加载 Planner Skill 超时",
                )
                : [];
        }
        const skillCtx = state.skills?.length ? skillPlannerContext(state.skills) : "";
        const apiContractInput = {
            coreType: state.coreType,
            version: state.version,
            externalDeps: state.grade?.vector?.external_deps ?? [],
            generatedFiles: state.generatedFiles ?? [],
        };
        const apiContractCtx = buildApiContractContext(apiContractInput);
        const knowledge = await loadKnowledgeContext({
            env: context.env,
            needs: plannerAssessment.needs,
            maxCharacters: 4_800,
            title: "Planner 已验证公共技术知识",
        });
        state.knowledgeUsed = mergeKnowledgeUsed(state.knowledgeUsed, knowledge.used);
        if (plannerLearningResolution?.status === "resolved"
            && previousPlannerLearningRequest) {
            state.knowledgeUsed = mergeKnowledgeUsed(
                state.knowledgeUsed,
                plannerLearningResolution.knowledgeUsed,
            );
            context.waitUntil(recordKnowledgeContextUsage({
                env: context.env,
                items: plannerLearningResolution.knowledgeUsed,
                generationTaskId: taskId,
                stage: "tool:planner",
            }));
        }

        const { system, user } = plannerPrompt(
            state.userPrompt,
            state.coreType,
            state.version,
            state.clarifyRounds,
            gradeContext,
            apiContractCtx,
            knowledge.context,
            skillCtx,
        );

        const renewed = await withPlannerDeadline(
            () => renewTaskPlannerLease(context.env, taskId, uid, leaseToken, PLANNER_LEASE_MS),
            preparationDeadline.signal,
            "续订 Planner 租约超时",
        );
        if (!renewed) return plannerBusyResponse();
        preparationDeadline.dispose();

        const plannerMessages: ModelChatMessage[] = plannerContinuationMessages ?? [
            { role: "system", content: system },
            { role: "user", content: user },
        ];
        const plannerTools = !previousPlannerLearningRequest
            || previousPlannerLearningRequest.round < MAX_LEARNING_TOOL_ROUNDS
            ? learningToolDefinition(llm)
            : [];
        const { readable, writable } = new TransformStream<Uint8Array>();
        const encoder = new TextEncoder();
        const writer = writable.getWriter();
        streamOwnsLease = true;

        const process = (async () => {
            const heartbeat = setInterval(() => {
                writer.write(sseEvent(encoder, { type: "heartbeat", stage: "plan", t: Date.now() })).catch(() => { });
            }, 12000);
            let resultCommitted = false;
            let attemptBillingCommitted = false;
            try {
                await writeSSE(writer, encoder, { type: "phase", phase: "planning", stage: "plan" });
                const upstreamDeadline = createPlannerIdleDeadline(
                    PLANNER_UPSTREAM_IDLE_MS,
                    "Planner 模型响应空闲超时",
                    operationDeadline.signal,
                );
                let resp: Response;
                let streamed: PlannerStreamResult;
                try {
                    resp = await withPlannerDeadline(() => fetch(llm.url, {
                        method: "POST",
                        headers: { "Content-Type": "application/json", Authorization: `Bearer ${llm.apiKey}` },
                        body: JSON.stringify({
                            model: llm.modelFor("pro"),
                            reasoning_effort: "high",
                            thinking: { type: "enabled" },
                            stream: true,
                            stream_options: { include_usage: true },
                            messages: plannerMessages,
                            ...(plannerTools.length ? { tools: plannerTools } : {}),
                        }),
                        signal: upstreamDeadline.signal,
                    }), upstreamDeadline.signal, "Planner 模型调用超时");
                    if (!resp.ok) {
                        const responseText = await withPlannerDeadline(
                            () => resp.text(),
                            upstreamDeadline.signal,
                            "读取 Planner 模型错误响应超时",
                        );
                        const authFailed = resp.status === 401;
                        await writePlannerError(
                            writer,
                            encoder,
                            authFailed
                                ? "DeepSeek API Key 无效，请重新填写"
                                : (responseText || `Planner 模型返回 HTTP ${resp.status}`),
                            authFailed ? "LLM_AUTH_FAILED" : "PLANNER_UPSTREAM_ERROR",
                            resp.status,
                            { retryable: !authFailed },
                        );
                        return;
                    }
                    upstreamDeadline.arm();
                    streamed = await withPlannerDeadline(
                        () => consumePlannerChatStream(resp, {
                            onActivity: upstreamDeadline.arm,
                            requireUsage: !llm.byok,
                            onThinking: content => writeSSE(writer, encoder, {
                                type: "reasoning", stage: "plan", content,
                            }),
                            onOutput: content => writeSSE(writer, encoder, {
                                type: "delta", stage: "plan", content,
                            }),
                        }),
                        upstreamDeadline.signal,
                        "读取 Planner 模型响应超时",
                    );
                } finally {
                    upstreamDeadline.dispose();
                }

                await recordKnowledgeContextUsage({
                    env: context.env,
                    items: knowledge.used,
                    generationTaskId: taskId,
                    stage: "planner",
                }).catch((error) => console.warn("planner knowledge usage recording failed", error));

                const nextPlannerLearningRequest = plannerTools.length
                    ? await createModelLearningRequest({
                        message: streamed.message,
                        messages: plannerMessages,
                        origin: "planner",
                        originKey: plannerLearningOriginKey,
                        round: (previousPlannerLearningRequest?.round ?? 0) + 1,
                        coreType: state.coreType,
                        mcVersion: state.version,
                        allowedDependencies: Array.isArray(state.grade?.vector?.external_deps)
                            ? state.grade.vector.external_deps
                            : [],
                    })
                    : null;
                if (nextPlannerLearningRequest) {
                    if (previousPlannerLearningRequest) {
                        removeModelLearningRequest(state, previousPlannerLearningRequest.requestId);
                    }
                    putModelLearningRequest(state, nextPlannerLearningRequest);
                    state.plannerLearningRequestId = nextPlannerLearningRequest.requestId;
                    state.plannerRequestId = plannerRequestId;
                    state.logs.push("Planner 主动请求查证公开 API，等待 Learning 返回");

                    const usage = streamed.usage;
                    if (!llm.byok && uid && usage) {
                        state.plannerAttemptBillingPending = {
                            requestId: plannerRequestId,
                            kind: "learning_tool",
                            recordedAt: Date.now(),
                        };
                        const committed = await withPlannerDeadline(
                            () => putTaskWithOperationLeaseAndCost(
                                context.env,
                                taskId,
                                JSON.stringify(state),
                                leaseToken,
                                leaseMode,
                                usageCost(llm.modelFor("pro"), usage),
                                3600,
                                uid,
                                false,
                            ),
                            operationDeadline.signal,
                            "提交 Planner Learning 用量超时",
                        );
                        if (!committed) {
                            await writePlannerError(
                                writer,
                                encoder,
                                "Planner 正在执行，请等待现有结果",
                                "PLANNER_IN_PROGRESS",
                                409,
                                { retryable: true, retryAfter: 2 },
                            );
                            return;
                        }
                        attemptBillingCommitted = true;

                        const settlement = await withPlannerDeadline(
                            () => settleTaskCostQuota(context.env, uid, taskId),
                            operationDeadline.signal,
                            "结算 Planner Learning 用量超时",
                        );
                        state.totalCost = settlement.total;
                        state.consumedQuota = settlement.consumed;
                        state.quotaExhausted = settlement.outOfQuota || state.quotaExhausted;
                        if (settlement.outOfQuota) {
                            await withPlannerDeadline(
                                () => markTaskQuotaExhausted(context.env, taskId, uid),
                                operationDeadline.signal,
                                "持久化 Planner 配额状态超时",
                            );
                        }
                        delete state.plannerAttemptBillingPending;
                    }

                    const persisted = await withPlannerDeadline(
                        () => putTaskWithPlannerLease(
                            context.env,
                            taskId,
                            JSON.stringify(state),
                            leaseToken,
                            leaseMode,
                            3600,
                            uid,
                        ),
                        operationDeadline.signal,
                        "提交 Planner Learning 请求超时",
                    );
                    if (!persisted) {
                        if (attemptBillingCommitted) {
                            throw new Error("Planner learning billing state commit lost its lease");
                        }
                        await writePlannerError(
                            writer,
                            encoder,
                            "Planner 正在执行，请等待现有结果",
                            "PLANNER_IN_PROGRESS",
                            409,
                            { retryable: true, retryAfter: 2 },
                        );
                        return;
                    }
                    leaseReleased = true;
                    attemptBillingCommitted = false;
                    await writeSSE(writer, encoder, {
                        type: "result",
                        stage: "plan",
                        taskId,
                        plannerRequestId,
                        learningToolRequests: [{
                            requestId: nextPlannerLearningRequest.requestId,
                            origin: nextPlannerLearningRequest.origin,
                            targetPath: nextPlannerLearningRequest.targetPath,
                            questions: nextPlannerLearningRequest.needs.map((need) => need.claim.question),
                        }],
                    });
                    return;
                }
                if (previousPlannerLearningRequest) {
                    removeModelLearningRequest(state, previousPlannerLearningRequest.requestId);
                }
                delete state.plannerLearningRequestId;

                const content = stripFences(streamed.content);
                let validationUsageCharged = false;
                const chargeValidationFailure = async () => {
                    const usage = streamed.usage;
                    if (validationUsageCharged || llm.byok || !uid || !usage) return;
                    validationUsageCharged = true;
                    state.plannerAttemptBillingPending = {
                        requestId: plannerRequestId,
                        kind: "validation_failure",
                        recordedAt: Date.now(),
                    };
                    const committed = await withPlannerDeadline(
                        () => putTaskWithOperationLeaseAndCost(
                            context.env,
                            taskId,
                            JSON.stringify(state),
                            leaseToken,
                            leaseMode,
                            usageCost(llm.modelFor("pro"), usage),
                            3600,
                            uid,
                            false,
                        ),
                        operationDeadline.signal,
                        "提交 Planner 校验失败用量超时",
                    );
                    if (!committed) throw new Error("Planner validation billing commit lost its lease");
                    attemptBillingCommitted = true;

                    const settlement = await withPlannerDeadline(
                        () => settleTaskCostQuota(context.env, uid, taskId),
                        operationDeadline.signal,
                        "结算 Planner 校验失败用量超时",
                    );
                    state.totalCost = settlement.total;
                    state.consumedQuota = settlement.consumed;
                    state.quotaExhausted = settlement.outOfQuota || state.quotaExhausted;
                    if (settlement.outOfQuota) {
                        await withPlannerDeadline(
                            () => markTaskQuotaExhausted(context.env, taskId, uid),
                            operationDeadline.signal,
                            "持久化 Planner 配额状态超时",
                        );
                    }
                    delete state.plannerAttemptBillingPending;
                    const persisted = await withPlannerDeadline(
                        () => putTaskWithPlannerLease(
                            context.env,
                            taskId,
                            JSON.stringify(state),
                            leaseToken,
                            leaseMode,
                            3600,
                            uid,
                        ),
                        operationDeadline.signal,
                        "提交 Planner 校验失败计费状态超时",
                    );
                    if (!persisted) throw new Error("Planner validation billing state commit lost its lease");
                    leaseReleased = true;
                    attemptBillingCommitted = false;
                };

                let plan: any;
                try {
                    plan = JSON.parse(content);
                } catch {
                    await chargeValidationFailure();
                    await writePlannerError(writer, encoder, "Planner 返回非 JSON", "PLANNER_INVALID_JSON", 422, { raw: content });
                    return;
                }

                if (!isRecord(plan)) {
                    await chargeValidationFailure();
                    await writePlannerError(
                        writer,
                        encoder,
                        "Planner 返回的根结构无效",
                        "PLANNER_INVALID_ROOT",
                        422,
                        { raw: plan },
                    );
                    return;
                }

                // —— 蓝图校验 ——
                if (!isValidBlueprint(plan.mainBlueprint)) {
                    await chargeValidationFailure();
                    await writePlannerError(
                        writer,
                        encoder,
                        "Planner 缺少有效的 mainBlueprint",
                        "PLANNER_INVALID_BLUEPRINT",
                        422,
                        { raw: plan },
                    );
                    return;
                }
                const blueprint = plan.mainBlueprint as MainBlueprint;

                // —— 文件项校验：每个文件必须带合法的 generatorType ——
                if (!Array.isArray(plan.files) || plan.files.length === 0) {
                    await chargeValidationFailure();
                    await writePlannerError(writer, encoder, "Planner 未返回 files 数组", "PLANNER_INVALID_FILES", 422);
                    return;
                }
                const validTypes = new Set<string>(GENERATOR_TYPES);
                for (const f of plan.files) {
                    if (
                        !isRecord(f)
                        || typeof f.path !== "string"
                        || !f.path.trim()
                        || typeof f.role !== "string"
                        || !f.role.trim()
                        || typeof f.order !== "number"
                        || !Number.isFinite(f.order)
                        || (f.depends !== undefined && (
                            !Array.isArray(f.depends)
                            || !f.depends.every((dependency: unknown) => typeof dependency === "string")
                        ))
                    ) {
                        await chargeValidationFailure();
                        await writePlannerError(
                            writer,
                            encoder,
                            "文件项缺少 path/role/order",
                            "PLANNER_INVALID_FILE",
                            422,
                            { file: f },
                        );
                        return;
                    }
                    if (typeof f.generatorType !== "string" || !validTypes.has(f.generatorType)) {
                        await chargeValidationFailure();
                        await writePlannerError(
                            writer,
                            encoder,
                            `非法 generatorType: ${f.generatorType}`,
                            "PLANNER_INVALID_GENERATOR_TYPE",
                            422,
                            { file: f },
                        );
                        return;
                    }
                }

                let sortedFiles: PlanFileItem[];
                let totalBuckets: number;
                let buckets: PlanFileItem[][];
                let fileStatuses: Record<string, "pending" | "generating" | "done" | "error" | "rework">;
                try {
                    const files = plan.files as PlanFileItem[];

                    // —— 拓扑排序（保证 order 单调，依赖在前） ——
                    sortedFiles = topoSort(files);

                    // —— 计算深度桶 ——
                    const depthMap = computeDepths(sortedFiles);
                    let maxDepth = 0;
                    for (const d of depthMap.values()) if (d > maxDepth) maxDepth = d;

                    // MainGen 强制放到最后一桶 (maxDepth + 1)
                    const mainGenBucket = maxDepth + 1;
                    for (const f of sortedFiles) {
                        if (f.generatorType === "MainGen") {
                            f.bucket = mainGenBucket;
                        } else {
                            f.bucket = depthMap.get(f.path) ?? 0;
                        }
                    }

                    // 构建桶数组：buckets[d] = 该深度的所有文件
                    totalBuckets = mainGenBucket + 1;
                    buckets = Array.from({ length: totalBuckets }, () => []);
                    for (const f of sortedFiles) {
                        buckets[f.bucket!].push(f);
                    }

                    // 初始化每文件状态
                    fileStatuses = {};
                    for (const f of sortedFiles) fileStatuses[f.path] = "pending";
                } catch (error) {
                    await chargeValidationFailure();
                    await writePlannerError(
                        writer,
                        encoder,
                        "Planner 返回的文件关系无效",
                        "PLANNER_INVALID_FILE_GRAPH",
                        422,
                        { reason: error instanceof Error ? error.message : String(error) },
                    );
                    return;
                }

                state.status = "planning";
                state.projectName = plan.projectName;
                state.javaVersion = plan.javaVersion;
                state.packageName = plan.packageName;
                state.mainBlueprint = blueprint;
                state.plan = sortedFiles;
                state.buckets = buckets;
                state.fileStatuses = fileStatuses;
                state.generationCheckpoints = {};
                state.currentBucket = 0;
                state.plannerRequestId = plannerRequestId;
                state.plannerResultAuthorization = plannerResultAuthorization;
                state.plannerBillingSettled = llm.byok;
                state.logs.push(`Planner 完成，${sortedFiles.length} 个文件分布在 ${totalBuckets} 个深度桶`);

                const costDelta = !llm.byok && streamed.usage
                    ? usageCost(llm.modelFor("pro"), streamed.usage)
                    : 0;
                const committed = await withPlannerDeadline(() => putTaskWithOperationLeaseAndCost(
                    context.env,
                    taskId,
                    JSON.stringify(state),
                    leaseToken,
                    leaseMode,
                    costDelta,
                    3600,
                    uid,
                    llm.byok,
                ), operationDeadline.signal, "提交 Planner 结果超时");
                if (!committed) {
                    const latestRaw = await withPlannerDeadline(
                        () => getOwnedTask(context.env, taskId, uid),
                        operationDeadline.signal,
                        "读取并发 Planner 结果超时",
                    );
                    if (latestRaw) {
                        try {
                            const latest = JSON.parse(latestRaw);
                            if (shouldReusePersistedPlannerResult(
                                latest,
                                body.replan,
                                plannerRequestId,
                                plannerResultAuthorization,
                            ) && latest.plannerBillingSettled !== false) {
                                await writeSSE(writer, encoder, {
                                    type: "result",
                                    stage: "plan",
                                    ...plannerResultPayload(taskId, latest),
                                });
                                return;
                            }
                        } catch { /* wait for the current lease holder */ }
                    }
                    await writePlannerError(
                        writer,
                        encoder,
                        "Planner 正在执行，请等待现有结果",
                        "PLANNER_IN_PROGRESS",
                        409,
                        { retryAfter: 2 },
                    );
                    return;
                }
                resultCommitted = true;
                if (llm.byok) {
                    leaseReleased = true;
                } else {
                    const settlement = await withPlannerDeadline(
                        () => settleTaskCostQuota(context.env, uid, taskId),
                        operationDeadline.signal,
                        "结算 Planner 用量超时",
                    );
                    state.totalCost = settlement.total;
                    state.consumedQuota = settlement.consumed;
                    state.quotaExhausted = settlement.outOfQuota || state.quotaExhausted;
                    state.plannerBillingSettled = true;
                    if (settlement.outOfQuota) {
                        await withPlannerDeadline(
                            () => markTaskQuotaExhausted(context.env, taskId, uid),
                            operationDeadline.signal,
                            "持久化 Planner 配额状态超时",
                        );
                    }
                    const settled = await withPlannerDeadline(
                        () => putTaskWithPlannerLease(
                            context.env,
                            taskId,
                            JSON.stringify(state),
                            leaseToken,
                            leaseMode,
                            3600,
                            uid,
                        ),
                        operationDeadline.signal,
                        "提交 Planner 结算状态超时",
                    );
                    if (!settled) throw new Error("Planner settlement state commit lost its lease");
                    leaseReleased = true;
                }

                await writeSSE(writer, encoder, {
                    type: "result",
                    stage: "plan",
                    ...plannerResultPayload(taskId, state),
                });
            } catch (error: any) {
                const timedOut = isPlannerTimeout(error) || operationDeadline.signal.aborted;
                const settlementPending = resultCommitted || attemptBillingCommitted;
                const message = timedOut
                    ? "Planner 处理超时，请重试"
                    : (error?.message || String(error));
                await writePlannerError(
                    writer,
                    encoder,
                    settlementPending ? "Planner 用量已记录，额度结算暂未完成，请重试当前请求" : message,
                    settlementPending ? "PLANNER_SETTLEMENT_PENDING" : (timedOut ? "PLANNER_TIMEOUT" : "PLANNER_FAILED"),
                    settlementPending ? 503 : (timedOut ? 504 : 500),
                    settlementPending ? { retryable: true, retryAfter: 2 } : {},
                );
            } finally {
                clearInterval(heartbeat);
                try { await writer.write(encoder.encode("data: [DONE]\n\n")); } catch { /* disconnected */ }
                try { await writer.close(); } catch { /* already disconnected */ }
                operationDeadline.dispose();
                if (!leaseReleased) {
                    await releaseTaskPlannerLease(
                        context.env,
                        taskId,
                        uid,
                        leaseToken,
                        leaseMode,
                    ).catch((error) => console.warn("planner lease release failed", error));
                }
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
        if (isPlannerTimeout(error) || operationDeadline.signal.aborted || preparationDeadline.signal.aborted) {
            return plannerTimeoutResponse();
        }
        throw error;
    } finally {
        preparationDeadline.dispose();
        if (!streamOwnsLease) {
            operationDeadline.dispose();
            if (!leaseReleased) {
                const release = releaseTaskPlannerLease(
                    context.env,
                    taskId,
                    uid,
                    leaseToken,
                    leaseMode,
                ).catch((error) => console.warn("planner lease release failed", error));
                // 租约清理不阻塞结构化超时或准备阶段错误响应。
                context.waitUntil(release);
            }
        }
    }
};
