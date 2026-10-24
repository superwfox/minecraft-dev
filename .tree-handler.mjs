import fs from 'node:fs'; import path from 'node:path';
const file = 'src/logic/generateHandler.ts'; let s = fs.readFileSync(file, 'utf8').replace(/\r\n/g, '\n');
const archive = '.deprecated/flowchart-planner/src/logic/generateHandler.removed.ts'; fs.mkdirSync(path.dirname(archive), { recursive: true });
function cut(a, b, replacement = '') { const start = s.indexOf(a), end = s.indexOf(b, start); if (start < 0 || end < 0) throw new Error(a); fs.appendFileSync(archive, '\n' + s.slice(start, end)); s = s.slice(0, start) + replacement + s.slice(end); }
s = s.replace('    waitForPathChoice,', '    waitForTreeDecision,').replace('    normalizeGradeRequestId,', '    normalizeTreeRequestId,');
s = 'import JSZip from "jszip";\nimport { renderTreeMarkdown, type ProjectTreeView, type TreeIssue } from "./projectTree";\nimport type { GenFile } from "./generateState";\n' + s;
s = s.replace('const MAX_REPLAN_ATTEMPTS = 2;\n', '');
cut('function createPlannerRequestId()', 'async function get(url:', 'function createClarifyRequestId(): string { return `clarify_${crypto.randomUUID().replace(/-/g, "")}`; }\nfunction createBuildRequestId(): string { return `build_${crypto.randomUUID().replace(/-/g, "")}`; }\n\n');
cut('/** SSE streaming file generation', 'async function streamBucketGeneration');
cut('/** SSE streaming complexity grading', '/** SSE streaming build fix');
cut('async function runGradeStage', 'async function buildWithRetry', fs.readFileSync('.tree-flow.txt', 'utf8'));
s = s.replaceAll('gradeAbort', 'treeAbort').replace('// clarify / grade 保留独立 controller', '// clarify / tree 保留独立 controller');
s = s.replace('type PreflightStage = "clarify" | "grade" | "plan";', 'type PreflightStage = "clarify" | "tree";');
s = s.replace('    if (value === "grade" || value === "grading") return "grade";\n    if (value === "plan" || value === "planning") return "plan";', '    if (value === "tree" || value === "tree_planning" || value === "tree_confirming") return "tree";');
s = s.replace('stage: "clarify" | "grade";', 'stage: "clarify" | "tree";').replace('"clarifyRequestId" | "gradeRequestId"', '"clarifyRequestId" | "treeRequestId"').replace('"CLARIFY_IN_PROGRESS" | "GRADE_IN_PROGRESS"', '"CLARIFY_IN_PROGRESS" | "TREE_IN_PROGRESS"').replace('"CLARIFY_RECOVERY_REQUIRED" | "GRADE_RECOVERY_REQUIRED"', '"CLARIFY_RECOVERY_REQUIRED" | "TREE_RECOVERY_REQUIRED"').replace('"CLARIFY_LEASE_LOST" : "GRADE_LEASE_LOST"', '"CLARIFY_LEASE_LOST" : "TREE_LEASE_LOST"');
s = s.replace('p === "grading" || p === "confirming"', 'p === "tree_planning" || p === "tree_confirming"').replace('p === "planning"', 'p === "creating"').replace('"grading"', '"tree_planning"').replace('"planning"', '"tree_planning"').replace('"confirming"', '"tree_confirming"').replace('"polling"', '"building"');
s = s.replace('                        case "learning_snapshot":', `                        case "tool_call":
                            genTask.treeToolCallCount++;
                            break;
                        case "tree_ops":
                            genTask.treeOpsLog.push(...(evt.results ?? []).map((result: { ok: boolean; summary: string; error?: string }) => result.ok ? result.summary : result.error || result.summary));
                            genTask.treeOpsLog = genTask.treeOpsLog.slice(-100);
                            break;
                        case "tree_patch":
                            if (genTask.tree && evt.node) {
                                const index = genTask.tree.nodes.findIndex(node => node.id === evt.node.id);
                                if (index >= 0) genTask.tree.nodes[index] = evt.node; else genTask.tree.nodes.push(evt.node);
                                if (evt.module && !genTask.tree.modules.some(module => module.id === evt.module.id)) genTask.tree.modules.push(evt.module);
                                genTask.tree.revision++;
                                if (!findFile(evt.node.path)) genTask.files.push({ path: evt.node.path, nodeId: evt.node.id, moduleId: evt.node.moduleId, origin: evt.node.origin, role: evt.node.responsibility, generatorType: evt.node.kind, status: "pending" });
                            }
                            break;
                        case "learning_snapshot":`);
s = s.replace('                        case "file_done": {', '                        case "file_done": {\n                            if (evt.contractCheck) genTask.nodeChecks[evt.contractCheck.nodeId] = evt.contractCheck;');
s = s.replace('                                const existing = findFile(evt.path);', '                                if (evt.contractCheck) genTask.nodeChecks[evt.contractCheck.nodeId] = evt.contractCheck;\n                                const existing = findFile(evt.path);');
s = s.replace('                                    existing.role = evt.role || existing.role;', '                                    existing.nodeId = evt.nodeId || existing.nodeId;\n                                    existing.role = evt.role || existing.role;');
s = s.replace('                                        path: evt.path, role: evt.role,', '                                        path: evt.path, role: evt.role, nodeId: evt.nodeId,');
s = s.replace('                        case "result":\n                            result = evt;', '                        case "result":\n                            if (evt.nodeChecks) Object.assign(genTask.nodeChecks, evt.nodeChecks);\n                            result = evt;');
fs.writeFileSync(file, s);
