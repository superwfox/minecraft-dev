import { reactive } from "vue";

export type ToolActivityKind = "skill" | "learning" | "tree" | "build" | "refresh";
export type ToolActivityStatus = "running" | "success" | "error" | "cancelled" | "notice";
export interface ToolActivity {
    id: number;
    kind: ToolActivityKind;
    title: string;
    detail: string;
    context: string;
    status: ToolActivityStatus;
    summary: string;
    startedAt: number;
    endedAt?: number;
    quiet: boolean;
}
export interface ToolActivityHandle {
    update: (detail: string, context?: string) => void;
    finish: (status: Exclude<ToolActivityStatus, "running">, summary: string) => void;
    fail: (error: unknown) => void;
}
type ActivityInput = Pick<ToolActivity, "kind" | "title"> & Partial<Pick<ToolActivity, "detail" | "context">> & {
    signal?: AbortSignal;
    refreshKey?: string;
};

// Transient presentation only: neither persisted nor awaited by generation requests.
export const toolActivities = reactive<ToolActivity[]>([]);
let sequence = 0;
const refreshTimes = new Map<string, number>();
const runningHandles = new Map<number, ToolActivityHandle>();

export function consumeToolActivity(id: number) {
    const index = toolActivities.findIndex(item => item.id === id);
    if (index >= 0) toolActivities.splice(index, 1);
}

function trimCompleted() {
    const completed = toolActivities.filter(item => item.status !== "running");
    for (const item of completed.slice(0, Math.max(0, completed.length - 8))) consumeToolActivity(item.id);
}

export function cancelToolActivities(clear = false) {
    for (const handle of [...runningHandles.values()]) handle.finish("cancelled", "调用已取消");
    if (clear) { toolActivities.splice(0); refreshTimes.clear(); }
}

export function beginToolActivity(input: ActivityInput): ToolActivityHandle {
    const now = Date.now();
    const key = input.refreshKey || input.kind;
    const quiet = input.kind === "refresh" && (now - (refreshTimes.get(key) || 0) < 20_000
        || toolActivities.some(item => item.status === "running" && item.kind !== "refresh"));
    if (input.kind === "refresh" && !quiet) refreshTimes.set(key, now);
    const item = reactive<ToolActivity>({
        id: ++sequence, kind: input.kind, title: input.title,
        detail: input.detail || "", context: input.context || "",
        status: "running", summary: "", startedAt: now, quiet,
    });
    toolActivities.push(item);
    let settled = false;
    const abort = () => handle.finish("cancelled", "调用已取消");
    const handle: ToolActivityHandle = {
        update(detail, context) {
            if (settled) return;
            item.detail = detail;
            if (context !== undefined) item.context = context;
        },
        finish(status, summary) {
            if (settled) return;
            settled = true;
            input.signal?.removeEventListener("abort", abort);
            runningHandles.delete(item.id);
            item.status = status; item.summary = summary; item.endedAt = Date.now();
            // Polling successes coalesce; failures are always surfaced.
            if (item.quiet && status !== "error") consumeToolActivity(item.id);
            else item.quiet = false;
            trimCompleted();
        },
        fail(error) {
            const cancelled = input.signal?.aborted || (error as { name?: string })?.name === "AbortError";
            handle.finish(cancelled ? "cancelled" : "error", cancelled ? "调用已取消"
                : error instanceof Error ? error.message : "工具调用失败");
        },
    };
    runningHandles.set(item.id, handle);
    if (input.signal?.aborted) abort();
    else input.signal?.addEventListener("abort", abort, { once: true });
    trimCompleted();
    return handle;
}

export async function withToolActivity<T>(input: ActivityInput, run: () => Promise<T>, summary: (result: T) => string): Promise<T> {
    const activity = beginToolActivity(input);
    try {
        const result = await run();
        activity.finish("success", summary(result));
        return result;
    } catch (error) { activity.fail(error); throw error; }
}
