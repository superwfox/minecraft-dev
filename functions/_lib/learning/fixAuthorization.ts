export interface FixLearningAuthorization {
    runId: number;
    previousRunId: number;
    diagnosticsFingerprint: string;
    repairAttempts: number;
}

export interface FixRepairAuthorization {
    runId: number;
    diagnosticsFingerprint: string;
    repairAttempts: number;
}

function positiveInteger(value: unknown): number {
    const number = Number(value);
    return Number.isInteger(number) && number > 0 ? number : 0;
}

function nonNegativeInteger(value: unknown): number | null {
    const number = Number(value);
    return Number.isInteger(number) && number >= 0 ? number : null;
}

function fingerprint(value: unknown): string {
    return typeof value === "string" && /^[a-f0-9]{8,128}$/i.test(value.trim())
        ? value.trim().toLowerCase()
        : "";
}

function repairAuthorizationForState(
    state: any,
    diagnosticsFingerprint: string,
): FixRepairAuthorization | null {
    const runId = positiveInteger(state?.runId);
    const repairAttempts = nonNegativeInteger(state?.repairAttempts);
    const normalizedFingerprint = fingerprint(diagnosticsFingerprint);
    if (!runId || repairAttempts === null || !normalizedFingerprint) return null;
    return {
        runId,
        diagnosticsFingerprint: normalizedFingerprint,
        repairAttempts,
    };
}

export function createFixRepairAuthorization(
    state: any,
    diagnosticsFingerprint: string,
): FixRepairAuthorization | null {
    return state?.status === "error"
        ? repairAuthorizationForState(state, diagnosticsFingerprint)
        : null;
}

export function sameFixRepairAuthorization(
    left: FixRepairAuthorization | null | undefined,
    right: FixRepairAuthorization | null | undefined,
): boolean {
    return !!left && !!right
        && left.runId === right.runId
        && left.diagnosticsFingerprint === right.diagnosticsFingerprint
        && left.repairAttempts === right.repairAttempts
        && !!fingerprint(left.diagnosticsFingerprint)
        && !!fingerprint(right.diagnosticsFingerprint);
}

export function currentFixRepairAuthorization(state: any): FixRepairAuthorization | null {
    if (state?.status !== "error" && state?.status !== "repairing") return null;
    const current = repairAuthorizationForState(state, state?.fixDiagnosticsFingerprint);
    const stored = state?.fixRepairAuthorization as FixRepairAuthorization | undefined;
    return sameFixRepairAuthorization(current, stored) ? current : null;
}

export function createFixLearningAuthorization(
    state: any,
    diagnosticsFingerprint: string,
): FixLearningAuthorization | null {
    const runId = positiveInteger(state?.runId);
    const repairAttempts = positiveInteger(state?.repairAttempts);
    const pendingSnapshot = state?.pendingFixSnapshot;
    const previousRunId = positiveInteger(pendingSnapshot?.runId);
    const pendingAttempt = positiveInteger(pendingSnapshot?.attempt);
    const normalizedFingerprint = fingerprint(diagnosticsFingerprint);
    if (state?.status !== "error"
        || !runId
        || !previousRunId
        || runId === previousRunId
        || !repairAttempts
        || pendingAttempt !== repairAttempts
        || !Array.isArray(pendingSnapshot?.diagnostics)
        || !pendingSnapshot.diagnostics.length
        || !normalizedFingerprint) return null;
    return {
        runId,
        previousRunId,
        diagnosticsFingerprint: normalizedFingerprint,
        repairAttempts,
    };
}

export function sameFixLearningAuthorization(
    left: FixLearningAuthorization | null | undefined,
    right: FixLearningAuthorization | null | undefined,
): boolean {
    return !!left && !!right
        && left.runId === right.runId
        && left.previousRunId === right.previousRunId
        && left.diagnosticsFingerprint === right.diagnosticsFingerprint
        && left.repairAttempts === right.repairAttempts;
}

export function currentFixLearningAuthorization(state: any): FixLearningAuthorization | null {
    const current = createFixLearningAuthorization(state, state?.fixDiagnosticsFingerprint);
    const stored = state?.fixLearningAuthorization as FixLearningAuthorization | undefined;
    return sameFixLearningAuthorization(current, stored) ? current : null;
}
