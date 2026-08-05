export const REPAIR_RECOVERY_LEASE_MS = 45_000;
export const REPAIR_LEASE_RENEW_INTERVAL_MS = 15_000;

export interface BuildRepairRecoverySnapshot {
    status: "repairing" | "fixed" | "error";
    repairRetryAfterMs?: number;
    repairChanged?: number;
    error?: string;
    repairStarted?: boolean;
}

export function buildRepairRecoverySnapshot(
    state: Record<string, any>,
    now = Date.now(),
    repairLeaseUntil = 0,
): BuildRepairRecoverySnapshot | null {
    const repairStartedAt = Math.max(0, Number(state.repairStartedAt) || 0);
    if (repairLeaseUntil > now) {
        return {
            status: "repairing",
            repairRetryAfterMs: repairLeaseUntil - now,
        };
    }
    if (state.status === "repairing") {
        const fallbackLeaseUntil = repairStartedAt
            ? repairStartedAt + REPAIR_RECOVERY_LEASE_MS
            : 0;
        return {
            status: "repairing",
            repairRetryAfterMs: Math.max(
                0,
                Math.max(fallbackLeaseUntil, repairLeaseUntil) - now,
            ),
        };
    }
    if (state.status === "fixed" && state.pendingFixSnapshot) {
        return {
            status: "fixed",
            repairChanged: Array.isArray(state.pendingFixSnapshot.changedFiles)
                ? state.pendingFixSnapshot.changedFiles.length
                : 0,
        };
    }
    if (state.status === "error" && repairStartedAt) {
        return {
            status: "error",
            error: state.error || "自动修复失败",
            repairStarted: true,
        };
    }
    return null;
}
