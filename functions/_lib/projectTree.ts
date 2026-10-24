import { inferGeneratorType, type GeneratorType, type MainBlueprint, type PlanFileItem } from "./prompts";
import type { KnowledgeNeed } from "./learning/types";
import type { ModelToolCall } from "./learning/tool";

export type TreeModuleKind = "business" | "common" | "system";
export type TreeNodeOrigin = "system" | "planner" | "review";
export type TreeStatus = "drafting" | "ready" | "locked";
export interface NodeContract {
    methods: { name: string; params: string; returns: string; isStatic: boolean }[];
    constructors: { params: string }[];
    events: string[];
    commands: { name: string; aliases: string[]; permission: string; usage: string; description: string }[];
    schedule: { mode: "timer" | "once" | "async"; periodTicks: number; delayTicks: number } | null;
    configKeys: string[];
    lifecycle: "onEnable" | "lazy" | null;
}
export interface TreeModule { id: string; title: string; responsibility: string; kind: TreeModuleKind }
export interface TreeNode {
    id: string; moduleId: string; kind: GeneratorType; title: string; responsibility: string;
    depends: string[]; contract: NodeContract; tag: "gui" | null; pairId: string; origin: TreeNodeOrigin;
}
export interface ProjectTree {
    schemaVersion: 1; revision: number; lockedRevision: number | null; status: TreeStatus;
    project: { projectName: string; packageName: string; javaVersion: string; summary: string; externalDeps: string[] };
    modules: TreeModule[]; nodes: TreeNode[]; knowledgeNeeds: KnowledgeNeed[];
}
export interface TreeIssue { code: string; message: string; targetId?: string }
export interface TreeOpResult { index: number; tool: string; ok: boolean; summary: string; error?: string }
export interface NodeContractCheck {
    nodeId: string; revision: number; items: { key: string; label: string; ok: boolean }[]; passed: number; total: number;
}
export interface TreeSession {
    mode: "build" | "refine"; round: number; status: "continue" | "learning" | "ready" | "failed";
    correction: string; focusIds: string[]; issues: TreeIssue[]; lastResults: TreeOpResult[];
    emptyRounds: number; learningRequestId: string | null;
}
export const MAX_TREE_MODULES = 10;
export const MAX_TREE_NODES = 40;
export const MAX_TREE_ROUNDS = 8;
export const MAX_TREE_TOOL_CALLS = 60;
export const SYSTEM_MODULE_IDS = ["_build", "_resources", "_root"] as const;
export const TREE_TOOL_NAMES = ["set_project", "upsert_module", "upsert_node", "remove_items", "merge_nodes", "finish_tree"] as const;
export const JAVA_KEYWORDS = new Set("abstract assert boolean break byte case catch char class const continue default do double else enum extends final finally float for goto if implements import instanceof int interface long native new package private protected public return short static strictfp super switch synchronized this throw throws transient try void volatile while _ var record yield sealed permits non-sealed true false null".split(" "));
const JAVA_KINDS: GeneratorType[] = ["CommandGen", "ListenerGen", "TaskGen", "ManagerGen", "ConfigClassGen", "ModelGen", "EnumGen", "UtilGen"];
const lower = (value: string) => value.toLowerCase();
const unique = (values: string[]) => [...new Set(values)];
export const emptyNodeContract = (): NodeContract => ({ methods: [], constructors: [], events: [], commands: [], schedule: null, configKeys: [], lifecycle: null });
export function packageNameFor(name: string): string { return `com.tahai.${name.toLowerCase()}`; }
export function javaVersionFor(version: string): string {
    const [major, minor] = version.split(".").map(Number);
    return major >= 26 ? "25" : major === 1 && minor >= 20 ? "21" : major === 1 && minor >= 17 ? "17" : major === 1 && minor >= 13 ? "11" : "8";
}
export function createInitialTree(_coreType: string, version: string): ProjectTree {
    const modules: TreeModule[] = [
        { id: "_build", title: "构建", responsibility: "Maven 构建配置", kind: "system" },
        { id: "_resources", title: "资源", responsibility: "插件描述与 YAML 资源", kind: "system" },
        { id: "_root", title: "主类", responsibility: "插件生命周期与注册", kind: "system" },
    ];
    const nodes = [
        { id: "pom.xml", moduleId: "_build", kind: "FileRelatedGen", title: "构建配置", responsibility: "Maven 构建配置" },
        { id: "plugin.yml", moduleId: "_resources", kind: "ConfigGen", title: "插件描述", responsibility: "声明插件、命令、权限与外部依赖" },
        { id: "Main", moduleId: "_root", kind: "MainGen", title: "插件主类", responsibility: "插件生命周期、命令监听注册、任务调度与数据落盘" },
    ].map(node => ({ ...node, kind: node.kind as GeneratorType, depends: [], contract: emptyNodeContract(), tag: null, pairId: "", origin: "system" as const }));
    return { schemaVersion: 1, revision: 0, lockedRevision: null, status: "drafting", project: { projectName: "", packageName: "", javaVersion: javaVersionFor(version), summary: "", externalDeps: [] }, modules, nodes, knowledgeNeeds: [] };
}
export function nodePackage(tree: ProjectTree, node: TreeNode): string {
    return node.moduleId === "_root" ? tree.project.packageName : `${tree.project.packageName}.${node.moduleId}`;
}
export function nodePath(tree: ProjectTree, node: TreeNode): string {
    if (node.moduleId === "_build") return node.id;
    if (node.moduleId === "_resources") return `src/main/resources/${node.id}`;
    return `src/main/java/${nodePackage(tree, node).replace(/\./g, "/")}/${node.id}.java`;
}
export function nodeFqcn(tree: ProjectTree, node: TreeNode): string {
    return ["_build", "_resources"].includes(node.moduleId) ? "" : `${nodePackage(tree, node)}.${node.id}`;
}
export function findNodeByPath(tree: ProjectTree, path: string): TreeNode | undefined {
    return tree.nodes.find(node => nodePath(tree, node) === path);
}

type JsonSchema = Record<string, unknown>;
const str = (maxLength = 600): JsonSchema => ({ type: "string", maxLength });
const list = (items: JsonSchema, maxItems: number): JsonSchema => ({ type: "array", items, maxItems });
const obj = (properties: Record<string, JsonSchema>): JsonSchema => ({ type: "object", properties, required: Object.keys(properties), additionalProperties: false });
const choice = (values: readonly string[]): JsonSchema => ({ type: "string", enum: [...values] });
export function treeToolDefinitions() {
    const contract = obj({
        methods: list(obj({ name: str(48), params: str(400), returns: str(160), isStatic: { type: "boolean" } }), 12),
        constructors: list(obj({ params: str(400) }), 3), events: list(str(80), 8),
        commands: list(obj({ name: str(48), aliases: list(str(48), 12), permission: str(120), usage: str(200), description: str(300) }), 6),
        schedule: obj({ mode: choice(["timer", "once", "async", "none"]), periodTicks: { type: "integer", minimum: 0 }, delayTicks: { type: "integer", minimum: 0 } }),
        configKeys: list(str(120), 20), lifecycle: choice(["onEnable", "lazy", "none"]),
    });
    const node = obj({ id: str(48), moduleId: str(24), kind: choice([...JAVA_KINDS, "ConfigGen"]), title: str(24), responsibility: str(600), depends: list(str(48), 12), contract, tag: choice(["gui", "none"]), pairId: str(48) });
    const definitions: [string, string, JsonSchema][] = [
        ["set_project", "设置项目名、摘要和外部插件依赖", obj({ projectName: str(40), summary: str(1000), externalDeps: list(str(41), 4) })],
        ["upsert_module", "新增或更新业务模块（Java 子包）", obj({ id: str(24), title: str(20), responsibility: str(300) })],
        ["upsert_node", "新增、移动或整体替换文件节点及其成员契约", node],
        ["remove_items", "删除模块或节点并清理依赖", obj({ moduleIds: list(str(24), 10), nodeIds: list(str(48), 40), reason: str() })],
        ["merge_nodes", "合并节点并重写依赖与 GUI 配对引用", obj({ sourceIds: { ...list(str(48), 6), minItems: 2 }, target: node, reason: str() })],
        ["finish_tree", "完成结构规划并提交校验", obj({ summary: str(1000) })],
    ];
    return definitions.map(([name, description, parameters]) => ({ type: "function" as const, function: { name, description, parameters } }));
}
function requireValue(condition: unknown, message: string): asserts condition { if (!condition) throw new Error(message); }
function text(value: unknown, max: number, allowEmpty = false): string {
    requireValue(typeof value === "string" && value.trim().length <= max && (allowEmpty || value.trim().length > 0), `文字长度必须为 ${allowEmpty ? 0 : 1}–${max}`);
    return value.trim();
}
function strings(value: unknown, max: number, pattern?: RegExp): string[] {
    requireValue(Array.isArray(value) && value.length <= max, `列表最多 ${max} 项`);
    const values = value.map(item => text(item, 200));
    requireValue(!pattern || values.every(item => pattern.test(item)), "列表中存在非法值");
    return unique(values);
}
function record(value: unknown): Record<string, unknown> {
    requireValue(!!value && typeof value === "object" && !Array.isArray(value), "必须提供对象");
    return value as Record<string, unknown>;
}
function boundedRecords(value: unknown, max: number): Record<string, unknown>[] {
    requireValue(Array.isArray(value) && value.length <= max, `列表最多 ${max} 项`);
    return value.map(record);
}
function normalizeContract(value: unknown): NodeContract {
    const c = record(value);
    const schedule = c.schedule == null ? null : record(c.schedule);
    requireValue(!schedule || ["timer", "once", "async", "none"].includes(String(schedule.mode)), "非法调度模式");
    if (schedule && schedule.mode !== "none") for (const key of ["periodTicks", "delayTicks"]) requireValue(Number.isSafeInteger(schedule[key]) && Number(schedule[key]) >= 0, "调度 tick 必须为非负整数");
    requireValue(!schedule || schedule.mode !== "timer" || Number(schedule.periodTicks) > 0, "周期任务 periodTicks 必须大于 0");
    requireValue([null, "none", "onEnable", "lazy"].includes(c.lifecycle as string | null), "非法生命周期");
    return {
        methods: boundedRecords(c.methods, 12).map(m => {
            requireValue(typeof m.isStatic === "boolean", "isStatic 必须为布尔值");
            const name = text(m.name, 48); requireValue(/^[a-zA-Z_$][\w$]*$/.test(name), "非法方法名");
            return { name, params: text(m.params, 400, true), returns: text(m.returns, 160), isStatic: m.isStatic };
        }),
        constructors: boundedRecords(c.constructors, 3).map(c => ({ params: text(c.params, 400, true) })),
        events: strings(c.events, 8, /^[A-Z]\w*Event$/),
        commands: boundedRecords(c.commands, 6).map(c => {
            const name = text(c.name, 48); requireValue(/^[a-z][a-z0-9_-]*$/.test(name), "非法命令名");
            return { name, aliases: strings(c.aliases, 12, /^[a-z][a-z0-9_-]*$/), permission: text(c.permission, 120, true), usage: text(c.usage, 200, true), description: text(c.description, 300, true) };
        }),
        schedule: !schedule || schedule.mode === "none" ? null : { mode: schedule.mode as "timer" | "once" | "async", periodTicks: Number(schedule.periodTicks), delayTicks: Number(schedule.delayTicks) },
        configKeys: strings(c.configKeys, 20, /^[a-z0-9_-]+(\.[a-z0-9_-]+)*$/),
        lifecycle: !c.lifecycle || c.lifecycle === "none" ? null : c.lifecycle as "onEnable" | "lazy",
    };
}
function upsertNode(tree: ProjectTree, input: Record<string, unknown>): TreeNode {
    const id = text(input.id, 48), moduleId = text(input.moduleId, 24);
    const existing = tree.nodes.find(n => lower(n.id) === lower(id));
    requireValue(!existing || existing.id === id, "节点 id 不得仅大小写不同");
    requireValue(!existing || existing.origin !== "system", "系统节点不可修改");
    requireValue(tree.modules.some(m => m.id === moduleId), "目标模块不存在");
    const resource = moduleId === "_resources";
    requireValue(resource ? input.kind === "ConfigGen" && /^[a-z][a-z0-9_-]{0,39}\.yml$/.test(id) && id !== "plugin.yml" : /^[A-Z][A-Za-z0-9]{1,47}$/.test(id) && id !== "Main" && JAVA_KINDS.includes(input.kind as GeneratorType) && !moduleId.startsWith("_"), "节点 id、类型或模块不合法");
    const count = tree.nodes.filter(n => n.origin !== "system").length;
    requireValue(!!existing || count < MAX_TREE_NODES, "超出节点数上限");
    const tag = input.tag === "gui" ? "gui" as const : null;
    requireValue(["gui", "none", null].includes(input.tag as string | null), "非法节点标签");
    const node: TreeNode = { id, moduleId, kind: input.kind as GeneratorType, title: text(input.title, 24), responsibility: text(input.responsibility, 600), depends: strings(input.depends, 12), contract: normalizeContract(input.contract), tag, pairId: tag ? text(input.pairId, 48, true) : "", origin: "planner" };
    if (existing) tree.nodes.splice(tree.nodes.indexOf(existing), 1, node); else tree.nodes.push(node);
    return node;
}
export function applyTreeToolCalls(input: ProjectTree, calls: ModelToolCall[]): { tree: ProjectTree; results: TreeOpResult[]; finishRequested: boolean } {
    let tree = structuredClone(input);
    const results: TreeOpResult[] = [];
    let finishRequested = false;
    calls.forEach((call, index) => {
        const tool = call.function.name;
        try {
            requireValue(tree.status !== "locked", "结构树已锁定");
            requireValue(index < MAX_TREE_TOOL_CALLS, "超出单轮工具调用上限");
            const args = record(JSON.parse(call.function.arguments));
            // A failed operation must not leave half a merge or deletion behind.
            const next = structuredClone(tree);
            let summary: string;
            if (tool === "set_project") {
                const name = text(args.projectName, 40);
                requireValue(/^[A-Z][A-Za-z0-9]{2,39}$/.test(name), "项目名必须为 PascalCase");
                next.project = { ...next.project, projectName: name, packageName: packageNameFor(name), summary: text(args.summary, 1000, true), externalDeps: strings(args.externalDeps, 4, /^[A-Za-z][A-Za-z0-9_-]{1,40}$/) };
                summary = `✎ 项目 ${name}`;
            } else if (tool === "upsert_module") {
                const id = text(args.id, 24);
                requireValue(/^[a-z][a-z0-9]{1,23}$/.test(id) && !JAVA_KEYWORDS.has(id), "非法模块 id 或 Java 关键字");
                const existing = next.modules.find(m => lower(m.id) === lower(id));
                requireValue(!existing || existing.id === id, "模块 id 不得仅大小写不同");
                requireValue(!!existing || next.modules.filter(m => m.kind !== "system").length < MAX_TREE_MODULES, "超出模块数上限");
                const module: TreeModule = { id, title: text(args.title, 20), responsibility: text(args.responsibility, 300), kind: id === "common" ? "common" : "business" };
                if (existing) next.modules.splice(next.modules.indexOf(existing), 1, module); else next.modules.push(module);
                summary = `${existing ? "✎" : "＋"} 模块 ${id}（${module.title}）`;
            } else if (tool === "upsert_node") {
                const exists = next.nodes.some(n => n.id === args.id);
                const node = upsertNode(next, args);
                summary = exists ? `✎ 节点 ${node.id}` : `＋ 节点 ${node.moduleId}/${node.id}`;
            } else if (tool === "remove_items") {
                const moduleIds = strings(args.moduleIds, 10), nodeIds = strings(args.nodeIds, 40);
                requireValue(!moduleIds.some(id => id.startsWith("_")) && !next.nodes.some(n => n.origin === "system" && nodeIds.includes(n.id)), "系统模块和节点不可删除");
                const removed = new Set(next.nodes.filter(n => nodeIds.includes(n.id) || moduleIds.includes(n.moduleId)).map(n => n.id));
                next.modules = next.modules.filter(m => !moduleIds.includes(m.id));
                next.nodes = next.nodes.filter(n => !removed.has(n.id)).map(n => ({ ...n, depends: n.depends.filter(id => !removed.has(id)), pairId: removed.has(n.pairId) ? "" : n.pairId }));
                summary = `－ 节点 ${[...removed].join("、")}`;
            } else if (tool === "merge_nodes") {
                const sourceIds = strings(args.sourceIds, 6);
                requireValue(sourceIds.length >= 2 && sourceIds.every(id => next.nodes.some(n => n.id === id && n.origin !== "system")), "合并必须包含 2–6 个非系统节点");
                const targetArgs = record(args.target);
                requireValue(!next.nodes.some(n => n.id === targetArgs.id && !sourceIds.includes(n.id)), "合并目标不能覆盖其他节点");
                next.nodes = next.nodes.filter(n => !sourceIds.includes(n.id));
                const target = upsertNode(next, targetArgs);
                for (const node of next.nodes) {
                    node.depends = unique(node.depends.map(id => sourceIds.includes(id) ? target.id : id)).filter(id => id !== node.id);
                    node.pairId = sourceIds.includes(node.pairId) ? target.id : node.pairId;
                    if (node.pairId === node.id) node.pairId = "";
                }
                summary = `⇄ 合并 ${sourceIds.join("、")} → ${target.id}`;
            } else if (tool === "finish_tree") { summary = "✓ 提交结构树"; finishRequested = true; }
            else throw new Error("未知结构树工具");
            next.revision++;
            next.status = "drafting";
            tree = next;
            results.push({ index, tool, ok: true, summary });
        } catch (error) { results.push({ index, tool, ok: false, summary: "操作失败", error: error instanceof Error ? error.message : String(error) }); }
    });
    return { tree, results, finishRequested };
}
export function validateProjectTree(tree: ProjectTree): TreeIssue[] {
    const issues: TreeIssue[] = [];
    const add = (code: string, message: string, targetId?: string) => issues.push({ code, message, ...(targetId ? { targetId } : {}) });
    if (!tree.project.projectName) add("PROJECT_NOT_SET", "请设置项目名称");
    if (!tree.nodes.some(n => n.origin !== "system")) add("NO_BUSINESS_NODE", "请添加业务文件节点");
    for (const module of tree.modules) if (module.kind !== "system" && !tree.nodes.some(n => n.moduleId === module.id)) add("EMPTY_MODULE", `模块 ${module.id} 没有节点`, module.id);
    const byId = new Map(tree.nodes.map(n => [n.id, n]));
    const commandNames = new Set<string>();
    for (const node of tree.nodes) {
        for (const id of node.depends) {
            if (id === node.id) add("SELF_DEPEND", `${node.id} 不能依赖自身`, node.id);
            else if (!byId.has(id)) add("DANGLING_DEPEND", `${node.id} 依赖不存在的 ${id}`, node.id);
        }
        const pair = byId.get(node.pairId);
        if (node.tag === "gui" && (!pair || pair.id === node.id || pair.tag !== "gui" || pair.pairId !== node.id || ![...node.contract.events, ...pair.contract.events].includes("InventoryClickEvent"))) add("GUI_PAIR_INVALID", `${node.id} 的 GUI 配对不完整`, node.id);
        if (node.kind === "CommandGen" && !node.contract.commands.length) add("COMMAND_CONTRACT_MISSING", `${node.id} 缺少命令契约`, node.id);
        if (node.kind === "ListenerGen" && !node.contract.events.length && !(node.tag === "gui" && pair?.contract.events.length)) add("EVENT_CONTRACT_MISSING", `${node.id} 缺少事件契约`, node.id);
        if (node.kind === "TaskGen" && !node.contract.schedule) add("SCHEDULE_MISSING", `${node.id} 缺少调度契约`, node.id);
        for (const cmd of node.contract.commands) for (const name of [cmd.name, ...cmd.aliases]) {
            if (commandNames.has(lower(name))) add("DUPLICATE_COMMAND", `命令或别名 ${name} 重复`, node.id);
            commandNames.add(lower(name));
        }
        const compatible = node.origin === "system"
            ? (node.id === "pom.xml" && node.moduleId === "_build" && node.kind === "FileRelatedGen") || (node.id === "plugin.yml" && node.moduleId === "_resources" && node.kind === "ConfigGen") || (node.id === "Main" && node.moduleId === "_root" && node.kind === "MainGen")
            : node.moduleId === "_resources" ? node.kind === "ConfigGen" : !node.moduleId.startsWith("_") && JAVA_KINDS.includes(node.kind);
        if (!compatible || !tree.modules.some(m => m.id === node.moduleId)) add("KIND_MODULE_MISMATCH", `${node.id} 类型与模块不匹配`, node.id);
    }
    const visiting = new Set<string>(), visited = new Set<string>();
    function visit(id: string, stack: string[]) {
        if (visiting.has(id)) { const cycle = [...stack.slice(stack.indexOf(id)), id]; add("DEPEND_CYCLE", `依赖成环：${cycle.join(" → ")}`, id); return; }
        if (visited.has(id)) return;
        visiting.add(id);
        for (const dependency of byId.get(id)?.depends ?? []) if (byId.has(dependency) && dependency !== id) visit(dependency, [...stack, id]);
        visiting.delete(id); visited.add(id);
    }
    for (const node of tree.nodes) visit(node.id, []);
    if (tree.nodes.some(n => n.contract.configKeys.length) && !tree.nodes.some(n => n.id === "config.yml" && n.moduleId === "_resources")) add("CONFIG_FILE_REQUIRED", "声明配置键时必须包含 config.yml");
    const nonSystem = tree.nodes.filter(n => n.origin !== "system");
    if (tree.modules.filter(m => m.kind !== "system").length > MAX_TREE_MODULES || nonSystem.length > MAX_TREE_NODES + (tree.status === "locked" ? 10 : 0) || nonSystem.filter(n => n.origin !== "review").length > MAX_TREE_NODES) add("LIMIT_EXCEEDED", "超出模块或节点上限");
    return issues;
}
export function planItemForNode(tree: ProjectTree, node: TreeNode, bucket = 0, order = 0): PlanFileItem {
    const pair = tree.nodes.find(n => n.id === node.pairId);
    return { path: nodePath(tree, node), role: node.responsibility, order, depends: [...node.depends], generatorType: node.kind, tag: node.tag, pairPath: pair ? nodePath(tree, pair) : "", bucket, nodeId: node.id, moduleId: node.moduleId };
}
export function deriveGenerationPlan(tree: ProjectTree): { plan: PlanFileItem[]; buckets: PlanFileItem[][]; mainBlueprint: MainBlueprint } {
    const main = tree.nodes.find(n => n.id === "Main")!;
    main.depends = tree.nodes.filter(n => ["ListenerGen", "CommandGen", "TaskGen", "ManagerGen", "ConfigClassGen"].includes(n.kind)).map(n => n.id);
    const ordered: TreeNode[] = [], depths = new Map<string, number>(), active = new Set<string>();
    const visit = (node: TreeNode): number => {
        if (depths.has(node.id)) return depths.get(node.id)!;
        requireValue(!active.has(node.id), "依赖成环，无法派生生成计划"); active.add(node.id);
        const depth = ["_build", "_resources"].includes(node.moduleId) ? 0 : node.depends.reduce((max, id) => { const dep = tree.nodes.find(n => n.id === id); return dep ? Math.max(max, visit(dep) + 1) : max; }, 0);
        active.delete(node.id); depths.set(node.id, depth); ordered.push(node); return depth;
    };
    for (const node of tree.nodes.filter(n => n.id !== "Main")) visit(node);
    const maxDepth = Math.max(0, ...depths.values());
    depths.set(main.id, maxDepth + 1); ordered.push(main);
    const usedDepths = unique(ordered.map(n => String(depths.get(n.id)))).map(Number).sort((a, b) => a - b);
    const plan = ordered.map((node, index) => planItemForNode(tree, node, usedDepths.indexOf(depths.get(node.id)!), index + 1));
    const buckets = usedDepths.map((_, bucket) => plan.filter(f => f.bucket === bucket));
    const mainBlueprint: MainBlueprint = { events: [], commands: [], tasks: [], services: [], config: { defaultsCopied: tree.nodes.some(n => n.id === "config.yml"), files: tree.nodes.filter(n => n.kind === "ConfigGen" && n.id !== "plugin.yml").map(n => n.id) }, fqcn: {} };
    for (const node of tree.nodes) {
        if (nodeFqcn(tree, node)) mainBlueprint.fqcn![node.id] = nodeFqcn(tree, node);
        if (node.kind === "ListenerGen") mainBlueprint.events.push(...node.contract.events.map(event => ({ event, listenerClass: node.id, priority: "NORMAL" })));
        if (node.kind === "CommandGen") mainBlueprint.commands.push(...node.contract.commands.map(cmd => ({ ...cmd, executorClass: node.id })));
        if (node.kind === "TaskGen" && node.contract.schedule) mainBlueprint.tasks.push({ taskClass: node.id, schedule: node.contract.schedule.mode, periodTicks: node.contract.schedule.periodTicks, delayTicks: node.contract.schedule.delayTicks, async: node.contract.schedule.mode === "async" });
        if (node.kind === "ManagerGen" && node.contract.lifecycle === "onEnable") mainBlueprint.services.push({ managerClass: node.id, lifecycle: "onEnable" });
    }
    return { plan, buckets, mainBlueprint };
}
export function appendReviewNode(tree: ProjectTree, input: { className: string; referencedByNodeId: string }): { node: TreeNode; created: boolean } | null {
    const existing = tree.nodes.find(n => lower(n.id) === lower(input.className));
    if (existing) return { node: existing, created: false };
    const reference = tree.nodes.find(n => n.id === input.referencedByNodeId);
    if (tree.status !== "locked" || !reference || !/^[A-Z][A-Za-z0-9]{1,47}$/.test(input.className) || tree.nodes.filter(n => n.origin !== "system").length >= MAX_TREE_NODES + 10 || tree.nodes.filter(n => n.origin === "review").length >= 10) return null;
    const moduleId = reference.moduleId.startsWith("_") ? "common" : reference.moduleId;
    if (!tree.modules.some(m => m.id === moduleId)) {
        if (tree.modules.filter(m => m.kind !== "system").length >= MAX_TREE_MODULES) return null;
        tree.modules.push({ id: moduleId, title: "公共", responsibility: "公共辅助代码", kind: "common" });
    }
    const inferred = inferGeneratorType(input.className, `${input.className}.java`);
    const node: TreeNode = { id: input.className, moduleId, kind: JAVA_KINDS.includes(inferred) ? inferred : "UtilGen", title: input.className.slice(0, 24), responsibility: `被 ${reference.id} 引用的 ${input.className}`, depends: [], contract: emptyNodeContract(), tag: null, pairId: "", origin: "review" };
    tree.nodes.push(node); reference.depends = unique([...reference.depends, node.id]); tree.revision++;
    return { node, created: true };
}
export function publicTreeView(tree: ProjectTree) {
    return { ...tree, nodes: tree.nodes.map(node => ({ ...node, path: nodePath(tree, node), fqcn: nodeFqcn(tree, node), packageName: nodeFqcn(tree, node) ? nodePackage(tree, node) : "" })) };
}
export function contractSignatureLines(node: TreeNode): string[] {
    const c = node.contract;
    return [...c.constructors.map(m => `public ${node.id}(${m.params})`), ...c.methods.map(m => `public ${m.isStatic ? "static " : ""}${m.returns} ${m.name}(${m.params})`), ...c.events.map(e => `监听 ${e}`), ...c.commands.map(cmd => `命令 /${cmd.name}${cmd.aliases.length ? `（别名 ${cmd.aliases.join(", ")}）` : ""} 权限 ${cmd.permission || "无"} 用法 ${cmd.usage} ${cmd.description}`), ...(c.schedule ? [`调度 ${c.schedule.mode} 延迟 ${c.schedule.delayTicks} ticks 周期 ${c.schedule.periodTicks} ticks`] : []), ...c.configKeys.map(k => `配置 ${k}`), ...(c.lifecycle ? [`生命周期 ${c.lifecycle}`] : [])];
}
export function treePromptSnapshot(tree: ProjectTree): string {
    return [`项目 ${JSON.stringify(tree.project)} 修订 ${tree.revision}`, ...tree.modules.flatMap(module => [`模块 ${module.id}（${module.title}）：${module.responsibility}`, ...tree.nodes.filter(n => n.moduleId === module.id).flatMap(n => [`  ${n.id} [${n.kind}] ${nodePath(tree, n)}：${n.responsibility}；依赖 ${n.depends.join(",")}；GUI ${n.pairId}`, ...contractSignatureLines(n).map(line => `    ${line}`)])])].join("\n");
}
export function projectExternalDeps(state: { tree?: { project?: { externalDeps?: string[] } } | null }): string[] { return state.tree?.project?.externalDeps ?? []; }
