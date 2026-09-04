export const LEARNING_CONTINUATION_TIMEOUT_CODE = "LEARNING_CONTINUATION_TIMEOUT";

export class LearningContinuationTimeoutError extends Error {
    readonly code = LEARNING_CONTINUATION_TIMEOUT_CODE;

    constructor(message: string) {
        super(message);
        this.name = "LearningContinuationTimeoutError";
    }
}

export interface LearningContinuationDeadline {
    readonly deadlineAt: number;
    readonly signal: AbortSignal;
    assertActive(): void;
    dispose(): void;
}

function parentAbortReason(parent: AbortSignal): Error {
    if (parent.reason instanceof Error) return parent.reason;
    const reason = parent.reason && typeof parent.reason === "object"
        ? parent.reason as { name?: unknown; message?: unknown }
        : {};
    const error = new Error(typeof reason.message === "string" ? reason.message : "interrupted");
    error.name = typeof reason.name === "string" ? reason.name : "AbortError";
    return error;
}

export function createLearningContinuationDeadline(
    timeoutMs: number,
    message: string,
    parent?: AbortSignal,
): LearningContinuationDeadline {
    const durationMs = Number.isFinite(timeoutMs)
        ? Math.max(1, Math.floor(timeoutMs))
        : 1;
    const deadlineAt = Date.now() + durationMs;
    const timeoutError = new LearningContinuationTimeoutError(message);
    const controller = new AbortController();
    const abortFromParent = () => {
        if (!controller.signal.aborted) controller.abort(parentAbortReason(parent!));
    };

    if (parent?.aborted) abortFromParent();
    else parent?.addEventListener("abort", abortFromParent, { once: true });

    const timer = setTimeout(() => {
        if (!controller.signal.aborted) controller.abort(timeoutError);
    }, durationMs);

    return {
        deadlineAt,
        signal: controller.signal,
        assertActive() {
            if (!controller.signal.aborted && Date.now() >= deadlineAt) {
                controller.abort(timeoutError);
            }
            if (!controller.signal.aborted) return;
            throw controller.signal.reason instanceof Error
                ? controller.signal.reason
                : timeoutError;
        },
        dispose() {
            clearTimeout(timer);
            parent?.removeEventListener("abort", abortFromParent);
        },
    };
}
