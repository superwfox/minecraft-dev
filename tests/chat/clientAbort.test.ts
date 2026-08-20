import { describe, expect, it } from "vitest";
import {
    ClientCancelledError,
    abortOnWriteFailure,
    isClientCancelled,
    linkAbortSignal,
    linkClientAbortSignal,
} from "../../functions/_lib/clientAbort";

describe("client abort helpers", () => {
    it("preserves the original reason when linking a generic abort signal", () => {
        const source = new AbortController();
        const target = new AbortController();
        const reason = new DOMException("deadline", "TimeoutError");

        linkAbortSignal(target, source.signal);
        source.abort(reason);

        expect(target.signal.aborted).toBe(true);
        expect(target.signal.reason).toBe(reason);
        expect(isClientCancelled(target.signal.reason)).toBe(false);
    });

    it("tags a linked client abort without losing its underlying reason", () => {
        const source = new AbortController();
        const target = new AbortController();
        const reason = new DOMException("page left", "AbortError");

        linkClientAbortSignal(target, source.signal, "Chat request cancelled");
        source.abort(reason);

        expect(target.signal.reason).toBeInstanceOf(ClientCancelledError);
        expect(target.signal.reason).toMatchObject({
            code: "CLIENT_CANCELLED",
            status: 499,
            cause: reason,
        });
        expect(isClientCancelled(target.signal.reason)).toBe(true);
    });

    it("turns a downstream write failure into a client cancellation", () => {
        const target = new AbortController();
        const writeError = new TypeError("Writable side closed");

        expect(() => abortOnWriteFailure(target, writeError)).toThrow(ClientCancelledError);
        expect(isClientCancelled(target.signal.reason)).toBe(true);
        expect(target.signal.reason).toMatchObject({ cause: writeError });
    });
});
