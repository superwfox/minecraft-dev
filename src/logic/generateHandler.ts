import {
    genTask,
    resetGenTask,
    waitForClarifyAnswers,
    waitForExtraPrompt,
    waitForPathChoice,
    cancelPendingInput,
    persistGenTaskNow,
    superConcurrency,
} from "./generateState";
import type { GenPhase } from "./generateState";
import { showSponsorModal, login, fetchMe } from "./auth";
import { fetchWithByokFallback } from "./byok";
import { selected } from "./skills";
import { parseResponse } from "../ide/composables/useIDEChat";

const MAX_FIX_ATTEMPTS = 3;
const MAX_REPLAN_ATTEMPTS = 2;

// ── ESC 撤回中断（仅思考/需求确认阶段）──
// clarify / grade 阶段的 SSE fetch controller；ESC 时 abort 断流（后端 waitUntil 仍会读完并结算 token）
let clarifyAbort: AbortController | null = null;
let gradeAbort: AbortController | null = null;

/** 判断错误是否来自 ESC 中断：fetch abort 抛 AbortError，等待 Promise 被拒抛 InterruptError */
function isInterrupt(e: any): boolean {
    return e?.interrupted === true || e?.name === "AbortError";
}

/** ESC 撤回：中断进行中的需求确认（abort SSE + 取消等待用户输入的 Promise）。
 *  token 花费由后端 clarify.ts 的 context.waitUntil 自动结算，前端无需处理。 */
export function interruptGenerate() {
    clarifyAbort?.abort();
    gradeAbort?.abort();
    cancelPendingInput();
}

/** 不可重试错误（鉴权 / 额度），跳过 post() 的重试逻辑 */
function noRetry(msg: string): Error {
    const e = new Error(msg);
    (e as any).noRetry = true;
    return e;
}

function setPhase(phase: GenPhase, log?: string) {
    genTask.phase = phase;
    if (log) genTask.logs.push(log);
}

function isGeneratingPhase(phase: GenPhase) {
    return ["planning", "clarifying", "awaiting_input", "generating", "verifying", "uploading", "building", "polling", "fixing"].includes(phase);
}

async function post(url: string, body: any, maxRetries = 3) {
    for (let attempt = 0; attempt <= maxRetries; attempt++) {
        try {
            const resp = await fetchWithByokFallback(url, {
                method: "POST",
                headers: { "Content-Type": "application/json" },
                body: JSON.stringify(body),
            });
            if (resp.status === 401) { login(); throw noRetry("请先登录后再使用"); }
            if (resp.status === 402) { showSponsorModal.value = true; fetchMe(); throw noRetry("本月额度已用尽"); }
            if (resp.status === 429) {
                // 构建端硬上限：不重试，向上抛
                const j = await resp.json().catch(() => ({}));
                throw noRetry(j?.error || "请求过于频繁");
            }
            if (resp.status === 400) {
                // pom 安全校验拦截等：不重试
                const j = await resp.json().catch(() => ({}));
                if (j?.code === "POM_BLOCKED") {
                    throw noRetry(`pom.xml 安全校验未通过：${j.error}`);
                }
                throw new Error(j?.error || await resp.text());
            }
            if (!resp.ok) throw new Error(await resp.text());
            return await resp.json() as any;
        } catch (e: any) {
            if (e?.noRetry || attempt >= maxRetries) throw e;
            const delay = 2000 * Math.pow(2, attempt);
            genTask.logs.push(`! 请求失败，${delay / 1000}s 后重试 (${attempt + 1}/${maxRetries})...`);
            await new Promise(r => setTimeout(r, delay));
        }
    }
}

function createPlannerRequestId(): string {
    return `plan_${crypto.randomUUID().replace(/-/g, "")}`;
}

async function postPlanner(body: any, waitMs = 390_000): Promise<any> {
    const deadline = Date.now() + waitMs;
    let announcedWait = false;
    let failures = 0;

    while (true) {
        let resp: Response;
        try {
            resp = await fetchWithByokFallback("/api/generate/plan", {
                method: "POST",
                headers: { "Content-Type": "application/json" },
                body: JSON.stringify(body),
            });
        } catch (error) {
            if (Date.now() >= deadline || failures++ >= 3) throw error;
            await new Promise(resolve => setTimeout(resolve, 2000 * Math.pow(2, failures - 1)));
            continue;
        }

        if (resp.status === 401) { login(); throw noRetry("请先登录后再使用"); }
        if (resp.status === 402) { showSponsorModal.value = true; fetchMe(); throw noRetry("本月额度已用尽"); }
        if (resp.status === 429) {
            const payload = await resp.json().catch(() => ({}));
            throw noRetry(payload?.error || "请求过于频繁");
        }
        if (resp.status === 409) {
            const payload = await resp.json().catch(() => ({}));
            if (payload?.code !== "PLANNER_IN_PROGRESS" || Date.now() >= deadline) {
                throw new Error(payload?.error || "Planner 状态冲突");
            }
            if (!announcedWait) {
                genTask.logs.push("· Planner 已在服务端执行，等待现有结果...");
                announcedWait = true;
            }
            const retrySeconds = Math.max(1, Number(resp.headers.get("Retry-After")) || 2);
            await new Promise(resolve => setTimeout(resolve, retrySeconds * 1000));
            continue;
        }
        if (resp.status === 400) {
            const payload = await resp.json().catch(() => ({}));
            throw noRetry(payload?.error || "Planner 请求无效");
        }
        if (!resp.ok) {
            const message = await resp.text();
            if (Date.now() >= deadline || failures++ >= 3) throw new Error(message);
            await new Promise(resolve => setTimeout(resolve, 2000 * Math.pow(2, failures - 1)));
            continue;
        }
        return await resp.json();
    }
}

async function get(url: string) {
    const resp = await fetch(url);
    if (!resp.ok) throw new Error(await resp.text());
    return resp.json() as any;
}

const LEARNING_TERMINAL = new Set(["ready", "deferred", "needs_review", "failed", "cancelled"]);

function applyLearningSnapshot(snapshot: any) {
    if (snapshot?.learningProgress) {
        genTask.learningProgress = { ...snapshot.learningProgress };
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

async function learningPost(url: string, body: any, signal: AbortSignal): Promise<any> {
    const resp = await fetchWithByokFallback(url, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(body),
        signal,
    });
    if (resp.status === 401) { login(); throw noRetry("请先登录后再使用"); }
    if (resp.status === 402) { showSponsorModal.value = true; fetchMe(); throw noRetry("本月额度已用尽"); }
    if (!resp.ok && resp.status !== 409) throw new Error(await resp.text());
    return await resp.json();
}

async function runLearning(
    stage: "planner" | "fix",
    chosenPathId?: string,
    waitMs = stage === "planner" ? 40_000 : 20_000,
) {
    const deadline = Date.now() + waitMs;
    let lastMessage = "";
    genTask.learningDeferred = false;

    const request = async (url: string, body: any) => {
        const remaining = Math.max(1, deadline - Date.now());
        const ctrl = new AbortController();
        const timer = setTimeout(() => ctrl.abort(), remaining);
        try {
            return await learningPost(url, body, ctrl.signal);
        } finally {
            clearTimeout(timer);
        }
    };
    const announce = (snapshot: any) => {
        applyLearningSnapshot(snapshot);
        const message = snapshot?.learningProgress?.message || "";
        if (message && message !== lastMessage) {
            genTask.logs.push(`▸ ${message}`);
            lastMessage = message;
        }
    };

    try {
        let snapshot = await request("/api/learning/start", {
            taskId: genTask.taskId,
            stage,
            chosenPathId,
        });
        announce(snapshot);

        while (snapshot?.learningProgress?.jobId
            && !LEARNING_TERMINAL.has(snapshot.learningProgress.status)
            && Date.now() < deadline) {
            snapshot = await request("/api/learning/step", {
                taskId: genTask.taskId,
                jobId: snapshot.learningProgress.jobId,
                revision: snapshot.learningProgress.revision,
            });
            announce(snapshot);
            if (!LEARNING_TERMINAL.has(snapshot?.learningProgress?.status)) {
                await new Promise(resolve => setTimeout(resolve, 200));
            }
        }

        if (!LEARNING_TERMINAL.has(genTask.learningProgress.status)) {
            genTask.learningDeferred = true;
            genTask.learningProgress.message = "本轮联网查证超过等待上限，已按现有知识继续";
            genTask.logs.push("! 联网查证超过等待上限，已按现有知识继续");
        }
    } catch (error: any) {
        genTask.learningDeferred = true;
        const timedOut = error?.name === "AbortError";
        genTask.learningProgress.message = timedOut
            ? "本轮联网查证超过等待上限，已按现有知识继续"
            : "联网查证暂不可用，已按现有知识继续";
        genTask.logs.push(timedOut
            ? "! 联网查证超过等待上限，已按现有知识继续"
            : `! 联网查证未完成，已按现有知识继续: ${error?.message || error}`);
    }
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

/** Read an SSE stream, dispatch events to genTask, return the result event */
async function readSSE(resp: Response, opts?: { idleMs?: number; onIdle?: () => void }): Promise<any> {
    const reader = resp.body!.getReader();
    const decoder = new TextDecoder();
    let buffer = "";
    let result: any = null;
    let streamedTodoCount = 0;

    // 空闲超时:每收到一块数据(含后端心跳)就重置;连续 idleMs 收不到任何字节才判定后端已死 → onIdle()。
    // 只在调用方传入 idleMs 时启用(桶生成),避免误杀健康但耗时很长的流。
    let idleTimer: any;
    const armIdle = () => {
        if (!opts?.idleMs) return;
        clearTimeout(idleTimer);
        idleTimer = setTimeout(() => opts.onIdle?.(), opts.idleMs);
    };
    armIdle();

    while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        armIdle();
        buffer += decoder.decode(value, { stream: true });
        const lines = buffer.split("\n");
        buffer = lines.pop()!;

        for (const line of lines) {
            const trimmed = line.trim();
            if (!trimmed.startsWith("data:")) continue;
            const payload = trimmed.slice(5).trim();
            if (payload === "[DONE]") continue;

            try {
                const evt = JSON.parse(payload);
                switch (evt.type) {
                    case "phase":
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
                    case "reasoning":
                        genTask.reasoningContent += evt.content;
                        break;
                    case "delta":
                        if (evt.path) {
                            const f = findFile(evt.path);
                            if (f) {
                                f.streamingContent = (f.streamingContent || "") + evt.content;
                            }
                        } else {
                            genTask.streamingContent += evt.content;
                            if (genTask.streamingPhase === "clarifying") {
                                const todos = extractCompletedTodos(genTask.streamingContent);
                                if (todos.length > streamedTodoCount) {
                                    for (let k = streamedTodoCount; k < todos.length; k++) {
                                        genTask.clarifyTodos.push(todos[k]);
                                    }
                                    streamedTodoCount = todos.length;
                                }
                            }
                        }
                        break;
                    case "log":
                        genTask.logs.push(evt.msg);
                        break;
                    case "file_done": {
                        const f = findFile(evt.path);
                        if (f) {
                            f.content = evt.content;
                            f.status = "done";
                            f.streamingPhase = "";
                            f.streamingContent = "";
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
                        if (!findFile(evt.path)) {
                            genTask.files.push({
                                path: evt.path, role: evt.role,
                                content: evt.content, status: "done",
                            });
                        }
                        break;
                    case "bucket_start":
                        for (const p of evt.paths || []) {
                            const f = findFile(p);
                            if (f) f.status = "generating";
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
            } catch { /* skip */ }
        }
    }

    clearTimeout(idleTimer);
    genTask.streamingPhase = "";
    genTask.streamingFile = "";
    genTask.streamingContent = "";
    return result;
}

/** SSE streaming file generation (legacy single-file flow，仅供补缺/重新规划使用) */
async function streamFileGeneration(taskId: string): Promise<any> {
    const resp = await fetchWithByokFallback("/api/generate/file", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ taskId }),
    });
    if (!resp.ok) throw new Error(await resp.text());

    const contentType = resp.headers.get("Content-Type") || "";
    if (contentType.includes("application/json")) {
        return await resp.json();
    }

    return readSSE(resp);
}

/** SSE streaming bucket generation — 一次跑一批文件。
 *  空闲超时(非总时长!):后端每 12s 发 heartbeat,只要还在流就一直续命;连续 BUCKET_IDLE_MS
 *  收不到任何字节(CF 强杀 / 上游彻底断死)才 abort → 前端重试同一桶。
 *  旧的「300s 总时长」会误杀健康但耗时较长的批次(如慢模型/pro 返工)→ 零进度 → replan 死循环。 */
const BUCKET_IDLE_MS = 45000; // 心跳 12s 一次,45s 无任何字节才判死
async function streamBucketGeneration(taskId: string, bucketIndex: number): Promise<any> {
    const ctrl = new AbortController();
    const resp = await fetchWithByokFallback("/api/generate/bucket", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ taskId, bucketIndex, superConcurrency: superConcurrency.value }),
        signal: ctrl.signal,
    });
    if (!resp.ok) throw new Error(await resp.text());
    return await readSSE(resp, { idleMs: BUCKET_IDLE_MS, onIdle: () => ctrl.abort() });
}

/** SSE streaming clarify round */
async function streamClarify(
    taskId: string,
    answers?: Record<string, string | string[]>,
    extraPrompt?: string,
): Promise<any> {
    clarifyAbort = new AbortController();
    const resp = await fetchWithByokFallback("/api/generate/clarify", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ taskId, answers, extraPrompt }),
        signal: clarifyAbort.signal,
    });
    if (!resp.ok) throw new Error(await resp.text());
    return readSSE(resp);
}

/** SSE streaming 复杂度分级（可带 correction 重画） */
async function streamGrade(taskId: string, correction?: string): Promise<any> {
    gradeAbort = new AbortController();
    const resp = await fetchWithByokFallback("/api/generate/grade", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ taskId, correction }),
        signal: gradeAbort.signal,
    });
    if (!resp.ok) throw new Error(await resp.text());
    return readSSE(resp);
}

/** SSE streaming build fix */
async function streamBuildFix(taskId: string, mode: "diagnose" | "repair" | "inspect" = "repair"): Promise<any> {
    const resp = await fetchWithByokFallback("/api/generate/fix", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ taskId, mode }),
    });
    if (!resp.ok) throw new Error(await resp.text());

    const contentType = resp.headers.get("Content-Type") || "";
    if (contentType.includes("application/json")) {
        return await resp.json();
    }

    return readSSE(resp);
}

// 记住上次生成的入参，供失败后「重试」手动重跑。刷新后内存丢失时，改用 genTask 上还原的入参。
let lastGenParams: { userPrompt: string; coreType: string; version: string } | null = null;
export function canRetryGenerate(): boolean {
    const has = !!lastGenParams || !!genTask.userPrompt || !!genTask.taskId;
    return has && (genTask.phase === "error" || genTask.phase === "idle");
}
/** 手动重试：优先用内存入参重跑；刷新后内存丢了则用还原的入参重跑，或从 KV 续跑。 */
export function retryGenerate() {
    const params = lastGenParams
        || (genTask.userPrompt ? { userPrompt: genTask.userPrompt, coreType: genTask.coreType, version: genTask.version } : null);
    if (params) {
        startGenerate(params.userPrompt, params.coreType, params.version).catch(() => { });
    } else if (genTask.taskId) {
        resumeGenerate().catch(() => { });
    }
}

/** 刷新恢复：genTask 已由 restoreGenTask 还原，据当前阶段续跑，避免刷新即失败。 */
export async function resumeGenerate() {
    const p = genTask.phase;
    if (!genTask.taskId || ["idle", "done", "error"].includes(p)) return;

    // 已触发构建的阶段只恢复轮询，避免刷新后重复建分支、重复触发 workflow。
    if (["building", "polling"].includes(p)) {
        try { await buildWithRetry(undefined, undefined, true); }
        catch (e: any) { genTask.phase = "error"; genTask.error = e?.message || String(e); }
        return;
    }
    // uploading / fixing 的服务端请求可能尚未完成，沿用原恢复策略。
    if (["uploading", "fixing"].includes(p)) {
        try { await buildWithRetry(); }
        catch (e: any) { genTask.phase = "error"; genTask.error = e?.message || String(e); }
        return;
    }

    // Planner 学习/规划阶段已有 taskId 和路径选择，可直接沿用服务端状态恢复。
    if (!genTask.files.length && p === "planning" && genTask.userPrompt) {
        genTask.logs.push("↻ 页面恢复：继续联网查证与项目规划");
        await startGenerate(genTask.userPrompt, genTask.coreType, genTask.version, { resumePrepared: true });
        return;
    }

    // 澄清/分级/确认依赖尚未恢复的交互 Promise，只能转为可重试状态。
    if (!genTask.files.length) {
        genTask.phase = "error";
        genTask.error = "页面刷新中断了需求确认，点「重试」用上次需求继续。";
        return;
    }

    // 生成/校验阶段（plan 已完成、有 files）：续跑桶循环（后端 fileStatuses 天然可续）→ 校验 → 构建
    try {
        genTask.logs.push("↻ 从刷新中断处继续生成…");
        setPhase("generating", "从中断处继续生成…");

        const bucketMap = new Map<number, number>();
        for (const f of genTask.files) { const b = f.bucket ?? 0; bucketMap.set(b, (bucketMap.get(b) ?? 0) + 1); }
        const sortedBucketIds = [...bucketMap.keys()].sort((a, b) => a - b);

        for (const bucketIndex of sortedBucketIds) {
            let bucketDone = false, guard = 0, noProgress = 0;
            const doneCount = () => genTask.files.filter(f => f.status === "done").length;
            while (!bucketDone) {
                if (guard++ > 80) throw new Error("续跑批次过多，请重试");
                const doneBefore = doneCount();
                let bucketResult: any = null;
                for (let bAttempt = 0; bAttempt < 2 && !bucketResult; bAttempt++) {
                    try { bucketResult = await streamBucketGeneration(genTask.taskId, bucketIndex); }
                    catch { bucketResult = null; }
                }
                if (!bucketResult) {
                    if (doneCount() > doneBefore) { noProgress = 0; continue; }
                    if (++noProgress >= 5) throw new Error("续跑连续零进度，请重试");
                    continue;
                }
                noProgress = 0;
                if (bucketResult.replan) throw new Error("续跑仍未通过审查，请重试");
                for (const c of bucketResult.completed || []) {
                    const f = genTask.files.find(x => x.path === c.path);
                    if (f) { f.content = c.content; f.status = "done"; }
                }
                bucketDone = !!bucketResult.bucketDone;
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
        genTask.phase = "error";
        genTask.error = e?.message || String(e);
        genTask.logs.push("× " + genTask.error);
    }
}

export async function startGenerate(
    userPrompt: string,
    coreType: string,
    version: string,
    options?: { resumePrepared?: boolean },
) {
    const resumePrepared = options?.resumePrepared === true;
    if (!resumePrepared && isGeneratingPhase(genTask.phase)) {
        throw new Error("当前已有构建任务正在进行");
    }
    let chosenPathId: string | undefined = resumePrepared ? genTask.chosenPathId || undefined : undefined;

    if (!resumePrepared) {
        lastGenParams = { userPrompt, coreType, version };

        resetGenTask();
        genTask.userPrompt = userPrompt;
        genTask.coreType = coreType;
        genTask.version = version;

    // ── Phase 1: create taskId (no plan yet) ──
    try {
        setPhase("planning", "正在创建任务...");
        const initResult = await post("/api/generate/plan", { userPrompt, coreType, version, skillIds: [...selected] });
        genTask.taskId = initResult.taskId;
        fetchMe(); // 扣费后刷新顶栏剩余额度
    } catch (e: any) {
        genTask.phase = "error";
        genTask.error = e.message || String(e);
        genTask.logs.push("× " + genTask.error);
        return;
    }

    // ── Phase 2: multi-round clarify loop ──
    try {
        setPhase("clarifying", "进入澄清阶段，请回答问题...");
        let answers: Record<string, string | string[]> | undefined = undefined;
        let extraPrompt: string | undefined = undefined;

        while (true) {
            genTask.reasoningContent = "";
            // 澄清调用可能因 CF→模型服务链路慢/抖动拿不到 result(超时/被切/连接失败)。
            // 这不一定是真失败:重试几次(保留已填 answers/补充说明),都不行才硬失败。
            let clarifyResult: any = null;
            for (let attempt = 0; attempt < 3 && !clarifyResult; attempt++) {
                try {
                    const r = await streamClarify(genTask.taskId, answers, extraPrompt);
                    if (r && !r.error) { clarifyResult = r; break; }
                    genTask.logs.push(`· 澄清${r?.error ? `出错(${r.error})` : "无返回"}，重试 (${attempt + 1}/3)...`);
                } catch (ce: any) {
                    if (isInterrupt(ce)) throw ce; // ESC 撤回照常中断
                    genTask.logs.push(`· 澄清中断（${ce?.message || ce}），重试 (${attempt + 1}/3)...`);
                }
            }
            extraPrompt = undefined;
            if (!clarifyResult) throw new Error("澄清阶段多次无响应（可能与模型服务连接不稳定，请稍后重试）");

            if (clarifyResult.needMoreInput) {
                genTask.moreInputHint = clarifyResult.hint || "请补充更多需求描述";
                setPhase("awaiting_input", "! 需求过于模糊，请补充描述");
                const extra = await waitForExtraPrompt();
                genTask.moreInputHint = "";
                extraPrompt = extra;
                setPhase("clarifying", "已收到补充，继续分析...");
                continue;
            }

            if (clarifyResult.done) {
                genTask.logs.push("● 澄清阶段完成");
                genTask.clarifyTodos = [];
                break;
            }

            // 推入历史（todos，answers 稍后填）
            genTask.clarifyTodos = clarifyResult.todos;
            const userAnswers = await waitForClarifyAnswers();

            genTask.clarifyHistory.push({ todos: clarifyResult.todos, answers: userAnswers });
            genTask.clarifyTodos = [];
            answers = userAnswers;
        }
    } catch (e: any) {
        if (isInterrupt(e)) {
            // ESC 撤回：安静复位回 idle（消耗已由后端结算）
            resetGenTask();
            fetchMe(); // 刷新顶栏剩余额度，反映已结算的扣费
            return;
        }
        genTask.phase = "error";
        genTask.error = e.message || String(e);
        genTask.logs.push("× " + genTask.error);
        return;
    }

    // ── Phase 2.5: 复杂度分级 +（非直接级）实现路径确认门 ──
    try {
        let correction: string | undefined;
        while (true) {
            genTask.reasoningContent = "";
            setPhase("grading", "正在分析需求复杂度...");
            const gradeRes = await streamGrade(genTask.taskId, correction);
            correction = undefined;
            // 直接级 / 兜底 → 走原路径，不出确认门
            if (!gradeRes || gradeRes.direct) break;

            // 非直接级：展示手牌路径门，等用户选路径或打回
            genTask.grade = { level: gradeRes.level, paths: gradeRes.paths || [] };
            setPhase("confirming", "请确认实现路径");
            const choice = await waitForPathChoice();
            if (choice.correction) {
                correction = choice.correction;
                genTask.grade = null;
                continue; // 带修正重新分级
            }
            chosenPathId = choice.pathId;
            genTask.chosenPathId = choice.pathId || "";
            genTask.grade = null;
            break;
        }
    } catch (e: any) {
        if (isInterrupt(e)) {
            resetGenTask();
            fetchMe();
            return;
        }
        // 分级异常不阻断生成：按原路径继续（plan 仍会按 vector 注入轴要求）
        genTask.grade = null;
        genTask.logs.push("! 分级阶段异常，按原路径继续: " + (e.message || e));
    }
    }

    // ── Phase 2.8: Planner 前限时查证公开技术缺口 ──
    setPhase("planning", "正在查证目标版本 API 与依赖...");
    await runLearning("planner", chosenPathId, 40_000);

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
                genTask.error = "";
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

            const planResult = await postPlanner({
                taskId: genTask.taskId,
                chosenPathId,
                skillIds: [...selected],
                replan: plannerReplan,
                plannerRequestId,
            });
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
            let needReplan = false;

            let allBucketsDone = false;
            outer: for (const bucketIndex of sortedBucketIds) {
                if (needReplan) break;
                // 桶分批推进：每次请求只生成一批（concurrency 个）文件，循环调用同一桶直到 bucketDone，
                // 避免一个 CF Worker 请求跑完整桶时长/CPU 超限被杀（流中断 → 无返回）。
                // fileStatuses 持久化保证不重复生成已完成文件。
                let bucketDone = false;
                let guard = 0;
                let noProgress = 0;
                const doneCount = () => genTask.files.filter(f => f.status === "done").length;
                while (!bucketDone) {
                    if (guard++ > 80) { // 安全阀，防意外死循环
                        genTask.logs.push(`× 桶 #${bucketIndex} 批次过多，终止生成`);
                        needReplan = true; break;
                    }
                    // 单批重试一次：批小，重试更不易再撞限制
                    const doneBefore = doneCount();
                    let bucketResult: any = null;
                    for (let bAttempt = 0; bAttempt < 2 && !bucketResult; bAttempt++) {
                        try {
                            bucketResult = await streamBucketGeneration(genTask.taskId, bucketIndex);
                        } catch (be: any) {
                            const m = be?.name === "AbortError" ? "超时" : (be?.message || String(be));
                            genTask.logs.push(`× 桶 #${bucketIndex} 批次中断（${m}）${bAttempt === 0 ? "，重试一次..." : ""}`);
                            bucketResult = null;
                        }
                    }
                    if (!bucketResult) {
                        // 流被切断（多因推理审查静默太久被 CF 切）≠ 生成失败：进度已在后端增量落库,
                        // 直接重试【同一桶】（已 done 文件会被 pending 跳过、继续往下做），不做破坏性重新规划。
                        // 只要本批收到过 file_done（有进度）就清零计数；连续多批零进度才退回 replan 兜底。
                        if (doneCount() > doneBefore) {
                            noProgress = 0;
                            genTask.logs.push(`· 桶 #${bucketIndex} 本批流中断但已落地部分文件，重试同一桶继续...`);
                            continue;
                        }
                        if (++noProgress >= 5) {
                            genTask.logs.push(`× 桶 #${bucketIndex} 连续 ${noProgress} 批零进度，退回重新规划`);
                            needReplan = true; break;
                        }
                        genTask.logs.push(`· 桶 #${bucketIndex} 本批无返回且无进度（${noProgress}/5），重试同一桶...`);
                        continue;
                    }
                    noProgress = 0;
                    if (bucketResult.replan) { needReplan = true; break; }
                    // 把本批完成的内容回填到 files
                    for (const c of bucketResult.completed || []) {
                        const f = genTask.files.find(x => x.path === c.path);
                        if (f) { f.content = c.content; f.status = "done"; }
                    }
                    bucketDone = !!bucketResult.bucketDone;
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
            if (replanAttempt >= MAX_REPLAN_ATTEMPTS) {
                genTask.phase = "error";
                genTask.error = e.message || String(e);
                genTask.logs.push("× " + genTask.error);
                return;
            }
            // If error is not from replan, don't retry
            if (!e.message?.includes("重新规划")) {
                genTask.phase = "error";
                genTask.error = e.message || String(e);
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
        if (reuseExisting) {
            setPhase("building", "正在恢复已有构建的状态...");
            genTask.logs.push("↻ 页面恢复：继续等待已有构建，不重复触发 workflow");
        } else {
            setPhase("uploading", "正在上传到 GitHub 并触发构建...");
            const payload: any = { taskId: genTask.taskId };
            // 首次构建带上 IDE 的最新内容 + 元数据（供 KV 任务过期后重建）；
            // 后续 fix 后重建用 KV 里已被 fix 改过的版本
            if (attempt === 0 && initialFiles) {
                payload.files = initialFiles;
                if (meta) payload.meta = meta;
            }
            const buildResult = await post("/api/generate/build", payload);
            // 从 IDE 进来的场景：填上 GenerateProgress 头部要展示的 meta
            if (!genTask.projectName && buildResult.projectName) genTask.projectName = buildResult.projectName;
            if (!genTask.packageName && buildResult.packageName) genTask.packageName = buildResult.packageName;
            if (!genTask.javaVersion && buildResult.javaVersion) genTask.javaVersion = buildResult.javaVersion;
            genTask.logs.push(`构建已触发 (run #${buildResult.runId || "pending"})`);
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

        if (canRepair) {
            try {
                const diagnosis = await streamBuildFix(genTask.taskId, "diagnose");
                if (Number(diagnosis?.knowledgeNeeds) > 0) {
                    genTask.logs.push(`▸ 构建诊断包含 ${diagnosis.knowledgeNeeds} 个公开技术缺口，开始限时查证`);
                    await runLearning("fix", undefined, 20_000);
                }
            } catch (error: any) {
                genTask.logs.push(`! 构建诊断学习准备失败，直接进入修复: ${error?.message || error}`);
            }
        }

        const fixResult = await streamBuildFix(genTask.taskId, canRepair ? "repair" : "inspect");
        if (!canRepair) {
            throw new Error(fixResult?.reason || "构建失败，已用尽自动修复次数");
        }
        const changed = Number(fixResult?.changed ?? fixResult?.fixed ?? 0);
        if (!fixResult || changed === 0) {
            throw new Error(fixResult?.reason || "自动修复未产生可重新验证的文件变更，构建失败");
        }
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
        await new Promise(r => setTimeout(r, delay));

        const result = await get(`/api/generate/status?taskId=${genTask.taskId}`);

        if (result.status === "done") {
            setPhase("done", "● 构建成功，JAR 已就绪！");
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
    try {
        await buildWithRetry(files, meta);
    } catch (e: any) {
        genTask.phase = "error";
        genTask.error = e?.message || String(e);
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

    try {
        genTask.error = "";
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
        });
        if (resp.status === 402) { showSponsorModal.value = true; throw new Error("本月额度已用尽"); }
        if (resp.status === 401) { login(); throw new Error("请先登录后再使用"); }
        if (!resp.ok) throw new Error(await resp.text());
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
                try {
                    const j = JSON.parse(payload);
                    const chunk = j?.choices?.[0]?.delta?.content ?? "";
                    if (chunk) { full += chunk; genTask.streamingContent = full; }
                } catch { /* skip */ }
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
        genTask.streamingPhase = "";
        genTask.streamingContent = "";
        genTask.phase = "error";
        genTask.error = e?.message || String(e);
        genTask.logs.push("× 追加失败：" + genTask.error);
    }
}
