import { redact } from "../../shared/projectArchive";

type JournalContext = { request: Request; env: { DB?: D1Database }; data: any; waitUntil?: (promise: Promise<any>) => void };
export async function cleanupProjectJournal(db?: D1Database) {
    if (!db) return;
    await db.prepare("UPDATE project_journal_health SET pruned_through=MAX(pruned_through,COALESCE((SELECT MAX(sequence) FROM project_journal j WHERE j.task_id=project_journal_health.task_id AND j.owner_uid=project_journal_health.owner_uid AND j.expires_at<?),0))").bind(Date.now()).run();
    await db.prepare("DELETE FROM project_journal WHERE sequence IN (SELECT sequence FROM project_journal WHERE expires_at<? LIMIT 500)").bind(Date.now()).run();
    await db.prepare("DELETE FROM project_journal_health WHERE NOT EXISTS (SELECT 1 FROM project_journal j WHERE j.task_id=project_journal_health.task_id AND j.owner_uid=project_journal_health.owner_uid) AND NOT EXISTS (SELECT 1 FROM generation_tasks t WHERE t.task_id=project_journal_health.task_id)").run();
}
const CHUNK = 160 * 1024;
export function journalRecorder(context: JournalContext) {
    if (context.data.projectJournal) return context.data.projectJournal as ReturnType<typeof makeRecorder>;
    const recorder = makeRecorder(context); context.data.projectJournal = recorder; return recorder;
}
function makeRecorder(context: JournalContext) {
    let identity: Promise<{ taskId: string; uid: string }>;
    const secrets = [context.request.headers.get("X-LLM-Key") || "", (context.env as any).DEEPSEEK_API_KEY || "", (context.env as any).GITHUB_PAT || "", (context.env as any).GITHUB_PR_TOKEN || ""];
    function owner() {
        return identity ??= (async () => {
            let body: any = context.data.journalInput || {}; try { if (!context.data.journalInput && /json/.test(context.request.headers.get("Content-Type") || "")) body = await context.request.clone().json(); } catch {}
            return { uid: String(context.data.uid || ""), taskId: String(context.data.journalTaskId || body.taskId || new URL(context.request.url).searchParams.get("taskId") || "") };
        })();
    }
    let failures = 0;
    async function record(kind: string, data: unknown, incomplete = false) {
        const { taskId, uid } = await owner(); if (!taskId || !uid || !context.env.DB) return false;
        const value = JSON.stringify(redact({ data, incomplete }, secrets)), id = crypto.randomUUID(), at = Date.now();
        const parts = Math.max(1, Math.ceil(value.length / CHUNK));
        try {
            await context.env.DB.prepare("INSERT INTO project_journal_health (task_id,owner_uid,expected_events,failed_events) VALUES (?,?,1,?) ON CONFLICT(task_id,owner_uid) DO UPDATE SET expected_events=expected_events+1,failed_events=failed_events+excluded.failed_events").bind(taskId, uid, failures).run();
            for (let part = 0; part < parts; part++) await context.env.DB.prepare("INSERT INTO project_journal (event_id,task_id,owner_uid,recorded_at,kind,payload,expires_at) VALUES (?,?,?,?,?,?,?)")
                .bind(`${id}:${part}`, taskId, uid, at, kind, JSON.stringify({ id, part, parts, text: value.slice(part * CHUNK, (part + 1) * CHUNK) }), at + 86400000).run();
            await context.env.DB.prepare("UPDATE project_journal_health SET completed_events=completed_events+1 WHERE task_id=? AND owner_uid=?").bind(taskId, uid).run();
            return true;
        } catch { failures++; return false; }
    }
    const pending: Promise<unknown>[] = [];
    function defer(promise: Promise<unknown>) { pending.push(promise); context.waitUntil?.(promise); }
    const recordedFetch: typeof fetch = async (input, init) => {
        const { taskId, uid } = await owner();
        if (!taskId || !uid) return fetch(input, init);
        const callId = crypto.randomUUID(), start = Date.now();
        const url = String(input instanceof Request ? input.url : input);
        const kind = /\/chat\/completions(?:\?|$)/.test(url) ? "model" : "tool";
        let request: unknown = init?.body; try { request = JSON.parse(String(init?.body || "{}")); } catch {}
        const recorded = await record(`${kind}.request`, { callId, url, method: init?.method || "GET", request });
        if (context.env.DB && !recorded) throw new Error("执行记录存储不可用，请检查工程迁移后重试；尚未调用模型");
        try {
            const response = await fetch(input, init);
            return observeResponse(response, async (data, incomplete) => record(`${kind}.response`, { callId, status: response.status, elapsedMs: Date.now() - start, ...data }, incomplete), defer);
        } catch (error) {
            await record(`${kind}.error`, { callId, elapsedMs: Date.now() - start, error: String(error) }, true); throw error;
        }
    };
    return { record, defer, fetch: recordedFetch, failures: () => failures, flush: () => Promise.allSettled(pending) };
}
/** One consumer forwards bytes unchanged; diagnostics exclude reasoning deltas. No response.clone() tee. */
export function observeResponse(response: Response, onPart: (data: any, incomplete: boolean) => Promise<unknown>, defer: (promise: Promise<unknown>) => void): Response {
    if (!response.body) return response;
    const reader = response.body.getReader(), decoder = new TextDecoder();
    const contentType = response.headers.get("Content-Type") || "";
    const sse = /text\/event-stream/.test(contentType), binary = !!contentType && !/text\/|json|javascript|xml|yaml|x-www-form-urlencoded/i.test(contentType);
    let buffer = "", events: unknown[] = [], size = 0, sawDone = false, ended = false, cancelled = false;
    let consuming: Promise<void> = Promise.resolve();
    const flush = async (incomplete: boolean) => {
        if (events.length || incomplete) { const batch = events; events = []; size = 0; await onPart({ events: batch }, incomplete); }
    };
    const consume = async (text: string, final = false) => {
        if (binary) { if (final) { events.push({ gap: "binary_response_not_archived", contentType }); await flush(true); } return; }
        buffer += text;
        if (sse) {
            let position: number;
            while ((position = buffer.indexOf("\n")) !== -1) {
                const line = buffer.slice(0, position).trim(); buffer = buffer.slice(position + 1);
                if (line === "data: [DONE]") { sawDone = true; continue; }
                if (!line.startsWith("data:")) continue;
                try {
                    const value = JSON.parse(line.slice(5));
                    if (["thinking", "reasoning"].includes(value.type)) continue;
                    const safe = redact(value);
                    if (safe.choices?.every((choice: any) => choice.delta && !Object.keys(choice.delta).length) && !safe.usage) continue;
                    events.push(safe); size += line.length;
                } catch { events.push({ malformed: line.slice(0, 2048) }); size += line.length; await flush(true); }
                if (size >= CHUNK) await flush(false);
            }
            if (buffer.length > 4 * 1024 * 1024) { events.push({ gap: "oversized_sse_line" }); buffer = ""; await flush(true); }
        } else if (buffer.length > 8 * 1024 * 1024) { events.push({ gap: "oversized_response" }); buffer = ""; await flush(true); }
        if (final) {
            if (buffer.trim()) { try { events.push(redact(JSON.parse(buffer))); } catch { events.push({ text: buffer, partial: sse }); } }
            buffer = ""; await flush(sse && !sawDone);
        }
    };
    const body = new ReadableStream<Uint8Array>({
        async pull(controller) {
            try {
                const chunk = await reader.read();
                if (chunk.done) { consuming = consume(decoder.decode(), true); await consuming; ended = true; if (!cancelled) controller.close(); }
                else if (!cancelled) { controller.enqueue(chunk.value); consuming = consume(decoder.decode(chunk.value, { stream: true })); await consuming; }
            } catch (error) { if (!cancelled) { await flush(true); controller.error(error); } }
        },
        async cancel(reason) { cancelled = true; await consuming.catch(() => {}); const promise = flush(!sawDone && !ended); defer(promise); await promise; await reader.cancel(reason); },
    });
    return new Response(body, { status: response.status, statusText: response.statusText, headers: response.headers });
}
