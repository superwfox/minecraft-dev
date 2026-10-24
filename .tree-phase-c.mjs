import fs from 'node:fs';
const read = p => fs.readFileSync(p, 'utf8');
const write = (p, s) => fs.writeFileSync(p, s);
function between(s, a, b, replacement) { const start = s.indexOf(a), end = s.indexOf(b, start); if (start < 0 || end < 0) throw new Error(a); return s.slice(0, start) + replacement + s.slice(end); }
const plan = read('functions/api/generate/plan.ts');
let stream = plan.slice(plan.indexOf('interface PlannerStreamCallbacks'), plan.indexOf('function plannerResultPayload'));
stream = stream.replaceAll('PlannerStream', 'ChatStream').replaceAll('plannerStreamText', 'streamText').replaceAll('consumePlannerChatStream', 'consumeChatStream').replace('async function consumeChatStream', 'export async function consumeChatStream').replace('    onActivity?: () => void;', '    onActivity?: () => void;\n    onToolCall?: (index: number, name: string) => void | Promise<void>;');
stream = stream.replace('    const toolCalls = new Map<number, ToolCall>();', '    const toolCalls = new Map<number, ToolCall>();\n    const announced = new Set<number>();');
stream = stream.replace('            toolCalls.set(index, current);', '            toolCalls.set(index, current);\n            if (current.function.name && !announced.has(index)) { announced.add(index); await callbacks.onToolCall?.(index, current.function.name); }');
write('functions/_lib/modelStream.ts', 'import { assertOpenAIResponse, OpenAIStreamProtocolError, type OpenAIStreamResult } from "./openAIStream";\nimport type { UsageBreakdown } from "./quota";\nimport type { ModelChatMessage } from "./learning/tool";\n\n' + stream);
let operations = read('functions/_lib/preflightOperations.ts').replace('"clarify" | "grade"', '"clarify" | "grade" | "tree"').replace('const prefix = stage === "clarify" ? "clarify" : "grade";', 'const prefix = stage;'); write('functions/_lib/preflightOperations.ts', operations);
let tool = read('functions/_lib/learning/tool.ts').replace('"planner" | "generate"', '"tree" | "planner" | "generate"').replace('["planner", "generate",', '["tree", "planner", "generate",'); write('functions/_lib/learning/tool.ts', tool);
let prompts = read('functions/_lib/prompts.ts');
const principles = prompts.slice(prompts.indexOf('极简原则（严格遵守）：'), prompts.indexOf('${gradeBlock}')).replaceAll('files[].role', '节点职责').replaceAll('files[].path', '节点路径').replaceAll('pairPath', 'pairId');
const axes = ['persistent', 'task', 'state_shared', 'external', 'gui_session'].map(axis => prompts.match(new RegExp('        ' + axis + ': "(.*)",'))?.[1]).filter(Boolean).join('\n');
prompts = prompts.replaceAll('复杂度分级', '结构规划');
prompts += '\n' + String.raw`
export interface TreeBuilderInput {
    userPrompt: string; coreType: string; version: string; clarifyRounds?: ClarifyRound[];
    treeSnapshot: string; issues: { code: string; message: string }[];
    lastResults: { ok: boolean; error?: string }[]; mode: "build" | "refine";
    correction: string; focusIds: string[]; round: number; maxRounds: number;
    apiContractContext?: string; knowledgeContext?: string; skillContext?: string;
}
export function treeBuilderPrompt(input: TreeBuilderInput): { system: string; user: string } {
    const decisions = input.clarifyRounds?.flatMap(round => round.todos.map(todo => `- ${todo.question} → ${JSON.stringify(round.answers[todo.id])}`)).join("\n") ?? "";
    return {
        system: `你是 Minecraft ${input.coreType} ${input.version} 项目结构规划器。用工具构建结构树，不输出 JSON 正文。
模块对应 Java 子包，模块数等于业务域数；只有一个业务域时只建一个模块。只有被两个以上模块共用的代码才放 common。
节点对应单个文件并携带完整成员契约。项目名 PascalCase，模块 id 小写英文，Java 节点 id 为类名且全项目不区分大小写唯一。
最多 10 个业务模块、40 个业务节点，每轮最多 60 次工具调用。
CommandGen：commands 非空，同时实现 CommandExecutor 和 TabCompleter。
ListenerGen：events 非空，实现 Listener；GUI 持有类可以无事件，但必须与监听类 tag=gui、pairId 互指，并包含 InventoryClickEvent。
TaskGen：schedule 非空，继承 BukkitRunnable，由 Main 启动。
ManagerGen：集中服务状态；ConfigClassGen：YAML 配置包装；ModelGen：POJO；EnumGen：枚举；UtilGen：无状态工具。
ConfigGen 只能放 _resources，声明 configKeys 时必须添加 config.yml。所有 methods、constructors、events、commands、schedule、configKeys、lifecycle 都是必须遵守的契约。
一轮可以批量调用多个树工具。认为完成时调用 finish_tree。learn_public_api 不能与树工具在同一轮混用。
系统模块 _build、_resources、_root 不可删除改名；pom.xml、plugin.yml、Main 由系统维护，不能改动；MainGen 和 FileRelatedGen 不可由模型创建。
不使用的 schedule.mode、lifecycle、tag 填 none，其余可选语义用空字符串或空数组。
refine 模式只改动修正意见和选中对象所涉及的部分，保持其余节点 id 不变。
__PRINCIPLES__
按需求落实以下约束，不新增用户未要求的业务：
__AXES__
${input.apiContractContext ?? ""}
${input.knowledgeContext ?? ""}
${input.skillContext ?? ""}`,
        user: `原始需求：${input.userPrompt}\n\n用户已确认的决策（必须严格遵守）：\n${decisions}\n\n当前树快照：\n${input.treeSnapshot}\n\n上一轮失败操作：\n${input.lastResults.filter(r => !r.ok).map(r => r.error).join("\n")}\n\n校验问题：\n${input.issues.map(i => `${i.code}: ${i.message}`).join("\n")}\n\n第 ${input.round}/${input.maxRounds} 轮\n${input.mode === "refine" ? `用户修正原文：${input.correction}\n选中对象（id 与标题见快照）：${input.focusIds.join(", ")}` : ""}`,
    };
}
`.replaceAll('\`', '`').replaceAll('\${', '${').replace('__PRINCIPLES__', principles).replace('__AXES__', axes);
write('functions/_lib/prompts.ts', prompts);
