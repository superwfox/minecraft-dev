import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createInitialTree, emptyNodeContract, nodePath, planItemForNode, type TreeNode } from "../../functions/_lib/projectTree";
const memory = vi.hoisted(() => ({ raw: "" }));
vi.mock("../../functions/_lib/taskStore", async original => ({ ...await original<Record<string, unknown>>(), getOwnedTask: vi.fn(async () => memory.raw), putTaskState: vi.fn(async (_env: unknown, _id: string, state: unknown) => { memory.raw = JSON.stringify(state); }) }));
vi.mock("../../functions/_lib/llm", async original => ({ ...await original<Record<string, unknown>>(), resolveTaskLLM: vi.fn(async () => ({ byok: true, apiKey: "key", providerId: "deepseek", url: "https://model.test", modelFor: () => "deepseek-v4-flash", canAutoLearn: false })) }));
import { onRequestPost } from "../../functions/api/generate/bucket";
const code = "package com.tahai.home.home;\npublic class HomeManager {\n public void save() {}\n}";
function fixture(stage = "generate", content = code) {
    const tree = createInitialTree("Paper", "1.21.4"); tree.project.projectName = "Home"; tree.project.packageName = "com.tahai.home"; tree.status = "locked";
    tree.modules.push({ id: "home", title: "家园", responsibility: "管理家园", kind: "business" });
    const node: TreeNode = { id: "HomeManager", moduleId: "home", title: "家园", kind: "ManagerGen", responsibility: "保存家园", depends: [], contract: emptyNodeContract(), tag: null, pairId: "", origin: "planner" };
    tree.nodes.push(node); const path = nodePath(tree, node), plan = [planItemForNode(tree, node)];
    return { taskId: "task", uid: "user", ...tree.project, coreType: "Paper", version: "1.21.4", tree, nodeChecks: {}, plan, buckets: [plan], currentBucket: 0, fileStatuses: { [path]: "pending" }, generatedFiles: [], generationCheckpoints: { [path]: { version: 1, path, stage, content, reworkCount: 0, dynamicGenDone: false, dynamicFiles: [], dynamicIndex: 0, lastReason: "" } }, logs: [], skills: [] };
}
async function invoke() {
    const waits: Promise<unknown>[] = [];
    const response = await onRequestPost({ request: new Request("https://app.test/api/generate/bucket", { method: "POST", body: JSON.stringify({ taskId: "task", bucketIndex: 0 }) }), env: { TASKS: {} }, data: { uid: "user" }, waitUntil: (promise: Promise<unknown>) => waits.push(promise) } as unknown as Parameters<typeof onRequestPost>[0]);
    const text = await response.text(); await Promise.all(waits); return { response, text, events: text.split("\n").filter(line => line.startsWith("data: {")).map(line => JSON.parse(line.slice(6))) };
}
beforeEach(() => { memory.raw = JSON.stringify(fixture()); vi.stubGlobal("fetch", vi.fn(async () => new Response(JSON.stringify({ choices: [{ message: { content: code } }] })))); });
afterEach(() => vi.unstubAllGlobals());
describe("tree generation integration", () => {
    it("requires a locked tree before model calls", async () => {
        const state = fixture(); state.tree.status = "drafting"; memory.raw = JSON.stringify(state);
        const result = await invoke(); expect(result.response.status).toBe(409); expect(JSON.parse(result.text).code).toBe("TREE_NOT_LOCKED"); expect(fetch).not.toHaveBeenCalled();
    });
    it("injects package and member contracts and advances only one stage", async () => {
        await invoke(); expect(fetch).toHaveBeenCalledOnce();
        expect(JSON.parse(String(vi.mocked(fetch).mock.calls[0][1]?.body)).messages[1].content).toContain("package com.tahai.home.home;");
        const state = JSON.parse(memory.raw); expect(Object.values(state.generationCheckpoints)[0]).toMatchObject({ stage: "review" });
    });
    it("uses deterministic contract failures instead of a model review", async () => {
        const state = fixture("review", code.replace(" public void save() {}", ""));
        state.tree.nodes[3].contract.methods.push({ name: "save", params: "", returns: "void", isStatic: false }); memory.raw = JSON.stringify(state);
        await invoke(); expect(fetch).toHaveBeenCalledOnce();
        const checkpoint = Object.values(JSON.parse(memory.raw).generationCheckpoints)[0];
        expect(checkpoint).toMatchObject({ lastReason: expect.stringContaining("结构树契约未满足"), reworkCount: 1, stage: "review" });
    });
    it("appends missing classes in the referring module and generates each once", async () => {
        memory.raw = JSON.stringify(fixture("review"));
        vi.mocked(fetch).mockResolvedValueOnce(new Response(JSON.stringify({ choices: [{ message: { content: JSON.stringify({ is_ok: false, reason: "缺少存储类", missing_classes: ["HomeStorage"] }) } }] })));
        const result = await invoke(), state = JSON.parse(memory.raw);
        expect(state.tree.nodes.at(-1)).toMatchObject({ id: "HomeStorage", moduleId: "home", origin: "review" });
        expect(state.plan.at(-1).path).toBe("src/main/java/com/tahai/home/home/HomeStorage.java"); expect(state.buckets[0]).toHaveLength(1);
        expect(result.events.some(e => e.type === "tree_patch")).toBe(true); expect(fetch).toHaveBeenCalledOnce();
        vi.mocked(fetch).mockResolvedValueOnce(new Response(JSON.stringify({ choices: [{ message: { content: "package com.tahai.home.home;\npublic class HomeStorage {}" } }] })));
        const generated = await invoke(); expect(generated.events.find(e => e.type === "new_file")).toMatchObject({ nodeId: "HomeStorage" });
        expect(fetch).toHaveBeenCalledTimes(2);
    });
    it("saves and emits contract totals on completion", async () => {
        memory.raw = JSON.stringify(fixture("review"));
        vi.mocked(fetch).mockResolvedValueOnce(new Response(JSON.stringify({ choices: [{ message: { content: '{"is_ok":true,"missing_classes":[]}' } }] })));
        const result = await invoke(); expect(result.events.find(e => e.type === "file_done").contractCheck).toMatchObject({ nodeId: "HomeManager", passed: 2, total: 2 });
        expect(JSON.parse(memory.raw).nodeChecks.HomeManager.passed).toBe(2);
    });
});
