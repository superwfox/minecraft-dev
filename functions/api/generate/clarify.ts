import { plannerClarifyPrompt } from "../../_lib/prompts";

const DEEPSEEK_URL = "https://api.deepseek.com/v1/chat/completions";
const MAX_CLARIFY_ROUNDS = 5;

interface Env {
    DEEPSEEK_API_KEY: string;
    TASKS: KVNamespace;
}

function stripFences(raw: string): string {
    return raw.replace(/^```[\w]*\n?/, "").replace(/\n?```\s*$/, "").trim();
}

function sseEvent(encoder: TextEncoder, data: any): Uint8Array {
    return encoder.encode(`data: ${JSON.stringify(data)}\n\n`);
}

async function callReasonerStream(
    key: string, system: string, user: string,
    writer: WritableStreamDefaultWriter<Uint8Array>, encoder: TextEncoder,
): Promise<string> {
    const resp = await fetch(DEEPSEEK_URL, {
        method: "POST",
        headers: { "Content-Type": "application/json", Authorization: `Bearer ${key}` },
        body: JSON.stringify({
            model: "deepseek-reasoner",
            stream: true,
            messages: [{ role: "system", content: system }, { role: "user", content: user }],
        }),
    });
    if (!resp.ok) throw new Error(await resp.text());

    const reader = resp.body!.getReader();
    const decoder = new TextDecoder();
    let buffer = "";
    let content = "";

    while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        buffer += decoder.decode(value, { stream: true });
        const lines = buffer.split("\n");
        buffer = lines.pop()!;

        for (const line of lines) {
            const trimmed = line.trim();
            if (!trimmed.startsWith("data:")) continue;
            const payload = trimmed.slice(5).trim();
            if (payload === "[DONE]") continue;
            try {
                const chunk = JSON.parse(payload);
                const delta = chunk.choices?.[0]?.delta;
                if (!delta) continue;
                if (delta.reasoning_content) {
                    await writer.write(sseEvent(encoder, {
                        type: "reasoning", content: delta.reasoning_content,
                    }));
                }
                if (delta.content) {
                    content += delta.content;
                    await writer.write(sseEvent(encoder, {
                        type: "delta", content: delta.content,
                    }));
                }
            } catch { /* skip */ }
        }
    }
    return content;
}

export const onRequestPost: PagesFunction<Env> = async (context) => {
    const body = await context.request.json() as any;
    const key = context.env.DEEPSEEK_API_KEY;
    if (!key) return new Response("API key not configured", { status: 500 });

    const taskId = body.taskId as string;
    const answers = body.answers as Record<string, string | string[]> | undefined;
    const extraPrompt = body.extraPrompt as string | undefined;

    const raw = await context.env.TASKS.get(taskId);
    if (!raw) return new Response("Task not found", { status: 404 });
    const state = JSON.parse(raw);

    // 将上一轮的 answers 回填到最后一轮的 todos
    if (answers && state.clarifyRounds.length > 0) {
        state.clarifyRounds[state.clarifyRounds.length - 1].answers = answers;
    }

    // 用户补充描述后，追加到原始需求
    if (extraPrompt && extraPrompt.trim()) {
        state.userPrompt = `${state.userPrompt}\n\n补充说明：${extraPrompt.trim()}`;
    }

    const { readable, writable } = new TransformStream<Uint8Array>();
    const encoder = new TextEncoder();
    const writer = writable.getWriter();

    const process = (async () => {
        try {
            // 超过最大轮次，强制 done
            if (state.clarifyRounds.length >= MAX_CLARIFY_ROUNDS) {
                state.clarifyDone = true;
                state.logs.push(`● 澄清轮次达到上限 ${MAX_CLARIFY_ROUNDS}，强制结束`);
                await context.env.TASKS.put(taskId, JSON.stringify(state), { expirationTtl: 3600 });
                await writer.write(sseEvent(encoder, { type: "result", done: true, todos: [] }));
                await writer.write(encoder.encode("data: [DONE]\n\n"));
                await writer.close();
                return;
            }

            await writer.write(sseEvent(encoder, {
                type: "phase", phase: "clarifying", round: state.clarifyRounds.length + 1,
            }));

            const { system, user } = plannerClarifyPrompt(
                state.userPrompt, state.coreType, state.version, state.clarifyRounds,
            );
            const content = await callReasonerStream(key, system, user, writer, encoder);

            let parsed: { done?: boolean; todos?: any[]; needMoreInput?: boolean; hint?: string };
            try {
                parsed = JSON.parse(stripFences(content));
            } catch {
                await writer.write(sseEvent(encoder, {
                    type: "log", msg: "× 澄清阶段解析失败，强制进入规划",
                }));
                state.clarifyDone = true;
                await context.env.TASKS.put(taskId, JSON.stringify(state), { expirationTtl: 3600 });
                await writer.write(sseEvent(encoder, { type: "result", done: true, todos: [] }));
                await writer.write(encoder.encode("data: [DONE]\n\n"));
                await writer.close();
                return;
            }

            if (parsed.needMoreInput) {
                state.logs.push(`! 需求过于模糊，请求用户补充`);
                await context.env.TASKS.put(taskId, JSON.stringify(state), { expirationTtl: 3600 });
                await writer.write(sseEvent(encoder, {
                    type: "result", needMoreInput: true, hint: parsed.hint || "请补充更具体的功能描述",
                }));
                await writer.write(encoder.encode("data: [DONE]\n\n"));
                return;
            }

            const todos = Array.isArray(parsed.todos) ? parsed.todos : [];
            const done = parsed.done === true || todos.length === 0;

            if (!done) {
                state.clarifyRounds.push({ todos, answers: {} });
                state.logs.push(`▸ 澄清第 ${state.clarifyRounds.length} 轮：${todos.length} 项待确认`);
            } else {
                state.clarifyDone = true;
                state.logs.push(`● 澄清完成，共 ${state.clarifyRounds.length} 轮`);
            }

            await context.env.TASKS.put(taskId, JSON.stringify(state), { expirationTtl: 3600 });

            await writer.write(sseEvent(encoder, { type: "result", done, todos }));
            await writer.write(encoder.encode("data: [DONE]\n\n"));
        } catch (e: any) {
            await writer.write(sseEvent(encoder, { type: "log", msg: `× 错误: ${e.message}` }));
            await writer.write(encoder.encode("data: [DONE]\n\n"));
        } finally {
            await writer.close();
        }
    })();

    context.waitUntil(process);

    return new Response(readable, {
        headers: {
            "Content-Type": "text/event-stream",
            "Cache-Control": "no-cache",
            "Connection": "keep-alive",
        },
    });
};
