import { isClientCancelled } from "./clientAbort";

// Long-running preflight streams stay bounded by semantic idle detection while
// their shorter execution lease is renewed independently.
export const PREFLIGHT_UPSTREAM_IDLE_MS = 90_000;
export const PREFLIGHT_OPERATION_MS = 360_000;
export const PREFLIGHT_STATE_FINALIZE_MS = 5_000;
export const PREFLIGHT_TERMINAL_WRITE_MS = 3_000;
export const PREFLIGHT_LEASE_MS = 120_000;
export const PREFLIGHT_LEASE_RENEW_MS = 30_000;

export class PreflightTimeoutError extends Error {
    constructor(message: string) {
        super(message);
        this.name = "PreflightTimeoutError";
    }
}

export interface PreflightDeadline {
    signal: AbortSignal;
    dispose(): void;
}

export interface PreflightIdleDeadline extends PreflightDeadline {
    arm(): void;
}

function deadlineReason(signal: AbortSignal, message: string): Error {
    return signal.reason instanceof Error
        ? signal.reason
        : new PreflightTimeoutError(message);
}

export function createPreflightDeadline(
    timeoutMs: number,
    message: string,
    parent?: AbortSignal,
): PreflightDeadline {
    const controller = new AbortController();
    const abortFromParent = () => {
        if (!controller.signal.aborted) controller.abort(deadlineReason(parent!, message));
    };
    if (parent?.aborted) abortFromParent();
    else parent?.addEventListener("abort", abortFromParent, { once: true });
    const timer = setTimeout(() => {
        if (!controller.signal.aborted) controller.abort(new PreflightTimeoutError(message));
    }, timeoutMs);
    return {
        signal: controller.signal,
        dispose() {
            clearTimeout(timer);
            parent?.removeEventListener("abort", abortFromParent);
        },
    };
}

export function createPreflightIdleDeadline(
    timeoutMs: number,
    message: string,
    parent?: AbortSignal,
): PreflightIdleDeadline {
    const controller = new AbortController();
    let timer: ReturnType<typeof setTimeout> | undefined;
    const abortFromParent = () => {
        if (!controller.signal.aborted) controller.abort(deadlineReason(parent!, message));
    };
    const arm = () => {
        if (timer) clearTimeout(timer);
        timer = setTimeout(() => {
            if (!controller.signal.aborted) controller.abort(new PreflightTimeoutError(message));
        }, timeoutMs);
    };
    if (parent?.aborted) abortFromParent();
    else parent?.addEventListener("abort", abortFromParent, { once: true });
    arm();
    return {
        signal: controller.signal,
        arm,
        dispose() {
            if (timer) clearTimeout(timer);
            parent?.removeEventListener("abort", abortFromParent);
        },
    };
}

export function withPreflightDeadline<T>(
    operation: () => Promise<T>,
    signal: AbortSignal,
    message: string,
): Promise<T> {
    if (signal.aborted) return Promise.reject(deadlineReason(signal, message));
    return new Promise<T>((resolve, reject) => {
        const abort = () => reject(deadlineReason(signal, message));
        signal.addEventListener("abort", abort, { once: true });
        let promise: Promise<T>;
        try {
            promise = operation();
        } catch (error) {
            signal.removeEventListener("abort", abort);
            reject(error);
            return;
        }
        promise.then(
            value => {
                signal.removeEventListener("abort", abort);
                resolve(value);
            },
            error => {
                signal.removeEventListener("abort", abort);
                reject(error);
            },
        );
    });
}

export function isPreflightTimeout(error: unknown): boolean {
    return !isClientCancelled(error) && (
        error instanceof PreflightTimeoutError
        || (!!error && typeof error === "object" && "name" in error && error.name === "AbortError")
    );
}

export function assertPreflightActive(signal: AbortSignal, message: string): void {
    if (signal.aborted) throw deadlineReason(signal, message);
}
