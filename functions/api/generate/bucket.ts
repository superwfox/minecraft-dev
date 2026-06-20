import { reworkPrompt, summaryExtractPrompt, dispatchGen, computeSlice, inferGeneratorType, skillFileGenContext } from "../../_lib/prompts";
import type { FileSummary, PlanFileItem, MainBlueprint } from "../../_lib/prompts";
import { accumulateCost, type UsageBreakdown } from "../../_lib/quota";
import { resolveLLM, type LLMProvider } from "../../_lib/llm";

const MAX_REWORK = 3;
const MAX_DYNAMIC_GEN = 3;
const DEFAULT_CONCURRENCY = 2;
const LLM_TIMEOUT_MS = 150000; // 单次 LLM 调用上限，超时 abort，避免某次 hang 拖垮整桶导致前端「无返回」

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

async function callAI(llm: LLMProvider, system: string, user: string, jsonMode = false, usePro = false): Promise<AICallResult> {
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
    try {
        const resp = await fetchWithBackoff(llm.url, {
            method: "POST",
            headers: { "Content-Type": "application/json", Authorization: `Bearer ${llm.apiKey}` },
            body: JSON.stringify(body),
            signal: ctrl.signal,
        });
        if (!resp.ok) throw new Error(await resp.text());
        const data = await resp.json() as any;
        return {
            content: data.choices?.[0]?.message?.content ?? "",
            model,
            usage: data.usage,
        };
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
    const timer = setTimeout(() => ctrl.abort(), LLM_TIMEOUT_MS);
    try {
        const resp = await fetchWithBackoff(llm.url, {
            method: "POST",
            headers: { "Content-Type": "application/json", Authorization: `Bearer ${llm.apiKey}` },
            body: JSON.stringify(body),
            signal: ctrl.signal,
        });
        if (!resp.ok) throw new Error(await resp.text());

        const reader = resp.body!.getReader();
        const decoder = new TextDecoder();
        let full = "";
        let buffer = "";
        let usage: UsageBreakdown | undefined;

        while (true) {
            const { done, value } = await reader.read();
            if (done) break;
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
        return { content: full, model, usage };
    } finally {
        clearTimeout(timer);
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
): Promise<FileGenOutput> {
    const filePath = target.path;
    const newFiles: FileGenOutput["newFiles"] = [];

    await writer.write(sseEvent(encoder, { type: "phase", path: filePath, phase: "generating" }));
    await writer.write(sseEvent(encoder, { type: "log", path: filePath, msg: `▸ 正在生成 ${filePath}` }));
    state.logs.push(`▸ 正在生成 ${filePath}`);

    const slice = computeSlice(target, blueprint);
    const skillCtx = state.skills?.length ? skillFileGenContext(state.skills) : "";
    const dispatched = dispatchGen(target, ctx, summaries, slice, skillCtx);
    const initialRes = await callAIStream(llm, dispatched.gen.system, dispatched.gen.user, writer, encoder, filePath);
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

        const check = dispatched.checker(filePath, content);
        const reviewRes = await callAI(llm, check.system, check.user, true, true);
        await charge(reviewRes);
        let review: any;
        try { review = JSON.parse(reviewRes.content); } catch { passed = true; break; }

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
                    const subRes = await callAIStream(llm, subDispatched.gen.system, subDispatched.gen.user, writer, encoder, newPath);
                    await charge(subRes);
                    const subContent = stripFences(subRes.content);

                    // Extract summary for the dynamically generated file
                    let subSummary: any = null;
                    try {
                        const ext = summaryExtractPrompt(newPath, subContent);
                        const sumRes = await callAI(llm, ext.system, ext.user, true);
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
        const rw = reworkPrompt(filePath, target.role, content, lastReason, ctx, summaries);
        const rwRes = await callAIStream(llm, rw.system, rw.user, writer, encoder, filePath, true);
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
    let apiSummary: any = null;
    try {
        await writer.write(sseEvent(encoder, { type: "log", path: filePath, msg: `▸ 提取 ${filePath} 的 API 摘要...` }));
        state.logs.push(`▸ 提取 ${filePath} 的 API 摘要...`);
        const ext = summaryExtractPrompt(filePath, content);
        const sumRes = await callAI(llm, ext.system, ext.user, true);
        await charge(sumRes);
        apiSummary = JSON.parse(sumRes.content);
    } catch {
        apiSummary = { description: content.split("\n").slice(0, 3).join(" ").slice(0, 120) };
    }

    const doneMsg = `● ${filePath} 已完成${reworkCount > 0 ? ` (修正${reworkCount}次)` : ""}`;
    state.logs.push(doneMsg);
    await writer.write(sseEvent(encoder, { type: "log", path: filePath, msg: doneMsg }));
    await writer.write(sseEvent(encoder, { type: "file_done", path: filePath, content }));

    return { path: filePath, content, apiSummary, reworkCount, failed: !passed, newFiles };
}

export const onRequestPost: PagesFunction<Env> = async (context) => {
    const { taskId, bucketIndex } = await context.request.json() as any;
    const llm = await resolveLLM(context);
    let concurrency = Math.max(1, parseInt(context.env.GEN_CONCURRENCY || "") || DEFAULT_CONCURRENCY);

    const raw = await context.env.TASKS.get(taskId);
    if (!raw) return new Response("Task not found", { status: 404 });
    const state = JSON.parse(raw);
    // 挂了 skill 的任务：prompt 更大、文件更多，降并发到 1，避免大 prompt × 并发撞 CF Worker 限制
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

    const process = (async () => {
        try {
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
            await Promise.all(targets.map(async (target) => {
                await sem.acquire();
                try {
                    if (replanTriggered) return; // 早停
                    state.fileStatuses ??= {};
                    state.fileStatuses[target.path] = "generating";
                    const localSummaries = baseSummaries.slice();
                    try {
                        const r = await generateAndCheckFile(
                            llm, target, ctx, localSummaries, blueprint, writer, encoder, state, charge,
                        );
                        if (r.replan) {
                            replanTriggered = r;
                            state.fileStatuses[target.path] = "error";
                        } else {
                            state.fileStatuses[target.path] = "done";
                        }
                        results.push(r);
                    } catch (taskErr: any) {
                        const reason = taskErr?.message ? String(taskErr.message) : String(taskErr);
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

            // 桶完成：把所有结果与新生成的动态文件追加到 state.generatedFiles
            for (const r of results) {
                state.generatedFiles.push({ path: r.path, content: r.content, apiSummary: r.apiSummary });
                for (const nf of r.newFiles) {
                    if (!state.generatedFiles.find((g: any) => g.path === nf.path)) {
                        state.generatedFiles.push(nf);
                        state.fileStatuses[nf.path] = "done";
                    }
                }
            }
            // 本批之外是否还有未完成文件：有则桶未完成（前端会再调同一桶），无则推进到下一桶
            const bucketDone = pending.length <= targets.length;
            if (bucketDone) state.currentBucket = bucketIndex + 1;
            state.currentFileIndex = state.generatedFiles.length;
            await context.env.TASKS.put(taskId, JSON.stringify(state), { expirationTtl: 3600 });

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
