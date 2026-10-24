import fs from 'node:fs';
const read = p => fs.readFileSync(p, 'utf8').replace(/\r\n/g, '\n');
const write = (p, s) => fs.writeFileSync(p, s);
function replaceRange(s, a, b, replacement) { const start = s.indexOf(a), end = s.indexOf(b, start); if (start < 0 || end < 0) throw new Error(a); return s.slice(0, start) + replacement + s.slice(end); }
let tree = read('functions/api/generate/clarify.ts').replaceAll('Clarify', 'Tree').replaceAll('clarify', 'tree').replaceAll('需求确认', '结构规划').replaceAll('澄清', '结构规划').replaceAll('CLARIFY', 'TREE');
tree = tree.replace('import { plannerTreePrompt, skillTreeContext } from "../../_lib/prompts";', 'import { treeBuilderPrompt, skillPlannerContext } from "../../_lib/prompts";\nimport { applyTreeToolCalls, createInitialTree, deriveGenerationPlan, MAX_TREE_ROUNDS, publicTreeView, treePromptSnapshot, treeToolDefinitions, validateProjectTree, type ProjectTree, type TreeSession } from "../../_lib/projectTree";\nimport { consumeChatStream } from "../../_lib/modelStream";\nimport { getSkillBundles } from "../../_lib/skills";\nimport { buildApiContractContext } from "../../_lib/apiContracts";\nimport { loadKnowledgeContext, mergeKnowledgeUsed } from "../../_lib/learning/context";\nimport { deduplicateKnowledgeNeeds } from "../../_lib/learning/assessment";\nimport { createModelLearningRequest, LEARNING_TOOL_NAME, learningToolDefinition, putModelLearningRequest, removeModelLearningRequest, type ModelChatMessage } from "../../_lib/learning/tool";\nimport { resolveModelLearningRequest, type ModelLearningResolution } from "../../_lib/learning/toolRuntime";');
tree = tree.replace('deepSeekKeyRequiredResponse, resolveTaskLLM', 'deepSeekKeyRequiredResponse, resolveTaskLLM, thinkingFor');
tree = tree.replace('const MAX_TREE_ROUNDS = 5;\n', '');
tree = replaceRange(tree, 'function stripFences', 'function sseEvent', '');
tree = replaceRange(tree, 'function normalizedTreeInput', 'function treeError', `function normalizedTreeInput(body: Record<string, unknown>): Record<string, unknown> {
    return { action: body.action, correction: typeof body.correction === "string" ? body.correction.trim() : "", focusIds: Array.isArray(body.focusIds) ? body.focusIds : [], skillIds: Array.isArray(body.skillIds) ? body.skillIds : [] };
}
function hasExplicitTreeInput(_body: unknown): boolean { return true; }

`);
tree = tree.replace('    const llm = await withPreflightDeadline(', `    if (!state.clarifyDone) return preflightJsonError("请先完成需求确认", "CLARIFY_REQUIRED", 409);
    if (state.tree?.status === "locked") return preflightJsonError("结构树已锁定", "TREE_LOCKED", 409);
    if (!["build", "refine", "continue"].includes(body.action)) return preflightJsonError("无效的结构规划操作", "INVALID_TREE_ACTION", 400);
    const llm = await withPreflightDeadline(`);
tree = tree.replace('    const leaseToken = ', `    let learningResolution: ModelLearningResolution | null = null;
    const learningId = state.treeSession?.status === "learning" ? state.treeSession.learningRequestId : "";
    // Resolve before acquiring the task fence, as learning authorization uses that fence.
    if (learningId && body.action === "continue") {
        learningResolution = await resolveModelLearningRequest({ env: context.env, state, uid, taskId, requestId: learningId, jobId: body.learningToolJobs?.[learningId], maxCharacters: 4800 });
        if (learningResolution.status === "pending") return new Response(sseEvent(new TextEncoder(), { type: "result", stage: "tree", status: "learning", round: state.treeSession.round, tree: publicTreeView(state.tree), issues: state.treeSession.issues, results: [], learningToolRequests: [learningResolution.request] }).buffer, { headers: { "Content-Type": "text/event-stream" } });
    }
    const leaseToken = `);
tree = tree.replace('            2,\n        );\n    }\n\n    const persistState', '            2,\n            { activeRequestId: activePreflightOperation(latestState ?? {}, "tree")?.requestId ?? requestId },\n        );\n    }\n\n    const persistState');
tree = replaceRange(tree, '        if (state.treeDone && !record)', '        if (state.quotaExhausted', '');
tree = replaceRange(tree, '            const answers = suppliedInput.answers', '            record = appendPreflightOperation', `            const session = state.treeSession as TreeSession | null;
            const currentTree = state.tree as ProjectTree | null;
            let invalid = "";
            if (body.action === "build") {
                if (session && session.status !== "failed") invalid = "已有结构规划会话，请继续或修正";
            } else if (body.action === "refine") {
                const correction = String(suppliedInput.correction);
                if (!correction || correction.length > 1000) invalid = "修正意见须为 1–1000 字";
                else if (currentTree?.status !== "ready" && !(session?.status === "failed" && currentTree?.nodes.some(n => n.origin !== "system"))) invalid = "当前结构树不能修正";
            } else if (!session || !["continue", "learning"].includes(session.status)) invalid = "当前没有可续接的规划会话";
            if (invalid) { scheduleLeaseRelease(); return preflightJsonError(invalid, "INVALID_TREE_ACTION", 400); }
            if (body.action !== "continue") {
                if (body.action === "build") state.tree = createInitialTree(state.coreType, state.version);
                else state.tree.status = "drafting";
                const focusIds = (suppliedInput.focusIds as unknown[]).filter((id): id is string => typeof id === "string" && [...state.tree.nodes, ...state.tree.modules].some(item => item.id === id));
                state.treeSession = { mode: body.action, round: 0, status: "continue", correction: String(suppliedInput.correction), focusIds, issues: [], lastResults: [], emptyRounds: 0, learningRequestId: null } satisfies TreeSession;
            }
`);
tree = tree.replace('round: state.treeRounds.length + 1,', 'round: state.treeSession.round + 1,').replace('phase: "treeing"', 'phase: "tree_planning"');
tree = replaceRange(tree, '                let result: Record<string, unknown> | undefined;', '                assertTreeOperationActive(operationDeadline.signal);\n                record!.status = "completed";', read('.tree-round.txt'));
tree = tree.replace('                await writeSSE(\n                    writer,\n                    encoder,\n                    { type: "result", stage: "tree", ...result! },', '                await writeSSE(writer, encoder, { type: "tree_ops", stage: "tree", round: state.treeSession.round, results: state.treeSession.lastResults }, operationAbort, terminalSignal());\n                await writeSSE(\n                    writer,\n                    encoder,\n                    { type: "result", stage: "tree", ...result! },');
tree = tree.replace('export const onRequestPost: PagesFunction<Env>', 'const onTreeRound: PagesFunction<Env>');
write('functions/api/generate/tree.ts', tree);
