// Cloudflare Pages Function: POST /api/stream
// 流式请求，按完整 SSE 事件转发 DeepSeek 的 stream 响应。
// 转发期间解析末尾 chunk 的 usage 字段，并累积到 D1 任务成本。

import { accumulateCost, type UsageBreakdown } from "../_lib/quota";
import {
    deepSeekKeyRequiredResponse,
    resolveLLM,
    resolveTaskLLM,
    tierFromModel,
    type LLMProvider,
} from "../_lib/llm";
import { getOwnedTask, markTaskQuotaExhausted } from "../_lib/taskStore";
import { buildApiContractContext } from "../_lib/apiContracts";
import {
    ClientCancelledError,
    abortOnWriteFailure,
    isClientCancelled,
    linkClientAbortSignal,
} from "../_lib/clientAbort";

interface Env {
    DEEPSEEK_API_KEY: string;
    TASKS: KVNamespace;
}

export const onRequestPost: PagesFunction<Env> = async (context) => {
    const body = await context.request.json() as any;
    const taskId: string | undefined = body.taskId;
    const uid: string = (context.data as any)?.uid || "";
    let taskState: any = null;
    let llm: LLMProvider;

    // 带 taskId 的调用必须命中当前用户的任务，避免越权读取上下文或错误归集费用。
    if (taskId) {
        const stateRaw = await getOwnedTask(context.env, taskId, uid);
        if (!stateRaw) return new Response("Task not found", { status: 404 });
        try { taskState = JSON.parse(stateRaw); } catch { return new Response("Task state unavailable", { status: 503 }); }
        const resolved = await resolveTaskLLM(context, taskState);
        if (!resolved) return deepSeekKeyRequiredResponse();
        llm = resolved;
        if (taskState.quotaExhausted && !llm.byok) {
            return new Response(JSON.stringify({ error: "充值额度已用尽", code: "QUOTA_EXHAUSTED" }), {
                status: 402, headers: { "Content-Type": "application/json" },
            });
        }
    } else {
        llm = await resolveLLM(context);
    }
    if (!llm.apiKey) return new Response("API key not configured", {status: 500});

    const tier = tierFromModel(body.model);
    const model = llm.modelFor(tier);

    const messages = Array.isArray(body.messages)
        ? body.messages.map((message: any) => ({ ...message }))
        : [];
    if (body.purpose === "append") {
        const fallback = body.projectContext ?? {};
        const generatedFiles = Array.isArray(taskState?.generatedFiles)
            ? taskState.generatedFiles.filter((file: any) => !/(^|\/)pom\.xml$/i.test(file.path))
            : [];
        const pomContent = fallback.pomContent
            || taskState?.generatedFiles?.find((file: any) => /(^|\/)pom\.xml$/i.test(file.path))?.content;
        if (pomContent) generatedFiles.push({ path: "pom.xml", content: String(pomContent) });
        const apiContract = buildApiContractContext({
            coreType: taskState?.coreType || fallback.coreType,
            version: taskState?.version || fallback.version,
            externalDeps: taskState?.grade?.vector?.external_deps ?? [],
            generatedFiles,
        });
        const systemMessage = messages.find((message: any) => message.role === "system");
        if (systemMessage) systemMessage.content = `${systemMessage.content}\n\n${apiContract}`;
        else messages.unshift({ role: "system", content: apiContract });
    }

    const payload: any = {
        model,
        messages,
        stream: true,
        stream_options: { include_usage: true },
    };
    if (tier === "pro") {
        payload.reasoning_effort = "high";
        payload.thinking = {type: "enabled"};
    }

    const upstreamAbort = new AbortController();
    const unlinkClientAbort = linkClientAbortSignal(
        upstreamAbort,
        context.request.signal,
        "Stream request cancelled by client",
    );
    let resp: Response;
    try {
        resp = await fetch(llm.url, {
            method: "POST",
            headers: {
                "Content-Type": "application/json",
                "Authorization": "Bearer " + llm.apiKey,
            },
            body: JSON.stringify(payload),
            signal: upstreamAbort.signal,
        });
    } catch (error) {
        unlinkClientAbort();
        if (isClientCancelled(error) || isClientCancelled(upstreamAbort.signal.reason)) {
            return new Response(JSON.stringify({ error: "请求已取消", code: "CLIENT_CANCELLED" }), {
                status: 499, headers: { "Content-Type": "application/json" },
            });
        }
        return new Response(JSON.stringify({ error: "与模型服务连接失败" }), {
            status: 502, headers: { "Content-Type": "application/json" },
        });
    }

    if (!resp.ok) {
        try {
            return new Response(await resp.text(), {status: resp.status});
        } catch (error) {
            if (isClientCancelled(error) || isClientCancelled(upstreamAbort.signal.reason)) {
                return new Response(JSON.stringify({ error: "请求已取消", code: "CLIENT_CANCELLED" }), {
                    status: 499, headers: { "Content-Type": "application/json" },
                });
            }
            return new Response(JSON.stringify({ error: "无法读取模型服务错误响应" }), {
                status: 502, headers: { "Content-Type": "application/json" },
            });
        } finally {
            unlinkClientAbort();
        }
    }
    if (!resp.body) {
        unlinkClientAbort();
        return new Response("Empty response", {status: 502});
    }

    // 用 TransformStream 包一层：事件级转发给前端，同时本端解析 usage。
    const upstream = resp.body;
    const { readable, writable } = new TransformStream<Uint8Array>();
    const writer = writable.getWriter();
    const encoder = new TextEncoder();
    const decoder = new TextDecoder();
    let downstreamFinished = false;

    const writeDownstream = async (value: Uint8Array) => {
        try {
            await writer.write(value);
        } catch (error) {
            abortOnWriteFailure(upstreamAbort, error);
        }
    };

    const downstreamClosed = writer.closed.catch((error) => {
        if (downstreamFinished || upstreamAbort.signal.aborted) return;
        upstreamAbort.abort(new ClientCancelledError("Client disconnected from stream", error));
    });

    const pump = (async () => {
        const reader = upstream.getReader();
        let buffer = "";
        let usage: UsageBreakdown | undefined;
        let upstreamDone = false;
        let heartbeat: ReturnType<typeof setInterval> | undefined;
        const maxPendingEventChars = 1_000_000;

        const inspectEvent = (eventText: string) => {
            const payloadStr = eventText
                .split(/\r?\n/)
                .map(line => line.trimStart())
                .filter(line => line.startsWith("data:"))
                .map(line => line.slice(5).trimStart())
                .join("\n")
                .trim();
            if (!payloadStr) return;
            if (payloadStr === "[DONE]") {
                upstreamDone = true;
                if (heartbeat) {
                    clearInterval(heartbeat);
                    heartbeat = undefined;
                }
                return;
            }
            try {
                const chunk = JSON.parse(payloadStr);
                if (chunk.usage) usage = chunk.usage;
            } catch { /* skip non-JSON events */ }
        };

        const forwardCompleteEvents = async () => {
            while (true) {
                const boundary = /\r?\n\r?\n/.exec(buffer);
                if (!boundary) return;
                const eventText = buffer.slice(0, boundary.index);
                buffer = buffer.slice(boundary.index + boundary[0].length);
                inspectEvent(eventText);
                await writeDownstream(encoder.encode(eventText + boundary[0]));
            }
        };

        // 只在完整 SSE 事件之间插入注释心跳，避免破坏被网络分块截开的 JSON 事件。
        heartbeat = setInterval(() => {
            writeDownstream(encoder.encode(": heartbeat\n\n")).catch(() => { });
        }, 12_000);
        try {
            while (!upstreamDone) {
                const { value, done } = await reader.read();
                if (done) break;
                buffer += decoder.decode(value, { stream: true });
                await forwardCompleteEvents();
                if (buffer.length > maxPendingEventChars) {
                    throw new Error("upstream SSE event exceeded the size limit");
                }
            }
            buffer += decoder.decode();
            await forwardCompleteEvents();
            if (!upstreamDone) throw new Error("upstream stream ended before [DONE]");
        } catch (error) {
            const cancelled = isClientCancelled(error) || isClientCancelled(upstreamAbort.signal.reason);
            if (!upstreamDone && !cancelled) {
                try {
                    await writeDownstream(encoder.encode(`data: ${JSON.stringify({
                        type: "error",
                        error: "模型流连接异常，请重试",
                        code: "STREAM_TRUNCATED",
                        status: 502,
                        retryable: true,
                    })}\n\n`));
                    await writeDownstream(encoder.encode("data: [DONE]\n\n"));
                } catch { /* client disconnected */ }
            }
        } finally {
            if (heartbeat) clearInterval(heartbeat);
            try { await reader.cancel(); } catch { /* already closed */ }
            try { reader.releaseLock(); } catch { /* already released */ }
            downstreamFinished = true;
            try { await writer.close(); } catch { /* already closed */ }
            await downstreamClosed;
            unlinkClientAbort();
        }

        // 流结束后累积成本（BYOK 自带 key 时跳过）
        if (!llm.byok && uid && usage) {
            const billingTaskId = taskId || `adhoc:${uid}`;
            try {
                const cost = await accumulateCost(context.env, uid, billingTaskId, model, usage, !!taskId);
                if (cost.outOfQuota && taskId) await markTaskQuotaExhausted(context.env, taskId, uid);
            } catch { /* ignore */ }
        }
    })();

    context.waitUntil(pump);

    return new Response(readable, {
        headers: {
            "Content-Type": "text/event-stream",
            "Cache-Control": "no-cache",
            "Connection": "keep-alive",
        },
    });
};
