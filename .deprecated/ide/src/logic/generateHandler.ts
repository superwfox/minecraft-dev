// 归档片段：原构建文件上传与追加需求实现，不参与当前应用。
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
        let buildResult: any = null;
        if (reuseExisting && genTask.buildRequestId) {
            setPhase("uploading", "正在恢复已有构建启动请求...");
            appendGenLog("↻ 页面恢复：使用原 build request ID 对账，不重复触发 workflow");
            buildResult = await post("/api/generate/build", {
                taskId: genTask.taskId,
                buildRequestId: genTask.buildRequestId,
            });
        } else if (reuseExisting) {
            setPhase("building", "正在恢复已有构建的状态...");
            appendGenLog("↻ 页面恢复：继续等待已有构建，不重复触发 workflow");
        } else {
            setPhase("uploading", "正在上传到 GitHub 并触发构建...");
            const buildRequestId = createBuildRequestId();
            genTask.buildRequestId = buildRequestId;
            persistGenTaskNow();
            const payload: any = {
                taskId: genTask.taskId,
                buildRequestId,
            };
            // 首次构建带上 IDE 的最新内容 + 元数据（供 KV 任务过期后重建）；
            // 后续 fix 后重建用 KV 里已被 fix 改过的版本
            if (attempt === 0 && initialFiles) {
                payload.files = initialFiles;
                if (meta) payload.meta = meta;
            }
            buildResult = await post("/api/generate/build", payload);
        }

        if (buildResult) {
            if (genTask.fixResumeStage === "rebuilding") {
                genTask.fixResumeStage = "";
                persistGenTaskNow();
            }
            // 从 IDE 进来的场景：填上 GenerateProgress 头部要展示的 meta
            if (!genTask.projectName && buildResult.projectName) genTask.projectName = buildResult.projectName;
            if (!genTask.packageName && buildResult.packageName) genTask.packageName = buildResult.packageName;
            if (!genTask.javaVersion && buildResult.javaVersion) genTask.javaVersion = buildResult.javaVersion;
            appendGenLog(`构建已确认 (run #${buildResult.runId || "pending"})`);
        }

        setPhase("building", "正在等待 GitHub Actions 构建...");
        const buildOk = await pollBuildStatus();

        if (buildOk) return; // success

        // 每次失败都抓取结构化诊断；最后一次只检查、不再调用模型修改。
        const canRepair = attempt < MAX_FIX_ATTEMPTS;
        if (canRepair) {
            appendGenLog(`! 构建失败，尝试自动修复 (第${attempt + 1}次)...`);
            setPhase("fixing", "正在分析编译错误并修复...");
        } else {
            setPhase("fixing", "正在获取最终构建诊断...");
        }

        let repairAuthorization: FixRepairAuthorization | null = null;
        if (canRepair) {
            genTask.fixResumeStage = "diagnosing";
            persistGenTaskNow();
            const diagnosis = await streamBuildFix(genTask.taskId, "diagnose");
            repairAuthorization = normalizeFixRepairAuthorization(diagnosis?.repairAuthorization);
            if (!repairAuthorization) {
                throw new Error(diagnosis?.reason || "服务端未返回当前构建的修复授权");
            }
            genTask.fixResumeStage = "repairing";
            persistGenTaskNow();
        } else {
            genTask.fixResumeStage = "inspecting";
            persistGenTaskNow();
        }

        const fixResult = canRepair && repairAuthorization
            ? await repairWithLearningTools(genTask.taskId, repairAuthorization)
            : await streamBuildFix(genTask.taskId, "inspect");
        if (!canRepair) {
            genTask.fixResumeStage = "";
            persistGenTaskNow();
            throw new Error(fixResult?.reason || "构建失败，已用尽自动修复次数");
        }
        const changed = repairedFileCount(fixResult);
        if (!fixResult || changed === 0) {
            throw new Error(fixResult?.reason || fixResult?.error || "自动修复未产生可重新验证的文件变更，构建失败");
        }
        genTask.fixResumeStage = "rebuilding";
        persistGenTaskNow();
        appendGenLog(`● 已修改 ${changed} 个文件，开始重新构建验证...`);
    }
}

/** Poll build status. Returns true on success, false on failure. */
async function pollBuildStatus(): Promise<boolean> {
    const deadline = Date.now() + 10 * 60_000;
    let i = 0;
    while (Date.now() < deadline) {
        // 前三次快速感知启动，随后逐步退避；隐藏标签页进一步降频。
        const delay = document.hidden ? 30_000 : i < 3 ? 5_000 : i < 9 ? 10_000 : 15_000;
        await waitWithAbort(delay, generationSignal());

        const result = await get(`/api/generate/status?taskId=${genTask.taskId}`);

        if (result.status === "done") {
            genTask.buildRequestId = "";
            genTask.fixResumeStage = "";
            setPhase("done", "● 构建成功，JAR 已就绪！");
            persistGenTaskNow();
            return true;
        }
        if (result.status === "error") {
            return false;
        }
        if (i % 3 === 0) {
            appendGenLog(`构建中... (${result.runStatus || "queued"})`);
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
    beginGenerationRun();
    const runId = generationRunId;
    if (genTask.taskId) {
        applyTaskExpiration(genTask.taskId, Date.now() + GEN_TASK_TTL_MS);
        scheduleTaskKeepalive(genTask.taskId, runId);
    }
    try {
        await buildWithRetry(files, meta);
    } catch (e: any) {
        if (!isGenerationRunCurrent(runId)) return;
        if (isInterrupt(e)) {
            markInterrupted(genTask.phase);
            return;
        }
        setGenerateError(e);
        appendGenLog("× " + genTask.error);
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

    beginGenerationRun();
    const appendRunId = generationRunId;
    try {
        const signal = generationSignal();
        const runId = generationRunId;
        clearGenerateError();
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
                model: "deepseek-flash",
                reasoning_effort: "high",
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
            signal,
        });
        assertGenerationRun(runId);
        await rejectAccessResponse(resp);
        if (!resp.ok) throw await responseError(resp);
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
                let event: any;
                try {
                    event = JSON.parse(payload);
                } catch { continue; }
                assertGenerationRun(runId);
                if (event?.type === "error" || (event?.type === "result" && event?.error)) {
                    rejectAccessEvent(event);
                    const message = typeof event?.error === "string"
                        ? event.error
                        : (event?.error?.message || event?.message || "流式请求失败");
                    throw new Error(message);
                }
                const chunk = event?.choices?.[0]?.delta?.content ?? "";
                if (chunk) { full += chunk; genTask.streamingContent = full; }
            }
        }
        genTask.streamingPhase = "";
        genTask.streamingContent = "";
        fetchMe(); // 刷新顶栏额度

        // 解析 FILE 块，应用到 genTask.files
        const existing = new Set(genTask.files.map(f => f.path));
        const parsed = parseResponse(full, existing);
        if (!parsed.files.length) {
            appendGenLog("! 追加需求未产出文件改动" + (parsed.reply ? `：${parsed.reply.slice(0, 80)}` : ""));
            setPhase("done", "● 无改动");
            return;
        }
        for (const fa of parsed.files) {
            const exist = genTask.files.find(f => f.path === fa.path);
            if (exist) {
                exist.content = fa.content;
                exist.status = "done";
                appendGenLog(`✎ 修改 ${fa.path}`);
            } else {
                genTask.files.push({
                    path: fa.path,
                    role: "追加：" + text.slice(0, 16),
                    content: fa.content,
                    status: "done",
                });
                appendGenLog(`＋ 新增 ${fa.path}`);
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
        if (!isGenerationRunCurrent(appendRunId)) return;
        if (isInterrupt(e)) {
            markInterrupted(genTask.phase);
            return;
        }
        genTask.streamingPhase = "";
        genTask.streamingContent = "";
        setGenerateError(e);
        appendGenLog("× 追加失败：" + genTask.error);
    }
}
