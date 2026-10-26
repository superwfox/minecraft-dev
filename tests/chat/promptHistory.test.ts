import { beforeEach, describe, expect, it, vi } from "vitest";
const memory = vi.hoisted(() => ({ owner: "live:alice", values: new Map<string, any>(), fail: false }));
vi.mock("../../src/logic/projectDb", () => ({
    projectOwner: () => memory.owner,
    dbList: async (_store: string, prefix: string, select?: (value: any) => any) => [...memory.values].filter(([key]) => key.startsWith(prefix)).map(([key, value]) => ({ key, value: select ? select(value) : value })),
    dbPut: async (_store: string, key: string, value: unknown) => { if (memory.fail) throw new Error("QuotaExceededError"); memory.values.set(key, value); },
    deleteProjectData: async (owner: string, id: string) => { memory.values.delete(`${owner}:${id}`); },
}));
import { loadPromptHistory, migratePromptHistory, promptHistory, removePromptHistoryEntry } from "../../src/logic/promptHistory";
describe("task project history", () => {
    beforeEach(() => { memory.values.clear(); memory.owner = "live:alice"; memory.fail = false; vi.stubGlobal("fetch", vi.fn(async () => new Response(null, { status: 204 }))); });
    it("keeps distinct tasks with the same prompt without the old twenty-entry eviction", async () => {
        for (let index = 0; index < 25; index++) memory.values.set(`live:alice:${index}`, { meta: { id: String(index), prompt: "相同需求", lastUsedAt: index } });
        await loadPromptHistory(); expect(promptHistory).toHaveLength(25); expect(promptHistory[0].id).toBe("24");
    });
    it("isolates accounts and preview namespace", async () => {
        memory.values.set("live:alice:one", { meta: { id: "one" } }); memory.values.set("preview:alice:two", { meta: { id: "two" } }); memory.values.set("live:bob:three", { meta: { id: "three" } });
        await loadPromptHistory(); expect(promptHistory.map(row => row.id)).toEqual(["one"]);
        memory.owner = "live:bob"; await loadPromptHistory(); expect(promptHistory.map(row => row.id)).toEqual(["three"]);
    });
    it("cleans only the deleted task and attempts remote cleanup", async () => {
        memory.values.set("live:alice:one", { meta: { id: "one", taskId: "remote-one" } }); memory.values.set("live:alice:two", { meta: { id: "two" } });
        await loadPromptHistory(); await removePromptHistoryEntry("one"); expect(promptHistory.map(row => row.id)).toEqual(["two"]);
        expect(fetch).toHaveBeenCalledWith("/api/generate/task?taskId=remote-one", { method: "DELETE" });
    });
    it("does not delete legacy storage until migration completes", async () => {
        const remove = vi.fn(); vi.stubGlobal("localStorage", { getItem: () => JSON.stringify([{ id: "old", prompt: "legacy" }]), removeItem: remove });
        memory.fail = true; await expect(migratePromptHistory("live:alice")).rejects.toThrow(); expect(remove).not.toHaveBeenCalled();
        memory.fail = false; await migratePromptHistory("live:alice"); expect(remove).toHaveBeenCalledOnce(); expect(memory.values.get("live:alice:legacy_old").meta.available).toBe(false);
    });
});
