import { describe, expect, it } from "vitest";
import {
    REPAIR_RECOVERY_LEASE_MS,
    buildRepairRecoverySnapshot,
} from "../../functions/_lib/buildRepairRecovery";

describe("build repair recovery snapshot", () => {
    it("reports the remaining repairing lease without extending it", () => {
        const startedAt = 1_700_000_000_000;

        expect(buildRepairRecoverySnapshot({
            status: "repairing",
            repairStartedAt: startedAt,
        }, startedAt + 5_000)).toEqual({
            status: "repairing",
            repairRetryAfterMs: REPAIR_RECOVERY_LEASE_MS - 5_000,
        });
        expect(buildRepairRecoverySnapshot({
            status: "repairing",
            repairStartedAt: startedAt,
        }, startedAt + REPAIR_RECOVERY_LEASE_MS + 1)).toEqual({
            status: "repairing",
            repairRetryAfterMs: 0,
        });
    });

    it("uses the renewed D1 lease as the authoritative recovery window", () => {
        const startedAt = 1_700_000_000_000;
        const now = startedAt + 40_000;
        const renewedLeaseUntil = now + REPAIR_RECOVERY_LEASE_MS;

        expect(buildRepairRecoverySnapshot({
            status: "repairing",
            repairStartedAt: startedAt,
        }, now, renewedLeaseUntil)).toEqual({
            status: "repairing",
            repairRetryAfterMs: REPAIR_RECOVERY_LEASE_MS,
        });
    });

    it("lets an active repair lease override a payload not yet initialized", () => {
        const now = 1_700_000_000_000;

        expect(buildRepairRecoverySnapshot({
            status: "error",
            error: "previous build failed",
        }, now, now + 30_000)).toEqual({
            status: "repairing",
            repairRetryAfterMs: 30_000,
        });
    });

    it("publishes only the changed file count for a completed repair", () => {
        expect(buildRepairRecoverySnapshot({
            status: "fixed",
            pendingFixSnapshot: {
                changedFiles: ["src/A.java", "src/B.java"],
                diagnostics: [{ private: "not exposed" }],
            },
        })).toEqual({
            status: "fixed",
            repairChanged: 2,
        });
    });

    it("marks only errors associated with a started repair", () => {
        expect(buildRepairRecoverySnapshot({
            status: "error",
            error: "自动修复失败",
            repairStartedAt: 1_700_000_000_000,
        })).toEqual({
            status: "error",
            error: "自动修复失败",
            repairStarted: true,
        });
        expect(buildRepairRecoverySnapshot({
            status: "error",
            error: "普通构建失败",
        })).toBeNull();
        expect(buildRepairRecoverySnapshot({ status: "building" })).toBeNull();
    });
});
