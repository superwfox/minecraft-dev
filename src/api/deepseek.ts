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
        body: JSON.stringify({ model: "deepseek-chat", messages }),
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
            body: JSON.stringify({ model: "deepseek-chat", messages, stream: true }),
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
