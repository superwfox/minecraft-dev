export const CLIENT_CANCELLED_CODE = "CLIENT_CANCELLED";

export class ClientCancelledError extends Error {
    readonly code = CLIENT_CANCELLED_CODE;
    readonly status = 499;
    readonly cause?: unknown;

    constructor(message = "Client disconnected", cause?: unknown) {
        super(message);
        this.name = "ClientCancelledError";
        this.cause = cause;
    }
}

export function isClientCancelled(error: unknown): boolean {
    if (error instanceof ClientCancelledError) return true;
    if (!error || typeof error !== "object") return false;
    const candidate = error as { name?: unknown; code?: unknown; status?: unknown };
    return candidate.name === "ClientCancelledError"
        || candidate.code === CLIENT_CANCELLED_CODE
        || candidate.status === 499;
}

function abortReason(signal: AbortSignal): unknown {
    return signal.reason ?? new DOMException("The operation was aborted", "AbortError");
}

/** Propagate one or more source signals into a target controller without changing their reasons. */
export function linkAbortSignal(
    target: AbortController,
    ...sources: Array<AbortSignal | null | undefined>
): () => void {
    const removers: Array<() => void> = [];
    for (const source of sources) {
        if (!source || target.signal.aborted) continue;
        const abort = () => {
            if (!target.signal.aborted) target.abort(abortReason(source));
        };
        if (source.aborted) {
            abort();
            break;
        }
        source.addEventListener("abort", abort, { once: true });
        removers.push(() => source.removeEventListener("abort", abort));
    }
    return () => removers.splice(0).forEach(remove => remove());
}

/** Link a client-owned request/response signal and tag its abort distinctly from an internal timeout. */
export function linkClientAbortSignal(
    target: AbortController,
    source: AbortSignal | null | undefined,
    message = "Client disconnected",
): () => void {
    if (!source || target.signal.aborted) return () => { };
    const abort = () => {
        if (!target.signal.aborted) {
            target.abort(new ClientCancelledError(message, abortReason(source)));
        }
    };
    if (source.aborted) abort();
    else source.addEventListener("abort", abort, { once: true });
    return () => source.removeEventListener("abort", abort);
}

/** Convert a downstream write failure into a client cancellation and stop the linked upstream work. */
export function abortOnWriteFailure(
    target: AbortController,
    error: unknown,
    message = "Client disconnected while receiving the response",
): never {
    if (!target.signal.aborted) target.abort(new ClientCancelledError(message, error));
    const reason = target.signal.reason;
    if (reason instanceof Error) throw reason;
    throw new ClientCancelledError(message, reason ?? error);
}
