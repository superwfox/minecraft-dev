import { reworkPrompt, summaryExtractPrompt, dispatchGen, computeSlice, inferGeneratorType } from "../../_lib/prompts";
import type { FileSummary, PlanFileItem, MainBlueprint } from "../../_lib/prompts";

const DEEPSEEK_URL = "https://api.deepseek.com/v1/chat/completions";
const MAX_REWORK = 5;
const MAX_DYNAMIC_GEN = 3;
const DEFAULT_CONCURRENCY = 2;

interface Env {
    DEEPSEEK_API_KEY: string;
    GEN_CONCURRENCY?: string;
    TASKS: KVNamespace;
}

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

async function callAI(key: string, system: string, user: string, jsonMode = false, usePro = false) {
    const body: any = {
        model: usePro ? "deepseek-v4-pro" : "deepseek-v4-flash",
        messages: [{ role: "system", content: system }, { role: "user", content: user }],
    };
    if (usePro) {
        body.reasoning_effort = "high";
        body.thinking = { type: "enabled" };
    }
    if (jsonMode) body.response_format = { type: "json_object" };

    const resp = await fetchWithBackoff(DEEPSEEK_URL, {
        method: "POST",
        headers: { "Content-Type": "application/json", Authorization: `Bearer ${key}` },
        body: JSON.stringify(body),
    });
    if (!resp.ok) throw new Error(await resp.text());
    const data = await resp.json() as any;
    return data.choices?.[0]?.message?.content ?? "";
}

/**
 * 流式调用 AI 生成。所有 SSE 事件都打上 path 标签，便于前端按文件路由。
 */
async function callAIStream(
    key: string, system: string, user: string,
    writer: WritableStreamDefaultWriter<Uint8Array>, encoder: TextEncoder,
    pathTag: string,
    usePro = false,
) {
    const body: any = {
        model: usePro ? "deepseek-v4-pro" : "deepseek-v4-flash",
        stream: true,
        messages: [{ role: "system", content: system }, { role: "user", content: user }],
    };
    if (usePro) {
        body.reasoning_effort = "high";
        body.thinking = { type: "enabled" };
    }

    const resp = await fetchWithBackoff(DEEPSEEK_URL, {
        method: "POST",
        headers: { "Content-Type": "application/json", Authorization: `Bearer ${key}` },
        body: JSON.stringify(body),
    });
    if (!resp.ok) throw new Error(await resp.text());

    const reader = resp.body!.getReader();
    const decoder = new TextDecoder();
    let full = "";
    let buffer = "";

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
            } catch { /* skip */ }
        }
    }
    return full;
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
    key: string,
    target: PlanFileItem,
    ctx: { projectName: string; packageName: string; coreType: string; version: string; javaVersion: string },
    summaries: FileSummary[],
    blueprint: MainBlueprint | null,
    writer: WritableStreamDefaultWriter<Uint8Array>, encoder: TextEncoder,
    state: any,
): Promise<FileGenOutput> {
    const filePath = target.path;
    const newFiles: FileGenOutput["newFiles"] = [];

    await writer.write(sseEvent(encoder, { type: "phase", path: filePath, phase: "generating" }));
    await writer.write(sseEvent(encoder, { type: "log", path: filePath, msg: `▸ 正在生成 ${filePath}` }));
    state.logs.push(`▸ 正在生成 ${filePath}`);

    const slice = computeSlice(target, blueprint);
    const dispatched = dispatchGen(target, ctx, summaries, slice);
    let content = stripFences(await callAIStream(key, dispatched.gen.system, dispatched.gen.user, writer, encoder, filePath));

    let reworkCount = 0;
    let dynamicGenDone = false;
    let passed = false;
    let lastReason = "";

    while (reworkCount < MAX_REWORK) {
        await writer.write(sseEvent(encoder, { type: "phase", path: filePath, phase: "reviewing" }));
        await writer.write(sseEvent(encoder, { type: "log", path: filePath, msg: `▸ 审查 ${filePath}...` }));
        state.logs.push(`▸ 审查 ${filePath}...`);

        const check = dispatched.checker(filePath, content);
        const reviewRaw = await callAI(key, check.system, check.user, true, true);
        let review: any;
        try { review = JSON.parse(reviewRaw); } catch { passed = true; break; }

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
                    const subDispatched = dispatchGen(inferredFile, ctx, summaries, computeSlice(inferredFile, blueprint));
                    await writer.write(sseEvent(encoder, { type: "phase", path: newPath, phase: "generating" }));
                    const subContent = stripFences(await callAIStream(key, subDispatched.gen.system, subDispatched.gen.user, writer, encoder, newPath));

                    // Extract summary for the dynamically generated file
                    let subSummary: any = null;
                    try {
                        const ext = summaryExtractPrompt(newPath, subContent);
                        subSummary = JSON.parse(await callAI(key, ext.system, ext.user, true));
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
        content = stripFences(await callAIStream(key, rw.system, rw.user, writer, encoder, filePath, true));
    }

    if (!passed && reworkCount >= MAX_REWORK) {
        const failMsg = `× ${filePath} 经过 ${MAX_REWORK} 次修正仍未通过审查，需要重新规划`;
        await writer.write(sseEvent(encoder, { type: "log", path: filePath, msg: failMsg }));
        state.logs.push(failMsg);
        return { path: filePath, content, apiSummary: null, reworkCount, failed: true, replan: true, reason: failMsg, newFiles };
    }

    // Summary extraction
    await writer.write(sseEvent(encoder, { type: "phase", path: filePath, phase: "summarizing" }));
    let apiSummary: any = null;
    try {
        await writer.write(sseEvent(encoder, { type: "log", path: filePath, msg: `▸ 提取 ${filePath} 的 API 摘要...` }));
        state.logs.push(`▸ 提取 ${filePath} 的 API 摘要...`);
        const ext = summaryExtractPrompt(filePath, content);
        apiSummary = JSON.parse(await callAI(key, ext.system, ext.user, true));
    } catch {
        apiSummary = { description: content.split("\n").slice(0, 3).join(" ").slice(0, 120) };
    }

    const doneMsg = `● ${filePath} 已完成${reworkCount > 0 ? ` (修正${reworkCount}次)` : ""}`;
    state.logs.push(doneMsg);
    await writer.write(sseEvent(encoder, { type: "log", path: filePath, msg: doneMsg }));
    await writer.write(sseEvent(encoder, { type: "file_done", path: filePath, content }));

    return { path: filePath, content, apiSummary, reworkCount, failed: false, newFiles };
}

export const onRequestPost: PagesFunction<Env> = async (context) => {
    const { taskId, bucketIndex } = await context.request.json() as any;
    const key = context.env.DEEPSEEK_API_KEY;
    const concurrency = Math.max(1, parseInt(context.env.GEN_CONCURRENCY || "") || DEFAULT_CONCURRENCY);

    const raw = await context.env.TASKS.get(taskId);
    if (!raw) return new Response("Task not found", { status: 404 });
    const state = JSON.parse(raw);

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

            // 跳过已完成的（容许重试）
            const targets = bucket.filter(f => state.fileStatuses?.[f.path] !== "done");
            // 共享上下文：本次桶内不互相依赖，但快照已生成的全局摘要供 dispatchGen 注入
            const baseSummaries = extractSummaries(state.generatedFiles);

            // 各文件结果按完成顺序入数组
            const results: FileGenOutput[] = [];
            const sem = makeSemaphore(concurrency);
            let replanTriggered: FileGenOutput | null = null;

            await Promise.all(targets.map(async (target) => {
                await sem.acquire();
                try {
                    if (replanTriggered) return; // 早停
                    state.fileStatuses ??= {};
                    state.fileStatuses[target.path] = "generating";
                    // 每个并发文件用独立的 summaries 副本，避免动态缺失类竞态污染
                    const localSummaries = baseSummaries.slice();
                    const r = await generateAndCheckFile(
                        key, target, ctx, localSummaries, blueprint, writer, encoder, state,
                    );
                    if (r.replan) {
                        replanTriggered = r;
                        state.fileStatuses[target.path] = "error";
                    } else {
                        state.fileStatuses[target.path] = "done";
                    }
                    results.push(r);
                } finally {
                    sem.release();
                }
            }));

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
            state.currentBucket = bucketIndex + 1;
            state.currentFileIndex = state.generatedFiles.length;
            await context.env.TASKS.put(taskId, JSON.stringify(state), { expirationTtl: 3600 });

            await writer.write(sseEvent(encoder, {
                type: "result",
                bucketIndex,
                done: state.currentBucket >= buckets.length,
                completed: results.map(r => ({ path: r.path, content: r.content, reworkCount: r.reworkCount })),
                newFiles: results.flatMap(r => r.newFiles.map(nf => ({ path: nf.path, role: nf.role, content: nf.content }))),
                bucketsRemaining: Math.max(0, buckets.length - state.currentBucket),
            }));
            await writer.write(encoder.encode("data: [DONE]\n\n"));
        } catch (e: any) {
            await writer.write(sseEvent(encoder, { type: "log", msg: `× 错误: ${e.message}` }));
            await writer.write(encoder.encode("data: [DONE]\n\n"));
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
