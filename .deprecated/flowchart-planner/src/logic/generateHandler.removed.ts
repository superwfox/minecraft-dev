
function createPlannerRequestId(): string {
    return `plan_${crypto.randomUUID().replace(/-/g, "")}`;
}

function createClarifyRequestId(): string {
    return `clarify_${crypto.randomUUID().replace(/-/g, "")}`;
}

function createGradeRequestId(): string {
    return `grade_${crypto.randomUUID().replace(/-/g, "")}`;
}

function createBuildRequestId(): string {
    return `build_${crypto.randomUUID().replace(/-/g, "")}`;
}

// 初次 Planner 请求仅按 SSE 活动判断失活；Learning 续接另受共享的绝对时限约束。
const PLANNER_TRANSPORT_IDLE_MS = 5_000;
const PLANNER_CONNECTION_RETRIES = 3;

class PlannerTransportTimeoutError extends Error {
    readonly code = "PLANNER_TRANSPORT_TIMEOUT";
    readonly retryable = true;

    constructor() {
        super("Planner SSE 连接 5 秒未收到任何数据");
        this.name = "PlannerTransportTimeoutError";
    }
}

function plannerAttemptAbortError(controller: AbortController): Error | null {
    if (!controller.signal.aborted) return null;
    return controller.signal.reason instanceof Error
        ? controller.signal.reason
        : null;
}

function isPlannerTimeout(code: string, status: number): boolean {
    return code === "PLANNER_TIMEOUT"
        || code === "CLOUDFLARE_TIMEOUT"
        || status === 524;
}

async function postPlanner(
    body: any,
    learningContinuation?: LearningContinuationDeadline,
): Promise<any> {
    const signal = generationSignal();
    const runId = generationRunId;
    let announcedWait = false;
    let failures = 0;
    let timeoutRetries = 0;
    const waitForPlannerRetry = async (delayMs: number) => {
        learningContinuation?.assertActive();
        const remainingMs = learningContinuation
            ? Math.max(1, learningContinuation.deadlineAt - Date.now())
            : delayMs;
        await waitWithAbort(Math.min(delayMs, remainingMs), signal);
        learningContinuation?.assertActive();
    };
    while (true) {
        learningContinuation?.assertActive();
        const attemptController = new AbortController();
        const unlinkGenerationAbort = linkGenerationAbort(attemptController);
        const unlinkLearningContinuation = learningContinuation
            ? linkAbortSignal(attemptController, learningContinuation.signal)
            : () => {};
        let transportIdleTimer: ReturnType<typeof setTimeout> | undefined;
        let lastTransportActivity = 0;

        const clearTransportIdleTimer = () => {
            if (transportIdleTimer) clearTimeout(transportIdleTimer);
            transportIdleTimer = undefined;
        };
        const scheduleTransportIdleCheck = () => {
            clearTransportIdleTimer();
            const elapsed = Date.now() - lastTransportActivity;
            const remaining = Math.max(1, PLANNER_TRANSPORT_IDLE_MS - elapsed);
            transportIdleTimer = setTimeout(() => {
                if (attemptController.signal.aborted) return;
                if (Date.now() - lastTransportActivity < PLANNER_TRANSPORT_IDLE_MS) {
                    scheduleTransportIdleCheck();
                    return;
                }
                attemptController.abort(new PlannerTransportTimeoutError());
            }, remaining);
        };
        const recordTransportActivity = () => {
            if (attemptController.signal.aborted) return;
            lastTransportActivity = Date.now();
            scheduleTransportIdleCheck();
        };

        try {
            let resp: Response;
            try {
                resp = await fetchWithByokFallback("/api/generate/plan", {
                    method: "POST",
                    headers: { "Content-Type": "application/json" },
                    body: JSON.stringify(body),
                    signal: attemptController.signal,
                });
            } catch (error) {
                if (signal.aborted || runId !== generationRunId) throw generationAbortError();
                learningContinuation?.assertActive();
                const attemptError = plannerAttemptAbortError(attemptController) || error;
                if (isInterrupt(attemptError)) throw generationAbortError();
                if (failures++ >= PLANNER_CONNECTION_RETRIES) throw attemptError;
                await waitForPlannerRetry(2000 * Math.pow(2, failures - 1));
                continue;
            }

            assertGenerationRun(runId);
            learningContinuation?.assertActive();

            await rejectAccessResponse(resp);
            if (resp.status === 429) {
                const payload = await resp.json().catch(() => ({})) as { code?: string; error?: string };
                throw noRetry(payload?.error || "请求过于频繁", {
                    code: payload?.code || "RATE_LIMITED",
                    status: resp.status,
                });
            }
            if (resp.status === 409) {
                const payload = await resp.json().catch(() => ({})) as { code?: string; error?: string };
                if (payload?.code !== "PLANNER_IN_PROGRESS") {
                    const error = new Error(payload?.error || "Planner 状态冲突");
                    (error as any).code = payload?.code || "PLANNER_CONFLICT";
                    (error as any).status = resp.status;
                    (error as any).noRetry = true;
                    throw error;
                }
                if (!announcedWait) {
                    appendGenLog("· Planner 已在服务端执行，等待现有结果...");
                    announcedWait = true;
                }
                const retrySeconds = Math.max(1, Number(resp.headers.get("Retry-After")) || 2);
                await waitForPlannerRetry(retrySeconds * 1000);
                continue;
            }
            if (resp.status === 400) {
                const payload = await resp.json().catch(() => ({})) as { code?: string; error?: string };
                throw noRetry(payload?.error || "Planner 请求无效", {
                    code: payload?.code || "PLANNER_REQUEST_INVALID",
                    status: resp.status,
                });
            }
            if (!resp.ok) {
                const apiError = await readApiError(resp, `Planner 请求失败（HTTP ${resp.status}）`);
                if (resp.status === 404 || apiError.code === "TASK_NOT_FOUND") {
                    throw noRetry(apiError.message || TASK_UNAVAILABLE_MESSAGE, {
                        code: apiError.code || "TASK_NOT_FOUND",
                        status: resp.status,
                    });
                }
                if (isPlannerTimeout(apiError.code, resp.status)) {
                    if (timeoutRetries++ >= 1) {
                        const error = new Error(apiError.message);
                        (error as any).code = apiError.code;
                        (error as any).status = resp.status;
                        throw error;
                    }
                    const retrySeconds = Math.max(1, Number(resp.headers.get("Retry-After")) || 1);
                    appendGenLog("! Planner 响应超时，使用同一请求 ID 重试一次...");
                    await waitForPlannerRetry(retrySeconds * 1000);
                    continue;
                }
                if (failures++ >= PLANNER_CONNECTION_RETRIES) {
                    throw new Error(apiError.message);
                }
                await waitForPlannerRetry(2000 * Math.pow(2, failures - 1));
                continue;
            }
            const contentType = resp.headers.get("Content-Type") || "";
            if (contentType.includes("text/event-stream")) {
                let streamed: any;
                recordTransportActivity();
                try {
                    streamed = await readSSE(resp, {
                        preflightStage: "plan",
                        requireDone: true,
                        runId,
                        onActivity: recordTransportActivity,
                    });
                } catch (error: any) {
                    if (signal.aborted || runId !== generationRunId) throw generationAbortError();
                    learningContinuation?.assertActive();
                    const attemptError = plannerAttemptAbortError(attemptController) || error;
                    if (isInterrupt(attemptError)) throw generationAbortError();
                    if (attemptError?.noRetry || attemptError?.terminal) throw attemptError;
                    if (failures++ >= PLANNER_CONNECTION_RETRIES) {
                        throw attemptError;
                    }
                    const delay = 2000 * Math.pow(2, failures - 1);
                    const reason = attemptError instanceof PlannerTransportTimeoutError
                        ? "链路静默，正在刷新连接"
                        : "连接中断";
                    appendGenLog(`! Planner ${reason}，${delay / 1000}s 后继续等待 (${failures}/${PLANNER_CONNECTION_RETRIES})...`);
                    await waitForPlannerRetry(delay);
                    continue;
                } finally {
                    clearTransportIdleTimer();
                }
                if (!streamed) {
                    if (failures++ >= PLANNER_CONNECTION_RETRIES) {
                        throw new Error("Planner 流已结束，但未返回结果");
                    }
                    await waitForPlannerRetry(2000 * Math.pow(2, failures - 1));
                    continue;
                }
                if (streamed.error) {
                    const status = Number(streamed.status) || 0;
                    const code = typeof streamed.code === "string" ? streamed.code : "";
                    if (code === "PLANNER_IN_PROGRESS") {
                        if (!announcedWait) {
                            appendGenLog("· Planner 已在服务端执行，等待现有结果...");
                            announcedWait = true;
                        }
                        const retrySeconds = Math.max(1, Number(streamed.retryAfter) || 2);
                        await waitForPlannerRetry(retrySeconds * 1000);
                        continue;
                    }

                    const plannerError = new Error(String(streamed.error));
                    (plannerError as any).code = code;
                    (plannerError as any).status = status;
                    if (isPlannerTimeout(code, status)) {
                        if (timeoutRetries++ >= 1) throw plannerError;
                        const retrySeconds = Math.max(1, Number(streamed.retryAfter) || 1);
                        appendGenLog("! Planner 响应超时，使用同一请求 ID 重试一次...");
                        await waitForPlannerRetry(retrySeconds * 1000);
                        continue;
                    }
                    if (status >= 400 && status < 500) {
                        (plannerError as any).noRetry = true;
                        throw plannerError;
                    }
                    if (failures++ >= PLANNER_CONNECTION_RETRIES) {
                        throw plannerError;
                    }
                    const delay = 2000 * Math.pow(2, failures - 1);
                    appendGenLog(`! Planner 请求失败，${delay / 1000}s 后重试 (${failures}/${PLANNER_CONNECTION_RETRIES})...`);
                    await waitForPlannerRetry(delay);
                    continue;
                }
                assertGenerationRun(runId);
                learningContinuation?.assertActive();
                return streamed;
            }
            const result = await resp.json();
            assertGenerationRun(runId);
            learningContinuation?.assertActive();
            return result;
        } catch (error) {
            if (signal.aborted || runId !== generationRunId) throw generationAbortError();
            learningContinuation?.assertActive();
            throw error;
        } finally {
            clearTransportIdleTimer();
            unlinkLearningContinuation();
            unlinkGenerationAbort();
        }
    }
}


/** SSE streaming file generation (legacy single-file flow，仅供补缺/重新规划使用) */
async function streamFileGeneration(taskId: string): Promise<any> {
    const signal = generationSignal();
    const runId = generationRunId;
    const resp = await fetchWithByokFallback("/api/generate/file", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ taskId }),
        signal,
    });
    assertGenerationRun(runId);
    await rejectAccessResponse(resp);
    if (!resp.ok) throw await responseError(resp);

    const contentType = resp.headers.get("Content-Type") || "";
    if (contentType.includes("application/json")) {
        const result = await resp.json();
        assertGenerationRun(runId);
        return result;
    }

    return readSSE(resp, { runId });
}

/** SSE streaming bucket generation — 一次推进一批文件的单个持久化阶段。
 *  服务端通过 heartbeat 保持连接，客户端不再因静默时长主动中止。 */

/** SSE streaming complexity grading. Correction redraws use a new semantic request ID. */
async function streamGrade(taskId: string, gradeRequestId: string, correction?: string): Promise<any> {
    return streamPreflightRequest({
        endpoint: "/api/generate/grade",
        stage: "grade",
        label: "分级",
        requestIdField: "gradeRequestId",
        requestId: gradeRequestId,
        taskId,
        payload: { correction },
        inProgressCode: "GRADE_IN_PROGRESS",
        recoveryCode: "GRADE_RECOVERY_REQUIRED",
        normalizeRequestId: normalizeGradeRequestId,
        onRecoverRequestId: requestId => {
            genTask.gradeRequestId = requestId;
            genTask.gradeRequestCorrection = "";
            persistGenTaskNow();
        },
        setController: controller => { gradeAbort = controller; },
        clearController: controller => {
            if (gradeAbort === controller) gradeAbort = null;
        },
    });
}


async function runGradeStage(resumePhase: GenPhase | "" = ""): Promise<string | undefined> {
    generationSignal();
    const stageRunId = generationRunId;
    let correction: string | undefined = resumePhase === "grading"
        ? genTask.gradeRequestCorrection || undefined
        : undefined;

    if (resumePhase === "confirming") {
        if (!genTask.grade) throw new Error("实现路径确认状态已失效，请重试分级");
        const choice = await waitForPathChoice();
        if (choice.correction) {
            correction = choice.correction;
            genTask.grade = null;
        } else {
            genTask.chosenPathId = choice.pathId || "";
            genTask.grade = null;
            setPhase("planning");
            persistGenTaskNow();
            return choice.pathId;
        }
    }

    while (true) {
        genTask.reasoningContent = "";
        setPhase("grading", "正在分析需求复杂度...");

        const gradeRequestId = genTask.gradeRequestId || createGradeRequestId();
        genTask.gradeRequestId = gradeRequestId;
        genTask.gradeRequestCorrection = correction || "";
        persistGenTaskNow();

        let gradeResult: any;
        try {
            gradeResult = await streamGrade(genTask.taskId, gradeRequestId, correction);
        } catch (error: any) {
            if (isInterrupt(error)) throw error;
            assertGenerationRun(stageRunId);
            if (error?.code === "CLARIFY_RECOVERY_REQUIRED") {
                const activeClarifyRequestId = normalizeClarifyRequestId(error.activeRequestId);
                if (!activeClarifyRequestId) {
                    throw new Error("服务端要求恢复需求确认，但未返回有效的 requestId");
                }
                genTask.clarifyRequestId = activeClarifyRequestId;
                genTask.clarifyRequestAnswers = null;
                genTask.clarifyRequestExtraPrompt = "";
                genTask.gradeRequestId = "";
                genTask.gradeRequestCorrection = "";
                genTask.grade = null;
                setPhase("clarifying", "↻ 分级前先恢复尚未结算的需求确认请求");
                persistGenTaskNow();
                await runClarifyStage("clarifying");
                correction = undefined;
                continue;
            }
            if (error?.code === "GRADE_CANCELLED") {
                genTask.gradeRequestId = "";
                persistGenTaskNow();
                continue;
            }
            if (error?.terminal) {
                genTask.gradeRequestId = "";
                persistGenTaskNow();
            }
            throw error;
        }

        genTask.plannerLearningRequired = gradeResult.learningRequired === true;
        genTask.plannerLearningNeedCount = genTask.plannerLearningRequired
            ? Math.max(0, Number(gradeResult.learningNeedCount) || 0)
            : 0;
        correction = undefined;

        if (gradeResult.direct) {
            genTask.grade = null;
            setPhase("planning");
            genTask.gradeRequestId = "";
            genTask.gradeRequestCorrection = "";
            persistGenTaskNow();
            return undefined;
        }

        genTask.grade = { level: gradeResult.level, paths: gradeResult.paths || [] };
        setPhase("confirming", "请确认实现路径");
        genTask.gradeRequestId = "";
        genTask.gradeRequestCorrection = "";
        persistGenTaskNow();
        const choice = await waitForPathChoice();
        if (choice.correction) {
            correction = choice.correction;
            genTask.grade = null;
            continue;
        }
        genTask.chosenPathId = choice.pathId || "";
        genTask.grade = null;
        setPhase("planning");
        persistGenTaskNow();
        return choice.pathId;
    }
}

// 记住上次生成的入参，供失败后「重试」手动重跑。刷新后内存丢失时，改用 genTask 上还原的入参。
let lastGenParams: { userPrompt: string; coreType: string; version: string } | null = null;
export function canRetryGenerate(): boolean {
    const has = !!lastGenParams || !!genTask.userPrompt || !!genTask.taskId;
    return has && (genTask.phase === "error" || genTask.phase === "idle" || genTask.phase === "interrupted");
}

function getPreFileResumePhase(): GenPhase | "" {
    if (genTask.clarifyRequestId) return "clarifying";
    if (genTask.gradeRequestId) return "grading";
    if (genTask.plannerRequestId
        || genTask.preflightStage === "plan"
        || (genTask.learningProgress.stage === "planner" && genTask.learningProgress.status !== "idle")) {
        return "planning";
    }
    if (genTask.grade) return "confirming";
    if (genTask.preflightStage === "clarify") {
        return genTask.moreInputHint ? "awaiting_input" : "clarifying";
    }
    if (genTask.preflightStage === "grade") return "grading";
    return "";
}

/** 手动重试：FileGen 前优先用原 taskId + stage requestId 对账，不重复执行 mode1。 */
export function retryGenerate() {
    const params = lastGenParams
        || (genTask.userPrompt ? { userPrompt: genTask.userPrompt, coreType: genTask.coreType, version: genTask.version } : null);
    if (genTask.phase === "interrupted" && genTask.taskId) {
        resumeGenerate().catch(() => { });
        return;
    }
    const interruptedResume = genTask.phase === "interrupted" ? genTask.interruptedFrom : "";
    const resumePhase = genTask.taskId && genTask.files.length === 0
        ? (interruptedResume || getPreFileResumePhase())
        : "";
    if (params && genTask.taskId && genTask.files.length === 0) {
        if (resumePhase) {
            genTask.phase = resumePhase;
            clearGenerateError();
            appendGenLog("↻ 使用现有任务恢复 FileGen 前置阶段，不重复创建任务");
            persistGenTaskNow();
            startGenerate(params.userPrompt, params.coreType, params.version, { resumePrepared: true }).catch(() => { });
        } else {
            setGenerateError(
                new Error("当前任务缺少可恢复的 requestId；为避免重复计费，未自动新建任务。"),
                "warning",
            );
            persistGenTaskNow();
        }
        return;
    }
    if (params) {
        startGenerate(params.userPrompt, params.coreType, params.version).catch(() => { });
    } else if (genTask.taskId) {
        resumeGenerate().catch(() => { });
    }
}

/** 刷新恢复：genTask 已由 restoreGenTask 还原，据当前阶段续跑，避免刷新即失败。 */
export async function resumeGenerate() {
    if (genTask.phase === "interrupted" && !genTask.taskId) {
        const params = lastGenParams
            || (genTask.userPrompt
                ? {userPrompt: genTask.userPrompt, coreType: genTask.coreType, version: genTask.version}
                : null);
        if (!params?.userPrompt || !params.coreType || !params.version) {
            setGenerateError(
                new Error("当前任务缺少重新创建所需的需求信息，请重新提交需求。"),
                "warning",
            );
            persistGenTaskNow();
            return;
        }
        await startGenerate(params.userPrompt, params.coreType, params.version);
        return;
    }
    if (genTask.phase === "interrupted") {
        if (!genTask.interruptedFrom) return;
        genTask.phase = genTask.interruptedFrom;
        genTask.interruptedFrom = "";
    }
    const p = genTask.phase;
    if (!genTask.taskId || ["idle", "done", "error", "interrupted"].includes(p)) return;

    if (!genTask.files.length
        && ["clarifying", "awaiting_input", "grading", "confirming", "planning"].includes(p)
        && genTask.userPrompt) {
        appendGenLog(p === "planning"
            ? "↻ 页面恢复：继续联网查证与项目规划"
            : "↻ 页面恢复：使用原 taskId 与前置 requestId 继续对账");
        await startGenerate(genTask.userPrompt, genTask.coreType, genTask.version, { resumePrepared: true });
        return;
    }

    beginGenerationRun();
    const resumeRunId = generationRunId;
    const recordResumeFailure = (error: any) => {
        if (!isGenerationRunCurrent(resumeRunId)) return;
        if (isInterrupt(error)) {
            markInterrupted(genTask.phase === "interrupted" ? genTask.interruptedFrom : genTask.phase);
            return;
        }
        setGenerateError(error);
        appendGenLog("× " + genTask.error);
        persistGenTaskNow();
    };

    try {
        await ensureTaskAlive(genTask.taskId, resumeRunId);
    } catch (error: any) {
        recordResumeFailure(error);
        return;
    }

    // 已触发构建的阶段只恢复轮询，避免刷新后重复建分支、重复触发 workflow。
    if (["building", "polling"].includes(p)) {
        try { await buildWithRetry(true); }
        catch (e: any) { recordResumeFailure(e); }
        return;
    }
    const hasRecoverableFixLearning = genTask.learningProgress.stage === "fix"
        && !!genTask.learningProgress.jobId
        && (!LEARNING_TERMINAL.has(genTask.learningProgress.status)
            || isUnconfirmedLearningProgress(genTask.learningProgress));
    const restoringFixStage: FixResumeStage = p === "fixing"
        ? genTask.fixResumeStage || (hasRecoverableFixLearning ? "learning" : "")
        : "";
    if (restoringFixStage) {
        try {
            genTask.fixResumeStage = restoringFixStage;
            persistGenTaskNow();
            await resumeFixingStage(genTask.taskId, restoringFixStage);
        } catch (e: any) {
            if (isGenerationRunCurrent(resumeRunId)) genTask.fixResumeStage = "";
            recordResumeFailure(e);
        }
        return;
    }

    // uploading 阶段优先复用已持久化的请求 ID，继续同一次服务端启动流程。
    if (p === "uploading") {
        try { await buildWithRetry(!!genTask.buildRequestId); }
        catch (e: any) { recordResumeFailure(e); }
        return;
    }
    if (p === "fixing") {
        try { await buildWithRetry(); }
        catch (e: any) { recordResumeFailure(e); }
        return;
    }

    // 无法识别的旧快照不自动重跑 mode1，避免重复创建并计费。
    if (!genTask.files.length) {
        setGenerateError(
            new Error("当前任务缺少可恢复的前置阶段信息，请重新开始生成。"),
            "warning",
        );
        return;
    }

    // 生成/校验阶段（plan 已完成、有 files）：续跑桶循环（后端 fileStatuses 天然可续）→ 校验 → 构建
    try {
        appendGenLog("↻ 从刷新中断处继续生成…");
        setPhase("generating", "从中断处继续生成…");

        const bucketMap = new Map<number, number>();
        for (const f of genTask.files) { const b = f.bucket ?? 0; bucketMap.set(b, (bucketMap.get(b) ?? 0) + 1); }
        const sortedBucketIds = [...bucketMap.keys()].sort((a, b) => a - b);
        const learningToolJobs: Record<string, string> = {};

        for (const bucketIndex of sortedBucketIds) {
            let bucketDone = false, guard = 0, noProgress = 0;
            const guardLimit = Math.max(80, (bucketMap.get(bucketIndex) ?? 1) * 16 + 20);
            const doneCount = () => genTask.files.filter(f => f.status === "done").length;
            while (!bucketDone) {
                if (guard++ > guardLimit) throw new Error("续跑阶段过多，请重试");
                const doneBefore = doneCount();
                let bucketResult: any = null;
                for (let bAttempt = 0; bAttempt < 2 && !bucketResult; bAttempt++) {
                    try {
                        bucketResult = await streamBucketGeneration(genTask.taskId, bucketIndex, learningToolJobs);
                    }
                    catch (error: any) {
                        if (isInterrupt(error)) throw error;
                        if (error?.noRetry || error?.terminal) throw error;
                        bucketResult = null;
                    }
                }
                if (!bucketResult) {
                    if (doneCount() > doneBefore) { noProgress = 0; continue; }
                    if (++noProgress >= 5) throw new Error("续跑连续零进度，请重试");
                    await waitWithAbort(1_500, generationSignal());
                    continue;
                }
                if (bucketResult.replan) throw new Error("续跑仍未通过审查，请重试");
                if (await runModelLearningToolRequests(bucketResult.learningToolRequests, learningToolJobs)) {
                    noProgress = 0;
                    continue;
                }
                for (const c of bucketResult.completed || []) {
                    const f = genTask.files.find(x => x.path === c.path);
                    if (f) { f.content = c.content; f.status = "done"; }
                }
                syncCurrentIndex();
                bucketDone = !!bucketResult.bucketDone;
                const progressed = bucketResult.progressed === true
                    || doneCount() > doneBefore
                    || bucketDone;
                if (!progressed) {
                    if (++noProgress >= 5) {
                        throw new Error("生成服务连续未推进，阶段进度已保存，请稍后重试");
                    }
                    const retryAfterMs = Math.max(500, Math.min(5_000, Number(bucketResult.retryAfterMs) || 1_500));
                    await waitWithAbort(retryAfterMs, generationSignal());
                    continue;
                }
                noProgress = 0;
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
                appendGenLog(`↻ 补生成 ${mp}`);
                const fileResult = await streamFileGeneration(genTask.taskId);
                if (!fileResult || fileResult.done) break;
            }
            verifyResult = await post("/api/generate/verify", { taskId: genTask.taskId });
        }
        if (!verifyResult.verified) throw new Error(`文件校验失败，缺失 ${verifyResult.missing.length} 个文件`);

        await buildWithRetry();
    } catch (e: any) {
        recordResumeFailure(e);
    }
}

export async function startGenerate(
    userPrompt: string,
    coreType: string,
    version: string,
    options?: { resumePrepared?: boolean },
) {
    const resumePrepared = options?.resumePrepared === true;
    const resumePhase: GenPhase | "" = resumePrepared ? genTask.phase : "";
    if (!resumePrepared && isGeneratingPhase(genTask.phase)) {
        throw new Error("当前已有构建任务正在进行");
    }
    beginGenerationRun();
    const runId = generationRunId;
    let chosenPathId: string | undefined = resumePrepared ? genTask.chosenPathId || undefined : undefined;

    if (resumePrepared && genTask.taskId) {
        try {
            await ensureTaskAlive(genTask.taskId, runId);
        } catch (error: any) {
            if (!isGenerationRunCurrent(runId)) return;
            if (isInterrupt(error)) {
                markInterrupted(resumePhase || genTask.phase);
                return;
            }
            setGenerateError(error);
            appendGenLog(`× ${genTask.error}`);
            persistGenTaskNow();
            return;
        }
    }

    if (!resumePrepared) {
        lastGenParams = { userPrompt, coreType, version };
        const skillIds = [...selected];
        recordPromptHistory({prompt: userPrompt, coreType, version, skillIds});

        resetGenTask();
        genTask.userPrompt = userPrompt;
        genTask.coreType = coreType;
        genTask.version = version;

        // ── Phase 1: create taskId (mode1, only for a genuinely new task) ──
        try {
            setPhase("planning", "正在创建任务...");
            const initResult = await post("/api/generate/plan", { userPrompt, coreType, version, skillIds });
            genTask.taskId = initResult.taskId;
            applyTaskExpiration(genTask.taskId, initResult.expiresAt);
            scheduleTaskKeepalive(genTask.taskId, runId);
            fetchMe(); // 扣费后刷新顶栏剩余额度
        } catch (e: any) {
            if (!isGenerationRunCurrent(runId)) return;
            if (isInterrupt(e)) {
                markInterrupted("planning");
                return;
            }
            setGenerateError(e);
            appendGenLog("× " + genTask.error);
            return;
        }
    }

    const resumeFromClarify = resumePhase === "clarifying" || resumePhase === "awaiting_input";
    if (!resumePrepared || resumeFromClarify) {
        try {
            if (!resumePrepared) setPhase("clarifying", "进入澄清阶段，请回答问题...");
            await runClarifyStage(resumeFromClarify ? resumePhase : "");
        } catch (e: any) {
            if (!isGenerationRunCurrent(runId)) {
                if (isInterrupt(e)) fetchMe();
                return;
            }
            if (isInterrupt(e)) {
                markInterrupted(genTask.phase === "interrupted" ? genTask.interruptedFrom : "clarifying");
                fetchMe();
                return;
            }
            setGenerateError(e);
            appendGenLog("× " + genTask.error);
            persistGenTaskNow();
            return;
        }
    }

    const resumeFromGrade = resumePhase === "grading" || resumePhase === "confirming";
    if (!resumePrepared || resumeFromClarify || resumeFromGrade) {
        try {
            const selectedPathId = await runGradeStage(resumeFromGrade ? resumePhase : "");
            if (selectedPathId !== undefined) chosenPathId = selectedPathId;
        } catch (e: any) {
            if (!isGenerationRunCurrent(runId)) {
                if (isInterrupt(e)) fetchMe();
                return;
            }
            if (isInterrupt(e)) {
                markInterrupted(genTask.phase === "interrupted" ? genTask.interruptedFrom : "grading");
                fetchMe();
                return;
            }
            // 未收到明确 terminal result 时禁止静默跳过分级进入 Planner。
            setGenerateError(e);
            appendGenLog("× " + genTask.error);
            persistGenTaskNow();
            return;
        }
    }

    chosenPathId = genTask.chosenPathId || chosenPathId;

    // Learning 的触发权交给后续 DS coding agent；这里仅进入规划，不再根据 Grader 结果抢跑。
    setPhase("planning", "开始规划；DS 可在需要精确外部 API 证据时主动调用 Learning...");

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
                appendGenLog(`↻ 第 ${replanAttempt} 次重新规划，从头开始生成...`);
                genTask.files = [];
                genTask.currentIndex = 0;
                clearGenerateError();
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

            const plannerLearningToolJobs: Record<string, string> = {};
            let planResult: any;
            let learningContinuation: LearningContinuationDeadline | undefined;
            try {
                while (true) {
                    learningContinuation?.assertActive();
                    planResult = await postPlanner({
                        taskId: genTask.taskId,
                        chosenPathId,
                        skillIds: [...selected],
                        replan: plannerReplan,
                        plannerRequestId,
                        learningToolJobs: plannerLearningToolJobs,
                    }, learningContinuation);
                    if (!modelLearningToolRequests(planResult?.learningToolRequests).length) break;
                    learningContinuation ??= createLearningContinuationDeadline(
                        GEN_TASK_TTL_MS,
                        "Planner 的 Learning 对话超过任务时限，已停止继续调用工具",
                        generationSignal(),
                    );
                    await runModelLearningToolRequests(
                        planResult?.learningToolRequests,
                        plannerLearningToolJobs,
                        learningContinuation,
                    );
                    setPhase("planning", "Learning 已返回，Planner 继续规划...");
                }
            } finally {
                learningContinuation?.dispose();
            }
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
            syncCurrentIndex();
            genTask.plannerRequestId = "";
            genTask.plannerReplan = false;
            genTask.plannerAttempt = 0;
            appendGenLog(`● 项目规划完成，共 ${genTask.files.length} 个文件`);
            persistGenTaskNow();

            setPhase("generating");
            // 收集 buckets：每个 file 自带 bucket 索引；按桶号升序并发
            const bucketMap = new Map<number, number>();
            for (const f of genTask.files) {
                const b = f.bucket ?? 0;
                bucketMap.set(b, (bucketMap.get(b) ?? 0) + 1);
            }
            const sortedBucketIds = [...bucketMap.keys()].sort((a, b) => a - b);
            const learningToolJobs: Record<string, string> = {};
            let needReplan = false;

            let allBucketsDone = false;
            outer: for (const bucketIndex of sortedBucketIds) {
                if (needReplan) break;
                // 桶按持久化阶段推进：每次请求每个目标最多一次模型调用，阶段完成后立即落盘。
                // 流中断时重试同一桶，服务端从 checkpoint 继续。
                let bucketDone = false;
                let guard = 0;
                let noProgress = 0;
                const guardLimit = Math.max(80, (bucketMap.get(bucketIndex) ?? 1) * 16 + 20);
                const doneCount = () => genTask.files.filter(f => f.status === "done").length;
                while (!bucketDone) {
                    if (guard++ > guardLimit) { // 安全阀，防意外死循环
                        throw new Error(`桶 #${bucketIndex} 阶段推进次数异常，已保留当前进度`);
                    }
                    // 单阶段重试一次；服务端会从已持久化检查点继续。
                    const doneBefore = doneCount();
                    let bucketResult: any = null;
                    for (let bAttempt = 0; bAttempt < 2 && !bucketResult; bAttempt++) {
                        try {
                            bucketResult = await streamBucketGeneration(genTask.taskId, bucketIndex, learningToolJobs);
                        } catch (be: any) {
                            if (isInterrupt(be)) throw be;
                            if (be?.noRetry || be?.terminal) throw be;
                            const m = be?.name === "AbortError" ? "超时" : (be?.message || String(be));
                            appendGenLog(`× 桶 #${bucketIndex} 批次中断（${m}）${bAttempt === 0 ? "，重试一次..." : ""}`);
                            bucketResult = null;
                        }
                    }
                    if (!bucketResult) {
                        // 流被切断不等于生成失败；直接重试同一阶段，禁止用重新规划覆盖已有进度。
                        if (doneCount() > doneBefore) {
                            noProgress = 0;
                            appendGenLog(`· 桶 #${bucketIndex} 连接中断但已落地文件，继续恢复...`);
                            continue;
                        }
                        if (++noProgress >= 5) {
                            throw new Error(`桶 #${bucketIndex} 连续连接中断，阶段进度已保存，请稍后重试`);
                        }
                        appendGenLog(`· 桶 #${bucketIndex} 当前阶段无返回（${noProgress}/5），继续恢复...`);
                        await waitWithAbort(1_500, generationSignal());
                        continue;
                    }
                    if (bucketResult.replan) { needReplan = true; break; }
                    if (await runModelLearningToolRequests(bucketResult.learningToolRequests, learningToolJobs)) {
                        noProgress = 0;
                        continue;
                    }
                    // 服务端每次返回该桶已落盘的完成文件，可修复“落盘后断流”造成的前端状态缺口。
                    for (const c of bucketResult.completed || []) {
                        const f = genTask.files.find(x => x.path === c.path);
                        if (f) { f.content = c.content; f.status = "done"; }
                    }
                    syncCurrentIndex();
                    bucketDone = !!bucketResult.bucketDone;
                    const progressed = bucketResult.progressed === true
                        || doneCount() > doneBefore
                        || bucketDone;
                    if (!progressed) {
                        if (++noProgress >= 5) {
                            throw new Error(`桶 #${bucketIndex} 连续未推进，阶段进度已保存，请稍后重试`);
                        }
                        const retryAfterMs = Math.max(500, Math.min(5_000, Number(bucketResult.retryAfterMs) || 1_500));
                        appendGenLog(`· 桶 #${bucketIndex} 当前阶段暂未推进（${noProgress}/5），稍后重试...`);
                        await waitWithAbort(retryAfterMs, generationSignal());
                        continue;
                    }
                    noProgress = 0;
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
                appendGenLog(`! 缺失 ${missingList.length} 个文件，正在补齐 (第${retry + 1}次)...`);
                await post("/api/generate/verify", { taskId: genTask.taskId, fixMissing: true });

                setPhase("generating");
                for (const mp of missingList) {
                    appendGenLog(`↻ 补生成 ${mp}`);
                    const fileResult = await streamFileGeneration(genTask.taskId);
                    if (!fileResult || fileResult.done) break;
                }

                setPhase("verifying", "正在重新校验...");
                verifyResult = await post("/api/generate/verify", { taskId: genTask.taskId });
            }

            if (!verifyResult.verified) {
                throw new Error(`文件校验失败，缺失 ${verifyResult.missing.length} 个文件: ${verifyResult.missing.join(", ")}`);
            }
            appendGenLog(`● 文件校验通过 (${verifyResult.generated}/${verifyResult.total})`);

            // Build with fix-retry loop
            await buildWithRetry();
            return; // success — exit replan loop
        } catch (e: any) {
            if (!isGenerationRunCurrent(runId)) return;
            if (isInterrupt(e)) {
                markInterrupted(genTask.phase === "interrupted" ? genTask.interruptedFrom : genTask.phase);
                return;
            }
            if (replanAttempt >= MAX_REPLAN_ATTEMPTS) {
                setGenerateError(e);
                appendGenLog("× " + genTask.error);
                return;
            }
            // If error is not from replan, don't retry
            if (!e.message?.includes("重新规划")) {
                setGenerateError(e);
                appendGenLog("× " + genTask.error);
                return;
            }
        }
    }
}

