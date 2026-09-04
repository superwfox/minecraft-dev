import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
    LEARNING_CONTINUATION_TIMEOUT_CODE,
    createLearningContinuationDeadline,
} from "../../src/logic/learningContinuation";

beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-09-04T00:00:00.000Z"));
});

afterEach(() => {
    vi.useRealTimers();
});

describe("Learning continuation deadline", () => {
    it("keeps one absolute deadline across repeated continuation progress", () => {
        const startedAt = Date.now();
        const deadline = createLearningContinuationDeadline(
            1_000,
            "Planner Learning timeout",
        );

        expect(deadline.deadlineAt).toBe(startedAt + 1_000);
        for (let turn = 0; turn < 9; turn++) {
            vi.advanceTimersByTime(100);
            expect(() => deadline.assertActive()).not.toThrow();
        }

        vi.advanceTimersByTime(100);
        expect(() => deadline.assertActive()).toThrow("Planner Learning timeout");
        expect(deadline.signal.reason).toMatchObject({
            name: "LearningContinuationTimeoutError",
            code: LEARNING_CONTINUATION_TIMEOUT_CODE,
        });
        deadline.dispose();
    });

    it("preserves parent cancellation as an AbortError", () => {
        const parent = new AbortController();
        const deadline = createLearningContinuationDeadline(
            1_000,
            "Fix Learning timeout",
            parent.signal,
        );

        parent.abort(new DOMException("User interrupted", "AbortError"));

        expect(() => deadline.assertActive()).toThrowError(DOMException);
        expect(deadline.signal.reason).toMatchObject({
            name: "AbortError",
            message: "User interrupted",
        });
        expect((deadline.signal.reason as any).code)
            .not.toBe(LEARNING_CONTINUATION_TIMEOUT_CODE);
        deadline.dispose();
    });
});
