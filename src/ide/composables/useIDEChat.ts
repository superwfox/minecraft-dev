import {reactive, ref} from "vue";
import {useIDEStore} from "./useIDEStore";

export type IDEFileAction = { path: string; action: "create" | "edit"; content: string };
export type IDEMessage = {
    role: "user" | "assistant";
    text: string;
    intent?: "chat" | "create" | "edit";
    files?: IDEFileAction[];
};

const SYSTEM_PROMPT = `你是 Minecraft Paper 1.21 插件项目的 IDE 内置 AI 助手。

【意图判断】
- chat：用户在询问、解释、讨论、技术答疑，不修改任何文件
- create：用户明确要求"新建/写一个/加一个/新增"某种功能或某个类
- edit：用户明确要求"改/修复/优化/重构/补充"某个已存在的文件
模糊或纯讨论时优先 chat。

【输出格式】严格遵守，不要任何额外解释

第一行必须是其中之一：
INTENT:chat
INTENT:create
INTENT:edit

之后是给用户看的中文回复（1-4 句话，简明）。

如果意图不是 chat，每个相关文件追加一个块：

FILE create src/main/java/com/tahai/Foo.java
\`\`\`java
完整文件内容
\`\`\`

FILE edit src/main/resources/plugin.yml
\`\`\`yaml
完整文件内容
\`\`\`

【规则】
- create 时 path 必须是完整路径（含 src/main/java/包名/Class.java）
- edit 时 path 必须存在于"当前 IDE 文件"列表
- content 永远是完整文件，绝不输出 diff 或片段
- Java 包名沿用现有文件结构（看其他文件的 package）
- 一次回复最多 3 个文件
- 不要写 ## 标题、不要 markdown 包裹整段回复、不要"以下是代码："这种废话

【Paper 项目约定】
- 颜色代码：yml/properties 配置文件中用 § 字符（如 §a 绿色、§c 红色、§6 金色、§r 重置）直接写，**绝对不要用 &**
- Java 代码中颜色优先用 ChatColor 枚举（ChatColor.GREEN + "text"），不要写 \\u00a7 或 §
- 如果不得不在 yml 里用 &，对应的 Java 代码必须调用 ChatColor.translateAlternateColorCodes('&', s) 转换
- 现代化优先：能用 Adventure API（Component, MiniMessage）就用
`;

const TRUNCATE_CHARS = 6000;

function truncate(s: string, max = TRUNCATE_CHARS): string {
    if (s.length <= max) return s;
    return s.slice(0, max) + "\n\n... [文件过长，已截断]";
}

function buildPrompt(userText: string): string {
    const store = useIDEStore();
    const lines: string[] = [];

    lines.push("【当前 IDE 文件列表】");
    if (store.state.files.length === 0) {
        lines.push("（空）");
    } else {
        for (const f of store.state.files) {
            lines.push(`- ${f.path}${f.role ? `  // ${f.role}` : ""}`);
        }
    }

    const cur = store.currentFile.value;
    if (cur) {
        lines.push("");
        lines.push(`【用户当前打开的文件】${cur.path}`);
        const ext = cur.path.split(".").pop()?.toLowerCase() || "";
        lines.push("```" + ext);
        lines.push(truncate(cur.content));
        lines.push("```");
    }

    lines.push("");
    lines.push("【用户消息】");
    lines.push(userText);
    return lines.join("\n");
}

function parseResponse(raw: string, existingPaths: Set<string>): {
    intent: "chat" | "create" | "edit";
    reply: string;
    files: IDEFileAction[];
} {
    const intentMatch = raw.match(/^\s*INTENT:\s*(chat|create|edit)/im);
    let intent: "chat" | "create" | "edit" = "chat";
    let bodyStart = 0;
    if (intentMatch) {
        intent = intentMatch[1].toLowerCase() as any;
        bodyStart = intentMatch.index! + intentMatch[0].length;
    }
    const body = raw.slice(bodyStart);

    const files: IDEFileAction[] = [];
    const fileRegex = /FILE\s+(create|edit)\s+([^\n`]+?)\s*\n```[\w-]*\s*\n([\s\S]*?)\n```/g;
    let firstFileIdx = -1;
    let m: RegExpExecArray | null;
    while ((m = fileRegex.exec(body)) !== null) {
        if (firstFileIdx === -1) firstFileIdx = m.index;
        const path = m[2].trim();
        const content = m[3];
        const action: "create" | "edit" = existingPaths.has(path) ? "edit" : "create";
        files.push({action, path, content});
    }

    let reply = firstFileIdx >= 0 ? body.slice(0, firstFileIdx) : body;
    reply = reply.replace(/^[\s\n]+|[\s\n]+$/g, "");

    return {intent, reply, files};
}

const state = reactive<{
    messages: IDEMessage[];
    streaming: boolean;
    streamingText: string;
}>({
    messages: [],
    streaming: false,
    streamingText: "",
});

// dock 三态由 chat composable 共享，让选区浮层也能控制
const dockState = ref<"dormant" | "hint" | "open">("dormant");

async function send(userText: string) {
    if (state.streaming) return;
    const store = useIDEStore();

    state.messages.push({role: "user", text: userText});
    state.streaming = true;
    state.streamingText = "";

    try {
        const resp = await fetch("/api/stream", {
            method: "POST",
            headers: {"Content-Type": "application/json"},
            body: JSON.stringify({
                model: "deepseek-v4-flash",
                taskId: store.state.taskId || undefined,
                messages: [
                    {role: "system", content: SYSTEM_PROMPT},
                    {role: "user", content: buildPrompt(userText)},
                ],
                stream: true,
            }),
        });
        if (resp.status === 402) throw new Error("本月额度已用尽，请登录后兑换或等下月");
        if (resp.status === 401) throw new Error("登录已过期，请重新登录");
        if (!resp.ok) throw new Error(await resp.text());
        if (!resp.body) throw new Error("无响应流");

        const reader = resp.body.getReader();
        const decoder = new TextDecoder();
        let buffer = "";
        let full = "";

        outer: while (true) {
            const {value, done} = await reader.read();
            if (done) break;
            buffer += decoder.decode(value, {stream: true});
            const lines = buffer.split("\n");
            buffer = lines.pop() ?? "";
            for (const line of lines) {
                const t = line.trim();
                if (!t.startsWith("data:")) continue;
                const payload = t.slice(5).trim();
                if (payload === "[DONE]") break outer;
                try {
                    const j = JSON.parse(payload);
                    const chunk = j?.choices?.[0]?.delta?.content ?? "";
                    if (chunk) {
                        full += chunk;
                        state.streamingText = full;
                    }
                } catch { /* skip */ }
            }
        }

        const existing = new Set(store.state.files.map(f => f.path));
        const parsed = parseResponse(full, existing);

        for (const f of parsed.files) {
            const prior = store.state.files.find(sf => sf.path === f.path);
            await store.upsertFile({
                path: f.path,
                content: f.content,
                role: prior?.role || (f.action === "create" ? "AI 创建" : prior?.role || ""),
                generatorType: prior?.generatorType ?? null,
            });
        }

        state.messages.push({
            role: "assistant",
            text: parsed.reply || (parsed.files.length ? "完成。" : "（无回复内容）"),
            intent: parsed.intent,
            files: parsed.files.length ? parsed.files : undefined,
        });
    } catch (e: any) {
        state.messages.push({
            role: "assistant",
            text: `AI 调用失败：${e?.message || String(e)}`,
            intent: "chat",
        });
    } finally {
        state.streaming = false;
        state.streamingText = "";
    }
}

// 供选区浮层调用的轻量 Q&A —— 不污染主聊天 state，只通过回调流式
async function askWithSelection(opts: {
    snippet: string;
    contextPath: string;
    taskHint: string;
    customQuestion?: string;
    onDelta: (chunk: string) => void;
    signal?: AbortSignal;
}): Promise<string> {
    const sys = `你是 Minecraft Paper 插件 IDE 内的代码助手。基于给定代码片段执行任务。

严格区分两类任务：

【修改类】 关键词：优化 / 重构 / 修复 / 修 Bug / 加注释 / 注释 / 改成 / 转换 / 提取 / 补全 / 重写 / 美化
- 仅输出修改后的完整代码片段，用 markdown 代码块包裹：\`\`\`<lang>\\n代码\\n\`\`\`
- 不要前后写任何解释、不要 "以下是修改后的代码：" 这种废话
- 必须输出完整可替换片段，缩进/语法正确，能直接替换原选区
- 严禁输出 diff 或局部片段

【解释类】 关键词：解释 / 是什么 / 为什么 / 做什么 / 如何 / 含义 / 作用
- 仅用 2-4 句中文说明
- 绝对不要写代码、不要 markdown 代码块

永远不要输出 INTENT 或 FILE 等标记。

【Paper 项目约定】
- 颜色代码：yml 中用 § 字符（如 §a §c §6 §r），绝不用 &
- Java 中颜色优先用 ChatColor 枚举（ChatColor.GREEN）`;

    const ext = opts.contextPath.split(".").pop()?.toLowerCase() || "";
    const user = `【代码片段】来自 ${opts.contextPath}
\`\`\`${ext}
${truncate(opts.snippet, 3000)}
\`\`\`

【任务】${opts.taskHint}${opts.customQuestion ? `\n【追加说明】${opts.customQuestion}` : ""}`;

    const store = useIDEStore();
    const resp = await fetch("/api/stream", {
        method: "POST",
        headers: {"Content-Type": "application/json"},
        body: JSON.stringify({
            model: "deepseek-v4-flash",
            taskId: store.state.taskId || undefined,
            messages: [
                {role: "system", content: sys},
                {role: "user", content: user},
            ],
            stream: true,
        }),
        signal: opts.signal,
    });
    if (resp.status === 402) throw new Error("本月额度已用尽");
    if (resp.status === 401) throw new Error("登录已过期");
    if (!resp.ok) throw new Error(await resp.text());
    if (!resp.body) throw new Error("无响应流");

    const reader = resp.body.getReader();
    const decoder = new TextDecoder();
    let buffer = "";
    let full = "";
    outer: while (true) {
        const {value, done} = await reader.read();
        if (done) break;
        buffer += decoder.decode(value, {stream: true});
        const lines = buffer.split("\n");
        buffer = lines.pop() ?? "";
        for (const line of lines) {
            const t = line.trim();
            if (!t.startsWith("data:")) continue;
            const payload = t.slice(5).trim();
            if (payload === "[DONE]") break outer;
            try {
                const j = JSON.parse(payload);
                const chunk = j?.choices?.[0]?.delta?.content ?? "";
                if (chunk) {
                    full += chunk;
                    opts.onDelta(chunk);
                }
            } catch { /* skip */ }
        }
    }
    return full;
}

// 选区浮层"进入聊天"时把对话推入主 dock
function pushSelectionToDock(opts: { snippet: string; contextPath: string; question: string; reply: string }) {
    const ext = opts.contextPath.split(".").pop()?.toLowerCase() || "";
    state.messages.push({
        role: "user",
        text: `${opts.question}\n\n来自 ${opts.contextPath}:\n\`\`\`${ext}\n${opts.snippet}\n\`\`\``,
    });
    state.messages.push({
        role: "assistant",
        text: opts.reply,
        intent: "chat",
    });
    dockState.value = "open";
}

function clear() {
    state.messages = [];
    state.streaming = false;
    state.streamingText = "";
}

export function useIDEChat() {
    return {state, dockState, send, askWithSelection, pushSelectionToDock, clear};
}
