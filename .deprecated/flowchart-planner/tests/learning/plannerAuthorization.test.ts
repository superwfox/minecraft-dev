import { describe, expect, it } from "vitest";
import {
    assessPlannerLearningAuthorization,
    assessPlannerResultAuthorization,
    samePlannerLearningAuthorization,
    samePlannerResultAuthorization,
} from "../../functions/_lib/learning/plannerAuthorization";
import { makeNeed } from "./testData";

function pathNeed(pathId: string, suffix = "resolve") {
    return makeNeed({
        id: `need-${pathId}-${suffix}`,
        integrationKind: "external_plugin",
        triggerReason: "external_plugin_contract",
        pathIds: [pathId],
        claim: {
            subject: `FancyHooksAPI#${suffix}`,
            question: `What is the exact FancyHooksAPI#${suffix} contract for Paper 1.21.4?`,
        },
        scope: {
            dependency: "FancyHooks",
            packageName: "dev.fancy.hooks",
            symbol: `dev.fancy.hooks.FancyHooksAPI#${suffix}`,
        },
        searchQueries: [`FancyHooksAPI ${suffix} Paper 1.21.4 official documentation`],
    });
}

function state() {
    return {
        coreType: "paper",
        version: "1.21.4",
        userPrompt: "Integrate FancyHooks into the plugin.",
        grade: {
            gateRequired: true,
            chosenPathId: "p1",
            paths: [{ id: "p1" }, { id: "p2" }],
            vector: { external_deps: ["FancyHooks"] },
            knowledgeNeeds: [pathNeed("p1"), pathNeed("p2")],
        },
    };
}

describe("Planner learning authorization", () => {
    it("binds the authorization to the selected path", async () => {
        const value = state();
        const first = await assessPlannerLearningAuthorization(value);
        const second = await assessPlannerLearningAuthorization({
            ...value,
            grade: { ...value.grade, chosenPathId: "p2" },
        });

        expect(first?.needs.map((need) => need.pathIds)).toEqual([["p1"]]);
        expect(second?.needs.map((need) => need.pathIds)).toEqual([["p2"]]);
        expect(first?.authorization.chosenPathId).toBe("p1");
        expect(second?.authorization.chosenPathId).toBe("p2");
        expect(samePlannerLearningAuthorization(first?.authorization, second?.authorization)).toBe(false);
    });

    it("expires when the complete selected-path need set changes", async () => {
        const value = state();
        const first = await assessPlannerLearningAuthorization(value);
        const changed = await assessPlannerLearningAuthorization({
            ...value,
            grade: {
                ...value.grade,
                knowledgeNeeds: [pathNeed("p1", "register"), pathNeed("p2")],
            },
        });

        expect(first?.authorization.needsFingerprint).toMatch(/^[a-f0-9]{64}$/);
        expect(changed?.authorization.needsFingerprint).toMatch(/^[a-f0-9]{64}$/);
        expect(first?.authorization.needsFingerprint).not.toBe(changed?.authorization.needsFingerprint);
        expect(samePlannerLearningAuthorization(first?.authorization, changed?.authorization)).toBe(false);
    });

    it("does not include task-local cache hit state in the authorization fingerprint", async () => {
        const value = state();
        const before = await assessPlannerLearningAuthorization(value);
        const after = await assessPlannerLearningAuthorization({
            ...value,
            knowledgeUsed: [{ knowledgeId: "know-cache-hit", status: "active" }],
            learningProgress: { cachedKnowledgeIds: ["know-cache-hit"] },
        });

        expect(after?.authorization).toEqual(before?.authorization);
        expect(samePlannerLearningAuthorization(before?.authorization, after?.authorization)).toBe(true);
    });

    it("fails closed for missing, unknown, or malformed gate selections", async () => {
        const value = state();
        expect(await assessPlannerLearningAuthorization({
            ...value,
            grade: { ...value.grade, chosenPathId: null },
        })).toBeNull();
        expect(await assessPlannerLearningAuthorization({
            ...value,
            grade: { ...value.grade, chosenPathId: "p3" },
        })).toBeNull();
        expect(await assessPlannerLearningAuthorization({
            ...value,
            grade: { ...value.grade, paths: [{ id: "p1" }, { id: "p1" }] },
        })).toBeNull();
    });
});

describe("Planner persisted-result authorization", () => {
    it("stays stable when later file generation changes API contract coverage", async () => {
        const value = state();
        const before = await assessPlannerResultAuthorization(value);
        const after = await assessPlannerResultAuthorization({
            ...value,
            generatedFiles: [{
                path: "src/main/java/example/FancyHooksBridge.java",
                content: "public final class FancyHooksBridge {}",
            }],
        });

        expect(before?.selectedNeedsFingerprint).toMatch(/^[a-f0-9]{64}$/);
        expect(after).toEqual(before);
        expect(samePlannerResultAuthorization(before, after)).toBe(true);
    });

    it("expires when the selected path or strict selected need set changes", async () => {
        const value = state();
        const original = await assessPlannerResultAuthorization(value);
        const changedPath = await assessPlannerResultAuthorization({
            ...value,
            grade: { ...value.grade, chosenPathId: "p2" },
        });
        const changedNeed = await assessPlannerResultAuthorization({
            ...value,
            grade: {
                ...value.grade,
                knowledgeNeeds: [pathNeed("p1", "register"), pathNeed("p2")],
            },
        });

        expect(samePlannerResultAuthorization(original, changedPath)).toBe(false);
        expect(samePlannerResultAuthorization(original, changedNeed)).toBe(false);
    });

    it("fails closed for an invalid gate selection", async () => {
        const value = state();
        expect(await assessPlannerResultAuthorization({
            ...value,
            grade: { ...value.grade, chosenPathId: null },
        })).toBeNull();
        expect(await assessPlannerResultAuthorization({
            ...value,
            grade: { ...value.grade, chosenPathId: "unknown" },
        })).toBeNull();
        expect(await assessPlannerResultAuthorization({
            ...value,
            grade: { ...value.grade, paths: [{ id: "p1" }, { id: "p1" }] },
        })).toBeNull();
    });
});
