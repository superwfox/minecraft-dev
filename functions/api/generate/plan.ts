import { plannerPrompt, skillPlannerContext, GENERATOR_TYPES, type GeneratorType, type MainBlueprint, type PlanFileItem, type PlannerGradeContext } from "../../_lib/prompts";
import { getSkillBundles } from "../../_lib/skills";
import { litAxes } from "../../_lib/complexity";
import { accumulateCost } from "../../_lib/quota";
import { resolveLLM } from "../../_lib/llm";
import { buildApiContractContext } from "../../_lib/apiContracts";
import { loadKnowledgeContext, mergeKnowledgeUsed, recordKnowledgeContextUsage } from "../../_lib/learning/context";
import {
    assessPlannerLearningAuthorization,
    assessPlannerResultAuthorization,
    samePlannerResultAuthorization,
    type PlannerResultAuthorization,
} from "../../_lib/learning/plannerAuthorization";
import {
    acquireTaskPlannerLease,
    assertBoundTaskStoreSchema,
    cleanupExpiredTasks,
    getOwnedTask,
    markTaskQuotaExhausted,
    putTaskState,
    putTaskWithPlannerLease,
    releaseTaskPlannerLease,
    renewTaskPlannerLease,
    TaskStoreUnavailableError,
} from "../../_lib/taskStore";

const DEEPSEEK_URL = "https://api.deepseek.com/v1/chat/completions";
const PLANNER_MODEL = "deepseek-v4-pro";
const PLANNER_PREPARATION_TIMEOUT_MS = 30_000;
const PLANNER_UPSTREAM_TIMEOUT_MS = 300_000;
// 整段 deadline 必须短于租约，避免旧请求过期后仍继续付费或提交。
const PLANNER_OPERATION_TIMEOUT_MS = 350_000;
const PLANNER_LEASE_MS = 360_000;

interface Env {
    DB?: D1Database;
    DEEPSEEK_API_KEY: string;
    TASKS: KVNamespace;
    GITHUB_TOKEN?: string;
}

/**
 * 对文件列表进行拓扑排序，确保被依赖的文件先生成。
 * depends 中的值是文件名（不含路径前缀），如 "EconomyManager.java"。
 * 如果 AI 返回的 depends 有误（引用不存在的文件），忽略该依赖，退回 order 排序。
 */
function topoSort(files: PlanFileItem[]): PlanFileItem[] {
    const nameToPath = new Map<string, string>();
    for (const f of files) {
        const fileName = f.path.split("/").pop() ?? f.path;
        nameToPath.set(fileName, f.path);
    }

    const inDegree = new Map<string, number>();
    const adj = new Map<string, string[]>();
    for (const f of files) {
        inDegree.set(f.path, 0);
        adj.set(f.path, []);
    }

    for (const f of files) {
        for (const dep of f.depends ?? []) {
            const depPath = nameToPath.get(dep);
            if (depPath && depPath !== f.path) {
                adj.get(depPath)!.push(f.path);
                inDegree.set(f.path, (inDegree.get(f.path) ?? 0) + 1);
            }
        }
    }

    const pathToFile = new Map(files.map(f => [f.path, f]));
    const queue = files
        .filter(f => inDegree.get(f.path) === 0)
        .sort((a, b) => a.order - b.order);
    const sorted: PlanFileItem[] = [];

    while (queue.length > 0) {
        const current = queue.shift()!;
        sorted.push(current);
        for (const next of adj.get(current.path) ?? []) {
            const deg = (inDegree.get(next) ?? 1) - 1;
            inDegree.set(next, deg);
            if (deg === 0) {
                queue.push(pathToFile.get(next)!);
                queue.sort((a, b) => a.order - b.order);
            }
        }
    }

    if (sorted.length < files.length) {
        const sortedPaths = new Set(sorted.map(f => f.path));
        const remaining = files.filter(f => !sortedPaths.has(f.path)).sort((a, b) => a.order - b.order);
        sorted.push(...remaining);
    }

    sorted.forEach((f, i) => { f.order = i + 1; });
    return sorted;
}

/**
 * 基于 depends 的可解析关系计算每个文件的深度。
 * depth(f) = 0 if 没有可解析的 depends
 *          = 1 + max(depth(dep)) 否则
 * 不可解析的依赖（引用不存在的文件名）会被忽略。
 * 检测到循环依赖时，对参与循环的节点返回 0（与 topoSort 的兜底一致）。
 */
function computeDepths(files: PlanFileItem[]): Map<string, number> {
    const nameToPath = new Map<string, string>();
    for (const f of files) {
        const fileName = f.path.split("/").pop() ?? f.path;
        nameToPath.set(fileName, f.path);
    }
    const pathToFile = new Map(files.map(f => [f.path, f]));
    const depthCache = new Map<string, number>();
    const visiting = new Set<string>();

    function depthOf(path: string): number {
        if (depthCache.has(path)) return depthCache.get(path)!;
        if (visiting.has(path)) return 0; // 循环依赖兜底
        visiting.add(path);
        const f = pathToFile.get(path);
        if (!f) { visiting.delete(path); return 0; }
        const deps = (f.depends ?? [])
            .map(d => nameToPath.get(d))
            .filter((p): p is string => !!p && p !== path);
        let d = 0;
        if (deps.length > 0) {
            d = 1 + Math.max(...deps.map(depthOf));
        }
        visiting.delete(path);
        depthCache.set(path, d);
        return d;
    }

    for (const f of files) depthOf(f.path);
    return depthCache;
}

function stripFences(raw: string): string {
    return raw.replace(/^```[\w]*\n?/, "").replace(/\n?```\s*$/, "").trim();
}

function isValidBlueprint(bp: any): bp is MainBlueprint {
    if (!bp || typeof bp !== "object") return false;
    if (!Array.isArray(bp.events)) return false;
    if (!Array.isArray(bp.commands)) return false;
    if (!Array.isArray(bp.tasks)) return false;
    if (!Array.isArray(bp.services)) return false;
    if (!bp.config || typeof bp.config !== "object") return false;
    if (!Array.isArray(bp.config.files)) return false;
    return true;
}

export function shouldReusePersistedPlannerResult(
    state: any,
    replan: unknown,
    plannerRequestId = "",
    expectedAuthorization?: PlannerResultAuthorization,
): boolean {
    const sameExplicitReplan = replan === true
        && !!plannerRequestId
        && state?.plannerRequestId === plannerRequestId;
    const authorizationMatches = !expectedAuthorization || samePlannerResultAuthorization(
        state?.plannerResultAuthorization,
        expectedAuthorization,
    );
    return authorizationMatches
        && (replan !== true || sameExplicitReplan)
        && state?.status === "planning"
        && isValidBlueprint(state.mainBlueprint)
        && Array.isArray(state.plan)
        && state.plan.length > 0
        && Array.isArray(state.buckets)
        && state.buckets.length > 0;
}

function plannerResultResponse(taskId: string, state: any): Response {
    return new Response(JSON.stringify({
        taskId,
        plan: state.plan,
        projectName: state.projectName,
        packageName: state.packageName,
        javaVersion: state.javaVersion,
        mainBlueprint: state.mainBlueprint,
        buckets: state.buckets,
    }), {
        headers: { "Content-Type": "application/json" },
    });
}

function parsePlannerRequestId(value: unknown): string {
    return typeof value === "string" && /^plan_[a-z0-9]{16,64}$/i.test(value)
        ? value
        : "";
}

function plannerBusyResponse(): Response {
    return new Response(JSON.stringify({
        error: "Planner 正在执行，请等待现有结果",
        code: "PLANNER_IN_PROGRESS",
    }), {
        status: 409,
        headers: {
            "Content-Type": "application/json",
            "Retry-After": "2",
        },
    });
}

class PlannerTimeoutError extends Error {
    constructor(message: string) {
        super(message);
        this.name = "PlannerTimeoutError";
    }
}

function plannerTimeoutResponse(): Response {
    return new Response(JSON.stringify({
        error: "Planner 处理超时，请重试",
        code: "PLANNER_TIMEOUT",
    }), {
        status: 504,
        headers: { "Content-Type": "application/json" },
    });
}

function createPlannerDeadline(timeoutMs: number, message: string, parent?: AbortSignal) {
    const controller = new AbortController();
    const abortFromParent = () => {
        if (!controller.signal.aborted) {
            controller.abort(parent?.reason instanceof Error ? parent.reason : new PlannerTimeoutError(message));
        }
    };
    if (parent?.aborted) abortFromParent();
    else parent?.addEventListener("abort", abortFromParent, { once: true });
    const timer = setTimeout(() => {
        if (!controller.signal.aborted) controller.abort(new PlannerTimeoutError(message));
    }, timeoutMs);
    return {
        signal: controller.signal,
        dispose() {
            clearTimeout(timer);
            parent?.removeEventListener("abort", abortFromParent);
        },
    };
}

function plannerAbortReason(signal: AbortSignal, message: string): Error {
    return signal.reason instanceof Error ? signal.reason : new PlannerTimeoutError(message);
}

function withPlannerDeadline<T>(operation: () => Promise<T>, signal: AbortSignal, message: string): Promise<T> {
    if (signal.aborted) return Promise.reject(plannerAbortReason(signal, message));
    return new Promise<T>((resolve, reject) => {
        const abort = () => reject(plannerAbortReason(signal, message));
        signal.addEventListener("abort", abort, { once: true });
        let promise: Promise<T>;
        try {
            promise = operation();
        } catch (error) {
            signal.removeEventListener("abort", abort);
            reject(error);
            return;
        }
        promise.then(
            (value) => {
                signal.removeEventListener("abort", abort);
                resolve(value);
            },
            (error) => {
                signal.removeEventListener("abort", abort);
                reject(error);
            },
        );
    });
}

function isPlannerTimeout(error: unknown): boolean {
    return error instanceof PlannerTimeoutError
        || !!error && typeof error === "object" && "name" in error && error.name === "AbortError";
}

export const onRequestPost: PagesFunction<Env> = async (context) => {
    const body = await context.request.json() as any;
    const key = context.env.DEEPSEEK_API_KEY;
    if (!key) return new Response("API key not configured", { status: 500 });
    const uid: string = (context.data as any)?.uid || "";

    // ─── Mode 1: initialize task, no plan yet ───
    if (!body.taskId) {
        try {
            await assertBoundTaskStoreSchema(context.env);
        } catch (error) {
            const message = error instanceof TaskStoreUnavailableError
                ? error.message
                : "D1 任务数据库暂不可用，请稍后重试";
            return new Response(JSON.stringify({
                error: message,
                code: "TASK_STORE_MIGRATION_REQUIRED",
            }), {
                status: 503,
                headers: { "Content-Type": "application/json", "Retry-After": "30" },
            });
        }

        const { userPrompt, coreType, version } = body;
        // 建任务即拉取已挂载 skill，让 clarify / grade / plan / fileGen 全程都能感知能力
        const skillIds: string[] = Array.isArray(body.skillIds) ? body.skillIds : [];
        const skills = skillIds.length ? await getSkillBundles(context.env, skillIds) : [];
        const taskId = `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
        const state = {
            taskId,
            uid,
            status: "clarifying",
            userPrompt,
            coreType,
            version,
            clarifyRounds: [],
            clarifyDone: false,
            projectName: "",
            javaVersion: "",
            packageName: "",
            mainBlueprint: null,
            plan: [],
            buckets: [],
            fileStatuses: {},
            currentBucket: 0,
            generatedFiles: [],
            currentFileIndex: 0,
            skills,
            logs: ["任务已创建，进入澄清阶段"],
        };
        await putTaskState(context.env, taskId, state, 3600, uid);
        context.waitUntil(cleanupExpiredTasks(context.env).catch(() => { }));
        return new Response(JSON.stringify({ taskId }), {
            headers: { "Content-Type": "application/json" },
        });
    }

    // ─── Mode 2: finalize plan using reasoner + clarify answers ───
    const taskId = body.taskId as string;
    const raw = await getOwnedTask(context.env, taskId, uid);
    if (!raw) return new Response("Task not found", { status: 404 });
    const suppliedPlannerRequestId = parsePlannerRequestId(body.plannerRequestId);
    if (body.replan === true && !suppliedPlannerRequestId) {
        return new Response(JSON.stringify({ error: "重新规划请求缺少有效 plannerRequestId" }), {
            status: 400,
            headers: { "Content-Type": "application/json" },
        });
    }
    const plannerRequestId = suppliedPlannerRequestId
        || `plan_${crypto.randomUUID().replace(/-/g, "")}`;
    const leaseToken = `planner_${crypto.randomUUID().replace(/-/g, "")}`;
    let leaseMode;
    try {
        leaseMode = await acquireTaskPlannerLease(
            context.env,
            taskId,
            uid,
            leaseToken,
            PLANNER_LEASE_MS,
        );
    } catch (error) {
        console.warn("planner lease acquisition failed", error);
        return new Response(JSON.stringify({
            error: "Planner 状态存储暂不可用，请稍后重试",
            code: "PLANNER_STORE_UNAVAILABLE",
        }), {
            status: 503,
            headers: { "Content-Type": "application/json", "Retry-After": "2" },
        });
    }
    if (!leaseMode) return plannerBusyResponse();

    const operationDeadline = createPlannerDeadline(
        PLANNER_OPERATION_TIMEOUT_MS,
        "Planner 整体处理超时",
    );
    const preparationDeadline = createPlannerDeadline(
        PLANNER_PREPARATION_TIMEOUT_MS,
        "Planner 上下文准备超时",
        operationDeadline.signal,
    );

    try {
        const latestAfterLeaseRaw = await withPlannerDeadline(
            () => getOwnedTask(context.env, taskId, uid),
            preparationDeadline.signal,
            "读取 Planner 状态超时",
        );
        if (!latestAfterLeaseRaw) {
            return new Response("Task state unavailable", { status: 503 });
        }
        const state = JSON.parse(latestAfterLeaseRaw);

        // ─── 分级确认门：非直接级须先选定实现路径，否则不消耗全量 plan 调用 ───
        const chosenPathId = typeof body.chosenPathId === "string" ? body.chosenPathId.trim() : "";
        const gradePaths = Array.isArray(state.grade?.paths) ? state.grade.paths : [];
        const effectivePathId = chosenPathId || state.grade?.chosenPathId || "";
        const validPath = !!effectivePathId && gradePaths.some((path: any) => path?.id === effectivePathId);
        if (chosenPathId && !validPath) {
            return new Response(JSON.stringify({ error: "无效的实现路径", code: "INVALID_PATH" }), {
                status: 400, headers: { "Content-Type": "application/json" },
            });
        }
        if (state.grade?.gateRequired && !effectivePathId) {
            return new Response(JSON.stringify({ error: "请先在确认门选择实现路径", code: "PATH_NOT_CONFIRMED" }), {
                status: 400, headers: { "Content-Type": "application/json" },
            });
        }
        if (effectivePathId && !validPath) {
            return new Response(JSON.stringify({ error: "已选实现路径不再有效", code: "INVALID_PATH" }), {
                status: 409, headers: { "Content-Type": "application/json" },
            });
        }
        if (chosenPathId && state.grade) state.grade.chosenPathId = chosenPathId;

        const [plannerAssessment, plannerResultAuthorization] = await Promise.all([
            assessPlannerLearningAuthorization(state),
            assessPlannerResultAuthorization(state),
        ]);
        if (!plannerAssessment || !plannerResultAuthorization) {
            return new Response(JSON.stringify({
                error: "Planner 路径授权已失效，请重新确认实现路径",
                code: "PLANNER_AUTHORIZATION_EXPIRED",
            }), {
                status: 409,
                headers: { "Content-Type": "application/json" },
            });
        }

        // 所有结果复用都在租约内读取最新状态，并绑定生成该结果时的路径与 need 集合。
        if (shouldReusePersistedPlannerResult(
            state,
            body.replan,
            plannerRequestId,
            plannerResultAuthorization,
        )) {
            return plannerResultResponse(taskId, state);
        }

        if (state.quotaExhausted) {
            return new Response(JSON.stringify({ error: "本月额度已用尽", code: "QUOTA_EXHAUSTED" }), {
                status: 402, headers: { "Content-Type": "application/json" },
            });
        }

        if (!state.clarifyDone) {
            return new Response(JSON.stringify({ error: "澄清阶段尚未完成" }), {
                status: 400, headers: { "Content-Type": "application/json" },
            });
        }

        // 据分级结果构建 plannerPrompt 的 gradeContext（点亮轴 + 所选路径）
        let gradeContext: PlannerGradeContext | undefined;
        if (state.grade?.vector) {
            const axes = litAxes(state.grade.vector);
            let chosenPath: PlannerGradeContext["chosenPath"];
            const pid = state.grade.chosenPathId;
            if (pid && Array.isArray(state.grade.paths)) {
                const p = state.grade.paths.find((x: any) => x.id === pid);
                if (p) chosenPath = { title: p.title, summary: p.summary, mermaid: p.mermaid };
            }
            if (axes.length || chosenPath) gradeContext = { axes, chosenPath };
        }

        // 据 body.skillIds 拉取用户挂载的 skill（KV 缓存 30min），存入 state 供逐文件生成复用
        const skillIds: string[] = Array.isArray(body.skillIds) ? body.skillIds : [];
        const loadedSkillIds = Array.isArray(state.skills) ? state.skills.map((s: any) => s.id) : [];
        const sameSkills = skillIds.length === loadedSkillIds.length
            && skillIds.every((id, i) => id === loadedSkillIds[i]);
        if (!sameSkills) {
            state.skills = skillIds.length
                ? await withPlannerDeadline(
                    () => getSkillBundles(context.env, skillIds, { signal: preparationDeadline.signal }),
                    preparationDeadline.signal,
                    "加载 Planner Skill 超时",
                )
                : [];
        }
        const skillCtx = state.skills?.length ? skillPlannerContext(state.skills) : "";
        const apiContractInput = {
            coreType: state.coreType,
            version: state.version,
            externalDeps: state.grade?.vector?.external_deps ?? [],
            generatedFiles: state.generatedFiles ?? [],
        };
        const apiContractCtx = buildApiContractContext(apiContractInput);
        const knowledge = await loadKnowledgeContext({
            env: context.env,
            needs: plannerAssessment.needs,
            maxCharacters: 4_800,
            title: "Planner 已验证公共技术知识",
        });
        state.knowledgeUsed = mergeKnowledgeUsed(state.knowledgeUsed, knowledge.used);

        const { system, user } = plannerPrompt(
            state.userPrompt,
            state.coreType,
            state.version,
            state.clarifyRounds,
            gradeContext,
            apiContractCtx,
            knowledge.context,
            skillCtx,
        );

        const llm = await withPlannerDeadline(
            () => resolveLLM(context),
            preparationDeadline.signal,
            "解析 Planner 模型配置超时",
        );
        const renewed = await withPlannerDeadline(
            () => renewTaskPlannerLease(context.env, taskId, uid, leaseToken, PLANNER_LEASE_MS),
            preparationDeadline.signal,
            "续订 Planner 租约超时",
        );
        if (!renewed) return plannerBusyResponse();
        preparationDeadline.dispose();

        const upstreamDeadline = createPlannerDeadline(
            PLANNER_UPSTREAM_TIMEOUT_MS,
            "Planner 模型调用超时",
            operationDeadline.signal,
        );
        let resp: Response;
        let responseText: string;
        try {
            resp = await withPlannerDeadline(() => fetch(llm.url, {
                method: "POST",
                headers: { "Content-Type": "application/json", Authorization: `Bearer ${llm.apiKey}` },
                body: JSON.stringify({
                    model: llm.modelFor("pro"),
                    reasoning_effort: "high",
                    thinking: { type: "enabled" },
                    messages: [{ role: "system", content: system }, { role: "user", content: user }],
                }),
                signal: upstreamDeadline.signal,
            }), upstreamDeadline.signal, "Planner 模型调用超时");
            responseText = await withPlannerDeadline(
                () => resp.text(),
                upstreamDeadline.signal,
                "读取 Planner 模型响应超时",
            );
        } finally {
            upstreamDeadline.dispose();
        }
        if (!resp.ok) return new Response(responseText, { status: resp.status });
        context.waitUntil(recordKnowledgeContextUsage({
            env: context.env,
            items: knowledge.used,
            generationTaskId: taskId,
            stage: "planner",
        }));

        const data = JSON.parse(responseText) as any;
        const content = stripFences(data.choices?.[0]?.message?.content ?? "");

        // 计费：累积 Planner 调用成本到 D1 任务记录（BYOK 自带 key 时跳过）
        if (!llm.byok && uid && data.usage) {
            const cost = await withPlannerDeadline(
                () => accumulateCost(context.env, uid, taskId, llm.modelFor("pro"), data.usage),
                operationDeadline.signal,
                "结算 Planner 用量超时",
            );
            state.totalCost = cost.total;
            state.consumedQuota = cost.consumed;
            if (cost.outOfQuota) {
                state.quotaExhausted = true;
                await withPlannerDeadline(
                    () => markTaskQuotaExhausted(context.env, taskId, uid),
                    operationDeadline.signal,
                    "持久化 Planner 配额状态超时",
                );
            }
        }

        let plan: any;
        try {
            plan = JSON.parse(content);
        } catch {
            return new Response(JSON.stringify({ error: "Planner 返回非 JSON", raw: content }), { status: 422 });
        }

        // —— 蓝图校验 ——
        if (!isValidBlueprint(plan.mainBlueprint)) {
            return new Response(JSON.stringify({
                error: "Planner 缺少有效的 mainBlueprint",
                raw: plan,
            }), { status: 422 });
        }
        const blueprint = plan.mainBlueprint as MainBlueprint;

        // —— 文件项校验：每个文件必须带合法的 generatorType ——
        if (!Array.isArray(plan.files) || plan.files.length === 0) {
            return new Response(JSON.stringify({ error: "Planner 未返回 files 数组" }), { status: 422 });
        }
        const validTypes = new Set<string>(GENERATOR_TYPES);
        for (const f of plan.files) {
            if (!f.path || !f.role || typeof f.order !== "number") {
                return new Response(JSON.stringify({
                    error: "文件项缺少 path/role/order", file: f,
                }), { status: 422 });
            }
            if (!f.generatorType || !validTypes.has(f.generatorType)) {
                return new Response(JSON.stringify({
                    error: `非法 generatorType: ${f.generatorType}`, file: f,
                }), { status: 422 });
            }
        }

        const files = plan.files as PlanFileItem[];

        // —— 拓扑排序（保证 order 单调，依赖在前） ——
        const sortedFiles = topoSort(files);

        // —— 计算深度桶 ——
        const depthMap = computeDepths(sortedFiles);
        let maxDepth = 0;
        for (const d of depthMap.values()) if (d > maxDepth) maxDepth = d;

        // MainGen 强制放到最后一桶 (maxDepth + 1)
        const mainGenBucket = maxDepth + 1;
        for (const f of sortedFiles) {
            if (f.generatorType === "MainGen") {
                f.bucket = mainGenBucket;
            } else {
                f.bucket = depthMap.get(f.path) ?? 0;
            }
        }

        // 构建桶数组：buckets[d] = 该深度的所有文件
        const totalBuckets = mainGenBucket + 1;
        const buckets: PlanFileItem[][] = Array.from({ length: totalBuckets }, () => []);
        for (const f of sortedFiles) {
            buckets[f.bucket!].push(f);
        }

        // 初始化每文件状态
        const fileStatuses: Record<string, "pending" | "generating" | "done" | "error" | "rework"> = {};
        for (const f of sortedFiles) fileStatuses[f.path] = "pending";

        state.status = "planning";
        state.projectName = plan.projectName;
        state.javaVersion = plan.javaVersion;
        state.packageName = plan.packageName;
        state.mainBlueprint = blueprint;
        state.plan = sortedFiles;
        state.buckets = buckets;
        state.fileStatuses = fileStatuses;
        state.currentBucket = 0;
        state.plannerRequestId = plannerRequestId;
        state.plannerResultAuthorization = plannerResultAuthorization;
        state.logs.push(`Planner 完成，${sortedFiles.length} 个文件分布在 ${totalBuckets} 个深度桶`);

        const committed = await withPlannerDeadline(() => putTaskWithPlannerLease(
            context.env,
            taskId,
            JSON.stringify(state),
            leaseToken,
            leaseMode,
            3600,
            uid,
        ), operationDeadline.signal, "提交 Planner 结果超时");
        if (!committed) {
            const latestRaw = await withPlannerDeadline(
                () => getOwnedTask(context.env, taskId, uid),
                operationDeadline.signal,
                "读取并发 Planner 结果超时",
            );
            if (latestRaw) {
                try {
                    const latest = JSON.parse(latestRaw);
                    if (shouldReusePersistedPlannerResult(
                        latest,
                        body.replan,
                        plannerRequestId,
                        plannerResultAuthorization,
                    )) {
                        return plannerResultResponse(taskId, latest);
                    }
                } catch { /* wait for the current lease holder */ }
            }
            return plannerBusyResponse();
        }

        return plannerResultResponse(taskId, state);
    } catch (error) {
        if (isPlannerTimeout(error) || operationDeadline.signal.aborted || preparationDeadline.signal.aborted) {
            return plannerTimeoutResponse();
        }
        throw error;
    } finally {
        preparationDeadline.dispose();
        operationDeadline.dispose();
        await releaseTaskPlannerLease(
            context.env,
            taskId,
            uid,
            leaseToken,
            leaseMode,
        ).catch((error) => console.warn("planner lease release failed", error));
    }
};
