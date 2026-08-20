import { reworkPrompt, dispatchGen, computeSlice, inferGeneratorType, skillFileGenContext } from "../../_lib/prompts";
import type { FileSummary, PlanFileItem, MainBlueprint } from "../../_lib/prompts";
import { accumulateCosts, type UsageBreakdown, type UsageCostEntry } from "../../_lib/quota";
import { deepSeekKeyRequiredResponse, resolveTaskLLM, type LLMProvider } from "../../_lib/llm";
import { extractFileSummary } from "../../_lib/fileSummary";
import { loadKnowledgeContext, mergeKnowledgeUsed, recordKnowledgeContextUsage } from "../../_lib/learning/context";
import {
    assessPlannerLearningAuthorization,
    assessPlannerResultAuthorization,
    samePlannerResultAuthorization,
} from "../../_lib/learning/plannerAuthorization";
import { getOwnedTask, markTaskQuotaExhausted, putTaskState } from "../../_lib/taskStore";
import { buildApiContractContext, findKnownApiIssues } from "../../_lib/apiContracts";
import {
    createModelLearningRequest,
    learningToolDefinition,
    MAX_LEARNING_TOOL_ROUNDS,
    putModelLearningRequest,
    removeModelLearningRequest,
    type ModelChatMessage,
    type ModelLearningOrigin,
    type ModelLearningRequest,
} from "../../_lib/learning/tool";
import {
    resolveModelLearningRequest,
    type ModelLearningResolution,
} from "../../_lib/learning/toolRuntime";
import { assertOpenAIResponse, OpenAIUpstreamHttpError } from "../../_lib/openAIStream";
import {
    abortOnWriteFailure,
    isClientCancelled,
    linkAbortSignal,
    linkClientAbortSignal,
} from "../../_lib/clientAbort";

const MAX_REWORK = 3;
const MAX_DYNAMIC_GEN = 3;
const SUPER_CONCURRENCY = 2; // 「超级并发」开关开启时的桶内并发数（默认串行=1）
const LLM_TIMEOUT_MS = 300000; // 单次 LLM 调用总时长上限（生成/审查均走非流式，免费版 CPU 有限）
const MAX_RETRY_AFTER_MS = 30000;

// 详细调试:把每一步(含 LLM 的 HTTP 状态/首字节耗时/错误堆栈/心跳是否真在跳)通过 SSE debug 事件发出,
// 前端累积并可下载。用于定位「桶零进度、无返回」到底死在哪一步。
type Dbg = (msg: string, extra?: any) => void;
const noopDbg: Dbg = () => { /* no-op */ };

interface Env {
    DB?: D1Database;
    DEEPSEEK_API_KEY: string;
    GEN_CONCURRENCY?: string;
    TASKS: KVNamespace;
}

interface AICallResult { content: string; message: any; model: string; usage?: UsageBreakdown; }
type ChargeFn = (r: AICallResult) => Promise<void>;
type ResolveLearningToolFn = (requestId: string) => Promise<ModelLearningResolution>;

function stripFences(raw: string): string {
    return raw.replace(/^```[\w]*\n?/, "").replace(/\n?```$/, "");
}

function extractSummaries(generatedFiles: any[]): FileSummary[] {
    return generatedFiles.map((f: any) => {
        const s: FileSummary = { path: f.path };
        if (f.apiSummary) Object.assign(s, f.apiSummary);
        return s;
    });
}

function sseEvent(encoder: TextEncoder, data: any): Uint8Array {
    return encoder.encode(`data: ${JSON.stringify(data)}\n\n`);
}

async function writeSSE(
    writer: WritableStreamDefaultWriter<Uint8Array>,
    encoder: TextEncoder,
    data: any,
    operationAbort: AbortController,
): Promise<void> {
    try {
        await writer.write(sseEvent(encoder, data));
    } catch (error) {
        abortOnWriteFailure(operationAbort, error, "Bucket client disconnected");
    }
}

interface BucketStreamError {
    message: string;
    code: string;
    status: number;
    retryable: boolean;
}

function bucketStreamError(error: unknown, fallbackCode = "BUCKET_FAILED"): BucketStreamError {
    if (error instanceof OpenAIUpstreamHttpError) {
        return {
            message: error.message,
            code: error.code,
            status: error.status,
            retryable: error.status !== 401,
        };
    }
    return {
        message: error instanceof Error ? error.message : String(error),
        code: fallbackCode,
        status: 500,
        retryable: true,
    };
}

interface BackoffOptions {
    maxRetries?: number;
    onRetry?: (event: { attempt: number; status: number; waitMs: number }) => void;
}

function abortError(signal?: AbortSignal | null): Error {
    if (signal?.reason instanceof Error) return signal.reason;
    const error = new Error("The operation was aborted");
    error.name = "AbortError";
    return error;
}

function assertBucketActive(signal: AbortSignal): void {
    if (signal.aborted) throw abortError(signal);
}

function retryDelayMs(retryAfter: string | null, attempt: number): number {
    const fallback = 1000 * Math.pow(2, attempt);
    if (!retryAfter) return Math.min(MAX_RETRY_AFTER_MS, fallback);

    const seconds = Number(retryAfter);
    const parsed = Number.isFinite(seconds)
        ? seconds * 1000
        : Date.parse(retryAfter) - Date.now();
    if (!Number.isFinite(parsed) || parsed < 0) return Math.min(MAX_RETRY_AFTER_MS, fallback);
    return Math.min(MAX_RETRY_AFTER_MS, parsed);
}

async function sleepWithSignal(ms: number, signal?: AbortSignal | null): Promise<void> {
    if (signal?.aborted) throw abortError(signal);
    await new Promise<void>((resolve, reject) => {
        let timer: ReturnType<typeof setTimeout>;
        const onAbort = () => {
            clearTimeout(timer);
            signal?.removeEventListener("abort", onAbort);
            reject(abortError(signal));
        };
        timer = setTimeout(() => {
            signal?.removeEventListener("abort", onAbort);
            resolve();
        }, ms);
        signal?.addEventListener("abort", onAbort, { once: true });
    });
}

/** Fetch wrapper with bounded, abort-aware 429 backoff. */
async function fetchWithBackoff(url: string, init: RequestInit, options: BackoffOptions = {}): Promise<Response> {
    const maxRetries = options.maxRetries ?? 3;
    let attempt = 0;
    while (true) {
        const resp = await fetch(url, init);
        if (resp.status !== 429 || attempt >= maxRetries) return resp;
        const waitMs = retryDelayMs(resp.headers.get("Retry-After"), attempt);
        options.onRetry?.({ attempt: attempt + 1, status: resp.status, waitMs });
        try { await resp.body?.cancel(); } catch { /* response body cleanup is best effort */ }
        await sleepWithSignal(waitMs, init.signal);
        attempt++;
    }
}

async function callAI(
    llm: LLMProvider,
    system: string,
    user: string,
    jsonMode = false,
    usePro = false,
    dbg: Dbg = noopDbg,
    messages?: ModelChatMessage[],
    tools: Record<string, unknown>[] = [],
    signal?: AbortSignal,
): Promise<AICallResult> {
    const model = llm.modelFor(usePro ? "pro" : "flash");
    const body: any = {
        model,
        messages: messages ?? [{ role: "system", content: system }, { role: "user", content: user }],
    };
    if (usePro) {
        body.reasoning_effort = "high";
        body.thinking = { type: "enabled" };
    }
    if (jsonMode) body.response_format = { type: "json_object" };
    if (tools.length) body.tools = tools;

    const ctrl = new AbortController();
    const disposeParentAbort = linkAbortSignal(ctrl, signal);
    const timer = setTimeout(() => ctrl.abort(abortError()), LLM_TIMEOUT_MS);
    const t0 = Date.now();
    dbg("callAI:req", { model, jsonMode, usePro, sysLen: system.length, userLen: user.length });
    try {
        const resp = await fetchWithBackoff(llm.url, {
            method: "POST",
            headers: { "Content-Type": "application/json", Authorization: `Bearer ${llm.apiKey}` },
            body: JSON.stringify(body),
            signal: ctrl.signal,
        }, {
            onRetry: ({ attempt, status, waitMs }) => dbg("callAI:retry", { model, attempt, status, waitMs }),
        });
        dbg("callAI:http", { model, status: resp.status, ms: Date.now() - t0 });
        try {
            await assertOpenAIResponse(resp);
        } catch (error) {
            dbg("callAI:http-err", {
                status: resp.status,
                body: (error instanceof Error ? error.message : String(error)).slice(0, 400),
            });
            throw error;
        }
        dbg("callAI:body-start", { model, ms: Date.now() - t0 });
        const data = await resp.json() as any;
        dbg("callAI:body-done", { model, ms: Date.now() - t0 });
        const message = data.choices?.[0]?.message ?? {};
        const content = message.content ?? "";
        dbg("callAI:done", { model, ms: Date.now() - t0, contentLen: content.length });
        return { content, message, model, usage: data.usage };
    } catch (e: any) {
        dbg("callAI:throw", { model, ms: Date.now() - t0, err: e?.name, msg: String(e?.message || e).slice(0, 400) });
        throw e;
    } finally {
        clearTimeout(timer);
        disposeParentAbort();
    }
}

/**
 * 流式调用 AI 生成。所有 SSE 事件都打上 path 标签，便于前端按文件路由。
 */
async function callAIStream(
    llm: LLMProvider, system: string, user: string,
    writer: WritableStreamDefaultWriter<Uint8Array>, encoder: TextEncoder,
    pathTag: string,
    usePro = false,
    dbg: Dbg = noopDbg,
    messages?: ModelChatMessage[],
    tools: Record<string, unknown>[] = [],
    signal?: AbortSignal,
): Promise<AICallResult> {
    // 【非流式】CF 免费版单请求仅 ~10ms CPU。流式逐 chunk decode + JSON.parse(几百次)会超 CPU
    // 被硬杀(debug 实测:29 次生成仅 2 次跑到 stream:done)。改为非流式,只做 1 次 resp.json()——
    // 与在免费版上稳定工作的 reChecker(callAI 非流式)同款,CPU 骤降。逐 token delta 转发本就已去掉,
    // 不流式对结果无影响。writer/encoder 参数保留仅为兼容调用点签名。
    const model = llm.modelFor(usePro ? "pro" : "flash");
    const body: any = {
        model,
        messages: messages ?? [{ role: "system", content: system }, { role: "user", content: user }],
    };
    if (usePro) {
        body.reasoning_effort = "high";
        body.thinking = { type: "enabled" };
    }
    if (tools.length) body.tools = tools;

    const ctrl = new AbortController();
    const disposeParentAbort = linkAbortSignal(ctrl, signal);
    const timer = setTimeout(() => ctrl.abort(abortError()), LLM_TIMEOUT_MS);
    const t0 = Date.now();
    dbg("stream:req", { path: pathTag, model, usePro, sysLen: system.length, userLen: user.length });
    try {
        const resp = await fetchWithBackoff(llm.url, {
            method: "POST",
            headers: { "Content-Type": "application/json", Authorization: `Bearer ${llm.apiKey}` },
            body: JSON.stringify(body),
            signal: ctrl.signal,
        }, {
            onRetry: ({ attempt, status, waitMs }) => dbg("stream:retry", { path: pathTag, model, attempt, status, waitMs }),
        });
        dbg("stream:http", { path: pathTag, status: resp.status, ms: Date.now() - t0 });
        try {
            await assertOpenAIResponse(resp);
        } catch (error) {
            dbg("stream:http-err", {
                path: pathTag,
                status: resp.status,
                body: (error instanceof Error ? error.message : String(error)).slice(0, 400),
            });
            throw error;
        }
        dbg("stream:body-start", { path: pathTag, model, ms: Date.now() - t0 });
        const data = await resp.json() as any;
        dbg("stream:body-done", { path: pathTag, model, ms: Date.now() - t0 });
        const message = data.choices?.[0]?.message ?? {};
        const content = message.content ?? "";
        dbg("stream:done", { path: pathTag, ms: Date.now() - t0, len: content.length });
        return { content, message, model, usage: data.usage };
    } catch (e: any) {
        dbg("stream:throw", { path: pathTag, ms: Date.now() - t0, err: e?.name, msg: String(e?.message || e).slice(0, 400) });
        throw e;
    } finally {
        clearTimeout(timer);
        disposeParentAbort();
    }
}

type FileGenerationStage = "generate" | "review" | "rework" | "dynamic_generate";

interface DynamicFileCheckpoint {
    className: string;
    path: string;
    role: string;
}

interface FileGenerationCheckpoint {
    version: 1;
    path: string;
    stage: FileGenerationStage;
    content: string;
    reworkCount: number;
    dynamicGenDone: boolean;
    dynamicFiles: DynamicFileCheckpoint[];
    dynamicIndex: number;
    lastReason: string;
    learningRequestId?: string;
}

interface GeneratedFileOutput {
    path: string;
    role: string;
    content: string;
    apiSummary: any;
}

interface FileStageOutcome {
    path: string;
    checkpoint: FileGenerationCheckpoint | null;
    completed?: GeneratedFileOutput & { reworkCount: number };
    newFiles: GeneratedFileOutput[];
    progressed: boolean;
    nextStage: FileGenerationStage | "done";
    learningToolRequests: ModelLearningRequest[];
}

const FILE_GENERATION_STAGES = new Set<FileGenerationStage>([
    "generate", "review", "rework", "dynamic_generate",
]);

function initialCheckpoint(path: string): FileGenerationCheckpoint {
    return {
        version: 1,
        path,
        stage: "generate",
        content: "",
        reworkCount: 0,
        dynamicGenDone: false,
        dynamicFiles: [],
        dynamicIndex: 0,
        lastReason: "",
    };
}

function checkpointFor(state: any, path: string): FileGenerationCheckpoint {
    const raw = state.generationCheckpoints?.[path];
    if (!raw || raw.version !== 1 || raw.path !== path || !FILE_GENERATION_STAGES.has(raw.stage)) {
        return initialCheckpoint(path);
    }
    const checkpoint: FileGenerationCheckpoint = {
        version: 1,
        path,
        stage: raw.stage,
        content: typeof raw.content === "string" ? raw.content : "",
        reworkCount: Math.max(0, Math.min(MAX_REWORK, Number(raw.reworkCount) || 0)),
        dynamicGenDone: !!raw.dynamicGenDone,
        dynamicFiles: Array.isArray(raw.dynamicFiles)
            ? raw.dynamicFiles.filter((item: any) => item
                && typeof item.className === "string"
                && typeof item.path === "string"
                && typeof item.role === "string")
                .map((item: any) => ({ className: item.className, path: item.path, role: item.role }))
                .slice(0, MAX_DYNAMIC_GEN)
            : [],
        dynamicIndex: Math.max(0, Number(raw.dynamicIndex) || 0),
        lastReason: typeof raw.lastReason === "string" ? raw.lastReason.slice(0, 2_000) : "",
        learningRequestId: typeof raw.learningRequestId === "string"
            && /^learnreq_[a-f0-9]{32}$/i.test(raw.learningRequestId)
            ? raw.learningRequestId
            : undefined,
    };
    if (checkpoint.stage !== "generate" && !checkpoint.content.trim()) return initialCheckpoint(path);
    if (checkpoint.stage === "dynamic_generate" && checkpoint.dynamicIndex >= checkpoint.dynamicFiles.length) {
        checkpoint.stage = "review";
    }
    return checkpoint;
}

async function logGeneration(
    state: any,
    writer: WritableStreamDefaultWriter<Uint8Array>,
    encoder: TextEncoder,
    operationAbort: AbortController,
    msg: string,
    path?: string,
): Promise<void> {
    assertBucketActive(operationAbort.signal);
    state.logs ??= [];
    state.logs.push(msg);
    await writeSSE(writer, encoder, { type: "log", path, msg }, operationAbort);
}

function nonEmptyModelContent(result: AICallResult, stage: string): string {
    const content = stripFences(result.content).trim();
    if (!content) throw new Error(`${stage}模型返回空内容`);
    return content;
}

type LearningAwareCallResult =
    | { kind: "result"; result: AICallResult }
    | { kind: "learning"; request: ModelLearningRequest };

async function callWithLearningTool(input: {
    llm: LLMProvider;
    state: any;
    checkpoint: FileGenerationCheckpoint;
    system: string;
    user: string;
    origin: ModelLearningOrigin;
    originKey: string;
    targetPath: string;
    coreType: string;
    mcVersion: string;
    resolveTool: ResolveLearningToolFn;
    charge: ChargeFn;
    signal: AbortSignal;
    invoke: (
        messages: ModelChatMessage[],
        tools: Record<string, unknown>[],
    ) => Promise<AICallResult>;
}): Promise<LearningAwareCallResult> {
    assertBucketActive(input.signal);
    const baseMessages: ModelChatMessage[] = [
        { role: "system", content: input.system },
        { role: "user", content: input.user },
    ];
    let messages = baseMessages;
    let previousRequest: ModelLearningRequest | null = null;
    const pendingId = input.checkpoint.learningRequestId;
    if (pendingId) {
        const resolution = await input.resolveTool(pendingId);
        const request = resolution.status === "missing" ? null : resolution.request;
        const matchesCallSite = request?.origin === input.origin
            && request.originKey === input.originKey
            && request.targetPath === input.targetPath;
        if (!matchesCallSite) {
            removeModelLearningRequest(input.state, pendingId);
            delete input.checkpoint.learningRequestId;
        } else if (resolution.status === "pending") {
            return { kind: "learning", request: resolution.request };
        } else if (resolution.status === "resolved") {
            previousRequest = resolution.request;
            messages = resolution.messages;
        } else {
            removeModelLearningRequest(input.state, pendingId);
            delete input.checkpoint.learningRequestId;
        }
    }

    const tools = previousRequest?.round === undefined
        || previousRequest.round < MAX_LEARNING_TOOL_ROUNDS
        ? learningToolDefinition(input.llm)
        : [];
    const result = await input.invoke(messages, tools);
    await input.charge(result);
    assertBucketActive(input.signal);
    const nextRequest = tools.length ? await createModelLearningRequest({
        message: result.message,
        messages,
        origin: input.origin,
        originKey: input.originKey,
        targetPath: input.targetPath,
        round: (previousRequest?.round ?? 0) + 1,
        coreType: input.coreType,
        mcVersion: input.mcVersion,
        allowedDependencies: Array.isArray(input.state.grade?.vector?.external_deps)
            ? input.state.grade.vector.external_deps
            : [],
    }) : null;
    if (nextRequest) {
        if (previousRequest) removeModelLearningRequest(input.state, previousRequest.requestId);
        putModelLearningRequest(input.state, nextRequest);
        input.checkpoint.learningRequestId = nextRequest.requestId;
        return { kind: "learning", request: nextRequest };
    }

    if (previousRequest) removeModelLearningRequest(input.state, previousRequest.requestId);
    delete input.checkpoint.learningRequestId;
    return { kind: "result", result };
}

function safeMissingClasses(value: unknown): string[] {
    if (!Array.isArray(value)) return [];
    return [...new Set(value
        .filter((item): item is string => typeof item === "string")
        .map(item => item.trim())
        .filter(item => /^[A-Za-z_$][\w$]*$/.test(item)))]
        .slice(0, MAX_DYNAMIC_GEN);
}

/** Advance one persisted file stage. Each invocation performs at most one LLM call per target. */
async function processFileStage(
    llm: LLMProvider,
    target: PlanFileItem,
    checkpoint: FileGenerationCheckpoint,
    ctx: { projectName: string; packageName: string; coreType: string; version: string; javaVersion: string },
    summaries: FileSummary[],
    blueprint: MainBlueprint | null,
    writer: WritableStreamDefaultWriter<Uint8Array>, encoder: TextEncoder,
    state: any,
    knowledgeContext: string,
    onKnowledgeApplied: (filePath: string) => void,
    resolveLearningTool: ResolveLearningToolFn,
    charge: ChargeFn,
    operationAbort: AbortController,
    dbg: Dbg = noopDbg,
): Promise<FileStageOutcome> {
    assertBucketActive(operationAbort.signal);
    const filePath = target.path;
    const skillCtx = state.skills?.length ? skillFileGenContext(state.skills) : "";
    const apiContractInput = {
        coreType: ctx.coreType,
        version: ctx.version,
        externalDeps: state.grade?.vector?.external_deps ?? [],
        generatedFiles: [
            ...(state.generatedFiles ?? []),
            ...summaries
                .filter((summary) => !(state.generatedFiles ?? []).some((file: any) => file.path === summary.path))
                .map((summary) => ({ path: summary.path, apiSummary: summary })),
        ],
    };
    const apiContractCtx = buildApiContractContext(apiContractInput);
    const dispatched = dispatchGen(
        target,
        ctx,
        summaries,
        computeSlice(target, blueprint),
        skillCtx,
        apiContractCtx,
        knowledgeContext,
    );
    const outcome = (nextStage: FileGenerationStage): FileStageOutcome => ({
        path: filePath,
        checkpoint,
        newFiles: [],
        progressed: true,
        nextStage,
        learningToolRequests: [],
    });
    const waitForLearning = (
        request: ModelLearningRequest,
        nextStage: FileGenerationStage = checkpoint.stage,
    ): FileStageOutcome => ({
        ...outcome(nextStage),
        learningToolRequests: [request],
    });
    const complete = async (): Promise<FileStageOutcome> => {
        const apiSummary = extractFileSummary(filePath, checkpoint.content, target.role);
        dbg("file:return", {
            path: filePath,
            failed: checkpoint.reworkCount >= MAX_REWORK,
            reworkCount: checkpoint.reworkCount,
        });
        const doneMsg = `● ${filePath} 已完成${checkpoint.reworkCount > 0 ? ` (修正${checkpoint.reworkCount}次)` : ""}`;
        await logGeneration(state, writer, encoder, operationAbort, doneMsg, filePath);
        return {
            path: filePath,
            checkpoint: null,
            completed: {
                path: filePath,
                role: target.role,
                content: checkpoint.content,
                apiSummary,
                reworkCount: checkpoint.reworkCount,
            },
            newFiles: [],
            progressed: true,
            nextStage: "done",
            learningToolRequests: [],
        };
    };
    const runRework = async (): Promise<FileStageOutcome> => {
        await writeSSE(writer, encoder, { type: "phase", path: filePath, phase: "reworking" }, operationAbort);
        dbg("file:rework-begin", { path: filePath, round: checkpoint.reworkCount });
        const rw = reworkPrompt(
            filePath,
            target.role,
            checkpoint.content,
            checkpoint.lastReason,
            ctx,
            summaries,
            apiContractCtx,
            knowledgeContext,
        );
        const call = await callWithLearningTool({
            llm,
            state,
            checkpoint,
            system: rw.system,
            user: rw.user,
            origin: "rework",
            originKey: `bucket:${filePath}:rework:${checkpoint.reworkCount}`,
            targetPath: filePath,
            coreType: ctx.coreType,
            mcVersion: ctx.version,
            resolveTool: resolveLearningTool,
            charge,
            signal: operationAbort.signal,
            invoke: (messages, tools) => callAIStream(
                llm, rw.system, rw.user, writer, encoder, filePath, false, dbg, messages, tools,
                operationAbort.signal,
            ),
        });
        if (call.kind === "learning") return waitForLearning(call.request, "rework");
        const rwRes = call.result;
        checkpoint.content = nonEmptyModelContent(rwRes, "返工");
        if (checkpoint.reworkCount >= MAX_REWORK) {
            const warnMsg = `! ${filePath} 经 ${MAX_REWORK} 次修正仍未通过审查，接受当前版本，交由编译阶段校验`;
            await logGeneration(state, writer, encoder, operationAbort, warnMsg, filePath);
            return complete();
        }
        checkpoint.stage = "review";
        return outcome("review");
    };

    dbg("stage:start", { path: filePath, stage: checkpoint.stage, round: checkpoint.reworkCount });
    if (checkpoint.stage === "generate") {
        await writeSSE(writer, encoder, { type: "phase", path: filePath, phase: "generating" }, operationAbort);
        await logGeneration(state, writer, encoder, operationAbort, `▸ 正在生成 ${filePath}`, filePath);
        dbg("file:dispatch", { path: filePath, gtype: (target as any).generatorType });
        dbg("file:gen-begin", { path: filePath });
        const call = await callWithLearningTool({
            llm,
            state,
            checkpoint,
            system: dispatched.gen.system,
            user: dispatched.gen.user,
            origin: "generate",
            originKey: `bucket:${filePath}:generate:0`,
            targetPath: filePath,
            coreType: ctx.coreType,
            mcVersion: ctx.version,
            resolveTool: resolveLearningTool,
            charge,
            signal: operationAbort.signal,
            invoke: (messages, tools) => callAIStream(
                llm,
                dispatched.gen.system,
                dispatched.gen.user,
                writer,
                encoder,
                filePath,
                false,
                dbg,
                messages,
                tools,
                operationAbort.signal,
            ),
        });
        if (call.kind === "learning") return waitForLearning(call.request, "generate");
        const initialRes = call.result;
        checkpoint.content = nonEmptyModelContent(initialRes, "生成");
        checkpoint.stage = "review";
        try { onKnowledgeApplied(filePath); } catch { /* usage telemetry is best effort */ }
        return outcome("review");
    }

    if (checkpoint.stage === "dynamic_generate") {
        const dynamic = checkpoint.dynamicFiles[checkpoint.dynamicIndex];
        if (!dynamic) {
            checkpoint.stage = "review";
            return outcome("review");
        }
        const inferredFile: PlanFileItem = {
            path: dynamic.path,
            role: dynamic.role,
            order: 0,
            generatorType: inferGeneratorType(dynamic.className, dynamic.path),
        };
        const subDispatched = dispatchGen(
            inferredFile,
            ctx,
            summaries,
            computeSlice(inferredFile, blueprint),
            skillCtx,
            apiContractCtx,
            knowledgeContext,
        );
        await writeSSE(writer, encoder, { type: "phase", path: dynamic.path, phase: "generating" }, operationAbort);
        await logGeneration(
            state,
            writer,
            encoder,
            operationAbort,
            `▸ 动态生成 ${dynamic.className} (${checkpoint.dynamicIndex + 1}/${checkpoint.dynamicFiles.length})`,
            filePath,
        );
        const call = await callWithLearningTool({
            llm,
            state,
            checkpoint,
            system: subDispatched.gen.system,
            user: subDispatched.gen.user,
            origin: "generate",
            originKey: `bucket:${filePath}:dynamic:${checkpoint.dynamicIndex}`,
            targetPath: dynamic.path,
            coreType: ctx.coreType,
            mcVersion: ctx.version,
            resolveTool: resolveLearningTool,
            charge,
            signal: operationAbort.signal,
            invoke: (messages, tools) => callAIStream(
                llm,
                subDispatched.gen.system,
                subDispatched.gen.user,
                writer,
                encoder,
                dynamic.path,
                false,
                dbg,
                messages,
                tools,
                operationAbort.signal,
            ),
        });
        if (call.kind === "learning") return waitForLearning(call.request, "dynamic_generate");
        const subRes = call.result;
        const content = nonEmptyModelContent(subRes, "动态生成");
        try { onKnowledgeApplied(dynamic.path); } catch { /* usage telemetry is best effort */ }
        checkpoint.dynamicIndex++;
        checkpoint.stage = checkpoint.dynamicIndex < checkpoint.dynamicFiles.length
            ? "dynamic_generate"
            : "review";
        await logGeneration(state, writer, encoder, operationAbort, `● ${dynamic.className} 动态生成完成`, filePath);
        return {
            ...outcome(checkpoint.stage),
            newFiles: [{
                path: dynamic.path,
                role: dynamic.role,
                content,
                apiSummary: extractFileSummary(dynamic.path, content, dynamic.role),
            }],
        };
    }

    if (checkpoint.stage === "rework") return runRework();

    await writeSSE(writer, encoder, { type: "phase", path: filePath, phase: "reviewing" }, operationAbort);
    await logGeneration(state, writer, encoder, operationAbort, `▸ 审查 ${filePath}...`, filePath);
    dbg("file:review-begin", { path: filePath, round: checkpoint.reworkCount });
    let review: any;
    let reviewUsedModel = false;
    const knownApiIssues = findKnownApiIssues(apiContractInput, checkpoint.content);
    if (knownApiIssues.length) {
        review = { is_ok: false, reason: knownApiIssues.join("；"), missing_classes: [] };
        dbg("file:review-known-api", { path: filePath, issues: knownApiIssues.length });
    } else {
        reviewUsedModel = true;
        const check = dispatched.checker(filePath, checkpoint.content);
        // 首轮用快速模型；只有返工后的复审才启用深度模型，兼顾常规速度与问题文件质量。
        const call = await callWithLearningTool({
            llm,
            state,
            checkpoint,
            system: check.system,
            user: check.user,
            origin: "review",
            originKey: `bucket:${filePath}:review:${checkpoint.reworkCount}`,
            targetPath: filePath,
            coreType: ctx.coreType,
            mcVersion: ctx.version,
            resolveTool: resolveLearningTool,
            charge,
            signal: operationAbort.signal,
            invoke: (messages, tools) => callAI(
                llm,
                check.system,
                check.user,
                true,
                checkpoint.reworkCount > 0,
                dbg,
                messages,
                tools,
                operationAbort.signal,
            ),
        });
        if (call.kind === "learning") return waitForLearning(call.request, "review");
        const reviewRes = call.result;
        try {
            review = JSON.parse(stripFences(reviewRes.content));
        } catch {
            dbg("file:review-parse-fail", { path: filePath });
            return complete();
        }
    }
    const missingClasses = safeMissingClasses(review?.missing_classes);
    dbg("file:review-done", { path: filePath, is_ok: !!review?.is_ok, missing: missingClasses.length });
    if (review?.is_ok) {
        await logGeneration(state, writer, encoder, operationAbort, `● ${filePath} 审查通过`, filePath);
        return complete();
    }

    if (missingClasses.length > 0 && !checkpoint.dynamicGenDone) {
        checkpoint.dynamicGenDone = true;
        const alreadyGenerated = new Set([
            ...summaries.map(summary => summary.className).filter((name): name is string => !!name),
            ...(state.generatedFiles ?? [])
                .map((file: any) => String(file.path || "").split("/").pop()?.replace(/\.java$/i, ""))
                .filter((name: unknown): name is string => typeof name === "string" && !!name),
            ...(state.plan ?? [])
                .map((file: any) => String(file.path || "").split("/").pop()?.replace(/\.java$/i, ""))
                .filter((name: unknown): name is string => typeof name === "string" && !!name),
        ]);
        const dynamicFiles = missingClasses
            .filter(className => !alreadyGenerated.has(className))
            .map(className => ({
                className,
                path: `src/main/java/${ctx.packageName.replace(/\./g, "/")}/${className}.java`,
                role: `${className} — 被 ${filePath.split("/").pop()} 引用`,
            }));
        if (dynamicFiles.length > 0) {
            checkpoint.dynamicFiles = dynamicFiles;
            checkpoint.dynamicIndex = 0;
            checkpoint.stage = "dynamic_generate";
            await logGeneration(
                state,
                writer,
                encoder,
                operationAbort,
                `▸ 发现 ${dynamicFiles.length} 个缺失类，动态生成: ${dynamicFiles.map(file => file.className).join(", ")}`,
                filePath,
            );
            return outcome("dynamic_generate");
        }
    }

    checkpoint.reworkCount++;
    checkpoint.lastReason = String(review?.reason || "审查未通过").slice(0, 2_000);
    checkpoint.stage = "rework";
    await logGeneration(
        state,
        writer,
        encoder,
        operationAbort,
        `↻ ${filePath} 需修正 (${checkpoint.reworkCount}/${MAX_REWORK}): ${checkpoint.lastReason}`,
        filePath,
    );
    // 已经完成模型复审时立即保存返工意图，下一请求再返工，保证单目标单请求最多一次模型调用。
    return reviewUsedModel ? outcome("rework") : runRework();
}

export const onRequestPost: PagesFunction<Env> = async (context) => {
    const body = await context.request.json() as any;
    const { taskId, bucketIndex, superConcurrency } = body;
    const learningToolJobs = body.learningToolJobs && typeof body.learningToolJobs === "object"
        ? body.learningToolJobs as Record<string, string>
        : {};
    const uid: string = (context.data as any)?.uid || "";
    // 默认每请求推进一个文件的一个阶段；超级并发只会并行多个独立阶段，不再把整份文件工作流塞进单请求。
    let concurrency = 1;
    if (superConcurrency) {
        concurrency = Math.max(2, parseInt(context.env.GEN_CONCURRENCY || "") || SUPER_CONCURRENCY);
    }

    const raw = await getOwnedTask(context.env, taskId, uid);
    if (!raw) return new Response("Task not found", { status: 404 });
    const state = JSON.parse(raw);
    const llm = await resolveTaskLLM(context, state);
    if (!llm) return deepSeekKeyRequiredResponse();
    // 挂了 skill 的任务：prompt 更大、文件更多，强制串行，避免大 prompt × 并发撞 CF Worker 限制
    if (state.skills?.length) concurrency = 1;

    if (state.plannerBillingSettled === false || state.plannerAttemptBillingPending) {
        return new Response(JSON.stringify({
            error: "Planner 额度结算尚未完成，请先重试 Planner",
            code: "PLANNER_SETTLEMENT_PENDING",
        }), {
            status: 503,
            headers: { "Content-Type": "application/json", "Retry-After": "2" },
        });
    }

    if (state.quotaExhausted && !llm.byok) {
        return new Response(JSON.stringify({ error: "充值额度已用尽", code: "QUOTA_EXHAUSTED" }), {
            status: 402, headers: { "Content-Type": "application/json" },
        });
    }

    const [plannerAssessment, plannerResultAuthorization] = await Promise.all([
        assessPlannerLearningAuthorization(state),
        assessPlannerResultAuthorization(state),
    ]);
    if (!plannerAssessment || !plannerResultAuthorization || !samePlannerResultAuthorization(
        state.plannerResultAuthorization,
        plannerResultAuthorization,
    )) {
        return new Response(JSON.stringify({
            error: "Planner 路径授权已失效，请重新规划",
            code: "PLANNER_AUTHORIZATION_EXPIRED",
        }), {
            status: 409,
            headers: { "Content-Type": "application/json" },
        });
    }

    const buckets = (state.buckets ?? []) as PlanFileItem[][];
    if (!Array.isArray(buckets) || bucketIndex < 0 || bucketIndex >= buckets.length) {
        return new Response(JSON.stringify({ error: "无效的 bucketIndex", bucketIndex }), {
            status: 400, headers: { "Content-Type": "application/json" },
        });
    }

    const pendingUsage: UsageCostEntry[] = [];
    let chargeFlushed = false;
    const charge: ChargeFn = async (r) => {
        if (llm.byok || !uid || !r.usage) return; // BYOK 自带 key：跳过计费
        pendingUsage.push({ model: r.model, usage: r.usage });
    };
    const flushCharge = async () => {
        if (chargeFlushed || llm.byok || !uid || pendingUsage.length === 0) return;
        const entries = pendingUsage.splice(0);
        let cost: Awaited<ReturnType<typeof accumulateCosts>>;
        try {
            cost = await accumulateCosts(context.env, uid, taskId, entries);
        } catch (error) {
            pendingUsage.unshift(...entries);
            throw error;
        }
        chargeFlushed = true;
        state.totalCost = cost.total;
        state.consumedQuota = cost.consumed;
        if (cost.outOfQuota) {
            state.quotaExhausted = true;
            await markTaskQuotaExhausted(context.env, taskId, uid);
        }
    };

    const bucket = buckets[bucketIndex];
    const ctx = {
        projectName: state.projectName,
        packageName: state.packageName,
        coreType: state.coreType,
        version: state.version,
        javaVersion: state.javaVersion,
    };
    const blueprint = (state.mainBlueprint ?? null) as MainBlueprint | null;
    const needs = plannerAssessment.needs;
    const knowledge = await loadKnowledgeContext({
        env: context.env,
        needs,
        maxCharacters: 3_200,
        title: "代码生成已验证公共技术知识",
    });
    state.knowledgeUsed = mergeKnowledgeUsed(state.knowledgeUsed, knowledge.used);
    const markKnowledgeApplied = (filePath: string) => {
        context.waitUntil(recordKnowledgeContextUsage({
            env: context.env,
            items: knowledge.used,
            generationTaskId: taskId,
            stage: `file:${filePath}`,
        }));
    };
    const resolveLearningTool: ResolveLearningToolFn = async (requestId) => {
        const resolution = await resolveModelLearningRequest({
            env: context.env,
            state,
            uid,
            taskId,
            requestId,
            jobId: learningToolJobs[requestId],
            maxCharacters: 6_000,
        });
        if (resolution.status === "resolved") {
            state.knowledgeUsed = mergeKnowledgeUsed(state.knowledgeUsed, resolution.knowledgeUsed);
            context.waitUntil(recordKnowledgeContextUsage({
                env: context.env,
                items: resolution.knowledgeUsed,
                generationTaskId: taskId,
                stage: `tool:${resolution.request.origin}:${resolution.request.targetPath || "project"}`,
            }));
        }
        return resolution;
    };

    const operationAbort = new AbortController();
    const disposeClientAbort = linkClientAbortSignal(
        operationAbort,
        context.request.signal,
        "Bucket client disconnected",
    );
    const { readable, writable } = new TransformStream<Uint8Array>();
    const encoder = new TextEncoder();
    const writer = writable.getWriter();

    // 详细调试:每一步发一个 debug SSE 事件(前端累积、可下载)。t 为相对本请求起点的毫秒。
    const T0 = Date.now();
    const debugRequest = crypto.randomUUID();
    const dbg: Dbg = (msg, extra) => {
        writer.write(sseEvent(encoder, {
            type: "debug",
            request: debugRequest,
            t: Date.now() - T0,
            bucket: bucketIndex,
            msg,
            ...(extra || {}),
        })).catch((error) => {
            try { abortOnWriteFailure(operationAbort, error, "Bucket client disconnected"); }
            catch { /* operation signal carries the cancellation */ }
        });
    };

    const process = (async () => {
        // 心跳:深度复审等非流式 LLM 调用期间可能长时间无响应字节；每 12s 写一次保持 SSE 活跃。
        // n=心跳序号:前端据此判断 CF Worker 的 setInterval 是否真的在跳(若无 heartbeat,则定时器未触发)。
        let hbCount = 0;
        const heartbeat = setInterval(() => {
            hbCount++;
            writer.write(sseEvent(encoder, { type: "heartbeat", t: Date.now(), n: hbCount })).catch((error) => {
                try { abortOnWriteFailure(operationAbort, error, "Bucket client disconnected"); }
                catch { /* operation signal carries the cancellation */ }
            });
            dbg("heartbeat", { n: hbCount });
        }, 12000);
        try {
            // 每次请求只推进每个目标的一个持久化阶段；中断后从该阶段继续。
            const pending = bucket.filter(f => state.fileStatuses?.[f.path] !== "done");
            const targets = pending.slice(0, Math.max(1, concurrency));
            state.generatedFiles ??= [];
            const plannedPaths = new Set((state.plan ?? []).map((file: any) => file.path));
            const completedBucketFiles = () => {
                const donePaths = new Set(bucket
                    .filter(file => state.fileStatuses?.[file.path] === "done")
                    .map(file => file.path));
                return state.generatedFiles
                    .filter((file: any) => donePaths.has(file.path))
                    .map((file: any) => ({
                        path: file.path,
                        content: file.content,
                        reworkCount: Math.max(0, Number(file.reworkCount) || 0),
                    }));
            };
            const dynamicFilesForClient = () => state.generatedFiles
                .filter((file: any) => !plannedPaths.has(file.path))
                .map((file: any) => ({
                    path: file.path,
                    role: typeof file.role === "string" && file.role ? file.role : "动态补全文件",
                    content: file.content,
                }));
            const baseSummaries = extractSummaries(state.generatedFiles);
            dbg("process:start", { bucketIndex, concurrency, superOn: !!superConcurrency, skills: state.skills?.length || 0, bucketsTotal: buckets.length });
            await writeSSE(writer, encoder, {
                type: "bucket_start", bucketIndex, paths: targets.map(f => f.path), concurrency,
            }, operationAbort);

            // 桶已全部完成（无 pending）→ 标记并前进
            if (pending.length === 0) {
                state.currentBucket = Math.max(state.currentBucket ?? 0, bucketIndex + 1);
                await putTaskState(context.env, taskId, state, 3600, uid);
                const completed = completedBucketFiles();
                const newFiles = dynamicFilesForClient();
                for (const newFile of newFiles) {
                    await writeSSE(writer, encoder, { type: "new_file", ...newFile }, operationAbort);
                }
                await writeSSE(writer, encoder, {
                    type: "result", bucketIndex, bucketDone: true,
                    done: state.currentBucket >= buckets.length,
                    progressed: false,
                    completed, newFiles, errors: [],
                    bucketsRemaining: Math.max(0, buckets.length - state.currentBucket),
                }, operationAbort);
                try { await writer.write(encoder.encode("data: [DONE]\n\n")); } catch { /* disconnected */ }
                return;
            }

            const errors: Array<BucketStreamError & { path: string; reason: string }> = [];
            state.fileStatuses ??= {};
            state.generationCheckpoints ??= {};
            for (const target of targets) state.fileStatuses[target.path] = "generating";

            dbg("batch:begin", { pending: pending.length, targets: targets.map(t => t.path) });
            const taskResults = await Promise.allSettled(targets.map(async (target): Promise<FileStageOutcome | null> => {
                const checkpoint = checkpointFor(state, target.path);
                dbg("task:begin", { path: target.path, stage: checkpoint.stage });
                try {
                    const result = await processFileStage(
                        llm,
                        target,
                        checkpoint,
                        ctx,
                        baseSummaries.slice(),
                        blueprint,
                        writer,
                        encoder,
                        state,
                        knowledge.context,
                        markKnowledgeApplied,
                        resolveLearningTool,
                        charge,
                        operationAbort,
                        dbg,
                    );
                    dbg("task:ok", { path: target.path, stage: result.nextStage, done: !!result.completed });
                    return result;
                } catch (taskErr: any) {
                    if (isClientCancelled(taskErr) || isClientCancelled(operationAbort.signal.reason)) {
                        throw taskErr;
                    }
                    const mapped = bucketStreamError(taskErr, "FILE_STAGE_FAILED");
                    const reason = mapped.message;
                    dbg("task:throw", {
                        path: target.path,
                        stage: checkpoint.stage,
                        err: taskErr?.name,
                        msg: reason.slice(0, 400),
                        stack: String(taskErr?.stack || "").slice(0, 600),
                    });
                    errors.push({ path: target.path, reason, ...mapped });
                    await logGeneration(
                        state,
                        writer,
                        encoder,
                        operationAbort,
                        `× ${target.path} 当前阶段中断：${reason}`,
                        target.path,
                    );
                    return null;
                }
            }));
            const rejected = taskResults.find(
                (result): result is PromiseRejectedResult => result.status === "rejected",
            );
            if (rejected) throw rejected.reason;
            const settled = taskResults.map((result) => (result as PromiseFulfilledResult<FileStageOutcome | null>).value);
            assertBucketActive(operationAbort.signal);
            const results = settled.filter((result): result is FileStageOutcome => !!result);
            const learningToolRequests = results.flatMap((result) => result.learningToolRequests);
            const upsertGeneratedFile = (file: GeneratedFileOutput & { reworkCount?: number }) => {
                const entry = {
                    path: file.path,
                    role: file.role,
                    content: file.content,
                    apiSummary: file.apiSummary,
                    ...(file.reworkCount === undefined ? {} : { reworkCount: file.reworkCount }),
                };
                const index = state.generatedFiles.findIndex((generated: any) => generated.path === file.path);
                if (index >= 0) state.generatedFiles[index] = { ...state.generatedFiles[index], ...entry };
                else state.generatedFiles.push(entry);
            };
            for (const result of results) {
                if (result.checkpoint) state.generationCheckpoints[result.path] = result.checkpoint;
                else delete state.generationCheckpoints[result.path];
                for (const newFile of result.newFiles) {
                    upsertGeneratedFile(newFile);
                    state.fileStatuses[newFile.path] = "done";
                }
                if (result.completed) {
                    upsertGeneratedFile(result.completed);
                    state.fileStatuses[result.path] = "done";
                }
            }

            const bucketDone = bucket.every(file => state.fileStatuses[file.path] === "done");
            if (bucketDone) state.currentBucket = Math.max(state.currentBucket ?? 0, bucketIndex + 1);
            state.currentFileIndex = state.generatedFiles.length;
            assertBucketActive(operationAbort.signal);
            // 先保存阶段，再做计费等附属写入；计费故障不能让已完成的模型阶段丢失并被重复执行。
            await putTaskState(context.env, taskId, state, 3600, uid);
            try {
                await flushCharge();
                if (state.quotaExhausted) await putTaskState(context.env, taskId, state, 3600, uid);
            } catch (chargeError: any) {
                dbg("charge:throw", { msg: String(chargeError?.message || chargeError).slice(0, 300) });
            }

            const completed = completedBucketFiles();
            const newFiles = dynamicFilesForClient();
            const primaryError = errors.find(error => !error.retryable) ?? errors[0];
            const retryable = errors.length > 0 && errors.every(error => error.retryable);
            for (const result of results) {
                dbg("stage:persisted", { path: result.path, stage: result.nextStage, done: !!result.completed });
                if (result.completed) {
                    await writeSSE(writer, encoder, {
                        type: "file_done",
                        path: result.completed.path,
                        content: result.completed.content,
                    }, operationAbort);
                }
            }
            for (const newFile of newFiles) {
                await writeSSE(writer, encoder, { type: "new_file", ...newFile }, operationAbort);
            }

            if (primaryError) {
                await writeSSE(writer, encoder, {
                    type: "error",
                    stage: "bucket",
                    error: primaryError.message,
                    code: primaryError.code,
                    status: primaryError.status,
                    retryable,
                }, operationAbort);
            }

            dbg("result:ok", {
                bucketDone,
                progressed: results.length,
                completed: completed.length,
                errors: errors.length,
                learningToolRequests: learningToolRequests.length,
                generatedTotal: state.generatedFiles.length,
            });
            await writeSSE(writer, encoder, {
                type: "result",
                bucketIndex,
                bucketDone,
                done: bucketDone && state.currentBucket >= buckets.length,
                progressed: results.length > 0,
                retryable,
                retryAfterMs: retryable ? 1_500 : 0,
                ...(primaryError ? {
                    error: primaryError.message,
                    code: primaryError.code,
                    status: primaryError.status,
                } : {}),
                active: results.map(result => ({ path: result.path, stage: result.nextStage })),
                completed,
                newFiles,
                learningToolRequests: learningToolRequests.map((request) => ({
                    requestId: request.requestId,
                    origin: request.origin,
                    targetPath: request.targetPath,
                    questions: request.needs.map((need) => need.claim.question),
                })),
                errors,
                bucketsRemaining: Math.max(0, buckets.length - state.currentBucket),
            }, operationAbort);
            try { await writer.write(encoder.encode("data: [DONE]\n\n")); } catch { /* disconnected */ }
        } catch (e: any) {
            if (isClientCancelled(e) || isClientCancelled(operationAbort.signal.reason)) return;
            const mapped = bucketStreamError(e);
            const errMsg = mapped.message;
            dbg("process:catch", { err: e?.name, msg: errMsg.slice(0, 400), stack: String(e?.stack || "").slice(0, 800) });
            await writeSSE(writer, encoder, { type: "log", msg: `× 桶执行错误: ${errMsg}` }, operationAbort);
            await writeSSE(writer, encoder, {
                type: "error",
                stage: "bucket",
                error: errMsg,
                code: mapped.code,
                status: mapped.status,
                retryable: mapped.retryable,
            }, operationAbort);
            await writeSSE(writer, encoder, {
                type: "result",
                bucketIndex,
                bucketDone: false,
                progressed: false,
                error: errMsg,
                code: mapped.code,
                status: mapped.status,
                retryable: mapped.retryable,
                retryAfterMs: mapped.retryable ? 1_500 : 0,
                completed: [],
                newFiles: [],
                errors: [{
                    reason: errMsg,
                    code: mapped.code,
                    status: mapped.status,
                    retryable: mapped.retryable,
                }],
            }, operationAbort);
            try { await writer.write(encoder.encode("data: [DONE]\n\n")); } catch { /* disconnected */ }
        } finally {
            dbg("process:finally", { hb: hbCount });
            clearInterval(heartbeat);
            try { await flushCharge(); } catch { /* 计费失败不覆盖主流程结果 */ }
            disposeClientAbort();
            try { await writer.close(); } catch { /* already closed/disconnected */ }
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
};
