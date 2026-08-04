import { describe, expect, it, vi } from "vitest";
import {
    acquireTaskPlannerLease,
    applyTaskQuotaExhausted,
    assertBoundTaskStoreSchema,
    deleteTask,
    getOwnedTask,
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
                                const requestedUntil = Number(args[3]) || 0;
                                const now = Number(args[4]) || 0;
                                if (requestedOwner !== ownerUid || (leaseToken && leaseUntil > now)) return null;
                                leaseToken = requestedToken;
                                leaseUntil = requestedUntil;
                                return { planner_lease_token: leaseToken };
                            }
                            if (sql.includes("SET planner_lease_until = ?4")) {
                                const requestedOwner = String(args[1] ?? "");
                                const requestedToken = String(args[2] ?? "");
                                if (requestedOwner !== ownerUid || requestedToken !== leaseToken) return null;
                                leaseUntil = Number(args[3]) || 0;
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
