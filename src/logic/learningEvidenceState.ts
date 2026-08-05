const TERMINAL_LEARNING_EVIDENCE_STATUSES = new Set([
    "ready",
    "deferred",
    "needs_review",
    "failed",
    "cancelled",
]);

export interface LearningEvidenceIdentity {
    jobId: string;
    stage: string;
    revision: number;
}

export function isLearningEvidenceTerminalStatus(value: unknown): boolean {
    return typeof value === "string" && TERMINAL_LEARNING_EVIDENCE_STATUSES.has(value);
}

export function isMatchingLearningEvidenceIdentity(
    expected: LearningEvidenceIdentity,
    actual: LearningEvidenceIdentity,
): boolean {
    return expected.jobId === actual.jobId
        && expected.stage === actual.stage
        && expected.revision === actual.revision;
}

export interface LearningEvidenceResultState {
    identityMatches: boolean;
    items: unknown[];
    cache: boolean;
}

export function resolveLearningEvidenceResult(
    items: unknown,
    serverStatus: unknown,
    expectedIdentity: LearningEvidenceIdentity,
    responseIdentity: LearningEvidenceIdentity,
): LearningEvidenceResultState {
    const identityMatches = isMatchingLearningEvidenceIdentity(expectedIdentity, responseIdentity);
    const acceptedItems = identityMatches && Array.isArray(items) ? items : [];
    return {
        identityMatches,
        items: acceptedItems,
        cache: identityMatches
            && (acceptedItems.length > 0 || isLearningEvidenceTerminalStatus(serverStatus)),
    };
}

export function shouldCacheLearningEvidenceResult(
    items: unknown,
    serverStatus: unknown,
    expectedIdentity: LearningEvidenceIdentity,
    responseIdentity: LearningEvidenceIdentity,
): boolean {
    return resolveLearningEvidenceResult(
        items,
        serverStatus,
        expectedIdentity,
        responseIdentity,
    ).cache;
}
