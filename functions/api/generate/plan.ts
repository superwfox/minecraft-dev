import { plannerPrompt } from "../../_lib/prompts";

const DEEPSEEK_URL = "https://api.deepseek.com/v1/chat/completions";

interface Env {
    DEEPSEEK_API_KEY: string;
    TASKS: KVNamespace;
}

interface PlanFile {
    path: string;
    role: string;
    order: number;
    depends?: string[];
}

/**
 * 对文件列表进行拓扑排序，确保被依赖的文件先生成。
 * depends 中的值是文件名（不含路径前缀），如 "EconomyManager.java"。
 * 如果 AI 返回的 depends 有误（引用不存在的文件），忽略该依赖，退回 order 排序。
 */
function topoSort(files: PlanFile[]): PlanFile[] {
    // 建立文件名 → 完整 path 的映射
    const nameToPath = new Map<string, string>();
    for (const f of files) {
        const fileName = f.path.split("/").pop() ?? f.path;
        nameToPath.set(fileName, f.path);
    }

    // 建立 path → 入度 和 邻接表
    const inDegree = new Map<string, number>();
    const adj = new Map<string, string[]>(); // dep path → [dependent paths]
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

    // Kahn 算法，同层内按 order 排序
    const pathToFile = new Map(files.map(f => [f.path, f]));
    const queue = files
        .filter(f => inDegree.get(f.path) === 0)
        .sort((a, b) => a.order - b.order);
    const sorted: PlanFile[] = [];

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

    // 如果有环或遗漏，把剩余文件按 order 追加
    if (sorted.length < files.length) {
        const sortedPaths = new Set(sorted.map(f => f.path));
        const remaining = files.filter(f => !sortedPaths.has(f.path)).sort((a, b) => a.order - b.order);
        sorted.push(...remaining);
    }

    // 重新编号 order
    sorted.forEach((f, i) => { f.order = i + 1; });
    return sorted;
}

export const onRequestPost: PagesFunction<Env> = async (context) => {
    const { userPrompt, coreType, version } = await context.request.json() as any;
    const key = context.env.DEEPSEEK_API_KEY;
    if (!key) return new Response("API key not configured", { status: 500 });

    const { system, user } = plannerPrompt(userPrompt, coreType, version);

    const resp = await fetch(DEEPSEEK_URL, {
        method: "POST",
        headers: { "Content-Type": "application/json", Authorization: `Bearer ${key}` },
        body: JSON.stringify({
            model: "deepseek-chat",
            messages: [{ role: "system", content: system }, { role: "user", content: user }],
            response_format: { type: "json_object" },
        }),
    });
    if (!resp.ok) return new Response(await resp.text(), { status: resp.status });

    const raw = await resp.json() as any;
    const content = raw.choices?.[0]?.message?.content ?? "";

    let plan: any;
    try {
        plan = JSON.parse(content);
    } catch {
        return new Response(JSON.stringify({ error: "Planner 返回非 JSON", raw: content }), { status: 422 });
    }

    // 拓扑排序：确保被依赖的文件先生成，主类最后
    const sortedFiles = topoSort(plan.files as PlanFile[]);

    const taskId = `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
    const state = {
        taskId,
        status: "planning",
        projectName: plan.projectName,
        javaVersion: plan.javaVersion,
        packageName: plan.packageName,
        coreType,
        version,
        plan: sortedFiles,
        generatedFiles: [],
        currentFileIndex: 0,
        logs: ["Planner 完成，文件树已生成（已按依赖拓扑排序）"],
    };

    await context.env.TASKS.put(taskId, JSON.stringify(state), { expirationTtl: 3600 });

    return new Response(JSON.stringify({ taskId, plan: state.plan, projectName: plan.projectName, packageName: plan.packageName, javaVersion: plan.javaVersion }), {
        headers: { "Content-Type": "application/json" },
    });
};
