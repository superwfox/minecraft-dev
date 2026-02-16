export type ChatMsg = {
    role: string;
    content: string;
};

export type StreamHandle = {
    stop: () => void;
    done: Promise<void>;
};

export async function askDeepSeek(prompt: string, preset: string): Promise<string> {
    const messages = [
        {role: "system", content: preset},
        {role: "user", content: prompt},
    ];
    const response = await fetch("/api/chat", {
        method: "POST",
        headers: {"Content-Type": "application/json"},
        body: JSON.stringify({model: "deepseek-chat", messages}),
    });
    if (!response.ok) throw new Error(await response.text());
    const data = await response.json() as any;
    return data.content ?? data.choices?.[0]?.message?.content ?? "";
}

export function consistChat(
    history: ChatMsg[],
    prompt: string,
    onDelta: (textChunk: string) => void,
    onDone: () => void,
): StreamHandle {
    const controller = new AbortController();
    const messages: ChatMsg[] = [...history, {role: "user", content: prompt}];

    const done = (async () => {
        const response = await fetch("/api/stream", {
            method: "POST",
            headers: {"Content-Type": "application/json"},
            body: JSON.stringify({model: "deepseek-chat", messages, stream: true}),
            signal: controller.signal,
        });

        if (!response.ok) throw new Error(await response.text());
        if (!response.body) throw new Error("No stream body");

        const reader = response.body.getReader();
        const decoder = new TextDecoder();
        let buffer = "";

        while (true) {
            const {value, done: readerDone} = await reader.read();
            if (readerDone) break;

            buffer += decoder.decode(value, {stream: true});
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

    return {stop: () => controller.abort(), done};
}
