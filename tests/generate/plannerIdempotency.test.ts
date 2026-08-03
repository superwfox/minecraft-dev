import { describe, expect, it, vi } from "vitest";
import { getSkillBundles } from "../../functions/_lib/skills";
import { shouldReusePersistedPlannerResult } from "../../functions/api/generate/plan";
import { normalizePlannerResumeState } from "../../src/logic/generateState";

function persistedPlannerState(overrides: Record<string, unknown> = {}) {
    const file = {
        path: "src/main/java/example/Main.java",
        role: "Plugin entrypoint",
        order: 1,
        generatorType: "MainGen",
        bucket: 1,
    };

    return {
        status: "planning",
        mainBlueprint: {
            events: [],
            commands: [],
            tasks: [],
            services: [],
            config: { files: [] },
        },
        plan: [file],
        buckets: [[], [file]],
        ...overrides,
    };
}

describe("Planner refresh resume state", () => {
    it("preserves a valid explicit replan request and attempt", () => {
        expect(normalizePlannerResumeState({
            plannerRequestId: "plan_1234567890abcdef",
            plannerReplan: true,
            plannerAttempt: 2,
        })).toEqual({
            plannerRequestId: "plan_1234567890abcdef",
            plannerReplan: true,
            plannerAttempt: 2,
        });
    });

    it("keeps normal retries at attempt zero and rejects malformed IDs", () => {
        expect(normalizePlannerResumeState({
            plannerRequestId: "plan_1234567890abcdef",
            plannerReplan: false,
            plannerAttempt: 2,
        })).toEqual({
            plannerRequestId: "plan_1234567890abcdef",
            plannerReplan: false,
            plannerAttempt: 0,
        });
        expect(normalizePlannerResumeState({
            plannerRequestId: "invalid",
            plannerReplan: true,
            plannerAttempt: 1,
        })).toEqual({
            plannerRequestId: "",
            plannerReplan: false,
            plannerAttempt: 0,
        });
    });
});

describe("Planner Skill deadline", () => {
    it("propagates an AbortSignal through an in-flight GitHub fetch", async () => {
        const fetchMock = vi.fn((_url: string | URL | Request, init?: RequestInit) => new Promise<Response>((_resolve, reject) => {
            const signal = init?.signal;
            if (!signal) {
                reject(new Error("missing abort signal"));
                return;
            }
            const abort = () => reject(signal.reason instanceof Error
                ? signal.reason
                : new DOMException("Aborted", "AbortError"));
            if (signal.aborted) abort();
            else signal.addEventListener("abort", abort, { once: true });
        }));
        vi.stubGlobal("fetch", fetchMock);
        const namespace = {
            get: async () => null,
            put: async () => undefined,
        } as unknown as KVNamespace;
        const controller = new AbortController();

        try {
            const pending = getSkillBundles(
                { TASKS: namespace },
                ["functions/example"],
                { signal: controller.signal },
            );
            await Promise.resolve();
            await Promise.resolve();
            controller.abort(new DOMException("Aborted", "AbortError"));

            await expect(pending).rejects.toMatchObject({ name: "AbortError" });
            expect(fetchMock).toHaveBeenCalled();
        } finally {
            vi.unstubAllGlobals();
        }
    });
});

describe("Planner persisted-result idempotency", () => {
    it("reuses a completed Planner result for a normal retry", () => {
        expect(shouldReusePersistedPlannerResult(persistedPlannerState(), undefined)).toBe(true);
    });

    it("does not reuse the old result for an explicit replan", () => {
        expect(shouldReusePersistedPlannerResult(persistedPlannerState(), true)).toBe(false);
    });

    it("reuses the result of the same explicit replan request", () => {
        const plannerRequestId = "plan_1234567890abcdef";
        const state = persistedPlannerState({ plannerRequestId });

        expect(shouldReusePersistedPlannerResult(state, true, plannerRequestId)).toBe(true);
        expect(shouldReusePersistedPlannerResult(state, true, "plan_fedcba0987654321")).toBe(false);
    });

    it("does not reuse incomplete or non-planning state", () => {
        expect(shouldReusePersistedPlannerResult(persistedPlannerState({ status: "error" }), false)).toBe(false);
        expect(shouldReusePersistedPlannerResult(persistedPlannerState({ mainBlueprint: null }), false)).toBe(false);
        expect(shouldReusePersistedPlannerResult(persistedPlannerState({ plan: [] }), false)).toBe(false);
        expect(shouldReusePersistedPlannerResult(persistedPlannerState({ buckets: [] }), false)).toBe(false);
    });
});
