import { reworkPrompt, summaryExtractPrompt, dispatchGen, computeSlice, inferGeneratorType, skillFileGenContext } from "../../_lib/prompts";
import type { FileSummary, PlanFileItem, MainBlueprint } from "../../_lib/prompts";
import { accumulateCost, type UsageBreakdown } from "../../_lib/quota";
import { resolveLLM, type LLMProvider } from "../../_lib/llm";

const MAX_REWORK = 3;
const MAX_DYNAMIC_GEN = 3;
const SUPER_CONCURRENCY = 2; // 「超级并发」开关开启时的桶内并发数（默认串行=1）
const LLM_TIMEOUT_MS = 150000; // 非流式单次调用上限（无中间块，只能用总时长）
const LLM_IDLE_MS = 120000;    // 流式调用的「空闲超时」：连续这么久没字节才 abort，长思考只要还在流就不误杀

// 详细调试:把每一步(含 LLM 的 HTTP 状态/首字节耗时/错误堆栈/心跳是否真在跳)通过 SSE debug 事件发出,
// 前端累积并可下载。用于定位「桶零进度、无返回」到底死在哪一步。
type Dbg = (msg: string, extra?: any) => void;
const noopDbg: Dbg = () => { /* no-op */ };

interface Env {
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

/** A simple async semaphore for bounded concurrency */
function makeSemaphore(cap: number) {
    let active = 0;
    const waiters: (() => void)[] = [];
    const acquire = async () => {
        if (active < cap) { active++; return; }
        await new Promise<void>(res => waiters.push(res));
        active++;
    };
    const release = () => {
        active--;
        const next = waiters.shift();
        if (next) next();
    };
    return { acquire, release };
}

/** Sleep helper for backoff */
const sleep = (ms: number) => new Promise(r => setTimeout(r, ms));

/** Single fetch wrapper with 429 backoff */
async function fetchWithBackoff(url: string, init: RequestInit, maxRetries = 3): Promise<Response> {
    let attempt = 0;
    while (true) {
        const resp = await fetch(url, init);
        if (resp.status !== 429 || attempt >= maxRetries) return resp;
        const retryAfter = resp.headers.get("Retry-After");
        const wait = retryAfter ? parseInt(retryAfter) * 1000 : 1000 * Math.pow(2, attempt);
        await sleep(wait);
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
        });
        dbg("callAI:http", { model, status: resp.status, ms: Date.now() - t0 });
        if (!resp.ok) {
            const txt = await resp.text();
            dbg("callAI:http-err", { status: resp.status, body: txt.slice(0, 400) });
            throw new Error(`HTTP ${resp.status}: ${txt.slice(0, 300)}`);
        }
        const data = await resp.json() as any;
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
    const model = llm.modelFor(usePro ? "pro" : "flash");
    const body: any = {
        model,
        stream: true,
        stream_options: { include_usage: true },
        messages: [{ role: "system", content: system }, { role: "user", content: user }],
    };
    if (usePro) {
        body.reasoning_effort = "high";
        body.thinking = { type: "enabled" };
    }

    const ctrl = new AbortController();
    // 空闲超时:每收到一块数据就续命(arm),只掐真正断死的连接；避免长思考被固定总时长误杀。
    let idle: any;
    const arm = () => { clearTimeout(idle); idle = setTimeout(() => ctrl.abort(), LLM_IDLE_MS); };
    arm();
    const t0 = Date.now();
    let firstByteMs = -1, chunks = 0;
    dbg("stream:req", { path: pathTag, model, usePro, sysLen: system.length, userLen: user.length });
    try {
        const resp = await fetchWithBackoff(llm.url, {
            method: "POST",
            headers: { "Content-Type": "application/json", Authorization: `Bearer ${llm.apiKey}` },
            body: JSON.stringify(body),
            signal: ctrl.signal,
        });
        dbg("stream:http", { path: pathTag, status: resp.status, ms: Date.now() - t0 });
        if (!resp.ok) {
            const txt = await resp.text();
            dbg("stream:http-err", { path: pathTag, status: resp.status, body: txt.slice(0, 400) });
            throw new Error(`HTTP ${resp.status}: ${txt.slice(0, 300)}`);
        }

        const reader = resp.body!.getReader();
        const decoder = new TextDecoder();
        let full = "";
        let buffer = "";
        let usage: UsageBreakdown | undefined;

        while (true) {
            const { done, value } = await reader.read();
            if (done) break;
            arm(); // 收到数据就重置空闲计时器
            chunks++;
            if (firstByteMs < 0) { firstByteMs = Date.now() - t0; dbg("stream:first-byte", { path: pathTag, ms: firstByteMs }); }
            buffer += decoder.decode(value, { stream: true });
            const lines = buffer.split("\n");
            buffer = lines.pop()!;

            for (const line of lines) {
                const trimmed = line.trim();
                if (!trimmed.startsWith("data:")) continue;
                const payload = trimmed.slice(5).trim();
                if (payload === "[DONE]") continue;
                try {
                    const chunk = JSON.parse(payload);
                    const delta = chunk.choices?.[0]?.delta?.content;
                    if (delta) {
                        full += delta;
                        await writer.write(sseEvent(encoder, { type: "delta", path: pathTag, content: delta }));
                    }
                    if (chunk.usage) usage = chunk.usage;
                } catch { /* skip */ }
            }
        }
        dbg("stream:done", { path: pathTag, ms: Date.now() - t0, firstByteMs, chunks, len: full.length });
        return { content: full, model, usage };
    } catch (e: any) {
        dbg("stream:throw", { path: pathTag, ms: Date.now() - t0, firstByteMs, chunks, err: e?.name, msg: String(e?.message || e).slice(0, 400) });
        throw e;
    } finally {
        clearTimeout(idle);
    }
}

interface FileGenOutput {
    path: string;
    content: string;
    apiSummary: any;
    reworkCount: number;
    failed: boolean;
    replan?: boolean;
    reason?: string;
    newFiles: { path: string; role: string; content: string; apiSummary: any }[];
}

/** 生成单个文件（含 reChecker + rework + 动态缺失类补全） */
async function generateAndCheckFile(
    llm: LLMProvider,
    target: PlanFileItem,
    ctx: { projectName: string; packageName: string; coreType: string; version: string; javaVersion: string },
    summaries: FileSummary[],
    blueprint: MainBlueprint | null,
    writer: WritableStreamDefaultWriter<Uint8Array>, encoder: TextEncoder,
    state: any,
    charge: ChargeFn,
    dbg: Dbg = noopDbg,
): Promise<FileGenOutput> {
    const filePath = target.path;
    const newFiles: FileGenOutput["newFiles"] = [];

    await writer.write(sseEvent(encoder, { type: "phase", path: filePath, phase: "generating" }));
    await writer.write(sseEvent(encoder, { type: "log", path: filePath, msg: `▸ 正在生成 ${filePath}` }));
    state.logs.push(`▸ 正在生成 ${filePath}`);

    dbg("file:dispatch", { path: filePath, gtype: (target as any).generatorType });
    const slice = computeSlice(target, blueprint);
    const skillCtx = state.skills?.length ? skillFileGenContext(state.skills) : "";
    const dispatched = dispatchGen(target, ctx, summaries, slice, skillCtx);
    dbg("file:gen-begin", { path: filePath });
    const initialRes = await callAIStream(llm, dispatched.gen.system, dispatched.gen.user, writer, encoder, filePath, false, dbg);
    await charge(initialRes);
    let content = stripFences(initialRes.content);

    let reworkCount = 0;
    let dynamicGenDone = false;
    let passed = false;
    let lastReason = "";

    while (reworkCount < MAX_REWORK) {
        await writer.write(sseEvent(encoder, { type: "phase", path: filePath, phase: "reviewing" }));
        await writer.write(sseEvent(encoder, { type: "log", path: filePath, msg: `▸ 审查 ${filePath}...` }));
        state.logs.push(`▸ 审查 ${filePath}...`);

        dbg("file:review-begin", { path: filePath, round: reworkCount });
        const check = dispatched.checker(filePath, content);
        const reviewRes = await callAI(llm, check.system, check.user, true, true, dbg);
        await charge(reviewRes);
        let review: any;
        try { review = JSON.parse(reviewRes.content); } catch { dbg("file:review-parse-fail", { path: filePath }); passed = true; break; }
        dbg("file:review-done", { path: filePath, is_ok: !!review.is_ok, missing: (review.missing_classes ?? []).length });

        if (review.is_ok) {
            await writer.write(sseEvent(encoder, { type: "log", path: filePath, msg: `● ${filePath} 审查通过` }));
            state.logs.push(`● ${filePath} 审查通过`);
            passed = true;
            break;
        }

        // Dynamic file generation for missing classes (try once)
        const missingClasses: string[] = review.missing_classes ?? [];
        if (missingClasses.length > 0 && !dynamicGenDone) {
            dynamicGenDone = true;
            const alreadyGenerated = new Set(summaries.map(s => s.className).filter(Boolean));
            const toGenerate = missingClasses
                .filter(c => !alreadyGenerated.has(c))
                .slice(0, MAX_DYNAMIC_GEN);

            if (toGenerate.length > 0) {
                await writer.write(sseEvent(encoder, { type: "log", path: filePath, msg: `▸ 发现 ${toGenerate.length} 个缺失类，动态生成: ${toGenerate.join(", ")}` }));
                state.logs.push(`▸ 发现 ${toGenerate.length} 个缺失类，动态生成: ${toGenerate.join(", ")}`);

                for (const className of toGenerate) {
                    const newPath = `src/main/java/${ctx.packageName.replace(/\./g, "/")}/${className}.java`;
                    const newRole = `${className} — 被 ${filePath.split("/").pop()} 引用`;
                    const inferredFile: PlanFileItem = {
                        path: newPath, role: newRole, order: 0,
                        generatorType: inferGeneratorType(className, newPath),
                    };
                    const subDispatched = dispatchGen(inferredFile, ctx, summaries, computeSlice(inferredFile, blueprint), skillCtx);
                    await writer.write(sseEvent(encoder, { type: "phase", path: newPath, phase: "generating" }));
                    const subRes = await callAIStream(llm, subDispatched.gen.system, subDispatched.gen.user, writer, encoder, newPath, false, dbg);
                    await charge(subRes);
                    const subContent = stripFences(subRes.content);

                    // Extract summary for the dynamically generated file
                    let subSummary: any = null;
                    try {
                        const ext = summaryExtractPrompt(newPath, subContent);
                        const sumRes = await callAI(llm, ext.system, ext.user, true, false, dbg);
                        await charge(sumRes);
                        subSummary = JSON.parse(sumRes.content);
                    } catch {
                        subSummary = { description: subContent.split("\n").slice(0, 3).join(" ").slice(0, 120) };
                    }
                    summaries.push({ path: newPath, ...subSummary });
                    newFiles.push({ path: newPath, role: newRole, content: subContent, apiSummary: subSummary });
                    await writer.write(sseEvent(encoder, { type: "new_file", path: newPath, role: newRole, content: subContent }));
                    await writer.write(sseEvent(encoder, { type: "log", path: filePath, msg: `● ${className} 动态生成完成` }));
                }
                continue; // re-check with updated summaries
            }
        }

        // Normal rework
        reworkCount++;
        lastReason = review.reason ?? "";
        const reworkMsg = `↻ ${filePath} 需修正 (${reworkCount}/${MAX_REWORK}): ${lastReason}`;
        await writer.write(sseEvent(encoder, { type: "log", path: filePath, msg: reworkMsg }));
        state.logs.push(reworkMsg);
        await writer.write(sseEvent(encoder, { type: "phase", path: filePath, phase: "reworking" }));
        dbg("file:rework-begin", { path: filePath, round: reworkCount });
        const rw = reworkPrompt(filePath, target.role, content, lastReason, ctx, summaries);
        const rwRes = await callAIStream(llm, rw.system, rw.user, writer, encoder, filePath, true, dbg);
        await charge(rwRes);
        content = stripFences(rwRes.content);
    }

    if (!passed && reworkCount >= MAX_REWORK) {
        // reChecker 是 LLM 审查、会误判（例如把合法的 public static 门面字段当成单例违规）。
        // 耗尽 rework 后【不再触发 replan】——否则重新规划又会产出同样的文件、撞同样的审查规则，
        // 陷入「循环生成→重新规划→再失败」直到整个任务白白失败。
        // 改为接受当前最后一版，记 warn 继续；真正的对错交给后续编译 + 编译错误修复（ground truth）兜底。
        const warnMsg = `! ${filePath} 经 ${MAX_REWORK} 次修正仍未通过审查，接受当前版本，交由编译阶段校验`;
        await writer.write(sseEvent(encoder, { type: "log", path: filePath, msg: warnMsg }));
        state.logs.push(warnMsg);
    }

    // Summary extraction
    await writer.write(sseEvent(encoder, { type: "phase", path: filePath, phase: "summarizing" }));
    dbg("file:summary-begin", { path: filePath });
    let apiSummary: any = null;
    try {
        await writer.write(sseEvent(encoder, { type: "log", path: filePath, msg: `▸ 提取 ${filePath} 的 API 摘要...` }));
        state.logs.push(`▸ 提取 ${filePath} 的 API 摘要...`);
        const ext = summaryExtractPrompt(filePath, content);
        const sumRes = await callAI(llm, ext.system, ext.user, true, false, dbg);
        await charge(sumRes);
        apiSummary = JSON.parse(sumRes.content);
    } catch (e: any) {
        dbg("file:summary-fallback", { path: filePath, msg: String(e?.message || e).slice(0, 200) });
        apiSummary = { description: content.split("\n").slice(0, 3).join(" ").slice(0, 120) };
    }
    dbg("file:return", { path: filePath, failed: !passed, reworkCount });

    const doneMsg = `● ${filePath} 已完成${reworkCount > 0 ? ` (修正${reworkCount}次)` : ""}`;
    state.logs.push(doneMsg);
    await writer.write(sseEvent(encoder, { type: "log", path: filePath, msg: doneMsg }));
    await writer.write(sseEvent(encoder, { type: "file_done", path: filePath, content }));

    return { path: filePath, content, apiSummary, reworkCount, failed: !passed, newFiles };
}

export const onRequestPost: PagesFunction<Env> = async (context) => {
    const { taskId, bucketIndex, superConcurrency } = await context.request.json() as any;
    const llm = await resolveLLM(context);
    // 默认串行（1 文件/请求，最稳）；仅当前端「超级并发」开关开启时才桶内并发（env 可覆盖并发数）。
    // 桶内并发会让单个 CF Worker 请求同时跑多个文件生成 + pro 审查/返工，更快但更易撞
    // 单请求 CPU/时长/子请求上限被强杀 →「零进度 → 重新规划 → 失败」，故默认关闭。
    let concurrency = 1;
    if (superConcurrency) {
        concurrency = Math.max(2, parseInt(context.env.GEN_CONCURRENCY || "") || SUPER_CONCURRENCY);
    }

    const raw = await context.env.TASKS.get(taskId);
    if (!raw) return new Response("Task not found", { status: 404 });
    const state = JSON.parse(raw);
    // 挂了 skill 的任务：prompt 更大、文件更多，强制串行，避免大 prompt × 并发撞 CF Worker 限制
    if (state.skills?.length) concurrency = 1;

    if (state.quotaExhausted) {
        return new Response(JSON.stringify({ error: "本月额度已用尽", code: "QUOTA_EXHAUSTED" }), {
            status: 402, headers: { "Content-Type": "application/json" },
        });
    }

    const uid: string | undefined = (context.data as any)?.uid;
    const charge: ChargeFn = async (r) => {
        if (llm.byok || !uid || !r.usage) return; // BYOK 自带 key：跳过计费
        const cost = await accumulateCost(context.env.TASKS, uid, taskId, r.model, r.usage);
        state.totalCost = cost.total;
        state.consumedQuota = cost.consumed;
        if (cost.outOfQuota) state.quotaExhausted = true;
    };

    const buckets = (state.buckets ?? []) as PlanFileItem[][];
    if (!Array.isArray(buckets) || bucketIndex < 0 || bucketIndex >= buckets.length) {
        return new Response(JSON.stringify({ error: "无效的 bucketIndex", bucketIndex }), {
            status: 400, headers: { "Content-Type": "application/json" },
        });
    }

    const bucket = buckets[bucketIndex];
    const ctx = {
        projectName: state.projectName,
        packageName: state.packageName,
        coreType: state.coreType,
        version: state.version,
        javaVersion: state.javaVersion,
    };
    const blueprint = (state.mainBlueprint ?? null) as MainBlueprint | null;

    const { readable, writable } = new TransformStream<Uint8Array>();
    const encoder = new TextEncoder();
    const writer = writable.getWriter();

    // 详细调试:每一步发一个 debug SSE 事件(前端累积、可下载)。t 为相对本请求起点的毫秒。
    const T0 = Date.now();
    const dbg: Dbg = (msg, extra) => {
        writer.write(sseEvent(encoder, { type: "debug", t: Date.now() - T0, bucket: bucketIndex, msg, ...(extra || {}) })).catch(() => { });
    };

    const process = (async () => {
        // 心跳:reChecker 审查 / 摘要等非流式 LLM 调用期间(推理模型 thinking 阶段不吐 token,
        // 首 token 可达 100s+),SSE 会长时间无字节 → Cloudflare 切断连接 → 前端收不到 result
        // 事件 → 误判「无返回」→ 退回重新规划循环。每 12s 写个 heartbeat 维持流活着(前端忽略此事件)。
        // n=心跳序号:前端据此判断 CF Worker 的 setInterval 是否真的在跳(若无 heartbeat,则定时器未触发)。
        let hbCount = 0;
        const heartbeat = setInterval(() => {
            hbCount++;
            writer.write(sseEvent(encoder, { type: "heartbeat", t: Date.now(), n: hbCount })).catch(() => { });
            dbg("heartbeat", { n: hbCount });
        }, 12000);
        try {
            dbg("process:start", { bucketIndex, concurrency, superOn: !!superConcurrency, skills: state.skills?.length || 0, bucketsTotal: buckets.length });
            await writer.write(sseEvent(encoder, {
                type: "bucket_start", bucketIndex, paths: bucket.map(f => f.path), concurrency,
            }));
            state.logs.push(`▸ 启动桶 #${bucketIndex}（${bucket.length} 文件，并发=${concurrency}）`);
            await writer.write(sseEvent(encoder, { type: "log", msg: `▸ 启动桶 #${bucketIndex}（${bucket.length} 文件，并发=${concurrency}）` }));

            // 本次只处理一批（concurrency 个）文件：避免在一个 CF Worker 请求里跑完整桶，
            // 导致执行时长 / CPU / subrequest 超限被 CF 强杀（SSE 流静默中断 → 前端「无返回」）。
            // state.fileStatuses 已持久化，前端会循环调用同一桶，直到收到 bucketDone:true。
            const pending = bucket.filter(f => state.fileStatuses?.[f.path] !== "done");
            const targets = pending.slice(0, Math.max(1, concurrency));
            // 共享上下文：本次桶内不互相依赖，但快照已生成的全局摘要供 dispatchGen 注入
            const baseSummaries = extractSummaries(state.generatedFiles);

            // 桶已全部完成（无 pending）→ 标记并前进
            if (pending.length === 0) {
                state.currentBucket = Math.max(state.currentBucket ?? 0, bucketIndex + 1);
                await context.env.TASKS.put(taskId, JSON.stringify(state), { expirationTtl: 3600 });
                await writer.write(sseEvent(encoder, {
                    type: "result", bucketIndex, bucketDone: true,
                    done: state.currentBucket >= buckets.length,
                    completed: [], newFiles: [], errors: [],
                    bucketsRemaining: Math.max(0, buckets.length - state.currentBucket),
                }));
                await writer.write(encoder.encode("data: [DONE]\n\n"));
                await writer.close();
                return;
            }

            // 各文件结果按完成顺序入数组
            const results: FileGenOutput[] = [];
            const errors: { path: string; reason: string }[] = [];
            const sem = makeSemaphore(concurrency);
            let replanTriggered: FileGenOutput | null = null;

            // 每个并发任务自己捕获异常，失败也照常写入 errors 数组，避免一个失败拖垮整个桶
            dbg("batch:begin", { pending: pending.length, targets: targets.map(t => t.path) });
            await Promise.all(targets.map(async (target) => {
                await sem.acquire();
                try {
                    if (replanTriggered) return; // 早停
                    state.fileStatuses ??= {};
                    state.fileStatuses[target.path] = "generating";
                    const localSummaries = baseSummaries.slice();
                    dbg("task:begin", { path: target.path });
                    try {
                        const r = await generateAndCheckFile(
                            llm, target, ctx, localSummaries, blueprint, writer, encoder, state, charge, dbg,
                        );
                        dbg("task:ok", { path: target.path, failed: r.failed, reworkCount: r.reworkCount });
                        if (r.replan) {
                            replanTriggered = r;
                            state.fileStatuses[target.path] = "error";
                        } else {
                            state.fileStatuses[target.path] = "done";
                            // 增量持久化:本文件完成即入库 + 落 KV。半路被 CF 杀掉也不丢进度,
                            // 前端重试同一桶时已 done 的文件会被 pending 过滤跳过,继续往下做。
                            state.generatedFiles.push({ path: r.path, content: r.content, apiSummary: r.apiSummary });
                            for (const nf of r.newFiles) {
                                if (!state.generatedFiles.find((g: any) => g.path === nf.path)) {
                                    state.generatedFiles.push(nf);
                                    state.fileStatuses[nf.path] = "done";
                                }
                            }
                            state.currentFileIndex = state.generatedFiles.length;
                            try { await context.env.TASKS.put(taskId, JSON.stringify(state), { expirationTtl: 3600 }); } catch { /* 落盘失败不阻断本批 */ }
                        }
                        results.push(r);
                    } catch (taskErr: any) {
                        const reason = taskErr?.message ? String(taskErr.message) : String(taskErr);
                        dbg("task:throw", { path: target.path, err: taskErr?.name, msg: reason.slice(0, 400), stack: String(taskErr?.stack || "").slice(0, 600) });
                        state.fileStatuses[target.path] = "error";
                        errors.push({ path: target.path, reason });
                        const failMsg = `× ${target.path} 生成异常：${reason}`;
                        state.logs.push(failMsg);
                        try {
                            await writer.write(sseEvent(encoder, { type: "log", path: target.path, msg: failMsg }));
                            await writer.write(sseEvent(encoder, { type: "file_error", path: target.path, reason }));
                        } catch { /* writer 可能已关闭，忽略 */ }
                    }
                } finally {
                    sem.release();
                }
            }));

            // 任意文件出现异常 → 触发重新规划
            if (!replanTriggered && errors.length > 0) {
                replanTriggered = {
                    path: errors[0].path,
                    content: "", apiSummary: null,
                    reworkCount: 0, failed: true, replan: true,
                    reason: `桶 #${bucketIndex} 中 ${errors.length} 个文件生成异常：${errors.map(e => e.path).join(", ")}`,
                    newFiles: [],
                };
            }

            if (replanTriggered) {
                dbg("result:replan", { path: replanTriggered.path, reason: replanTriggered.reason, errors: errors.length });
                state.status = "error";
                state.error = replanTriggered.reason ?? "审查未通过";
                await context.env.TASKS.put(taskId, JSON.stringify(state), { expirationTtl: 3600 });
                await writer.write(sseEvent(encoder, {
                    type: "result", bucketIndex, replan: true,
                    path: replanTriggered.path, reason: replanTriggered.reason,
                }));
                await writer.write(encoder.encode("data: [DONE]\n\n"));
                await writer.close();
                return;
            }

            // 本批文件已在各自完成时增量入库 + 落 KV（见上方 generateAndCheckFile 成功分支）
            // 本批之外是否还有未完成文件：有则桶未完成（前端会再调同一桶），无则推进到下一桶
            const bucketDone = pending.length <= targets.length;
            if (bucketDone) state.currentBucket = bucketIndex + 1;
            state.currentFileIndex = state.generatedFiles.length;
            await context.env.TASKS.put(taskId, JSON.stringify(state), { expirationTtl: 3600 });

            dbg("result:ok", { bucketDone, completed: results.length, generatedTotal: state.generatedFiles.length });
            await writer.write(sseEvent(encoder, {
                type: "result",
                bucketIndex,
                bucketDone,
                done: bucketDone && state.currentBucket >= buckets.length,
                completed: results.map(r => ({ path: r.path, content: r.content, reworkCount: r.reworkCount })),
                newFiles: results.flatMap(r => r.newFiles.map(nf => ({ path: nf.path, role: nf.role, content: nf.content }))),
                bucketsRemaining: Math.max(0, buckets.length - state.currentBucket),
            }));
            await writer.write(encoder.encode("data: [DONE]\n\n"));
        } catch (e: any) {
            const errMsg = e?.message ? String(e.message) : String(e);
            dbg("process:catch", { err: e?.name, msg: errMsg.slice(0, 400), stack: String(e?.stack || "").slice(0, 800) });
            try {
                await writer.write(sseEvent(encoder, { type: "log", msg: `× 桶执行错误: ${errMsg}` }));
                // 关键：始终发出 result 事件，避免前端拿到 null
                await writer.write(sseEvent(encoder, {
                    type: "result", bucketIndex, replan: true,
                    reason: `桶 #${bucketIndex} 执行失败: ${errMsg}`,
                }));
                await writer.write(encoder.encode("data: [DONE]\n\n"));
            } catch { /* writer 可能已关闭 */ }
        } finally {
            dbg("process:finally", { hb: hbCount });
            clearInterval(heartbeat);
            await writer.close();
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
