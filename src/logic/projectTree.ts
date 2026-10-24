import type { publicTreeView, NodeContractCheck, TreeIssue, TreeOpResult, TreeNode } from "../../functions/_lib/projectTree";
import type { GenFile, GeneratorType } from "./generateState";
export type { NodeContractCheck, TreeIssue, TreeOpResult };
export type ProjectTreeView = Omit<ReturnType<typeof publicTreeView>, "project"> & { project: ReturnType<typeof publicTreeView>["project"] & { coreType?: string; version?: string } };
export type TreeNodeView = ProjectTreeView["nodes"][number];
export const generatorLabels: Record<GeneratorType, string> = { MainGen: "插件主类", CommandGen: "命令", ListenerGen: "事件监听", TaskGen: "调度任务", ManagerGen: "服务管理", ConfigGen: "YAML 资源", ConfigClassGen: "配置加载", ModelGen: "数据模型", EnumGen: "枚举", UtilGen: "工具", FileRelatedGen: "构建配置" };
export function contractSignatureLines(node: TreeNode): string[] {
    const c = node.contract;
    return [...c.constructors.map(m => `${node.id}(${m.params})`), ...c.methods.map(m => `${m.isStatic ? "static " : ""}${m.returns} ${m.name}(${m.params})`), ...c.events.map(e => `监听 ${e}`), ...c.commands.map(cmd => `命令 /${cmd.name} · 别名 ${cmd.aliases.join(", ") || "无"} · 权限 ${cmd.permission || "无"} · 用法 ${cmd.usage} · ${cmd.description}`), ...(c.schedule ? [`调度 ${c.schedule.mode} · 延迟 ${c.schedule.delayTicks} ticks · 周期 ${c.schedule.periodTicks} ticks`] : []), ...c.configKeys.map(k => `配置 ${k}`), ...(c.lifecycle ? [`生命周期 ${c.lifecycle}`] : [])];
}
export function nodeStatusOf(node: TreeNodeView, files: GenFile[], checks: Record<string, NodeContractCheck>, diagnostics: { path?: string }[] = []) {
    const file = files.find(file => file.path === node.path), check = checks[node.id];
    const buildError = diagnostics.some(d => d.path && (node.path.endsWith(d.path.replace(/\\/g, "/")) || d.path.replace(/\\/g, "/").endsWith(node.path)));
    const status = buildError ? "error" : file?.status ?? "pending";
    return { status, contractOk: !!check && check.passed === check.total, check, buildError };
}
export function moduleProgress(tree: ProjectTreeView, files: GenFile[]) {
    return Object.fromEntries(tree.modules.map(module => {
        const nodes = tree.nodes.filter(node => node.moduleId === module.id);
        return [module.id, { done: nodes.filter(node => files.some(file => file.path === node.path && file.status === "done")).length, total: nodes.length }];
    }));
}
export function treeTotals(tree: ProjectTreeView, files: GenFile[], checks: Record<string, NodeContractCheck>) {
    return { done: tree.nodes.filter(node => files.some(file => file.path === node.path && file.status === "done")).length, total: tree.nodes.length, passed: tree.nodes.reduce((sum, node) => sum + (checks[node.id]?.passed ?? 0), 0), contracts: tree.nodes.reduce((sum, node) => sum + (checks[node.id]?.total ?? 0), 0) };
}
export function renderTreeMarkdown(tree: ProjectTreeView, checks: Record<string, NodeContractCheck>): string {
    const lines = [`# ${tree.project.projectName}`, "", tree.project.summary, "", `- 包名：${tree.project.packageName}`, `- 核心与版本：${tree.project.coreType ?? ""} ${tree.project.version ?? ""}`, `- Java：${tree.project.javaVersion}`, `- 外部依赖：${tree.project.externalDeps.join(", ") || "无"}`, `- 修订：${tree.revision}`, ""];
    for (const module of tree.modules) {
        lines.push(`## ${module.title} (${module.id})`, "", module.responsibility, "");
        for (const node of tree.nodes.filter(node => node.moduleId === module.id)) {
            const check = checks[node.id];
            lines.push(`### ${node.id} · ${generatorLabels[node.kind]}`, "", `路径：\`${node.path}\``, "", node.responsibility, "", `依赖：${node.depends.join(", ") || "无"}`, `来源：${node.origin === "review" ? "审查追加" : node.origin === "system" ? "系统" : "结构规划"}`, `契约：${check ? `${check.passed}/${check.total}` : "待核对"}`, "", ...contractSignatureLines(node).map(line => `- ${line}`), "");
        }
    }
    return lines.join("\n");
}
