import { createInitialTree, emptyNodeContract, publicTreeView, type TreeNode } from "./projectTree";
import { projectFiles } from "../../shared/projectArchive";
export function seedJarProject(input: any, coreType: string, version: string) {
    const files = projectFiles(input.files), tree = createInitialTree(coreType, version);
    const mainClass = String(input.mainClass || "");
    if (!/^(?:[A-Za-z_$][\w$]*\.)+[A-Za-z_$][\w$]*$/.test(mainClass)) throw new Error("无法识别插件主类");
    const mainPath = `src/main/java/${mainClass.replace(/\./g, "/")}.java`;
    const rawName = String(input.projectName || "ImportedPlugin").replace(/[^a-zA-Z0-9]/g, "");
    tree.project = { projectName: /^[A-Z]/.test(rawName) ? rawName.slice(0, 40) : `Imported${rawName}`.slice(0, 40), packageName: mainClass.slice(0, mainClass.lastIndexOf(".")), javaVersion: String(input.javaVersion || tree.project.javaVersion), summary: "从已有 JAR 提取的工程，行为路径需要模型结合实际源码分析。", externalDeps: [] };
    tree.modules.push({ id: "imported", title: "已有实现", responsibility: "JAR 中的插件实现与行为", kind: "business" });
    const main = tree.nodes.find(n => n.id === "Main")!; main.sourcePath = mainPath; main.sourceClass = mainClass.split(".").at(-1);
    const ids = new Set(tree.nodes.map(n => n.id.toLowerCase()));
    for (const file of files.filter(f => f.path.startsWith("src/main/java/") && f.path.endsWith(".java") && f.path !== mainPath)) {
        const className = file.path.split("/").at(-1)!.slice(0, -5), base = /^[A-Z][A-Za-z0-9]{1,47}$/.test(className) ? className : `Imported${className.replace(/[^A-Za-z0-9]/g, '')}`.slice(0, 42); let id = base, suffix = 2;
        while (ids.has(id.toLowerCase())) id = `${base}${suffix++}`;
        ids.add(id.toLowerCase());
        const node: TreeNode = { id, sourcePath: file.path, sourceClass: className, moduleId: "imported", kind: "UtilGen", title: className.slice(0, 24), responsibility: `保留已有实现 ${file.path}，由模型分析职责与契约`, depends: [], contract: emptyNodeContract(), tag: null, pairId: "", origin: "planner" };
        tree.nodes.push(node);
    }
    // A one-class plugin still represents actual business logic, not an empty scaffold.
    if (tree.nodes.length === 3) tree.modules[2].responsibility += "，包含既有业务逻辑";
    const resources = files.filter(file => !file.path.endsWith(".java") && !["pom.xml", "src/main/resources/plugin.yml"].includes(file.path));
    return { tree, generatedFiles: files.filter(file => file.path.endsWith(".java") || ["pom.xml", "src/main/resources/plugin.yml"].includes(file.path)), resources, importReport: input.report || {},
        treeContext: `此工程来自 JAR。保留所有 sourcePath/sourceClass 绑定、包名与资源，根据以下报告及已有源码分析行为路径。系统 Main 是逻辑 id，实际主类为 ${mainClass}，不得重命名。${JSON.stringify(input.report || {})}` };
}
