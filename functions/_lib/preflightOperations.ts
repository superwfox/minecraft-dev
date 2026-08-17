export type PreflightStage = "clarify" | "grade";
export type PreflightOperationStatus = "running" | "retryable" | "completed";

export interface PreflightOperationRecord {
    requestId: string;
    inputHash: string;
    input: Record<string, unknown>;
    status: PreflightOperationStatus;
    result?: Record<string, unknown>;
    billingSettled: boolean;
    startedAt: number;
    completedAt?: number;
    lastError?: string;
}

const MAX_OPERATION_HISTORY = 20;

function canonicalize(value: unknown): unknown {
    if (Array.isArray(value)) return value.map(canonicalize);
    if (!value || typeof value !== "object") return value;
    const input = value as Record<string, unknown>;
    const output: Record<string, unknown> = {};
    for (const key of Object.keys(input).sort()) {
        if (input[key] !== undefined) output[key] = canonicalize(input[key]);
    }
    return output;
}

export async function preflightInputHash(input: Record<string, unknown>): Promise<string> {
    const bytes = new TextEncoder().encode(JSON.stringify(canonicalize(input)));
    const digest = await crypto.subtle.digest("SHA-256", bytes);
    return [...new Uint8Array(digest)].map(value => value.toString(16).padStart(2, "0")).join("");
}

export function parsePreflightRequestId(stage: PreflightStage, value: unknown): string {
    const prefix = stage === "clarify" ? "clarify" : "grade";
    return typeof value === "string" && new RegExp(`^${prefix}_[a-z0-9]{16,64}$`, "i").test(value)
        ? value
        : "";
}

export function preflightOperations(state: any, stage: PreflightStage): PreflightOperationRecord[] {
    const key = `${stage}Operations`;
    if (!Array.isArray(state[key])) state[key] = [];
    state[key] = state[key].filter((record: any) =>
        record
        && typeof record.requestId === "string"
        && typeof record.inputHash === "string"
        && ["running", "retryable", "completed"].includes(record.status),
    ).slice(-MAX_OPERATION_HISTORY);
    return state[key] as PreflightOperationRecord[];
}

export function findPreflightOperation(
    state: any,
    stage: PreflightStage,
    requestId: string,
): PreflightOperationRecord | undefined {
    return preflightOperations(state, stage).find(record => record.requestId === requestId);
}

export function activePreflightOperation(
    state: any,
    stage: PreflightStage,
): PreflightOperationRecord | undefined {
    return preflightOperations(state, stage).find(record =>
        record.status !== "completed" || !record.billingSettled,
    );
}

export function appendPreflightOperation(
    state: any,
    stage: PreflightStage,
    record: PreflightOperationRecord,
): PreflightOperationRecord {
    const operations = preflightOperations(state, stage);
    operations.push(record);
    if (operations.length > MAX_OPERATION_HISTORY) {
        const removable = operations.findIndex(item => item.status === "completed");
        if (removable >= 0) operations.splice(removable, 1);
    }
    return record;
}

function sse(data: unknown): string {
    return `data: ${JSON.stringify(data)}\n\n`;
}

export function replayPreflightResult(
    stage: PreflightStage,
    record: PreflightOperationRecord,
): Response {
    return new Response(
        sse({ type: "result", stage, replay: true, ...(record.result ?? {}) }) + "data: [DONE]\n\n",
        {
            headers: {
                "Content-Type": "text/event-stream",
                "Cache-Control": "no-cache",
                "Connection": "keep-alive",
            },
        },
    );
}

export function preflightJsonError(
    error: string,
    code: string,
    status: number,
    retryAfter?: number,
    details: Record<string, unknown> = {},
): Response {
    const headers: Record<string, string> = { "Content-Type": "application/json" };
    if (retryAfter) headers["Retry-After"] = String(retryAfter);
    return new Response(JSON.stringify({ error, code, ...details }), { status, headers });
}
