import { describe, expect, it, vi } from "vitest";
import {
    acquireTaskOperationLease,
    acquireTaskPlannerLease,
    applyTaskQuotaExhausted,
    assertBoundTaskStoreSchema,
    deleteTask,
    getOwnedTask,
    putTask,
    putTaskState,
    putTaskWithOperationLease,
    renewOwnedTask,
    renewTaskOperationLease,
    renewTaskPlannerLease,
    TaskOwnershipError,
    TaskStoreUnavailableError,
} from "../../functions/_lib/taskStore";

function createMemoryKv(initial: Record<string, string> = {}) {
    const values = new Map(Object.entries(initial));
    const namespace = {
        get: async (key: string) => values.get(key) ?? null,
        put: async (key: string, value: string) => { values.set(key, value); },
        delete: async (key: string) => { values.delete(key); },
    } as unknown as KVNamespace;
    return { namespace, values };
}

const REQUIRED_TASK_COLUMNS = [
    "task_id",
    "owner_uid",
    "cost_total",
    "cost_consumed",
    "created_at",
    "updated_at",
    "expires_at",
    "quota_exhausted",
    "planner_lease_token",
    "planner_lease_until",
];

function createSchemaD1(columns = REQUIRED_TASK_COLUMNS) {
    const database = {
        prepare(sql: string) {
            return {
                async all() {
                    if (sql.includes("sqlite_master")) {
                        return {
                            results: [
                                { name: "generation_tasks" },
                                { name: "generation_task_chunks" },
                            ],
                        };
                    }
                    if (sql.includes("PRAGMA table_info(generation_tasks)")) {
                        return { results: columns.map(name => ({ name })) };
                    }
                    throw new Error(`unexpected schema query: ${sql}`);
                },
            };
        },
    } as unknown as D1Database;
    return database;
}

function createQuotaMarkerD1(taskId: string, ownerUid: string, raw: string) {
    let quotaExhausted = 0;
    const database = {
        prepare(sql: string) {
            return {
                bind() {
                    return {
                        async first() {
                            if (sql.includes("SELECT owner_uid")) return { owner_uid: ownerUid };
                            if (sql.includes("SET quota_exhausted = 1")) {
                                quotaExhausted = 1;
                                return { task_id: taskId };
                            }
                            throw new Error(`unexpected first query: ${sql}`);
                        },
                        async all() {
                            if (!sql.includes("SELECT c.payload")) {
                                throw new Error(`unexpected all query: ${sql}`);
                            }
                            return {
                                results: [{ payload: raw, quota_exhausted: quotaExhausted }],
                            };
                        },
                    };
                },
            };
        },
    } as unknown as D1Database;
    return { database, quotaExhausted: () => quotaExhausted };
}

function createTaskRenewalD1(taskId: string, ownerUid: string, initialExpiresAt: number) {
    let expiresAt = initialExpiresAt;
    const database = {
        prepare(sql: string) {
            return {
                bind(...args: unknown[]) {
                    return {
                        async first() {
                            if (!sql.includes("UPDATE generation_tasks")
                                || !sql.includes("RETURNING expires_at")) {
                                throw new Error(`unexpected renewal query: ${sql}`);
                            }
                            const now = Math.floor(Date.now() / 1000) * 1000;
                            if (String(args[0]) !== taskId
                                || String(args[1]) !== ownerUid
                                || expiresAt <= now) return null;
                            expiresAt = Math.max(expiresAt, now + (Number(args[2]) || 0));
                            return { expires_at: expiresAt };
                        },
                    };
                },
            };
        },
    } as unknown as D1Database;
    return {
        database,
        expiresAt: () => expiresAt,
        expire: () => { expiresAt = Math.floor(Date.now() / 1000) * 1000 - 1; },
    };
}

function createPlannerLeaseD1(ownerUid: string) {
    let leaseToken = "";
    let leaseUntil = 0;
    const database = {
        prepare(sql: string) {
            return {
                bind(...args: unknown[]) {
                    return {
                        async first() {
                            if (sql.includes("SET planner_lease_token = ?3")) {
                                const requestedOwner = String(args[1] ?? "");
                                const requestedToken = String(args[2] ?? "");
                                const leaseMs = Number(args[3]) || 0;
                                const now = Math.floor(Date.now() / 1000) * 1000;
                                if (requestedOwner !== ownerUid || leaseUntil > now) return null;
                                leaseToken = requestedToken;
                                leaseUntil = now + leaseMs;
                                return { planner_lease_token: leaseToken };
                            }
                            if (sql.includes("SET planner_lease_until =")) {
                                const requestedOwner = String(args[1] ?? "");
                                const requestedToken = String(args[2] ?? "");
                                const leaseMs = Number(args[3]) || 0;
                                const now = Math.floor(Date.now() / 1000) * 1000;
                                if (requestedOwner !== ownerUid || requestedToken !== leaseToken || leaseUntil <= now) {
                                    return null;
                                }
                                leaseUntil = now + leaseMs;
                                return { planner_lease_token: leaseToken };
                            }
                            if (sql.includes("SELECT owner_uid")) return { owner_uid: ownerUid };
                            throw new Error(`unexpected first query: ${sql}`);
                        },
                    };
                },
            };
        },
    } as unknown as D1Database;
    return { database, currentLease: () => ({ leaseToken, leaseUntil }) };
}

function createOperationLeaseD1(
    ownerUid: string,
    initialRaw = JSON.stringify({ uid: ownerUid, status: "error" }),
) {
    let leaseToken = "";
    let leaseUntil = 0;
    let expiresAt = Date.now() + 3_600_000;
    const chunks = new Map<number, string>([[0, initialRaw]]);
    const d1Now = () => Math.floor(Date.now() / 1000) * 1000;
    const rawPayload = () => [...chunks.entries()]
        .sort(([left], [right]) => left - right)
        .map(([, value]) => value)
        .join("");

    const statement = (sql: string, args: unknown[] = []): any => ({
        sql,
        args,
        bind: (...bound: unknown[]) => statement(sql, bound),
        first: async () => {
            if (sql.includes("SET planner_lease_token = ?3") && sql.includes("RETURNING planner_lease_token")) {
                const requestedOwner = String(args[1] ?? "");
                const requestedToken = String(args[2] ?? "");
                const leaseMs = Number(args[3]) || 0;
                const now = d1Now();
                if (requestedOwner !== ownerUid || leaseUntil > now) return null;
                leaseToken = requestedToken;
                leaseUntil = now + leaseMs;
                expiresAt = Math.max(expiresAt, leaseUntil);
                return { planner_lease_token: leaseToken };
            }
            if (sql.includes("SET planner_lease_until =") && sql.includes("RETURNING planner_lease_token")) {
                const requestedOwner = String(args[1] ?? "");
                const requestedToken = String(args[2] ?? "");
                const leaseMs = Number(args[3]) || 0;
                const now = d1Now();
                if (requestedOwner !== ownerUid || requestedToken !== leaseToken || leaseUntil <= now) {
                    return null;
                }
                leaseUntil = now + leaseMs;
                expiresAt = Math.max(expiresAt, leaseUntil);
                return { planner_lease_token: leaseToken };
            }
            if (sql.includes("SELECT owner_uid")) return { owner_uid: ownerUid };
            if (sql.includes("SELECT planner_lease_token")) {
                return { planner_lease_token: leaseToken, planner_lease_until: leaseUntil };
            }
            throw new Error(`unexpected first query: ${sql}`);
        },
        all: async () => {
            if (!sql.includes("SELECT c.payload")) throw new Error(`unexpected all query: ${sql}`);
            return {
                results: [...chunks.entries()]
                    .sort(([left], [right]) => left - right)
                    .map(([, payload]) => ({
                        payload,
                        quota_exhausted: 0,
                        planner_lease_token: leaseToken,
                        planner_lease_until: leaseUntil,
                    })),
            };
        },
        run: async () => {
            const requestedOwner = String(args[1] ?? "");
            const requestedToken = String(args[2] ?? "");
            if (sql.includes("SET planner_lease_token = ?4")
                && requestedOwner === ownerUid
                && requestedToken === leaseToken) {
                leaseToken = String(args[3] ?? "");
                leaseUntil = 0;
                return { meta: { changes: 1 } };
            }
            return { meta: { changes: 0 } };
        },
    });

    const database = {
        prepare(sql: string) {
            return statement(sql);
        },
        async batch(statements: any[]) {
            return statements.map((prepared) => {
                const sql = String(prepared.sql);
                const args = prepared.args as unknown[];
                const now = d1Now();
                let changes = 0;

                if (sql.includes("INSERT INTO generation_tasks")) {
                    const requestedOwner = String(args[1] ?? "");
                    const expirationMs = Number(args[5]) || 0;
                    const writeToken = String(args[6] ?? "");
                    const expectedFence = String(args[7] ?? "");
                    if (requestedOwner === ownerUid
                        && (expiresAt <= now || (leaseToken === expectedFence && leaseUntil <= now))) {
                        leaseToken = writeToken;
                        leaseUntil = 0;
                        expiresAt = now + expirationMs;
                        changes = 1;
                    }
                } else if (sql.includes("SET planner_lease_token = ?4")
                    && sql.includes("planner_lease_until >")) {
                    const requestedOwner = String(args[1] ?? "");
                    const requestedToken = String(args[2] ?? "");
                    const writeToken = String(args[3] ?? "");
                    const expirationMs = Number(args[4]) || 0;
                    if (requestedOwner === ownerUid
                        && requestedToken === leaseToken
                        && leaseUntil > now) {
                        leaseToken = writeToken;
                        expiresAt = now + expirationMs;
                        changes = 1;
                    }
                } else if (sql.includes("INSERT INTO generation_task_chunks")) {
                    const requestedOwner = String(args[3] ?? "");
                    const writeToken = String(args[4] ?? "");
                    if (requestedOwner === ownerUid && writeToken === leaseToken) {
                        chunks.set(Number(args[1]) || 0, String(args[2] ?? ""));
                        changes = 1;
                    }
                } else if (sql.includes("DELETE FROM generation_task_chunks")) {
                    const requestedOwner = String(args[2] ?? "");
                    const writeToken = String(args[3] ?? "");
                    if (requestedOwner === ownerUid && writeToken === leaseToken) {
                        const firstDeleted = Number(args[1]) || 0;
                        for (const index of chunks.keys()) {
                            if (index >= firstDeleted) chunks.delete(index);
                        }
                        changes = 1;
                    }
                } else if (sql.includes("planner_lease_until = CASE")) {
                    const requestedOwner = String(args[1] ?? "");
                    const finalToken = String(args[2] ?? "");
                    const releaseLease = Number(args[3]) === 1;
                    const expirationMs = Number(args[4]) || 0;
                    const writeToken = String(args[5] ?? "");
                    if (requestedOwner === ownerUid && writeToken === leaseToken) {
                        leaseToken = finalToken;
                        if (releaseLease) leaseUntil = 0;
                        expiresAt = now + expirationMs;
                        changes = 1;
                    }
                } else if (sql.includes("SET planner_lease_token = ?3, planner_lease_until = 0")) {
                    const requestedOwner = String(args[1] ?? "");
                    const finalToken = String(args[2] ?? "");
                    const expirationMs = Number(args[3]) || 0;
                    const writeToken = String(args[4] ?? "");
                    if (requestedOwner === ownerUid && writeToken === leaseToken) {
                        leaseToken = finalToken;
                        leaseUntil = 0;
                        expiresAt = now + expirationMs;
                        changes = 1;
                    }
                }
                return { meta: { changes } };
            });
        },
    } as unknown as D1Database;

    return {
        database,
        currentLease: () => ({ leaseToken, leaseUntil }),
        payload: rawPayload,
        expireLease: () => { leaseUntil = d1Now() - 1; },
    };
}

describe("task store schema gate", () => {
    it("accepts the fully migrated task schema", async () => {
        const { namespace } = createMemoryKv();

        await expect(assertBoundTaskStoreSchema({
            TASKS: namespace,
            DB: createSchemaD1(),
        })).resolves.toBeUndefined();
    });

    it("points to the quota migration when quota_exhausted is missing", async () => {
        const { namespace } = createMemoryKv();
        const columns = REQUIRED_TASK_COLUMNS.filter(name => name !== "quota_exhausted");

        await expect(assertBoundTaskStoreSchema({
            TASKS: namespace,
            DB: createSchemaD1(columns),
        })).rejects.toThrow("0003_generation_task_quota.sql");
    });

    it("points to the Planner migration when lease columns are missing", async () => {
        const { namespace } = createMemoryKv();
        const columns = REQUIRED_TASK_COLUMNS.filter(name => !name.startsWith("planner_lease_"));

        await expect(assertBoundTaskStoreSchema({
            TASKS: namespace,
            DB: createSchemaD1(columns),
        })).rejects.toThrow("0004_generation_task_planner_lease.sql");
    });
});

describe("task quota state overlay", () => {
    it("sets the durable quota flag without discarding generation state", () => {
        const raw = JSON.stringify({
            uid: "user-1",
            plan: { files: ["src/Main.java"] },
            quotaExhausted: false,
        });

        expect(JSON.parse(applyTaskQuotaExhausted(raw, true))).toEqual({
            uid: "user-1",
            plan: { files: ["src/Main.java"] },
            quotaExhausted: true,
        });
    });

    it("leaves state unchanged when no overlay applies or JSON is invalid", () => {
        const raw = JSON.stringify({ uid: "user-1", quotaExhausted: false });

        expect(applyTaskQuotaExhausted(raw, false)).toBe(raw);
        expect(applyTaskQuotaExhausted("not-json", true)).toBe("not-json");
    });

    it("merges a KV fallback marker into a recovered D1 task and promotes it", async () => {
        const taskId = "task-quota-recovery";
        const ownerUid = "user-1";
        const raw = JSON.stringify({ uid: ownerUid, quotaExhausted: false, plan: ["kept"] });
        const { namespace, values } = createMemoryKv({
            [`taskQuotaExhausted:${taskId}`]: ownerUid,
        });
        const d1 = createQuotaMarkerD1(taskId, ownerUid, raw);

        const recovered = await getOwnedTask(
            { TASKS: namespace, DB: d1.database },
            taskId,
            ownerUid,
        );

        expect(JSON.parse(String(recovered))).toMatchObject({
            quotaExhausted: true,
            plan: ["kept"],
        });
        expect(d1.quotaExhausted()).toBe(1);
        expect(values.has(`taskQuotaExhausted:${taskId}`)).toBe(false);
    });
});

describe("task state write policy", () => {
    it("does not expose a stale KV shadow when a bound D1 read fails", async () => {
        const taskId = "task-d1-read-failure";
        const ownerUid = "user-1";
        const staleRaw = JSON.stringify({ uid: ownerUid, status: "building", runId: 123 });
        const { namespace } = createMemoryKv({ [taskId]: staleRaw });
        const database = {
            prepare() {
                return {
                    bind() {
                        return { first: async () => { throw new Error("d1 unavailable"); } };
                    },
                };
            },
        } as unknown as D1Database;
        const warn = vi.spyOn(console, "warn").mockImplementation(() => undefined);

        try {
            await expect(getOwnedTask(
                { TASKS: namespace, DB: database },
                taskId,
                ownerUid,
            )).rejects.toBeInstanceOf(TaskStoreUnavailableError);
        } finally {
            warn.mockRestore();
        }
    });

    it("does not shadow a failed bound D1 write in KV", async () => {
        const taskId = "task-d1-write-failure";
        const ownerUid = "user-1";
        const { namespace, values } = createMemoryKv();
        const database = {
            prepare(sql: string) {
                return {
                    bind(...args: unknown[]) {
                        return { sql, args };
                    },
                };
            },
            async batch() {
                throw new Error("d1 unavailable");
            },
        } as unknown as D1Database;
        const warn = vi.spyOn(console, "warn").mockImplementation(() => undefined);

        try {
            await expect(putTask(
                { TASKS: namespace, DB: database },
                taskId,
                JSON.stringify({ uid: ownerUid, status: "planning" }),
                3600,
                ownerUid,
            )).rejects.toBeInstanceOf(TaskStoreUnavailableError);
            expect(values.has(taskId)).toBe(false);
        } finally {
            warn.mockRestore();
        }
    });
});

describe("task expiry renewal", () => {
    it("renews only an active task owned by the current user", async () => {
        vi.useFakeTimers();
        vi.setSystemTime(new Date("2026-09-01T08:00:00.000Z"));
        try {
            const taskId = "task-renew";
            const ownerUid = "user-1";
            const now = Date.now();
            const renewal = createTaskRenewalD1(taskId, ownerUid, now + 60_000);
            const { namespace } = createMemoryKv();
            const env = { TASKS: namespace, DB: renewal.database };

            await expect(renewOwnedTask(env, taskId, ownerUid)).resolves.toBe(now + 3_600_000);
            expect(renewal.expiresAt()).toBe(now + 3_600_000);
            await expect(renewOwnedTask(env, taskId, "other-user")).resolves.toBeNull();

            renewal.expire();
            await expect(renewOwnedTask(env, taskId, ownerUid)).resolves.toBeNull();
        } finally {
            vi.useRealTimers();
        }
    });
});

describe("Planner lease policy", () => {
    it("requires D1 and never creates a KV fallback lock", async () => {
        const taskId = "task-no-d1";
        const ownerUid = "user-1";
        const { namespace, values } = createMemoryKv({
            [taskId]: JSON.stringify({ uid: ownerUid }),
        });

        await expect(acquireTaskPlannerLease(
            { TASKS: namespace },
            taskId,
            ownerUid,
            "planner_no_d1",
            60_000,
        )).rejects.toBeInstanceOf(TaskStoreUnavailableError);
        expect(values.has(`taskPlannerLease:${taskId}`)).toBe(false);
    });

    it("fails closed when a bound D1 lease operation is unavailable", async () => {
        const taskId = "task-d1-failure";
        const ownerUid = "user-1";
        const { namespace, values } = createMemoryKv();
        const database = {
            prepare() {
                return {
                    bind() {
                        return { first: async () => { throw new Error("d1 unavailable"); } };
                    },
                };
            },
        } as unknown as D1Database;
        const warn = vi.spyOn(console, "warn").mockImplementation(() => undefined);

        try {
            await expect(acquireTaskPlannerLease(
                { TASKS: namespace, DB: database },
                taskId,
                ownerUid,
                "planner_d1_failure",
                60_000,
            )).rejects.toThrow("d1 unavailable");
            expect(values.has(`taskPlannerLease:${taskId}`)).toBe(false);
        } finally {
            warn.mockRestore();
        }
    });

    it("serializes D1 acquisition and renews only the current token", async () => {
        const taskId = "task-d1-lease";
        const ownerUid = "user-1";
        const { namespace } = createMemoryKv();
        const d1 = createPlannerLeaseD1(ownerUid);
        const env = { TASKS: namespace, DB: d1.database };

        expect(await acquireTaskPlannerLease(env, taskId, ownerUid, "planner_first", 60_000)).toBe("d1");
        const firstLeaseUntil = d1.currentLease().leaseUntil;
        expect(await acquireTaskPlannerLease(env, taskId, ownerUid, "planner_second", 60_000)).toBeNull();
        await expect(acquireTaskPlannerLease(env, taskId, "user-2", "planner_other", 60_000))
            .rejects.toBeInstanceOf(TaskOwnershipError);

        expect(await renewTaskPlannerLease(env, taskId, ownerUid, "planner_first", 120_000)).toBe(true);
        expect(d1.currentLease().leaseUntil).toBeGreaterThan(firstLeaseUntil);
        expect(await renewTaskPlannerLease(env, taskId, ownerUid, "planner_second", 120_000)).toBe(false);
    });

    it("retains and atomically releases a fenced operation lease", async () => {
        const taskId = "task-operation-lease";
        const ownerUid = "user-1";
        const { namespace } = createMemoryKv();
        const d1 = createOperationLeaseD1(ownerUid);
        const env = { TASKS: namespace, DB: d1.database };
        const token = "repair:first";

        expect(await acquireTaskOperationLease(env, taskId, ownerUid, token, 45_000)).toBe("d1");
        expect(await acquireTaskOperationLease(env, taskId, ownerUid, "repair:second", 45_000)).toBeNull();
        expect(await putTaskWithOperationLease(
            env,
            taskId,
            JSON.stringify({ status: "repairing" }),
            token,
            "d1",
            3600,
            ownerUid,
            false,
        )).toBe(true);
        expect(d1.currentLease().leaseToken).toBe(token);
        expect(await renewTaskOperationLease(env, taskId, ownerUid, token, 45_000)).toBe(true);

        expect(await putTaskWithOperationLease(
            env,
            taskId,
            JSON.stringify({ status: "fixed" }),
            token,
            "d1",
            3600,
            ownerUid,
            true,
        )).toBe(true);
        expect(JSON.parse(d1.payload())).toEqual({ status: "fixed" });
        expect(d1.currentLease()).toEqual({ leaseToken: `fence:${token}`, leaseUntil: 0 });
    });

    it("rejects a stale ordinary write after an operation completion fence", async () => {
        const taskId = "task-operation-fence";
        const ownerUid = "user-1";
        const initialRaw = JSON.stringify({
            uid: ownerUid,
            status: "error",
            generatedFiles: [{ path: "src/Main.java", content: "before" }],
        });
        const { namespace } = createMemoryKv();
        const d1 = createOperationLeaseD1(ownerUid, initialRaw);
        const env = { TASKS: namespace, DB: d1.database };
        const token = "repair:fenced";

        const staleRaw = await getOwnedTask(env, taskId, ownerUid);
        expect(staleRaw).not.toBeNull();
        expect(await acquireTaskOperationLease(env, taskId, ownerUid, token, 45_000)).toBe("d1");

        const leasedRaw = await getOwnedTask(env, taskId, ownerUid);
        const fixedState = JSON.parse(String(leasedRaw));
        fixedState.status = "fixed";
        fixedState.generatedFiles[0].content = "after";
        expect(await putTaskWithOperationLease(
            env,
            taskId,
            JSON.stringify(fixedState),
            token,
            "d1",
            3600,
            ownerUid,
            true,
        )).toBe(true);

        await expect(putTask(env, taskId, String(staleRaw), 3600, ownerUid))
            .rejects.toBeInstanceOf(TaskOwnershipError);
        const freshRaw = await getOwnedTask(env, taskId, ownerUid);
        expect(JSON.parse(String(freshRaw))).toMatchObject({
            status: "fixed",
            generatedFiles: [{ path: "src/Main.java", content: "after" }],
        });

        const freshState = JSON.parse(String(freshRaw));
        freshState.note = "fresh write";
        await expect(putTask(env, taskId, JSON.stringify(freshState), 3600, ownerUid))
            .resolves.toBeUndefined();
        expect(JSON.parse(d1.payload())).toMatchObject({ status: "fixed", note: "fresh write" });
    });

    it("advances the ordinary write fence while allowing sequential writes from one state", async () => {
        const taskId = "task-ordinary-fence";
        const ownerUid = "user-1";
        const initialRaw = JSON.stringify({ uid: ownerUid, status: "planning" });
        const { namespace } = createMemoryKv();
        const d1 = createOperationLeaseD1(ownerUid, initialRaw);
        const env = { TASKS: namespace, DB: d1.database };

        const firstRaw = await getOwnedTask(env, taskId, ownerUid);
        const staleRaw = await getOwnedTask(env, taskId, ownerUid);
        const state = JSON.parse(String(firstRaw));
        state.first = true;
        await putTaskState(env, taskId, state, 3600, ownerUid);

        state.second = true;
        await putTaskState(env, taskId, state, 3600, ownerUid);
        expect(JSON.parse(d1.payload())).toMatchObject({
            status: "planning",
            first: true,
            second: true,
        });

        const staleState = JSON.parse(String(staleRaw));
        staleState.stale = true;
        await expect(putTaskState(env, taskId, staleState, 3600, ownerUid))
            .rejects.toBeInstanceOf(TaskOwnershipError);
        expect(JSON.parse(d1.payload())).not.toHaveProperty("stale");
    });

    it("does not renew or write with an expired operation token", async () => {
        const taskId = "task-expired-operation-lease";
        const ownerUid = "user-1";
        const initialRaw = JSON.stringify({ uid: ownerUid, status: "error" });
        const { namespace } = createMemoryKv();
        const d1 = createOperationLeaseD1(ownerUid, initialRaw);
        const env = { TASKS: namespace, DB: d1.database };
        const token = "repair:expired";

        expect(await acquireTaskOperationLease(env, taskId, ownerUid, token, 45_000)).toBe("d1");
        d1.expireLease();
        expect(await renewTaskOperationLease(env, taskId, ownerUid, token, 45_000)).toBe(false);
        expect(await putTaskWithOperationLease(
            env,
            taskId,
            JSON.stringify({ status: "fixed" }),
            token,
            "d1",
            3600,
            ownerUid,
            true,
        )).toBe(false);
        expect(d1.payload()).toBe(initialRaw);
    });

    it("removes legacy KV Planner metadata when the owned task is deleted", async () => {
        const taskId = "task-delete";
        const ownerUid = "user-1";
        const { namespace, values } = createMemoryKv({
            [taskId]: JSON.stringify({ uid: ownerUid }),
            [`taskCost:${taskId}`]: JSON.stringify({ total: 1 }),
            [`taskQuotaExhausted:${taskId}`]: ownerUid,
            [`taskPlannerLease:${taskId}`]: JSON.stringify({
                ownerUid,
                leaseToken: "planner_legacy",
                expiresAt: Date.now() + 60_000,
            }),
        });

        await deleteTask({ TASKS: namespace }, taskId, ownerUid);

        expect([...values.keys()].filter(key => key.includes(taskId))).toEqual([]);
    });
});
