import { extractFileSummary } from "./fileSummary";
import { contractSignatureLines, nodeFqcn, nodePackage, nodePath, type NodeContractCheck, type ProjectTree, type TreeNode } from "./projectTree";
export { contractSignatureLines } from "./projectTree";

const escape = (value: string) => value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
export function parameterCount(params: string): number {
    if (!params.trim()) return 0;
    let nesting = 0, count = 1;
    for (const char of params) {
        if ("<([{".includes(char)) nesting++;
        else if (">)]}".includes(char)) nesting--;
        else if (char === "," && nesting === 0) count++;
    }
    return count;
}
export function checkNodeContract(tree: ProjectTree, node: TreeNode, content: string): NodeContractCheck {
    const items: NodeContractCheck["items"] = [];
    const add = (key: string, label: string, ok: boolean) => items.push({ key, label, ok });
    const test = (pattern: string, flags = "m") => new RegExp(pattern, flags).test(content);
    if (nodeFqcn(tree, node)) {
        const summary = extractFileSummary(nodePath(tree, node), content);
        add("class", `类名 ${node.id}`, test(`\\b(class|interface|enum|record)\\s+${escape(node.id)}\\b`));
        add("package", `包 ${nodePackage(tree, node)}`, test(`^\\s*package\\s+${escape(nodePackage(tree, node))}\\s*;`));
        node.contract.methods.forEach((method, index) => add(`method:${index}`, `方法 ${method.name}(${parameterCount(method.params)} 参)`, !!summary.publicMethods?.some(m => m.name === method.name && parameterCount(m.params) === parameterCount(method.params))));
        node.contract.constructors.forEach((ctor, index) => add(`constructor:${index}`, `构造器 ${node.id}(${parameterCount(ctor.params)} 参)`, !!summary.constructors?.some(c => parameterCount(c.params) === parameterCount(ctor.params))));
        const interfaces = summary.implements ?? [];
        const implementsType = (name: string) => interfaces.some(type => type.split(".").pop()?.trim() === name);
        if (node.kind === "ListenerGen") {
            const holder = node.tag === "gui" && !node.contract.events.length;
            add("listener", holder ? "实现 InventoryHolder" : "实现 Listener", implementsType(holder ? "InventoryHolder" : "Listener"));
            for (const event of node.contract.events) add(`event:${event}`, `监听 ${event}`, test(`@(?:org\\.bukkit\\.event\\.)?EventHandler(?:\\s*\\([^)]*\\))?\\s+(?:(?:public|protected|private|final)\\s+)*void\\s+\\w+\\s*\\(\\s*(?:[\\w.]+\\.)?${escape(event)}\\s+\\w+\\s*\\)`));
        }
        if (node.kind === "CommandGen") for (const type of ["CommandExecutor", "TabCompleter"]) add(type, `实现 ${type}`, implementsType(type));
        if (node.kind === "TaskGen") add("task", "继承 BukkitRunnable", test("\\bextends\\s+(?:org\\.bukkit\\.scheduler\\.)?BukkitRunnable\\b"));
        if (node.kind === "MainGen") {
            add("main", "继承 JavaPlugin", test("\\bextends\\s+(?:org\\.bukkit\\.plugin\\.java\\.)?JavaPlugin\\b"));
            for (const other of tree.nodes) {
                for (const cmd of other.contract.commands) add(`command:${cmd.name}`, `命令 /${cmd.name}`, test(`getCommand\\(\\s*"${escape(cmd.name)}"\\s*\\)`));
                if (other.kind === "ListenerGen" && other.contract.events.length) add(`listener:${other.id}`, `注册监听 ${other.id}`, test(`\\bnew\\s+${escape(other.id)}\\s*\\(`));
                if (["TaskGen", "ManagerGen"].includes(other.kind)) add(`reference:${other.id}`, `引用 ${other.id}`, test(`\\b${escape(other.id)}\\b`));
            }
        }
    } else if (node.id === "plugin.yml") {
        add("main", `主类 ${tree.project.packageName}.Main`, test(`^main:\\s*["']?${escape(tree.project.packageName)}\\.Main["']?\\s*$`));
        const block = content.match(/^commands:\s*\r?\n((?:[ \t]+[^\n]*\n?|\s*\n)*)/m)?.[1] ?? "";
        for (const cmd of tree.nodes.flatMap(n => n.contract.commands)) add(`command:${cmd.name}`, `命令 /${cmd.name}`, new RegExp(`^[ \\t]+${escape(cmd.name)}\\s*:`, "m").test(block));
    } else if (node.id === "config.yml") {
        for (const key of new Set(tree.nodes.flatMap(n => n.contract.configKeys))) add(`config:${key}`, `配置 ${key}`, test(`^\\s*${escape(key.split(".").pop()!)}\\s*:`));
    }
    return { nodeId: node.id, revision: tree.revision, items, passed: items.filter(i => i.ok).length, total: items.length };
}
export function nodeGenerationContext(tree: ProjectTree, node: TreeNode): string {
    const module = tree.modules.find(m => m.id === node.moduleId);
    const lines = ["结构树成员契约（必须全部实现且签名一致）：", `所在模块 ${module?.title}（${node.moduleId}）：${module?.responsibility}`, `文件 ${nodePath(tree, node)}`, `职责：${node.responsibility}`, ...contractSignatureLines(node)];
    if (nodeFqcn(tree, node)) lines.push(`FQCN: ${nodeFqcn(tree, node)}`, `强制包声明：package ${nodePackage(tree, node)};`, "除接口或父类要求的方法外，不得新增 public 方法。声明构造器时以契约为准，未声明时沿用专精规则。");
    for (const id of node.depends) {
        const dependency = tree.nodes.find(n => n.id === id);
        if (dependency) lines.push(`依赖 ${nodeFqcn(tree, dependency) || dependency.id}`, ...contractSignatureLines(dependency).map(line => `  ${line}`));
    }
    lines.push("只能通过依赖契约调用；跨包引用必须 import 全限定名。");
    if (node.id === "plugin.yml") lines.push("全部命令（含权限、usage、别名和 description）：", ...tree.nodes.flatMap(n => contractSignatureLines(n).filter(s => s.startsWith("命令"))), `外部依赖 ${tree.project.externalDeps.join(", ")}，根据硬依赖/可降级语义声明 depend/softdepend。`);
    if (node.id === "config.yml") for (const key of new Set(tree.nodes.flatMap(n => n.contract.configKeys))) lines.push(`配置 ${key}，使用者：${tree.nodes.filter(n => n.contract.configKeys.includes(key)).map(n => n.id).join(", ")}`);
    if (node.kind === "MainGen") lines.push("Main 必须导入全部依赖：", ...tree.nodes.filter(n => node.depends.includes(n.id) && nodeFqcn(tree, n)).map(n => `import ${nodeFqcn(tree, n)};`));
    return lines.join("\n");
}
export function nodeReviewContext(tree: ProjectTree, node: TreeNode): string {
    return [`结构树文件 ${nodeFqcn(tree, node) || node.id}`, ...contractSignatureLines(node), `全树类名列表：${tree.nodes.filter(n => nodeFqcn(tree, n)).map(n => n.id).join(", ")}`].join("\n");
}
