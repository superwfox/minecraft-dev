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

describe("learning evidence cache state", () => {
    it("caches a non-empty evidence response only for the exact job identity", () => {
        expect(shouldCacheLearningEvidenceResult(
            [{ knowledgeId: "know-1" }],
            "verifying",
            identity,
            identity,
        )).toBe(true);
        expect(shouldCacheLearningEvidenceResult(
            [{ knowledgeId: "know-old" }],
            "ready",
            identity,
            { ...identity, jobId: "learn-old" },
        )).toBe(false);
    });

    it("rejects responses from another stage or revision", () => {
        expect(isMatchingLearningEvidenceIdentity(identity, identity)).toBe(true);
        expect(isMatchingLearningEvidenceIdentity(identity, { ...identity, stage: "planner" })).toBe(false);
        expect(isMatchingLearningEvidenceIdentity(identity, { ...identity, revision: 5 })).toBe(false);
    });

    it("clears evidence returned for a different identity and waits for the exact key", () => {
        expect(resolveLearningEvidenceResult(
            [{ knowledgeId: "know-newer" }],
            "ready",
            identity,
            { ...identity, revision: identity.revision + 1 },
        )).toEqual({
            identityMatches: false,
            items: [],
            cache: false,
        });

        expect(resolveLearningEvidenceResult(
            [{ knowledgeId: "know-current" }],
            "ready",
            identity,
            identity,
        )).toEqual({
            identityMatches: true,
            items: [{ knowledgeId: "know-current" }],
            cache: true,
        });
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
