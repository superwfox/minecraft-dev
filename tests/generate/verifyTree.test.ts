import { beforeEach, expect, it, vi } from "vitest";
import { createInitialTree, deriveGenerationPlan } from "../../functions/_lib/projectTree";
const memory = vi.hoisted(() => ({ raw: "" }));
vi.mock("../../functions/_lib/taskStore", () => ({ getOwnedTask: vi.fn(async () => memory.raw), putTaskState: vi.fn(async (_env: unknown, _id: string, state: unknown) => { memory.raw = JSON.stringify(state); }) }));
import { onRequestPost } from "../../functions/api/generate/verify";
beforeEach(() => { const tree = createInitialTree("Paper", "1.21.4"); tree.project.packageName = "com.tahai.home"; tree.status = "locked"; memory.raw = JSON.stringify({ tree, ...deriveGenerationPlan(tree), generatedFiles: [{ path: "pom.xml", content: "<project/>" }], fileStatuses: {}, generationCheckpoints: {}, logs: [], currentBucket: 0 }); });
async function invoke(fixMissing = false) {
    return onRequestPost({ request: new Request("https://app.test/api/generate/verify", { method: "POST", body: JSON.stringify({ taskId: "task", fixMissing }) }), env: { TASKS: {} }, data: { uid: "user" } } as unknown as Parameters<typeof onRequestPost>[0]);
}
it("reports missing tree nodes rather than trusting the old plan", async () => { const result = await (await invoke()).json(); expect(result).toMatchObject({ verified: false, total: 3, generated: 1, missing: ["src/main/resources/plugin.yml", "src/main/java/com/tahai/home/Main.java"] }); });
it("creates a repair bucket and resets checkpoints with Main last", async () => {
    const result = await (await invoke(true)).json() as { repairBucketIndex: number };
    const state = JSON.parse(memory.raw); expect(state.currentBucket).toBe(result.repairBucketIndex); expect(state.buckets.at(-1).at(-1).nodeId).toBe("Main"); expect(Object.values(state.fileStatuses)).toEqual(["pending", "pending"]);
});
