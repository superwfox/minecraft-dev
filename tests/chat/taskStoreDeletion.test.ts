import { describe, expect, it, vi } from "vitest";
import {
    deleteTask,
    hasOwnedTask,
    TaskStoreUnavailableError,
} from "../../functions/_lib/taskStore";

describe("task deletion billing integrity", () => {
    it("removes task cost records without refunding settled user quota", async () => {
        const values = new Map<string, string>([
            ["user:user-1", JSON.stringify({ paidBalance: 2, totalRecharged: 25 })],
            ["task-1", JSON.stringify({ uid: "user-1", status: "planning" })],
            ["taskCost:task-1", JSON.stringify({ uid: "user-1", total: 1.2, consumed: 1 })],
        ]);
        const namespace = {
            get: vi.fn(async (key: string) => values.get(key) ?? null),
            delete: vi.fn(async (key: string) => {
                values.delete(key);
            }),
        } as unknown as KVNamespace;

        await deleteTask({ TASKS: namespace }, "task-1", "user-1");

        expect(values.has("task-1")).toBe(false);
        expect(values.has("taskCost:task-1")).toBe(false);
        expect(JSON.parse(values.get("user:user-1") || "{}")).toEqual({
            paidBalance: 2,
            totalRecharged: 25,
        });
        expect(namespace.delete).not.toHaveBeenCalledWith("user:user-1");
    });

    it("recognizes an expired D1 task by owner without applying the normal expiry filter", async () => {
        const prepare = vi.fn((sql: string) => ({
            bind: vi.fn(() => ({
                first: vi.fn(async () => {
                    if (sql.includes("expires_at")) return null;
                    return { owner_uid: "user-1" };
                }),
            })),
        }));
        const database = { prepare } as unknown as D1Database;
        const namespace = { get: vi.fn() } as unknown as KVNamespace;

        await expect(hasOwnedTask({ DB: database, TASKS: namespace }, "task-expired", "user-1"))
            .resolves.toBe(true);

        expect(prepare).toHaveBeenCalledOnce();
        expect(String(prepare.mock.calls[0][0])).not.toContain("expires_at");
        expect(namespace.get).not.toHaveBeenCalled();
    });

    it("propagates D1 deletion failures instead of falling back to a false success", async () => {
        const database = {
            batch: vi.fn(async () => {
                throw new Error("D1 unavailable");
            }),
            prepare: vi.fn(),
        } as unknown as D1Database;
        const namespace = {
            get: vi.fn(),
            delete: vi.fn(),
        } as unknown as KVNamespace;

        await expect(deleteTask(
            { DB: database, TASKS: namespace },
            "task-1",
            "user-1",
        )).rejects.toBeInstanceOf(TaskStoreUnavailableError);

        expect(namespace.get).not.toHaveBeenCalled();
        expect(namespace.delete).not.toHaveBeenCalled();
    });
});
