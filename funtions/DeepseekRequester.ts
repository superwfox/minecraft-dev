const QuestURL = "https://api.deepseek.com/v1/chat/completions";

type ChatMsg = {
    role: string,
    content: string
}

type StreamHandle = {
    stop: () => void;                 // 用户调用它来停止
    done: Promise<void>;              // 等到流结束/被停止
};

export async function askDeepSeek(prompt: string, preset: string) {
    const response = await fetch(QuestURL, {
        method: "POST",
        headers: {
            "Content-Type": "application/json",
            "Authorization": "Bearer " + env.DEEPSEEK_API_KEY,
        },
        body: JSON.stringify({
            model: "deepseek-chat",
            messages: [
                {role: "system", content: preset},
                {role: "user", content: prompt}
            ],
        }),
    });
    const data = await response.json();
    return data.choices[0].message.content;
}

export function consistChat(history: ChatMsg[], prompt: string, onDelta: (textChunk: string) => void, onDone: () => void)
    : StreamHandle {
    const controller = new AbortController();
    const done = (async () => {
        const response = await fetch(QuestURL, {
            method: "POST",
            headers: {
                "Content-Type": "application/json",
                "Authorization": "Bearer " + env.DEEPSEEK_API_KEY,
                "Accept": "text/event-stream"
            },
            body: JSON.stringify({
                model: "deepseek-chat",
                messages: history +
                    {role: "user", content: prompt},
                stream: true
            }),
            signal: controller.signal,
        });

        if (!response.ok) throw new Error(await response.text());
        if (!response.body) throw new Error("No stream body");

        const reader = response.body.getReader();
        const decoder = new TextDecoder();
        let buffer = "";

        const readNext = async (): Promise<void> => {
            const {value, done} = await reader.read();
            if (done) return;

            buffer += decoder.decode(value, {stream: true});

            const lines = buffer.split("\n");
            buffer = lines.pop() ?? "";

            for (const line of lines) {
                const trimmed = line.trim();
                if (!trimmed.startsWith("data:")) continue;

                const payload = trimmed.slice(5).trim();
                if (payload === "[DONE]") return;

                try {
                    const json = JSON.parse(payload);
                    const chunk = json?.choices?.[0]?.delta?.content ?? "";
                    if (chunk) onDelta(chunk);
                } catch {
                    // 忽略不是 JSON 的行
                }
            }

            await readNext(); // 继续读下一段
        };
        await readNext();
    })().catch((err) => {
        // 用户 stop() 会触发 AbortError，这里就安静结束
        if (err?.name === "AbortError") return;
        throw err;
    });

    return {
        stop: () => controller.abort(),
        done,
    };
}