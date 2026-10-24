import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { applyTreeToolCalls, createInitialTree, emptyNodeContract } from "../../functions/_lib/projectTree";
import type { ModelToolCall } from "../../functions/_lib/learning/tool";

const store = vi.hoisted(() => ({ raw: "", lease: vi.fn(), persist: vi.fn(), cost: vi.fn() }));
const llm = vi.hoisted(() => ({ byok: false, providerId: "deepseek", canAutoLearn: true, apiKey: "key", url: "https://model.test", modelFor: () => "deepseek-v4-pro" }));
vi.mock("../../functions/_lib/taskStore", async original => ({
    ...await original<Record<string, unknown>>(), getOwnedTask: vi.fn(async () => store.raw),
    acquireTaskOperationLease: store.lease, renewTaskOperationLease: vi.fn(async () => true),
    releaseTaskOperationLease: vi.fn(async () => true), putTaskWithOperationLease: store.persist,
    putTaskWithOperationLeaseAndCost: store.cost,
}));
vi.mock("../../functions/_lib/llm", async original => ({ ...await original<Record<string, unknown>>(), resolveTaskLLM: vi.fn(async () => llm) }));
vi.mock("../../functions/_lib/quota", async original => ({ ...await original<Record<string, unknown>>(), settleTaskCostQuota: vi.fn(async () => ({ total: 1, consumed: 0, outOfQuota: false })) }));
import { onRequestGet, onRequestPost } from "../../functions/api/generate/tree";
const call = (name: string, args: unknown): ModelToolCall => ({ id: `call_${name}`, type: "function", function: { name, arguments: JSON.stringify(args) } });
const calls = () => [call("set_project", { projectName: "HomePlus", summary: "家园", externalDeps: [] }), call("upsert_module", { id: "home", title: "家园", responsibility: "家园管理" }), ...["HomeData", "HomeStorage"].map(id => call("upsert_node", { id, moduleId: "home", kind: "ModelGen", title: id, responsibility: "家园数据", depends: [], contract: emptyNodeContract(), tag: "none", pairId: "" })), call("finish_tree", { summary: "完成" })];
const modelResponse = (toolCalls: ModelToolCall[]) => new Response(`data: ${JSON.stringify({ choices: [{ delta: { tool_calls: toolCalls.map((call, index) => ({ ...call, index })) } }], usage: { prompt_tokens: 10, completion_tokens: 10 } })}\n\ndata: [DONE]\n\n`, { headers: { "Content-Type": "text/event-stream" } });
const requestId = (index = 1) => `tree_${String(index).padStart(16, "0")}`;
async function invoke(body: Record<string, unknown>) {
    const waits: Promise<unknown>[] = [];
    const response = await onRequestPost({ request: new Request("https://app.test/api/generate/tree", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ taskId: "task", ...body }) }), env: { TASKS: {}, DB: {} }, data: { uid: "user" }, waitUntil: (promise: Promise<unknown>) => waits.push(promise) } as unknown as Parameters<typeof onRequestPost>[0]);
    const text = await response.text(); await Promise.all(waits);
    return { response, text, events: text.split("\n").filter(line => line.startsWith("data: {")).map(line => JSON.parse(line.slice(6))) };
}
beforeEach(() => {
    vi.clearAllMocks(); llm.byok = false;
    store.raw = JSON.stringify({ taskId: "task", uid: "user", userPrompt: "家园插件", coreType: "Paper", version: "1.21.4", clarifyDone: true, clarifyRounds: [], tree: null, treeSession: null, treeOperations: [], skills: [], logs: [], nodeChecks: {} });
    store.lease.mockResolvedValue("d1");
    const persist = async (_env: unknown, _id: string, raw: string) => { store.raw = raw; return true; };
    store.persist.mockImplementation(persist); store.cost.mockImplementation(persist);
    vi.stubGlobal("fetch", vi.fn(async () => modelResponse(calls())));
});
afterEach(() => vi.unstubAllGlobals());
describe("tree planning rounds", () => {
    it("requires clarified requirements", async () => {
        store.raw = JSON.stringify({ ...JSON.parse(store.raw), clarifyDone: false });
        const result = await invoke({ action: "build", treeRequestId: requestId() });
        expect(result.response.status).toBe(409); expect(JSON.parse(result.text).code).toBe("CLARIFY_REQUIRED"); expect(fetch).not.toHaveBeenCalled();
    });
    it("builds with ordered tool events, commits cost atomically and replays", async () => {
        const body = { action: "build", treeRequestId: requestId() };
        const result = await invoke(body);
        expect(result.events.find(e => e.type === "result")).toMatchObject({ status: "ready", round: 1 });
        expect(result.events.findIndex(e => e.type === "tool_call")).toBeLessThan(result.events.findIndex(e => e.type === "tree_ops"));
        expect(store.cost).toHaveBeenCalledOnce(); expect(JSON.parse(store.raw).tree.project.packageName).toBe("com.tahai.homeplus");
        await invoke(body); expect(fetch).toHaveBeenCalledOnce();
    });
    it("rejects reused request IDs with changed input", async () => {
        await invoke({ action: "build", treeRequestId: requestId() });
        const result = await invoke({ action: "refine", correction: "修改", treeRequestId: requestId() });
        expect(result.response.status).toBe(409); expect(JSON.parse(result.text).code).toBe("TREE_REQUEST_CONFLICT");
    });
    it("passes validation issues to the following round", async () => {
        vi.mocked(fetch).mockResolvedValueOnce(modelResponse([call("finish_tree", { summary: "完成" })]));
        expect((await invoke({ action: "build", treeRequestId: requestId() })).events.at(-1).status).toBe("continue");
        await invoke({ action: "continue", treeRequestId: requestId(2) });
        const init = vi.mocked(fetch).mock.calls[1][1]!;
        expect(JSON.parse(String(init.body)).messages[1].content).toContain("PROJECT_NOT_SET");
    });
    it("returns TREE_IN_PROGRESS when the lease is held", async () => {
        store.lease.mockResolvedValue(null);
        const result = await invoke({ action: "build", treeRequestId: requestId() });
        expect(result.response.status).toBe(409); expect(JSON.parse(result.text)).toMatchObject({ code: "TREE_IN_PROGRESS", activeRequestId: requestId() });
    });
    it("refines with correction and selected object titles", async () => {
        await invoke({ action: "build", treeRequestId: requestId() });
        const revision = JSON.parse(store.raw).tree.revision;
        await invoke({ action: "refine", correction: "合并家园数据", focusIds: ["HomeData", "missing"], treeRequestId: requestId(2) });
        expect(JSON.parse(String(vi.mocked(fetch).mock.calls[1][1]!.body)).messages[1].content).toContain("合并家园数据");
        expect(JSON.parse(store.raw).treeSession.focusIds).toEqual(["HomeData"]); expect(JSON.parse(store.raw).tree.revision).toBeGreaterThan(revision);
    });
    it("fails after two empty rounds with invalid trees", async () => {
        vi.mocked(fetch).mockImplementation(async () => modelResponse([]));
        await invoke({ action: "build", treeRequestId: requestId() });
        expect((await invoke({ action: "continue", treeRequestId: requestId(2) })).events.at(-1).status).toBe("failed");
    });
    it("confirms with revision checks and a single final Main bucket, idempotently", async () => {
        await invoke({ action: "build", treeRequestId: requestId() });
        const revision = JSON.parse(store.raw).tree.revision;
        expect((await invoke({ action: "confirm", revision: revision - 1 })).response.status).toBe(409);
        const confirmed = JSON.parse((await invoke({ action: "confirm", revision })).text);
        expect(confirmed.bucketPaths.at(-1)).toEqual(["src/main/java/com/tahai/homeplus/Main.java"]);
        expect(JSON.parse((await invoke({ action: "confirm", revision })).text)).toEqual(confirmed);
        const locked = await invoke({ action: "build", treeRequestId: requestId(3) });
        expect(JSON.parse(locked.text).code).toBe("TREE_LOCKED"); expect(fetch).toHaveBeenCalledOnce();
    });
    it("does not add model cost for BYOK", async () => {
        llm.byok = true; await invoke({ action: "build", treeRequestId: requestId() });
        expect(store.cost.mock.calls[0][5]).toBe(0);
    });
    it("serves restored tree views and node checks", async () => {
        const tree = applyTreeToolCalls(createInitialTree("Paper", "1.21.4"), calls()).tree;
        store.raw = JSON.stringify({ ...JSON.parse(store.raw), tree });
        const response = await onRequestGet({ request: new Request("https://app.test/api/generate/tree?taskId=task"), env: { TASKS: {} }, data: { uid: "user" } } as unknown as Parameters<typeof onRequestGet>[0]);
        expect((await response.json() as { tree: { nodes: { path: string }[] } }).tree.nodes[3].path).toContain("/home/HomeData.java");
    });
});
