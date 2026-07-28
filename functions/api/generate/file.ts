import { reworkPrompt, summaryExtractPrompt, dispatchGen, computeSlice, inferGeneratorType, skillFileGenContext } from "../../_lib/prompts";
import type { FileSummary, PlanFileItem, MainBlueprint } from "../../_lib/prompts";
import { accumulateCosts, type UsageBreakdown, type UsageCostEntry } from "../../_lib/quota";
import { resolveLLM, type LLMProvider } from "../../_lib/llm";
import { getTask, putTask } from "../../_lib/taskStore";
import { buildApiContractContext, findKnownApiIssues } from "../../_lib/apiContracts";

const MAX_REWORK = 5;
const MAX_DYNAMIC_GEN = 3;
const LLM_TIMEOUT_MS = 150000; // 非流式单次调用上限（无中间块，只能用总时长）
const LLM_IDLE_MS = 120000;    // 流式调用的空闲超时：连续这么久没字节才 abort，长思考只要在流就不误杀

interface Env {
    DEEPSEEK_API_KEY: string;
    TASKS: KVNamespace;
}

interface AICallResult { content: string; model: string; usage?: UsageBreakdown; }

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
        const resp = await fetch(llm.url, {
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

async function callAIStream(
    llm: LLMProvider, system: string, user: string,
    writer: WritableStreamDefaultWriter<Uint8Array>, encoder: TextEncoder,
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

    // 空闲超时:每收到一块数据就续命(arm),只掐真正断死的连接，不误杀慢而活着的长思考。
    const ctrl = new AbortController();
    let idle: any;
    const arm = () => { clearTimeout(idle); idle = setTimeout(() => ctrl.abort(), LLM_IDLE_MS); };
    arm();
    try {
        const resp = await fetch(llm.url, {
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
            arm();
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
                        await writer.write(encoder.encode(`data: ${JSON.stringify({ type: "delta", content: delta })}\n\n`));
                    }
                    if (chunk.usage) usage = chunk.usage;
                } catch { /* skip */ }
            }
        }
        return { content: full, model, usage };
    } finally {
        clearTimeout(idle);
    }
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

type ChargeFn = (r: AICallResult) => Promise<void>;

/** Generate a single file with optional reChecker + rework, return content and summary */
async function generateSingleFile(
    llm: LLMProvider, filePath: string, fileRole: string,
    ctx: { projectName: string; packageName: string; coreType: string; version: string; javaVersion: string },
    summaries: FileSummary[],
    blueprint: MainBlueprint | null,
    writer: WritableStreamDefaultWriter<Uint8Array>, encoder: TextEncoder,
    state: any,
    maxRework: number,
    charge: ChargeFn,
): Promise<{ content: string; apiSummary: any; reworkCount: number; failed: boolean }> {
    await writer.write(sseEvent(encoder, { type: "phase", phase: "generating", file: filePath }));
    await writer.write(sseEvent(encoder, { type: "log", msg: `▸ 正在生成 ${filePath}` }));
    state.logs.push(`▸ 正在生成 ${filePath}`);

    // 动态文件按类名后缀启发式推断 generatorType
    const className = (filePath.split("/").pop() ?? "").replace(/\.java$/, "");
    const inferredFile: PlanFileItem = {
        path: filePath,
        role: fileRole,
        order: 0,
        generatorType: inferGeneratorType(className, filePath),
    };
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
    const dispatched = dispatchGen(inferredFile, ctx, summaries, computeSlice(inferredFile, blueprint), skillCtx, apiContractCtx);

    const gen = dispatched.gen;
    const initialGen = await callAIStream(llm, gen.system, gen.user, writer, encoder);
    await charge(initialGen);
    let content = stripFences(initialGen.content);
    let reworkCount = 0;
    let passed = false;

    for (let i = 0; i < maxRework; i++) {
        await writer.write(sseEvent(encoder, { type: "phase", phase: "reviewing", file: filePath }));
        await writer.write(sseEvent(encoder, { type: "log", msg: `▸ 审查 ${filePath}...` }));
        state.logs.push(`▸ 审查 ${filePath}...`);

        let review: any;
        const knownApiIssues = findKnownApiIssues(apiContractInput, content);
        if (knownApiIssues.length) {
            review = { is_ok: false, reason: knownApiIssues.join("；"), missing_classes: [] };
        } else {
            const check = dispatched.checker(filePath, content);
            const reviewRes = await callAI(llm, check.system, check.user, true, true);
            await charge(reviewRes);
            try { review = JSON.parse(reviewRes.content); } catch { passed = true; break; }
        }

        if (review.is_ok) {
            await writer.write(sseEvent(encoder, { type: "log", msg: `● ${filePath} 审查通过` }));
            state.logs.push(`● ${filePath} 审查通过`);
            passed = true;
            break;
        }

        reworkCount++;
        const msg = `↻ ${filePath} 需修正 (${reworkCount}/${maxRework}): ${review.reason}`;
        await writer.write(sseEvent(encoder, { type: "log", msg }));
        state.logs.push(msg);

        await writer.write(sseEvent(encoder, { type: "phase", phase: "reworking", file: filePath }));
        const rw = reworkPrompt(filePath, fileRole, content, review.reason, ctx, summaries, apiContractCtx);
        const rwRes = await callAIStream(llm, rw.system, rw.user, writer, encoder, true);
        await charge(rwRes);
        content = stripFences(rwRes.content);
    }

    // Extract summary
    await writer.write(sseEvent(encoder, { type: "phase", phase: "summarizing", file: filePath }));
    let apiSummary: any = null;
    try {
        await writer.write(sseEvent(encoder, { type: "log", msg: `▸ 提取 ${filePath} 的 API 摘要...` }));
        state.logs.push(`▸ 提取 ${filePath} 的 API 摘要...`);
        const ext = summaryExtractPrompt(filePath, content);
        const sumRes = await callAI(llm, ext.system, ext.user, true);
        await charge(sumRes);
        apiSummary = JSON.parse(sumRes.content);
    } catch {
        apiSummary = { description: content.split("\n").slice(0, 3).join(" ").slice(0, 120) };
    }

    return { content, apiSummary, reworkCount, failed: !passed };
}

export const onRequestPost: PagesFunction<Env> = async (context) => {
    const { taskId } = await context.request.json() as any;
    const llm = await resolveLLM(context);

    const raw = await getTask(context.env, taskId);
    if (!raw) return new Response("Task not found", { status: 404 });
    const state = JSON.parse(raw);

    if (state.quotaExhausted) {
        return new Response(JSON.stringify({ error: "本月额度已用尽", code: "QUOTA_EXHAUSTED" }), {
            status: 402, headers: { "Content-Type": "application/json" },
        });
    }

    if (state.currentFileIndex >= state.plan.length) {
        return new Response(JSON.stringify({ done: true, fileIndex: state.currentFileIndex }), {
            headers: { "Content-Type": "application/json" },
        });
    }

    const uid: string | undefined = (context.data as any)?.uid;
    const pendingUsage: UsageCostEntry[] = [];
    let chargeFlushed = false;
    const charge: ChargeFn = async (r) => {
        if (llm.byok || !uid || !r.usage) return; // BYOK 自带 key：跳过计费
        pendingUsage.push({ model: r.model, usage: r.usage });
    };
    const flushCharge = async () => {
        if (chargeFlushed || llm.byok || !uid || pendingUsage.length === 0) return;
        chargeFlushed = true;
        const cost = await accumulateCosts(context.env, uid, taskId, pendingUsage.splice(0));
        state.totalCost = cost.total;
        state.consumedQuota = cost.consumed;
        if (cost.outOfQuota) state.quotaExhausted = true;
    };

    const target = state.plan[state.currentFileIndex] as PlanFileItem;
    const summaries = extractSummaries(state.generatedFiles);
    const ctx = {
        projectName: state.projectName,
        packageName: state.packageName,
        coreType: state.coreType,
        version: state.version,
        javaVersion: state.javaVersion,
    };
    const blueprint = (state.mainBlueprint ?? null) as MainBlueprint | null;
    const slice = computeSlice(target, blueprint);
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
    const dispatched = dispatchGen(target, ctx, summaries, slice, skillCtx, apiContractCtx);

    const { readable, writable } = new TransformStream<Uint8Array>();
    const encoder = new TextEncoder();
    const writer = writable.getWriter();

    const process = (async () => {
        // 心跳:推理/审查首 token 前那段静默期每 12s 写一个,避免被 CF 因长静默切断连接。
        const heartbeat = setInterval(() => {
            writer.write(sseEvent(encoder, { type: "heartbeat", t: Date.now() })).catch(() => { });
        }, 12000);
        try {
            // Phase: generating main file
            await writer.write(sseEvent(encoder, { type: "phase", phase: "generating", file: target.path }));
            await writer.write(sseEvent(encoder, { type: "log", msg: `正在生成 ${target.path} (${state.currentFileIndex + 1}/${state.plan.length})` }));
            state.logs.push(`正在生成 ${target.path} (${state.currentFileIndex + 1}/${state.plan.length})`);

            const gen = dispatched.gen;
            const initialRes = await callAIStream(llm, gen.system, gen.user, writer, encoder);
            await charge(initialRes);
            let content = stripFences(initialRes.content);
            let reworkCount = 0;
            let dynamicGenDone = false;
            let passed = false;

            // reChecker loop with dynamic file generation support
            while (reworkCount < MAX_REWORK) {
                await writer.write(sseEvent(encoder, { type: "phase", phase: "reviewing", file: target.path }));
                await writer.write(sseEvent(encoder, { type: "log", msg: `▸ 审查 ${target.path}...` }));
                state.logs.push(`▸ 审查 ${target.path}...`);

                let review: any;
                const knownApiIssues = findKnownApiIssues(apiContractInput, content);
                if (knownApiIssues.length) {
                    review = { is_ok: false, reason: knownApiIssues.join("；"), missing_classes: [] };
                } else {
                    const check = dispatched.checker(target.path, content);
                    const reviewRes = await callAI(llm, check.system, check.user, true, true);
                    await charge(reviewRes);
                    try { review = JSON.parse(reviewRes.content); } catch { passed = true; break; }
                }

                if (review.is_ok) {
                    await writer.write(sseEvent(encoder, { type: "log", msg: `● ${target.path} 审查通过` }));
                    state.logs.push(`● ${target.path} 审查通过`);
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
                        await writer.write(sseEvent(encoder, { type: "log", msg: `▸ 发现 ${toGenerate.length} 个缺失类，动态生成: ${toGenerate.join(", ")}` }));
                        state.logs.push(`▸ 发现 ${toGenerate.length} 个缺失类，动态生成: ${toGenerate.join(", ")}`);

                        for (const className of toGenerate) {
                            const newPath = `src/main/java/${ctx.packageName.replace(/\./g, "/")}/${className}.java`;
                            const newRole = `${className} — 被 ${target.path.split("/").pop()} 引用`;

                            const result = await generateSingleFile(
                                llm, newPath, newRole, ctx, summaries, blueprint,
                                writer, encoder, state, 1, charge,
                            );

                            state.generatedFiles.push({ path: newPath, content: result.content, apiSummary: result.apiSummary });
                            summaries.push({ path: newPath, ...result.apiSummary });

                            await writer.write(sseEvent(encoder, {
                                type: "new_file", path: newPath, role: newRole, content: result.content,
                            }));
                            const msg = `● ${className} 动态生成完成`;
                            await writer.write(sseEvent(encoder, { type: "log", msg }));
                            state.logs.push(msg);
                        }

                        // Re-check the original file with updated summaries (don't count as rework)
                        continue;
                    }
                }

                // Normal rework
                reworkCount++;
                const reworkMsg = `↻ ${target.path} 需修正 (${reworkCount}/${MAX_REWORK}): ${review.reason}`;
                await writer.write(sseEvent(encoder, { type: "log", msg: reworkMsg }));
                state.logs.push(reworkMsg);

                await writer.write(sseEvent(encoder, { type: "phase", phase: "reworking", file: target.path }));
                const rw = reworkPrompt(target.path, target.role, content, review.reason, ctx, summaries, apiContractCtx);
                const rwRes = await callAIStream(llm, rw.system, rw.user, writer, encoder, true);
                await charge(rwRes);
                content = stripFences(rwRes.content);
            }

            // rework 耗尽仍未通过：reChecker 是 LLM 审查、会误判，不再触发 replan
            // （否则重新规划又会撞同样的审查规则，导致整个任务白白失败）。
            // 接受当前最后一版，记 warn 继续；真正的对错交给后续编译 + 编译错误修复兜底。
            if (!passed && reworkCount >= MAX_REWORK) {
                const warnMsg = `! ${target.path} 经 ${MAX_REWORK} 次修正仍未通过审查，接受当前版本，交由编译阶段校验`;
                await writer.write(sseEvent(encoder, { type: "log", msg: warnMsg }));
                state.logs.push(warnMsg);
            }

            // Summary extraction for the original file
            await writer.write(sseEvent(encoder, { type: "phase", phase: "summarizing", file: target.path }));
            let apiSummary: any = null;
            try {
                await writer.write(sseEvent(encoder, { type: "log", msg: `▸ 提取 ${target.path} 的 API 摘要...` }));
                state.logs.push(`▸ 提取 ${target.path} 的 API 摘要...`);
                const ext = summaryExtractPrompt(target.path, content);
                const sumRes = await callAI(llm, ext.system, ext.user, true);
                await charge(sumRes);
                apiSummary = JSON.parse(sumRes.content);
            } catch {
                apiSummary = { description: content.split("\n").slice(0, 3).join(" ").slice(0, 120) };
            }

            state.generatedFiles.push({ path: target.path, content, apiSummary });
            state.currentFileIndex++;
            const doneMsg = `● ${target.path} 已完成${reworkCount > 0 ? ` (修正${reworkCount}次)` : ""}`;
            state.logs.push(doneMsg);
            await writer.write(sseEvent(encoder, { type: "log", msg: doneMsg }));

            await flushCharge();
            await putTask(context.env, taskId, JSON.stringify(state));

            await writer.write(sseEvent(encoder, {
                type: "result", done: false,
                fileIndex: state.currentFileIndex - 1,
                path: target.path, content,
                remaining: state.plan.length - state.currentFileIndex,
                reworkCount,
            }));

            await writer.write(encoder.encode("data: [DONE]\n\n"));
        } catch (e: any) {
            await writer.write(sseEvent(encoder, { type: "log", msg: `× 错误: ${e.message}` }));
            await writer.write(encoder.encode("data: [DONE]\n\n"));
        } finally {
            clearInterval(heartbeat);
            try { await flushCharge(); } catch { /* 计费失败不覆盖文件生成结果 */ }
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
