import { describe, expect, it } from "vitest";
import {
    createFixLearningAuthorization,
    createFixRepairAuthorization,
    currentFixLearningAuthorization,
    currentFixRepairAuthorization,
    sameFixLearningAuthorization,
    sameFixRepairAuthorization,
} from "../../functions/_lib/learning/fixAuthorization";

function state(): any {
    return {
        status: "error",
        runId: 202,
        repairAttempts: 1,
        pendingFixSnapshot: {
            attempt: 1,
            runId: 101,
            diagnostics: [{ key: "compile:a" }],
        },
        fixDiagnosticsFingerprint: "a1b2c3d4",
    };
}

describe("Fix repair authorization", () => {
    it("allows the first ordinary repair and keeps the same authorization recoverable", () => {
        const value: any = {
            status: "error",
            runId: 202,
            repairAttempts: 0,
            fixDiagnosticsFingerprint: "a1b2c3d4",
        };
        const authorization = createFixRepairAuthorization(value, value.fixDiagnosticsFingerprint);
        value.fixRepairAuthorization = authorization;

        expect(authorization).toEqual({
            runId: 202,
            diagnosticsFingerprint: "a1b2c3d4",
            repairAttempts: 0,
        });
        expect(currentFixRepairAuthorization(value)).toEqual(authorization);
        expect(currentFixRepairAuthorization({ ...value, status: "repairing" })).toEqual(authorization);
    });

    it("expires when the failed run, diagnostic, attempt, or task status changes", () => {
        const value: any = {
            status: "error",
            runId: 202,
            repairAttempts: 1,
            fixDiagnosticsFingerprint: "a1b2c3d4",
        };
        value.fixRepairAuthorization = createFixRepairAuthorization(
            value,
            value.fixDiagnosticsFingerprint,
        );

        expect(currentFixRepairAuthorization({ ...value, status: "done" })).toBeNull();
        expect(currentFixRepairAuthorization({ ...value, runId: 203 })).toBeNull();
        expect(currentFixRepairAuthorization({
            ...value,
            fixDiagnosticsFingerprint: "deadbeef",
        })).toBeNull();
        expect(currentFixRepairAuthorization({ ...value, repairAttempts: 2 })).toBeNull();
        expect(sameFixRepairAuthorization(value.fixRepairAuthorization, {
            ...value.fixRepairAuthorization,
            runId: 203,
        })).toBe(false);
    });
});

describe("Fix learning authorization", () => {
    it("binds authorization to the current and previous build runs", () => {
        const value = state();
        const authorization = createFixLearningAuthorization(value, value.fixDiagnosticsFingerprint);
        value.fixLearningAuthorization = authorization;

        expect(authorization).toEqual({
            runId: 202,
            previousRunId: 101,
            diagnosticsFingerprint: "a1b2c3d4",
            repairAttempts: 1,
        });
        expect(currentFixLearningAuthorization(value)).toEqual(authorization);
    });

    it("expires when status, run, fingerprint, or repair snapshot changes", () => {
        const value = state();
        value.fixLearningAuthorization = createFixLearningAuthorization(value, value.fixDiagnosticsFingerprint);

        expect(currentFixLearningAuthorization({ ...value, status: "done" })).toBeNull();
        expect(currentFixLearningAuthorization({ ...value, runId: 203 })).toBeNull();
        expect(currentFixLearningAuthorization({
            ...value,
            fixDiagnosticsFingerprint: "deadbeef",
        })).toBeNull();
        expect(currentFixLearningAuthorization({
            ...value,
            pendingFixSnapshot: { ...value.pendingFixSnapshot, attempt: 2 },
        })).toBeNull();
        expect(sameFixLearningAuthorization(value.fixLearningAuthorization, {
            ...value.fixLearningAuthorization!,
            runId: 203,
        })).toBe(false);
        expect(createFixLearningAuthorization({
            ...value,
            runId: value.pendingFixSnapshot.runId,
        }, value.fixDiagnosticsFingerprint)).toBeNull();
    });
});
