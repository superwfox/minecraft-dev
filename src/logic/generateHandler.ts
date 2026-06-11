import { genTask, resetGenTask, waitForClarifyAnswers, waitForExtraPrompt } from "./generateState";
import type { GenPhase } from "./generateState";
import { showSponsorModal, login, fetchMe } from "./auth";

const MAX_FIX_ATTEMPTS = 2;
const MAX_REPLAN_ATTEMPTS = 2;

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
            const resp = await fetch(url, {
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

async function get(url: string) {
    const resp = await fetch(url);
    if (!resp.ok) throw new Error(await resp.text());
    return resp.json() as any;
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
async function readSSE(resp: Response): Promise<any> {
    const reader = resp.body!.getReader();
    const decoder = new TextDecoder();
    let buffer = "";
    let result: any = null;
    let streamedTodoCount = 0;

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
                }
            } catch { /* skip */ }
        }
    }

    genTask.streamingPhase = "";
    genTask.streamingFile = "";
    genTask.streamingContent = "";
    return result;
}

/** SSE streaming file generation (legacy single-file flow，仅供补缺/重新规划使用) */
async function streamFileGeneration(taskId: string): Promise<any> {
    const resp = await fetch("/api/generate/file", {
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

/** SSE streaming bucket generation — 一次跑一个桶，桶内并发 */
async function streamBucketGeneration(taskId: string, bucketIndex: number): Promise<any> {
    const resp = await fetch("/api/generate/bucket", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ taskId, bucketIndex }),
    });
    if (!resp.ok) throw new Error(await resp.text());
    return readSSE(resp);
}

/** SSE streaming clarify round */
async function streamClarify(
    taskId: string,
    answers?: Record<string, string | string[]>,
    extraPrompt?: string,
): Promise<any> {
    const resp = await fetch("/api/generate/clarify", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ taskId, answers, extraPrompt }),
    });
    if (!resp.ok) throw new Error(await resp.text());
    return readSSE(resp);
}

/** SSE streaming build fix */
async function streamBuildFix(taskId: string): Promise<any> {
    const resp = await fetch("/api/generate/fix", {
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

export async function startGenerate(userPrompt: string, coreType: string, version: string) {
    if (isGeneratingPhase(genTask.phase)) {
        throw new Error("当前已有构建任务正在进行");
    }

    resetGenTask();

    // ── Phase 1: create taskId (no plan yet) ──
    try {
        setPhase("planning", "正在创建任务...");
        const initResult = await post("/api/generate/plan", { userPrompt, coreType, version });
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
            const clarifyResult = await streamClarify(genTask.taskId, answers, extraPrompt);
            extraPrompt = undefined;
            if (!clarifyResult) throw new Error("澄清阶段无响应");

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
        genTask.phase = "error";
        genTask.error = e.message || String(e);
        genTask.logs.push("× " + genTask.error);
        return;
    }

    // ── Phase 3: planning + generating + build (with replan loop) ──
    for (let replanAttempt = 0; replanAttempt <= MAX_REPLAN_ATTEMPTS; replanAttempt++) {
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

            const planResult = await post("/api/generate/plan", { taskId: genTask.taskId });
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
            genTask.logs.push(`● 项目规划完成，共 ${genTask.files.length} 个文件`);

            setPhase("generating");
            // 收集 buckets：每个 file 自带 bucket 索引；按桶号升序并发
            const bucketMap = new Map<number, number>();
            for (const f of genTask.files) {
                const b = f.bucket ?? 0;
                bucketMap.set(b, (bucketMap.get(b) ?? 0) + 1);
            }
            const sortedBucketIds = [...bucketMap.keys()].sort((a, b) => a - b);
            let needReplan = false;

            for (const bucketIndex of sortedBucketIds) {
                if (needReplan) break;
                const bucketResult = await streamBucketGeneration(genTask.taskId, bucketIndex);
                if (!bucketResult) {
                    throw new Error(`桶 #${bucketIndex} 无返回`);
                }
                if (bucketResult.replan) {
                    needReplan = true;
                    break;
                }
                // 把已完成的内容回填到 files
                for (const c of bucketResult.completed || []) {
                    const f = genTask.files.find(x => x.path === c.path);
                    if (f) {
                        f.content = c.content;
                        f.status = "done";
                    }
                }
                if (bucketResult.done) break;
            }

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

async function buildWithRetry(initialFiles?: { path: string; content: string }[]) {
    for (let attempt = 0; attempt <= MAX_FIX_ATTEMPTS; attempt++) {
        setPhase("uploading", "正在上传到 GitHub 并触发构建...");
        const payload: any = { taskId: genTask.taskId };
        // 首次构建带上 IDE 的最新内容；后续 fix 后重建用 KV 里已被 fix 改过的版本
        if (attempt === 0 && initialFiles) payload.files = initialFiles;
        const buildResult = await post("/api/generate/build", payload);
        // 从 IDE 进来的场景：填上 GenerateProgress 头部要展示的 meta
        if (!genTask.projectName && buildResult.projectName) genTask.projectName = buildResult.projectName;
        if (!genTask.packageName && buildResult.packageName) genTask.packageName = buildResult.packageName;
        if (!genTask.javaVersion && buildResult.javaVersion) genTask.javaVersion = buildResult.javaVersion;
        genTask.logs.push(`构建已触发 (run #${buildResult.runId || "pending"})`);

        setPhase("building", "正在等待 GitHub Actions 构建...");
        const buildOk = await pollBuildStatus();

        if (buildOk) return; // success

        // Build failed — attempt fix
        if (attempt < MAX_FIX_ATTEMPTS) {
            genTask.logs.push(`! 构建失败，尝试自动修复 (第${attempt + 1}次)...`);
            setPhase("fixing", "正在分析编译错误并修复...");

            const fixResult = await streamBuildFix(genTask.taskId);
            if (!fixResult || fixResult.fixed === 0) {
                throw new Error("自动修复未能修正任何文件，构建失败");
            }
            genTask.logs.push(`● 已修复 ${fixResult.fixed} 个文件，重新构建...`);
        } else {
            throw new Error("构建失败，已用尽自动修复次数");
        }
    }
}

/** Poll build status. Returns true on success, false on failure. */
async function pollBuildStatus(): Promise<boolean> {
    const maxAttempts = 60;
    for (let i = 0; i < maxAttempts; i++) {
        await new Promise(r => setTimeout(r, 5000));

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
export async function startBuildFromIDE(files: { path: string; content: string }[]) {
    try {
        await buildWithRetry(files);
    } catch (e: any) {
        genTask.phase = "error";
        genTask.error = e?.message || String(e);
        genTask.logs.push("× " + genTask.error);
    }
}
