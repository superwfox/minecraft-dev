import { plannerPrompt, skillPlannerContext, GENERATOR_TYPES, type GeneratorType, type MainBlueprint, type PlanFileItem, type PlannerGradeContext } from "../../_lib/prompts";
import { getSkillBundles } from "../../_lib/skills";
import { litAxes } from "../../_lib/complexity";
import { accumulateCost } from "../../_lib/quota";
import { resolveLLM } from "../../_lib/llm";

const DEEPSEEK_URL = "https://api.deepseek.com/v1/chat/completions";
const PLANNER_MODEL = "deepseek-v4-pro";

interface Env {
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

export const onRequestPost: PagesFunction<Env> = async (context) => {
    const body = await context.request.json() as any;
    const key = context.env.DEEPSEEK_API_KEY;
    if (!key) return new Response("API key not configured", { status: 500 });

    // ─── Mode 1: initialize task, no plan yet ───
    if (!body.taskId) {
        const { userPrompt, coreType, version } = body;
        // 建任务即拉取已挂载 skill，让 clarify / grade / plan / fileGen 全程都能感知能力
        const skillIds: string[] = Array.isArray(body.skillIds) ? body.skillIds : [];
        const skills = skillIds.length ? await getSkillBundles(context.env, skillIds) : [];
        const taskId = `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
        const state = {
            taskId,
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
        await context.env.TASKS.put(taskId, JSON.stringify(state), { expirationTtl: 3600 });
        return new Response(JSON.stringify({ taskId }), {
            headers: { "Content-Type": "application/json" },
        });
    }

    // ─── Mode 2: finalize plan using reasoner + clarify answers ───
    const taskId = body.taskId as string;
    const raw = await context.env.TASKS.get(taskId);
    if (!raw) return new Response("Task not found", { status: 404 });
    const state = JSON.parse(raw);

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

    // ─── 分级确认门：非直接级须先选定实现路径，否则不消耗全量 plan 调用 ───
    const chosenPathId = body.chosenPathId as string | undefined;
    if (state.grade?.gateRequired) {
        if (chosenPathId) state.grade.chosenPathId = chosenPathId;
        if (!state.grade.chosenPathId) {
            return new Response(JSON.stringify({ error: "请先在确认门选择实现路径", code: "PATH_NOT_CONFIRMED" }), {
                status: 400, headers: { "Content-Type": "application/json" },
            });
        }
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
        state.skills = skillIds.length ? await getSkillBundles(context.env, skillIds) : [];
    }
    const skillCtx = state.skills?.length ? skillPlannerContext(state.skills) : "";

    const { system, user } = plannerPrompt(state.userPrompt, state.coreType, state.version, state.clarifyRounds, gradeContext, skillCtx);

    const llm = await resolveLLM(context);
    const resp = await fetch(llm.url, {
        method: "POST",
        headers: { "Content-Type": "application/json", Authorization: `Bearer ${llm.apiKey}` },
        body: JSON.stringify({
            model: llm.modelFor("pro"),
            reasoning_effort: "high",
            thinking: { type: "enabled" },
            messages: [{ role: "system", content: system }, { role: "user", content: user }],
        }),
    });
    if (!resp.ok) return new Response(await resp.text(), { status: resp.status });

    const data = await resp.json() as any;
    const content = stripFences(data.choices?.[0]?.message?.content ?? "");

    // 计费：累积 Planner 调用成本到 taskCost:<taskId>（BYOK 自带 key 时跳过）
    const uid: string | undefined = (context.data as any)?.uid;
    if (!llm.byok && uid && data.usage) {
        const cost = await accumulateCost(context.env.TASKS, uid, taskId, llm.modelFor("pro"), data.usage);
        state.totalCost = cost.total;
        state.consumedQuota = cost.consumed;
        if (cost.outOfQuota) state.quotaExhausted = true;
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
    state.logs.push(`Planner 完成，${sortedFiles.length} 个文件分布在 ${totalBuckets} 个深度桶`);

    await context.env.TASKS.put(taskId, JSON.stringify(state), { expirationTtl: 3600 });

    return new Response(JSON.stringify({
        taskId,
        plan: state.plan,
        projectName: plan.projectName,
        packageName: plan.packageName,
        javaVersion: plan.javaVersion,
        mainBlueprint: blueprint,
        buckets,
    }), {
        headers: { "Content-Type": "application/json" },
    });
};
