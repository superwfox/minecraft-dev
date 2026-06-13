export type ChatMsg = {
    role: string;
    content: string;
};

export type StreamHandle = {
    stop: () => void;
    done: Promise<void>;
};

const INFO_PRESET =
    "请根据用户输入判断需求返回json，若内容无关则plainText。 键值对如下： " +
    "\"coreType\" : {\"PAPER\",\"BUKKIT\",\"SPIGOT\",\"FORGE\",\"FABRIC\",\"其他\",\"null\"} ," +
    "\"version\" : {\"1.21\",\"1.20\",\"1.19\",\"1.18\",\"1.17\",\"1.16\",\"1.15\",\"1.14\",\"1.13\",\"1.12\",\"1.11\",\"1.10\",\"1.9\",\"1.8\",\"1.7\",\"null\"} ," +
    "\"title\" : String ," +
    "\"rawPrompt\" : String ";

const TODO_PRESET =
    "将需求转换为json数组，若内容无关则直接输出plainText而非json。用于表示实现步骤每个元素包含以下键值对，对于不同的事件 需要写在不同的step当中： " +
    "\"step\" : int ," +
    "\"content\" : String #如果使用该键值 则无需判断后续元素 直接返回 ," +
    "\"function\" : String #没有请填null ," +
    "\"params\" : String[] #没有请填null ," +
    "\"event\" : String #没有请填null";

async function askDeepSeek(prompt: string, preset: string): Promise<string> {
    const messages = [
        { role: "system", content: preset },
        { role: "user", content: prompt },
    ];
    const response = await fetch("/api/chat", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ model: "deepseek-v4-flash", messages }),
    });
    if (!response.ok) throw new Error(await response.text());
    const data = await response.json() as any;
    return data.content ?? data.choices?.[0]?.message?.content ?? "";
}

export function getInfo(prompt: string) {
    return askDeepSeek(prompt, INFO_PRESET);
}

export function getTodoList(prompt: string) {
    return askDeepSeek(prompt, TODO_PRESET);
}

async function streamAsk(prompt: string, preset: string, onDelta: (chunk: string) => void, signal?: AbortSignal): Promise<string> {
    const messages = [
        { role: "system", content: preset },
        { role: "user", content: prompt },
    ];
    const response = await fetch("/api/stream", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ model: "deepseek-v4-flash", messages, stream: true }),
        signal,
    });
    if (!response.ok) throw new Error(await response.text());
    if (!response.body) throw new Error("No stream body");

    const reader = response.body.getReader();
    const decoder = new TextDecoder();
    let buffer = "";
    let full = "";

    while (true) {
        const { value, done } = await reader.read();
        if (done) break;
        buffer += decoder.decode(value, { stream: true });
        const lines = buffer.split("\n");
        buffer = lines.pop() ?? "";
        for (const line of lines) {
            const trimmed = line.trim();
            if (!trimmed.startsWith("data:")) continue;
            const payload = trimmed.slice(5).trim();
            if (payload === "[DONE]") return full;
            try {
                const json = JSON.parse(payload);
                const chunk = json?.choices?.[0]?.delta?.content ?? "";
                if (chunk) { full += chunk; onDelta(chunk); }
            } catch { /* skip */ }
        }
    }
    return full;
}

export function streamGetInfo(prompt: string, onDelta: (chunk: string) => void, signal?: AbortSignal) {
    return streamAsk(prompt, INFO_PRESET, onDelta, signal);
}

export function streamGetTodoList(prompt: string, onDelta: (chunk: string) => void) {
    return streamAsk(prompt, TODO_PRESET, onDelta);
}

const PRECHECK_PRESET =
    "你是一个 Minecraft 插件需求完整性检查器，判断用户的描述是否逻辑闭环、可以进入规划阶段。" +
    "需求必须至少有明确的核心功能或玩法目标，能识别\"玩家做什么\"或\"系统实现什么\"。" +
    "不要求细节（后续澄清会细化），只要逻辑闭环即可。" +
    "只输出 JSON，不要任何其他内容：" +
    "完整 → {\"complete\": true}；" +
    "不完整 → {\"complete\": false, \"hint\": \"请补充：1) xxx；2) xxx；3) xxx\"}，" +
    "hint 列出 2-4 条简短、具体的补充方向。";

export async function precheckPrompt(prompt: string): Promise<{ complete: boolean; hint?: string }> {
    const messages = [
        { role: "system", content: PRECHECK_PRESET },
        { role: "user", content: prompt },
    ];
    const response = await fetch("/api/chat", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ model: "deepseek-v4-pro", messages }),
    });
    if (!response.ok) throw new Error(await response.text());
    const data = await response.json() as any;
    const raw = (data.content ?? data.choices?.[0]?.message?.content ?? "").trim();
    const cleaned = raw.replace(/^```[\w]*\n?/, "").replace(/\n?```\s*$/, "").trim();
    try {
        const parsed = JSON.parse(cleaned);
        return { complete: parsed.complete === true, hint: parsed.hint };
    } catch {
        // 解析失败时视为通过，避免卡住流程
        return { complete: true };
    }
}

export function consistChat(
    history: ChatMsg[],
    prompt: string,
    onDelta: (textChunk: string) => void,
    onDone: () => void,
): StreamHandle {
    const controller = new AbortController();
    const messages: ChatMsg[] = [...history, { role: "user", content: prompt }];

    const done = (async () => {
        const response = await fetch("/api/stream", {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ model: "deepseek-v4-flash", messages, stream: true }),
            signal: controller.signal,
        });

        if (!response.ok) throw new Error(await response.text());
        if (!response.body) throw new Error("No stream body");

        const reader = response.body.getReader();
        const decoder = new TextDecoder();
        let buffer = "";

        while (true) {
            const { value, done: readerDone } = await reader.read();
            if (readerDone) break;

            buffer += decoder.decode(value, { stream: true });
            const lines = buffer.split("\n");
            buffer = lines.pop() ?? "";

            for (const line of lines) {
                const trimmed = line.trim();
                if (!trimmed.startsWith("data:")) continue;
                const payload = trimmed.slice(5).trim();
                if (payload === "[DONE]") { onDone(); return; }
                try {
                    const json = JSON.parse(payload);
                    const chunk = json?.choices?.[0]?.delta?.content ?? "";
                    if (chunk) onDelta(chunk);
                } catch { /* skip */ }
            }
        }
        onDone();
    })().catch((err) => {
        if (err?.name === "AbortError") return;
        onDone();
        throw err;
    });

    return { stop: () => controller.abort(), done };
}
