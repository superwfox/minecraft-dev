import { describe, expect, it } from "vitest";
import {
    isLearningEvidenceTerminalStatus,
    isMatchingLearningEvidenceIdentity,
    resolveLearningEvidenceResult,
    shouldCacheLearningEvidenceResult,
    type LearningEvidenceIdentity,
} from "../../src/logic/learningEvidenceState";

const identity: LearningEvidenceIdentity = {
    jobId: "learn-1",
    stage: "fix",
    revision: 4,
};

const recipe = {
    schemaVersion: "implementation_recipe.v1",
    language: "java",
    integrationKind: "external_plugin",
    title: "Resolve PlaceholderAPI placeholders",
    code: [
        "public static String resolve(Player player, String input) {",
        "    return PlaceholderAPI.setPlaceholders(player, input);",
        "}",
    ].join("\n"),
    imports: [
        "import me.clip.placeholderapi.PlaceholderAPI;",
        "import org.bukkit.entity.Player;",
    ],
    versionScope: "PlaceholderAPI 2.11.x on Paper 1.21.4",
    prerequisites: ["PlaceholderAPI is installed and declared as a dependency."],
    notes: ["Call after the target player is available."],
    sourceIds: ["src-1"],
};

const evidenceItem = {
    knowledgeId: "know-1",
    summary: "PlaceholderAPI resolves placeholders through setPlaceholders.",
    kind: "fact",
    confidence: 0.96,
    status: "active",
    scope: { dependency: "PlaceholderAPI", mcVersion: "1.21.4" },
    reason: {
        code: "external_plugin_contract",
        message: "The request explicitly integrates PlaceholderAPI.",
    },
    recipe,
    sources: [{
        sourceId: "src-1",
        title: "PlaceholderAPI Wiki",
        url: "https://github.com/PlaceholderAPI/PlaceholderAPI/wiki/Using-PlaceholderAPI",
        sourceType: "documentation",
        authority: "official",
        fetchedAt: 1_700_000_000_000,
        excerpt: "PlaceholderAPI.setPlaceholders(player, text)",
        relation: "supports",
    }],
};

const searchedSource = {
    needId: "need-api",
    question: "What is the supported PlaceholderAPI call?",
    url: "https://github.com/PlaceholderAPI/PlaceholderAPI/wiki/Using-PlaceholderAPI",
    reason: "The official wiki is searched to verify the supported method call.",
    status: "supports",
    title: "PlaceholderAPI Wiki",
    sourceType: "documentation",
    authority: "official",
};

describe("learning evidence cache state", () => {
    it("caches a normalized evidence response only for the exact job identity", () => {
        expect(shouldCacheLearningEvidenceResult(
            [evidenceItem],
            "verifying",
            identity,
            identity,
        )).toBe(true);
        expect(shouldCacheLearningEvidenceResult(
            [evidenceItem],
            "ready",
            identity,
            { ...identity, jobId: "learn-old" },
        )).toBe(false);

        const result = resolveLearningEvidenceResult(
            [evidenceItem],
            "ready",
            identity,
            identity,
        );
        expect(result.identityMatches).toBe(true);
        expect(result.cache).toBe(true);
        expect(result.searchedSources).toEqual([]);
        expect(result.diagnostics).toEqual([]);
        expect(result.items).toHaveLength(1);
        expect(result.items[0]).toMatchObject({
            knowledgeId: "know-1",
            recipe,
            sources: [{
                sourceId: "src-1",
                url: evidenceItem.sources[0].url,
            }],
        });
    });

    it("rejects responses from another stage or revision", () => {
        expect(isMatchingLearningEvidenceIdentity(identity, identity)).toBe(true);
        expect(isMatchingLearningEvidenceIdentity(identity, { ...identity, stage: "planner" })).toBe(false);
        expect(isMatchingLearningEvidenceIdentity(identity, { ...identity, revision: 5 })).toBe(false);
    });

    it("clears evidence and searched URLs returned for a different identity", () => {
        expect(resolveLearningEvidenceResult(
            [evidenceItem],
            "ready",
            identity,
            { ...identity, revision: identity.revision + 1 },
            [searchedSource],
        )).toEqual({
            identityMatches: false,
            items: [],
            searchedSources: [],
            diagnostics: [],
            cache: false,
        });
    });

    it("caches searched URL audit while the matching job is still active", () => {
        const result = resolveLearningEvidenceResult(
            [],
            "fetching",
            identity,
            identity,
            [searchedSource],
        );

        expect(result.cache).toBe(true);
        expect(result.items).toEqual([]);
        expect(result.searchedSources).toEqual([{
            ...searchedSource,
            canonicalUrl: undefined,
        }]);
    });

    it("keeps bounded structured diagnostics for the matching job", () => {
        const result = resolveLearningEvidenceResult(
            [],
            "deferred",
            identity,
            identity,
            [],
            [{
                at: 1_700_000_000_000,
                stage: "verification",
                status: "error",
                code: "verification_evidence",
                message: "The verifier excerpt did not match the fetched source.",
                httpStatus: 200,
                elapsedMs: 42,
            }],
        );

        expect(result.diagnostics).toEqual([expect.objectContaining({
            stage: "verification",
            code: "verification_evidence",
            httpStatus: 200,
            elapsedMs: 42,
        })]);
    });

    it("drops unsafe evidence links and unknown URL audit states", () => {
        const result = resolveLearningEvidenceResult(
            [{
                ...evidenceItem,
                sources: [{ ...evidenceItem.sources[0], url: "javascript:alert(1)" }],
            }],
            "ready",
            identity,
            identity,
            [{ ...searchedSource, status: "private_state" }],
        );

        expect(result.items[0].sources).toEqual([]);
        expect(result.searchedSources).toEqual([]);
    });

    it("omits historical recipes with empty lists or overlong fields", () => {
        const emptyNotes = resolveLearningEvidenceResult(
            [{ ...evidenceItem, recipe: { ...recipe, notes: [] } }],
            "ready",
            identity,
            identity,
        );
        const overlongTitle = resolveLearningEvidenceResult(
            [{ ...evidenceItem, recipe: { ...recipe, title: "x".repeat(161) } }],
            "ready",
            identity,
            identity,
        );

        expect(emptyNotes.items[0].recipe).toBeUndefined();
        expect(overlongTitle.items[0].recipe).toBeUndefined();
    });

    it("does not cache an empty response while the matching server job is active", () => {
        expect(shouldCacheLearningEvidenceResult([], "discovering", identity, identity)).toBe(false);
        expect(shouldCacheLearningEvidenceResult([], "verifying", identity, identity)).toBe(false);
        expect(shouldCacheLearningEvidenceResult([], "unknown", identity, identity)).toBe(false);
    });

    it("caches an empty response only after the matching job reports a terminal state", () => {
        for (const status of ["ready", "deferred", "needs_review", "failed", "cancelled"]) {
            expect(isLearningEvidenceTerminalStatus(status)).toBe(true);
            expect(shouldCacheLearningEvidenceResult([], status, identity, identity)).toBe(true);
        }
        expect(isLearningEvidenceTerminalStatus("fetching")).toBe(false);
    });
});
