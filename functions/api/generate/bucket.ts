import { reworkPrompt, dispatchGen, computeSlice, inferGeneratorType, skillFileGenContext } from "../../_lib/prompts";
import type { FileSummary, PlanFileItem, MainBlueprint } from "../../_lib/prompts";
import { accumulateCosts, type UsageBreakdown, type UsageCostEntry } from "../../_lib/quota";
import { resolveLLM, type LLMProvider } from "../../_lib/llm";
import { extractFileSummary } from "../../_lib/fileSummary";
import { loadKnowledgeContext, mergeKnowledgeUsed, recordKnowledgeContextUsage } from "../../_lib/learning/context";
import {
    assessPlannerLearningAuthorization,
    assessPlannerResultAuthorization,
    samePlannerResultAuthorization,
} from "../../_lib/learning/plannerAuthorization";
import { getOwnedTask, markTaskQuotaExhausted, putTaskState } from "../../_lib/taskStore";
import { buildApiContractContext, findKnownApiIssues } from "../../_lib/apiContracts";

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

interface AICallResult { content: string; model: string; usage?: UsageBreakdown; }
type ChargeFn = (r: AICallResult) => Promise<void>;

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
): Promise<void> {
    try { await writer.write(sseEvent(encoder, data)); } catch { /* generation continues after client disconnect */ }
}

interface BackoffOptions {
    maxRetries?: number;
    onRetry?: (event: { attempt: number; status: number; waitMs: number }) => void;
}

function abortError(): Error {
    const error = new Error("The operation was aborted");
    error.name = "AbortError";
    return error;
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
    if (signal?.aborted) throw abortError();
    await new Promise<void>((resolve, reject) => {
        let timer: ReturnType<typeof setTimeout>;
        const onAbort = () => {
            clearTimeout(timer);
            signal?.removeEventListener("abort", onAbort);
            reject(abortError());
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

async function callAI(llm: LLMProvider, system: string, user: string, jsonMode = false, usePro = false, dbg: Dbg = noopDbg): Promise<AICallResult> {
    const model = llm.modelFor(usePro ? "pro" : "flash");
    const body: any = {
        model,
        messages: [{ role: "system", content: system }, { role: "user", content: user }],
    };
    if (usePro) {
        body.reasoning_effort = "high";
        body.thinking = { type: "enabled" };
    }
    if (jsonMode) body.response_format = { type: "json_object" };

    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), LLM_TIMEOUT_MS);
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
        if (!resp.ok) {
            const txt = await resp.text();
            dbg("callAI:http-err", { status: resp.status, body: txt.slice(0, 400) });
            throw new Error(`HTTP ${resp.status}: ${txt.slice(0, 300)}`);
        }
        dbg("callAI:body-start", { model, ms: Date.now() - t0 });
        const data = await resp.json() as any;
        dbg("callAI:body-done", { model, ms: Date.now() - t0 });
        const content = data.choices?.[0]?.message?.content ?? "";
        dbg("callAI:done", { model, ms: Date.now() - t0, contentLen: content.length });
        return { content, model, usage: data.usage };
    } catch (e: any) {
        dbg("callAI:throw", { model, ms: Date.now() - t0, err: e?.name, msg: String(e?.message || e).slice(0, 400) });
        throw e;
    } finally {
        clearTimeout(timer);
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
): Promise<AICallResult> {
    // 【非流式】CF 免费版单请求仅 ~10ms CPU。流式逐 chunk decode + JSON.parse(几百次)会超 CPU
    // 被硬杀(debug 实测:29 次生成仅 2 次跑到 stream:done)。改为非流式,只做 1 次 resp.json()——
    // 与在免费版上稳定工作的 reChecker(callAI 非流式)同款,CPU 骤降。逐 token delta 转发本就已去掉,
    // 不流式对结果无影响。writer/encoder 参数保留仅为兼容调用点签名。
    const model = llm.modelFor(usePro ? "pro" : "flash");
    const body: any = {
        model,
        messages: [{ role: "system", content: system }, { role: "user", content: user }],
    };
    if (usePro) {
        body.reasoning_effort = "high";
        body.thinking = { type: "enabled" };
    }

    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), LLM_TIMEOUT_MS);
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
        if (!resp.ok) {
            const txt = await resp.text();
            dbg("stream:http-err", { path: pathTag, status: resp.status, body: txt.slice(0, 400) });
            throw new Error(`HTTP ${resp.status}: ${txt.slice(0, 300)}`);
        }
        dbg("stream:body-start", { path: pathTag, model, ms: Date.now() - t0 });
        const data = await resp.json() as any;
        dbg("stream:body-done", { path: pathTag, model, ms: Date.now() - t0 });
        const content = data.choices?.[0]?.message?.content ?? "";
        dbg("stream:done", { path: pathTag, ms: Date.now() - t0, len: content.length });
        return { content, model, usage: data.usage };
    } catch (e: any) {
        dbg("stream:throw", { path: pathTag, ms: Date.now() - t0, err: e?.name, msg: String(e?.message || e).slice(0, 400) });
        throw e;
    } finally {
        clearTimeout(timer);
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
    msg: string,
    path?: string,
): Promise<void> {
    state.logs ??= [];
    state.logs.push(msg);
    await writeSSE(writer, encoder, { type: "log", path, msg });
}

function nonEmptyModelContent(result: AICallResult, stage: string): string {
    const content = stripFences(result.content).trim();
    if (!content) throw new Error(`${stage}模型返回空内容`);
    return content;
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
    charge: ChargeFn,
    dbg: Dbg = noopDbg,
): Promise<FileStageOutcome> {
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
    });
    const complete = async (): Promise<FileStageOutcome> => {
        const apiSummary = extractFileSummary(filePath, checkpoint.content, target.role);
        dbg("file:return", {
            path: filePath,
            failed: checkpoint.reworkCount >= MAX_REWORK,
            reworkCount: checkpoint.reworkCount,
        });
        const doneMsg = `● ${filePath} 已完成${checkpoint.reworkCount > 0 ? ` (修正${checkpoint.reworkCount}次)` : ""}`;
        await logGeneration(state, writer, encoder, doneMsg, filePath);
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
        };
    };
    const runRework = async (): Promise<FileStageOutcome> => {
        await writeSSE(writer, encoder, { type: "phase", path: filePath, phase: "reworking" });
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
        const rwRes = await callAIStream(llm, rw.system, rw.user, writer, encoder, filePath, false, dbg);
        await charge(rwRes);
        checkpoint.content = nonEmptyModelContent(rwRes, "返工");
        if (checkpoint.reworkCount >= MAX_REWORK) {
            const warnMsg = `! ${filePath} 经 ${MAX_REWORK} 次修正仍未通过审查，接受当前版本，交由编译阶段校验`;
            await logGeneration(state, writer, encoder, warnMsg, filePath);
            return complete();
        }
        checkpoint.stage = "review";
        return outcome("review");
    };

    dbg("stage:start", { path: filePath, stage: checkpoint.stage, round: checkpoint.reworkCount });
    if (checkpoint.stage === "generate") {
        await writeSSE(writer, encoder, { type: "phase", path: filePath, phase: "generating" });
        await logGeneration(state, writer, encoder, `▸ 正在生成 ${filePath}`, filePath);
        dbg("file:dispatch", { path: filePath, gtype: (target as any).generatorType });
        dbg("file:gen-begin", { path: filePath });
        const initialRes = await callAIStream(
            llm,
            dispatched.gen.system,
            dispatched.gen.user,
            writer,
            encoder,
            filePath,
            false,
            dbg,
        );
        await charge(initialRes);
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
        await writeSSE(writer, encoder, { type: "phase", path: dynamic.path, phase: "generating" });
        await logGeneration(
            state,
            writer,
            encoder,
            `▸ 动态生成 ${dynamic.className} (${checkpoint.dynamicIndex + 1}/${checkpoint.dynamicFiles.length})`,
            filePath,
        );
        const subRes = await callAIStream(
            llm,
            subDispatched.gen.system,
            subDispatched.gen.user,
            writer,
            encoder,
            dynamic.path,
            false,
            dbg,
        );
        await charge(subRes);
        const content = nonEmptyModelContent(subRes, "动态生成");
        try { onKnowledgeApplied(dynamic.path); } catch { /* usage telemetry is best effort */ }
        checkpoint.dynamicIndex++;
        checkpoint.stage = checkpoint.dynamicIndex < checkpoint.dynamicFiles.length
            ? "dynamic_generate"
            : "review";
        await logGeneration(state, writer, encoder, `● ${dynamic.className} 动态生成完成`, filePath);
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

    await writeSSE(writer, encoder, { type: "phase", path: filePath, phase: "reviewing" });
    await logGeneration(state, writer, encoder, `▸ 审查 ${filePath}...`, filePath);
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
        const reviewRes = await callAI(llm, check.system, check.user, true, checkpoint.reworkCount > 0, dbg);
        await charge(reviewRes);
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
        await logGeneration(state, writer, encoder, `● ${filePath} 审查通过`, filePath);
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
        `↻ ${filePath} 需修正 (${checkpoint.reworkCount}/${MAX_REWORK}): ${checkpoint.lastReason}`,
        filePath,
    );
    // 已经完成模型复审时立即保存返工意图，下一请求再返工，保证单目标单请求最多一次模型调用。
    return reviewUsedModel ? outcome("rework") : runRework();
}

export const onRequestPost: PagesFunction<Env> = async (context) => {
    const { taskId, bucketIndex, superConcurrency } = await context.request.json() as any;
    const uid: string = (context.data as any)?.uid || "";
    // 默认每请求推进一个文件的一个阶段；超级并发只会并行多个独立阶段，不再把整份文件工作流塞进单请求。
    let concurrency = 1;
    if (superConcurrency) {
        concurrency = Math.max(2, parseInt(context.env.GEN_CONCURRENCY || "") || SUPER_CONCURRENCY);
    }

    const raw = await getOwnedTask(context.env, taskId, uid);
    if (!raw) return new Response("Task not found", { status: 404 });
    const state = JSON.parse(raw);
    // 挂了 skill 的任务：prompt 更大、文件更多，强制串行，避免大 prompt × 并发撞 CF Worker 限制
    if (state.skills?.length) concurrency = 1;

    if (state.quotaExhausted) {
        return new Response(JSON.stringify({ error: "本月额度已用尽", code: "QUOTA_EXHAUSTED" }), {
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

    const llm = await resolveLLM(context);
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
        })).catch(() => { });
    };

    const process = (async () => {
        // 心跳:深度复审等非流式 LLM 调用期间可能长时间无响应字节；每 12s 写一次保持 SSE 活跃。
        // n=心跳序号:前端据此判断 CF Worker 的 setInterval 是否真的在跳(若无 heartbeat,则定时器未触发)。
        let hbCount = 0;
        const heartbeat = setInterval(() => {
            hbCount++;
            writer.write(sseEvent(encoder, { type: "heartbeat", t: Date.now(), n: hbCount })).catch(() => { });
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
            });

            // 桶已全部完成（无 pending）→ 标记并前进
            if (pending.length === 0) {
                state.currentBucket = Math.max(state.currentBucket ?? 0, bucketIndex + 1);
                await putTaskState(context.env, taskId, state, 3600, uid);
                const completed = completedBucketFiles();
                const newFiles = dynamicFilesForClient();
                for (const newFile of newFiles) await writeSSE(writer, encoder, { type: "new_file", ...newFile });
                await writeSSE(writer, encoder, {
                    type: "result", bucketIndex, bucketDone: true,
                    done: state.currentBucket >= buckets.length,
                    progressed: false,
                    completed, newFiles, errors: [],
                    bucketsRemaining: Math.max(0, buckets.length - state.currentBucket),
                });
                try { await writer.write(encoder.encode("data: [DONE]\n\n")); } catch { /* disconnected */ }
                return;
            }

            const errors: { path: string; reason: string }[] = [];
            state.fileStatuses ??= {};
            state.generationCheckpoints ??= {};
            for (const target of targets) state.fileStatuses[target.path] = "generating";

            dbg("batch:begin", { pending: pending.length, targets: targets.map(t => t.path) });
            const settled = await Promise.all(targets.map(async (target): Promise<FileStageOutcome | null> => {
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
                        charge,
                        dbg,
                    );
                    dbg("task:ok", { path: target.path, stage: result.nextStage, done: !!result.completed });
                    return result;
                } catch (taskErr: any) {
                    const reason = taskErr?.message ? String(taskErr.message) : String(taskErr);
                    dbg("task:throw", {
                        path: target.path,
                        stage: checkpoint.stage,
                        err: taskErr?.name,
                        msg: reason.slice(0, 400),
                        stack: String(taskErr?.stack || "").slice(0, 600),
                    });
                    errors.push({ path: target.path, reason });
                    await logGeneration(state, writer, encoder, `× ${target.path} 当前阶段中断：${reason}`, target.path);
                    return null;
                }
            }));
            const results = settled.filter((result): result is FileStageOutcome => !!result);
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
            for (const result of results) {
                dbg("stage:persisted", { path: result.path, stage: result.nextStage, done: !!result.completed });
                if (result.completed) {
                    await writeSSE(writer, encoder, {
                        type: "file_done",
                        path: result.completed.path,
                        content: result.completed.content,
                    });
                }
            }
            for (const newFile of newFiles) await writeSSE(writer, encoder, { type: "new_file", ...newFile });

            dbg("result:ok", {
                bucketDone,
                progressed: results.length,
                completed: completed.length,
                errors: errors.length,
                generatedTotal: state.generatedFiles.length,
            });
            await writeSSE(writer, encoder, {
                type: "result",
                bucketIndex,
                bucketDone,
                done: bucketDone && state.currentBucket >= buckets.length,
                progressed: results.length > 0,
                retryable: errors.length > 0,
                retryAfterMs: errors.length > 0 ? 1_500 : 0,
                active: results.map(result => ({ path: result.path, stage: result.nextStage })),
                completed,
                newFiles,
                errors,
                bucketsRemaining: Math.max(0, buckets.length - state.currentBucket),
            });
            try { await writer.write(encoder.encode("data: [DONE]\n\n")); } catch { /* disconnected */ }
        } catch (e: any) {
            const errMsg = e?.message ? String(e.message) : String(e);
            dbg("process:catch", { err: e?.name, msg: errMsg.slice(0, 400), stack: String(e?.stack || "").slice(0, 800) });
            await writeSSE(writer, encoder, { type: "log", msg: `× 桶执行错误: ${errMsg}` });
            await writeSSE(writer, encoder, {
                type: "result",
                bucketIndex,
                bucketDone: false,
                progressed: false,
                retryable: true,
                retryAfterMs: 1_500,
                completed: [],
                newFiles: [],
                errors: [{ reason: errMsg }],
            });
            try { await writer.write(encoder.encode("data: [DONE]\n\n")); } catch { /* disconnected */ }
        } finally {
            dbg("process:finally", { hb: hbCount });
            clearInterval(heartbeat);
            try { await flushCharge(); } catch { /* 计费失败不覆盖主流程结果 */ }
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
