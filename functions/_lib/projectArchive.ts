import { deriveGenerationPlan, nodePath, publicTreeView, validateProjectTree, type ProjectTree } from "./projectTree";
import { checkNodeContract } from "./projectTreeContract";
import { extractFileSummary } from "./fileSummary";
import { digest, projectFiles, safeProjectPath, redact } from "../../shared/projectArchive";

const CHECKPOINT_FIELDS = ["taskId", "userPrompt", "coreType", "version", "projectName", "packageName", "javaVersion", "status", "tree", "treeSession", "treeOperations", "clarifyRounds", "clarifyDone", "clarifyOperations", "preflightProtocolVersion", "plan", "buckets", "currentBucket", "generatedFiles", "fileStatuses", "generationCheckpoints", "nodeChecks", "logs", "skills", "knowledgeUsed", "negativeFactsUsed", "buildBranch", "buildHeadSha", "runId", "artifactId", "buildRequestId", "buildDiagnostics", "buildFixHistory", "projectOrigin", "importReport", "revisionId", "parentRevisionId", "revisionRequestId", "revisionBase", "changeRequest", "changeSummary", "treeContext", "resources", "pathReviews", "compileCheck", "sourceFingerprint"];
export function checkpointView(state: any) {
    return redact(Object.fromEntries(CHECKPOINT_FIELDS.filter(key => state[key] !== undefined).map(key => [key, state[key]])));
}
export async function checkpointSeal(secret: string, uid: string, state: unknown): Promise<string> {
    const key = await crypto.subtle.importKey("raw", new TextEncoder().encode(secret), { name: "HMAC", hash: "SHA-256" }, false, ["sign"]);
    const signature = await crypto.subtle.sign("HMAC", key, new TextEncoder().encode(`${uid}:${await digest(state)}`));
    return Array.from(new Uint8Array(signature), b => b.toString(16).padStart(2, "0")).join("");
}
export async function validCheckpointSeal(secret: string, uid: string, state: unknown, seal: unknown) {
    if (typeof seal !== "string" || !/^[a-f0-9]{64}$/.test(seal)) return false;
    const expected = await checkpointSeal(secret, uid, state);
    let diff = 0; for (let i = 0; i < expected.length; i++) diff |= expected.charCodeAt(i) ^ seal.charCodeAt(i);
    return diff === 0;
}
export function restoredProject(input: any, taskId: string, uid: string) {
    if (!input || typeof input.userPrompt !== "string" || input.userPrompt.length > 50000 || !/^[\w .-]{1,80}$/.test(input.version) || !["PAPER", "SPIGOT", "BUKKIT", "FORGE", "FABRIC"].includes(String(input.coreType).toUpperCase())) throw new Error("工程需求或版本无效");
    const files = projectFiles(input.generatedFiles ?? []);
    const tree = input.tree ? JSON.parse(JSON.stringify(input.tree)) as ProjectTree : null;
    if (tree) {
        if (!Array.isArray(tree.nodes) || tree.nodes.length > 2000 || tree.nodes.some(node => !safeProjectPath(nodePath(tree, node)))) throw new Error("工程结构无效");
        if (tree.status === "locked" && validateProjectTree(tree).length) throw new Error("工程结构需要先修正");
    }
    const derived = tree?.status === "locked" ? deriveGenerationPlan(tree) : { plan: [], buckets: [], mainBlueprint: null };
    const state: any = {
        taskId, uid, userPrompt: input.userPrompt, coreType: input.coreType, version: input.version,
        projectName: tree?.project.projectName ?? "", packageName: tree?.project.packageName ?? "", javaVersion: tree?.project.javaVersion ?? "",
        tree, treeSession: tree && tree.status !== "locked" ? { mode: "build", round: 0, status: tree.status === "ready" ? "ready" : "continue", correction: "", focusIds: [], issues: [], lastResults: [], emptyRounds: 0, learningRequestId: null } : null,
        clarifyRounds: Array.isArray(input.clarifyRounds) ? input.clarifyRounds : [], clarifyDone: !!tree || input.clarifyDone === true,
        clarifyOperations: [], treeOperations: [], preflightProtocolVersion: 1,
        ...derived, currentBucket: 0, generationCheckpoints: {}, generatedFiles: files, fileStatuses: {}, currentFileIndex: 0,
        nodeChecks: {}, pathReviews: {}, sourceFingerprint: "", compileCheck: null, logs: ["从本地工程恢复，检查与编译证据将重新核验"],
        skills: Array.isArray(input.skills) ? input.skills : [], resources: projectFiles(input.resources ?? []),
        revisionId: crypto.randomUUID(), parentRevisionId: input.revisionId || "", projectOrigin: input.projectOrigin === "jar" ? "jar" : "prompt",
        revisionRequestId: typeof input.revisionRequestId === "string" ? input.revisionRequestId : "",
        revisionBase: input.revisionBase ?? null, changeRequest: typeof input.changeRequest === "string" ? input.changeRequest.slice(0, 1000) : "", treeContext: typeof input.treeContext === "string" ? input.treeContext : "",
        restoredFromTerminal: ["done", "error", "failed"].includes(input.status),
        importReport: input.importReport ?? null, status: tree?.status === "locked" ? "generating" : tree ? "tree_confirming" : input.clarifyDone === true ? "tree_planning" : "clarifying",
    };
    for (const file of derived.plan) {
        const source = files.find(f => f.path === file.path);
        const node = tree?.nodes.find(n => nodePath(tree, n) === file.path);
        const check = source && node ? checkNodeContract(tree!, node, source.content) : null;
        state.fileStatuses[file.path] = check && check.passed === check.total ? "done" : "pending";
        if (source) source.apiSummary = extractFileSummary(source.path, source.content);
        if (check) state.nodeChecks[node!.id] = check;
    }
    state.currentFileIndex = Object.values(state.fileStatuses).filter(status => status === "done").length;
    return state;
}
export function incrementalPlan(state: any, tree: ProjectTree) {
    const derived = deriveGenerationPlan(tree);
    const before: ProjectTree | undefined = state.revisionBase?.tree;
    const plannedPaths = new Set(tree.nodes.map(node => nodePath(tree, node)));
    const resources = projectFiles(state.resources ?? []);
    const sources = projectFiles([...new Map([...resources.filter(file => !file.encoding && plannedPaths.has(file.path)), ...(state.generatedFiles ?? [])].map(file => [file.path, file])).values()]);
    const changed = new Set<string>();
    for (const node of tree.nodes) {
        const previous = before?.nodes.find(n => n.id === node.id);
        if (!sources.some(f => f.path === nodePath(tree, node)) || before && (!previous || nodePath(before, previous) !== nodePath(tree, node) || JSON.stringify(previous) !== JSON.stringify(node))) changed.add(node.id);
    }
    // An explicit user request can change implementation without changing a contract.
    if (state.changeRequest) {
        const touched = tree.paths?.filter(path => JSON.stringify(path) !== JSON.stringify(before?.paths?.find(p => p.id === path.id))) ?? [];
        if (touched.length) touched.flatMap(path => path.nodes.flatMap(step => step.fileIds)).forEach(id => changed.add(id));
        else if (!before || !tree.nodes.some(node => { const previous = before.nodes.find(n => n.id === node.id); return previous && JSON.stringify(previous) !== JSON.stringify(node); })) tree.nodes.filter(n => !["_build", "_resources"].includes(n.moduleId)).forEach(n => changed.add(n.id));
    }
    if (before && JSON.stringify(before.project) !== JSON.stringify(tree.project)) { changed.add("pom.xml"); changed.add("plugin.yml"); }
    if (before && JSON.stringify(before.nodes.map(n => [n.id, n.contract.commands])) !== JSON.stringify(tree.nodes.map(n => [n.id, n.contract.commands]))) changed.add("plugin.yml");
    let size: number;
    do { size = changed.size; for (const node of tree.nodes) if (node.depends.some(id => changed.has(id))) changed.add(node.id); } while (changed.size !== size);
    if (before && JSON.stringify(before) !== JSON.stringify(tree) || changed.size) changed.add("Main");
    const retained = sources.filter(file => tree.nodes.some(node => nodePath(tree, node) === file.path));
    const statuses: Record<string, string> = {}, nodeChecks: Record<string, unknown> = {};
    for (const node of tree.nodes) {
        const file = retained.find(f => f.path === nodePath(tree, node));
        const check = file && checkNodeContract(tree, node, file.content);
        if (file) file.apiSummary = extractFileSummary(file.path, file.content);
        const done = !!check && check.passed === check.total && !changed.has(node.id);
        statuses[nodePath(tree, node)] = done ? "done" : "pending";
        if (done) nodeChecks[node.id] = check;
    }
    return { ...derived, generatedFiles: retained, resources: resources.filter(file => !plannedPaths.has(file.path) || file.encoding), fileStatuses: statuses, nodeChecks, currentBucket: 0, currentFileIndex: Object.values(statuses).filter(s => s === "done").length, generationCheckpoints: {}, pathReviews: {}, sourceFingerprint: "", compileCheck: null, pathRepair: null, pathRepairAttempts: 0,
        changeSummary: { added: tree.nodes.filter(n => before && !before.nodes.some(previous => previous.id === n.id)).map(n => nodePath(tree, n)), changed: [...changed], affected: tree.nodes.filter(n => changed.has(n.id)).map(n => nodePath(tree, n)), removed: sources.filter(f => !retained.some(r => r.path === f.path)).map(f => f.path) } };
}
export function revisionChangeSummary(state: any) {
    return state.revisionBase && state.tree?.status === "ready" ? incrementalPlan(state, state.tree).changeSummary : state.changeSummary || null;
}
