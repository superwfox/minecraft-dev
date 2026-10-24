import fs from 'node:fs'; import path from 'node:path';
const file = 'src/logic/generateState.ts'; let s = fs.readFileSync(file, 'utf8').replace(/\r\n/g, '\n');
const archiveFile = 'deprecated/flowchart-planner/src/logic/generateState.removed.ts'; fs.mkdirSync(path.dirname(archiveFile), { recursive: true });
function cut(a, b, replacement = '') { const start = s.indexOf(a), end = s.indexOf(b, start); if (start < 0 || end < 0) throw new Error(a); fs.appendFileSync(archiveFile, '\n' + s.slice(start, end)); s = s.slice(0, start) + replacement + s.slice(end); }
s = 'import type { ProjectTreeView, TreeIssue, NodeContractCheck } from "./projectTree";\n' + s;
s = s.replace(/export type GenPhase = [^\n]+/, 'export type GenPhase = "idle" | "creating" | "clarifying" | "awaiting_input" | "tree_planning" | "tree_confirming" | "generating" | "verifying" | "uploading" | "building" | "fixing" | "interrupted" | "done" | "error";');
cut('export type GradePath', 'export type LearningStage');
cut('export type PlannerResumeState', 'export type FixResumeStage');
s = s.replace('stage: "clarify" | "grade"', 'stage: "clarify" | "tree"');
cut('export function normalizeGradeRequestId', 'function normalizeClarifyRequestAnswers', 'export function normalizeTreeRequestId(value: unknown): string {\n    return typeof value === "string" && /^tree_[a-f0-9]{16,64}$/i.test(value) ? value : "";\n}\n\n');
cut('export function normalizePlannerResumeState', 'function emptyLearningProgress');
// Remove the retired state declarations, initializers, assignments and snapshot properties.
const retired = /\b(?:grade|chosenPathId|gradeRequestId|gradeRequestCorrection|plannerRequestId|plannerReplan|plannerAttempt|plannerLearningRequired|plannerLearningNeedCount)\b/;
let lines = s.split('\n'); let kept = [];
for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    if (line.includes('const plannerResume =')) { fs.appendFileSync(archiveFile, '\n' + line); continue; }
    if (retired.test(line)) {
        if (line.includes('preflightStage:') || line.includes('genTask.preflightStage = s.preflightStage')) { kept.push(line.replaceAll('"grade" | "plan"', '"tree"').replaceAll('s.preflightStage === "grade" || s.preflightStage === "plan"', 's.preflightStage === "tree"')); continue; }
        if (line.includes('genTask.clarifyRequestId, genTask.gradeRequestId')) { kept.push(line.replace(', genTask.gradeRequestId', '')); continue; }
        fs.appendFileSync(archiveFile, '\n' + line);
        if (line.includes('= typeof s.gradeRequestCorrection')) { fs.appendFileSync(archiveFile, '\n' + lines[++i] + '\n' + lines[++i]); }
        continue;
    }
    kept.push(line);
}
s = kept.join('\n').replaceAll('"planning"', '"creating"');
s = s.replace('export type GenFile = {', 'export type GenFile = {\n    nodeId?: string;\n    moduleId?: string;\n    origin?: "system" | "planner" | "review";');
const fields = { tree: 'null', treeRequestId: '""', treeMode: '"build"', treeSessionStatus: '""', treeIssues: '[]', treeOpsLog: '[]', treeCorrection: '""', treeFocusIds: '[]', nodeChecks: '{}', treeRound: '0', treeToolCallCount: '0', currentBucket: '0' };
const types = '    tree: ProjectTreeView | null;\n    treeRequestId: string;\n    treeMode: "build" | "refine" | "continue";\n    treeSessionStatus: "" | "continue" | "learning" | "ready" | "failed";\n    treeIssues: TreeIssue[];\n    treeOpsLog: string[];\n    treeCorrection: string;\n    treeFocusIds: string[];\n    nodeChecks: Record<string, NodeContractCheck>;\n    treeRound: number;\n    treeToolCallCount: number;\n    currentBucket: number;\n';
s = s.replace('export type GenTask = {\n', 'export type GenTask = {\n' + types);
s = s.replace('export const genTask = reactive<GenTask>({\n', 'export const genTask = reactive<GenTask>({\n' + Object.entries(fields).map(([key,value]) => `    ${key}: ${value},`).join('\n') + '\n');
s = s.replace('export function resetGenTask() {', 'export function resetGenTask() {\n' + Object.entries(fields).map(([key,value]) => `    genTask.${key} = ${value};`).join('\n'));
s = s.replace('        const snap = {', '        const snap = {\n            schemaVersion: 2,\n' + Object.keys(fields).map(key => `            ${key}: genTask.${key},`).join('\n'));
s = s.replace('generatorType: f.generatorType, tag:', 'nodeId: f.nodeId, moduleId: f.moduleId, origin: f.origin, generatorType: f.generatorType, tag:');
s = s.replace('        const s = JSON.parse(raw);', '        const s = JSON.parse(raw);\n        if (s.schemaVersion !== 2) { resetGenTask(); return false; }');
s = s.replace('        genTask.taskId = s.taskId || "";', Object.entries(fields).map(([key,value]) => `        genTask.${key} = s.${key} ?? ${value};`).join('\n') + '\n        genTask.treeRequestId = normalizeTreeRequestId(s.treeRequestId);\n        genTask.treeOpsLog = genTask.treeOpsLog.slice(-100);\n        genTask.taskId = s.taskId || "";');
s = s.replace('        genTask.buildRequestId, genTask.fixResumeStage],', '        genTask.buildRequestId, genTask.fixResumeStage, genTask.tree?.revision, genTask.treeRequestId, genTask.treeRound, genTask.treeSessionStatus, genTask.treeFocusIds.join(","), genTask.treeCorrection, genTask.currentBucket, Object.keys(genTask.nodeChecks).length],');
cut('export const pathGateWaiting', '/** ESC 中断', `export type TreeDecision = { action: "confirm" } | { action: "refine"; correction: string; focusIds: string[] };
export const treeGateWaiting = ref(false);
let treeResolver: ((decision: TreeDecision) => void) | null = null;
let treeRejecter: ((error: Error) => void) | null = null;
export function waitForTreeDecision(): Promise<TreeDecision> {
    treeGateWaiting.value = true;
    return new Promise((resolve, reject) => { treeResolver = resolve; treeRejecter = reject; });
}
function resolveTree(decision: TreeDecision) {
    const resolve = treeResolver;
    treeResolver = null; treeRejecter = null; treeGateWaiting.value = false;
    resolve?.(decision);
}
export function submitTreeConfirm() { resolveTree({ action: "confirm" }); }
export function submitTreeRefine(correction: string, focusIds: string[]) { resolveTree({ action: "refine", correction, focusIds }); }

`);
s = s.replaceAll('pathGateWaiting.value', 'treeGateWaiting.value').replaceAll('pathRejecter', 'treeRejecter').replaceAll('pathResolver', 'treeResolver').replace('路径确认', '结构树确认');
fs.writeFileSync(file, s);
