import { describe, expect, it } from "vitest";
import {
    canReviewKnowledgeTransition,
    getLearningEvidenceItems,
    knowledgeIdForLearningResult,
    knowledgeStatusAt,
    reviewedKnowledgeExpiresAt,
} from "../../functions/_lib/learning/store";
import { makeKnowledgeItem, makeRecipe } from "./testData";

describe("knowledge review policy", () => {
    it("allows approving only the latest pending fact revision", () => {
        const pending = makeKnowledgeItem({ status: "needs_review", revision: 3 });

        expect(canReviewKnowledgeTransition(pending, 3, "active")).toBe(true);
        expect(canReviewKnowledgeTransition(pending, 4, "active")).toBe(false);
        expect(canReviewKnowledgeTransition({ ...pending, status: "active" }, 3, "active")).toBe(false);
    });

    it("keeps strategy knowledge out of active runtime context", () => {
        const strategy = makeKnowledgeItem({
            kind: "strategy",
            status: "needs_review",
            revision: 2,
        });

        expect(canReviewKnowledgeTransition(strategy, 2, "active")).toBe(false);
        expect(canReviewKnowledgeTransition(strategy, 2, "rejected")).toBe(true);
        expect(canReviewKnowledgeTransition(strategy, 2, "deprecated")).toBe(true);
    });

    it("allows administrators to deprecate active facts without reopening other transitions", () => {
        const active = makeKnowledgeItem({ status: "active", revision: 2 });

        expect(canReviewKnowledgeTransition(active, 3, "deprecated")).toBe(true);
        expect(canReviewKnowledgeTransition(active, 2, "active")).toBe(false);
        expect(canReviewKnowledgeTransition(active, 2, "rejected")).toBe(false);
    });

    it("bounds reviewed knowledge lifetime by source authority", () => {
        const now = 1_800_000_000_000;
        const existingExpiry = now + 7 * 86_400_000;

        expect(reviewedKnowledgeExpiresAt({
            hasGroundTruth: true,
            currentExpiresAt: 0,
            now,
        })).toBe(0);
        expect(reviewedKnowledgeExpiresAt({
            hasGroundTruth: false,
            currentExpiresAt: 0,
            now,
        })).toBe(now + 90 * 86_400_000);
        expect(reviewedKnowledgeExpiresAt({
            hasGroundTruth: false,
            currentExpiresAt: existingExpiry,
            now,
        })).toBe(existingExpiry);
    });

    it("derives stable bounded IDs for retried learning results", () => {
        expect(knowledgeIdForLearningResult("learn_ABC-123", 1)).toBe("know_abc12301");
        expect(knowledgeIdForLearningResult("learn_ABC-123", 1)).toBe(
            knowledgeIdForLearningResult("learn_ABC-123", 1.9),
        );
        expect(knowledgeIdForLearningResult("learn_ABC-123", Number.NaN)).toBe("know_abc12300");
        expect(knowledgeIdForLearningResult("learn_ABC-123", Number.POSITIVE_INFINITY)).toBe("know_abc12300");
        expect(knowledgeIdForLearningResult("learn_ABC-123", 10_000)).toBe("know_abc123zz");
        expect(() => knowledgeIdForLearningResult("learn_---", 0)).toThrow("invalid_learning_job_id");
    });

    it("maps elapsed active facts to expired without mutating other states", () => {
        const now = 1_800_000_000_000;

        expect(knowledgeStatusAt({ status: "active", expiresAt: now - 1 }, now)).toBe("expired");
        expect(knowledgeStatusAt({ status: "active", expiresAt: now + 1 }, now)).toBe("active");
        expect(knowledgeStatusAt({ status: "needs_review", expiresAt: now - 1 }, now)).toBe("needs_review");
    });

    it("omits malformed historical recipes from the public evidence projection", async () => {
        const row = {
            knowledge_id: "know-test",
            summary: "verified fact",
            kind: "fact",
            confidence: 0.96,
            status: "active",
            scope_json: "{}",
            payload_json: JSON.stringify({
                recipe: makeRecipe({ notes: [] }),
            }),
            expires_at: 0,
            source_id: null,
        };
        const db = {
            prepare: () => ({
                bind: () => ({
                    all: async () => ({ results: [row] }),
                }),
            }),
        } as unknown as D1Database;

        const items = await getLearningEvidenceItems({ DB: db }, ["know-test"]);

        expect(items).toHaveLength(1);
        expect(items[0].recipe).toBeUndefined();
    });
});
