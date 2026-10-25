import type { UsageCostEntry } from "./quota";

export type DeepSeekWebTool = "search" | "fetch";

export interface WebToolAttempt {
    httpStatus: number;
    elapsedMs: number;
    reason?: "http" | "timeout" | "network" | "invalid_response";
    detailCode?: string;
    retryable: boolean;
}

export type WebToolResult = {
    attempts: WebToolAttempt[];
    usageEntries: UsageCostEntry[];
} & ({ ok: true; payload: Record<string, unknown> } | {
    ok: false;
    reason: NonNullable<WebToolAttempt["reason"]>;
    httpStatus: number;
    retryable: boolean;
});

/** Raw Search/Fetch APIs have request charges, independent of model token usage. */
export async function requestDeepSeekWebTool(input: {
    tool: DeepSeekWebTool;
    apiKey: string;
    body: Record<string, unknown>;
    budgetMs: number;
    fetchImpl?: typeof fetch;
    signal?: AbortSignal;
    onUsage?: (entry: UsageCostEntry) => void;
}): Promise<WebToolResult> {
    const attempts: WebToolAttempt[] = [];
    const usageEntries: UsageCostEntry[] = [];
    const deadline = Date.now() + Math.max(1, input.budgetMs);
    for (let index = 0; index < 2; index++) {
        const startedAt = Date.now();
        const controller = new AbortController();
        const abort = () => controller.abort();
        input.signal?.addEventListener("abort", abort, { once: true });
        if (input.signal?.aborted) controller.abort();
        const timer = setTimeout(abort, Math.max(1, deadline - startedAt));
        const attempt: WebToolAttempt = { httpStatus: 0, elapsedMs: 0, retryable: false };
        try {
            if (controller.signal.aborted || startedAt >= deadline) throw new DOMException("Aborted", "AbortError");
            const response = await (input.fetchImpl ?? fetch)(`https://api.deepseek.com/v1/tools/${input.tool}`, {
                method: "POST",
                redirect: "manual",
                headers: { "Content-Type": "application/json", Authorization: `Bearer ${input.apiKey}` },
                body: JSON.stringify(input.body),
                signal: controller.signal,
            });
            attempt.httpStatus = response.status;
            if (response.status !== 200) {
                await response.body?.cancel();
                attempt.reason = "http";
                attempt.detailCode = `${input.tool}_http_${response.status}`;
                attempt.retryable = response.status === 408 || response.status === 429
                    || (response.status >= 500 && response.status <= 599);
            } else {
                const payload: unknown = await response.json();
                if (!payload || typeof payload !== "object" || Array.isArray(payload)) {
                    attempt.reason = "invalid_response";
                } else {
                    const data = payload as Record<string, unknown>;
                    const billable = input.tool === "search"
                        ? Array.isArray(data.results) && data.results.length > 0
                        : typeof data.content === "string" && !!data.content.trim();
                    if (billable) {
                        const entry: UsageCostEntry = { service: `deepseek-${input.tool}`, requests: 1 };
                        usageEntries.push(entry);
                        input.onUsage?.(entry);
                    }
                    if (controller.signal.aborted || Date.now() >= deadline) throw new DOMException("Aborted", "AbortError");
                    const valid = input.tool === "search" ? Array.isArray(data.results)
                        : typeof data.content === "string" && typeof data.title === "string";
                    if (valid) {
                        attempt.elapsedMs = Math.max(0, Date.now() - startedAt);
                        attempts.push(attempt);
                        return { ok: true, payload: data, attempts, usageEntries };
                    }
                    attempt.reason = "invalid_response";
                }
                attempt.detailCode = `${input.tool}_invalid_response`;
            }
        } catch (error) {
            attempt.reason = controller.signal.aborted || (error instanceof Error && error.name === "AbortError")
                ? "timeout" : error instanceof SyntaxError ? "invalid_response" : "network";
            attempt.detailCode = `${input.tool}_${attempt.reason}`;
        } finally {
            clearTimeout(timer);
            input.signal?.removeEventListener("abort", abort);
        }
        attempt.elapsedMs = Math.max(0, Date.now() - startedAt);
        attempts.push(attempt);
        if (index === 0 && attempt.retryable && !input.signal?.aborted && deadline - Date.now() >= 1_000) {
            await new Promise(resolve => setTimeout(resolve, 250));
            continue;
        }
        return {
            ok: false, reason: attempt.reason ?? "invalid_response", httpStatus: attempt.httpStatus,
            retryable: attempt.retryable, attempts, usageEntries,
        };
    }
    throw new Error("unreachable_web_tool_attempt");
}
