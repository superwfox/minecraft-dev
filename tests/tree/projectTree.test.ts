import { describe, expect, it } from "vitest";
import { appendReviewNode, applyTreeToolCalls, createInitialTree, deriveGenerationPlan, emptyNodeContract, javaVersionFor, MAX_TREE_TOOL_CALLS, nodePath, treeToolDefinitions, validateProjectTree, type ProjectTree, type TreeNode } from "../../functions/_lib/projectTree";
import type { ModelToolCall } from "../../functions/_lib/learning/tool";

const call = (name: string, args: unknown): ModelToolCall => ({ id: name, type: "function", function: { name, arguments: JSON.stringify(args) } });
const node = (id: string, extra: Partial<TreeNode> = {}) => ({ id, moduleId: "home", kind: "ModelGen", title: id, responsibility: "家园数据", depends: [], contract: emptyNodeContract(), tag: "none", pairId: "", ...extra });
function fixture(): ProjectTree {
    return applyTreeToolCalls(createInitialTree("Paper", "1.21.4"), [
        call("set_project", { projectName: "HomePlus", summary: "家园", externalDeps: [] }),
        call("upsert_module", { id: "home", title: "家园", responsibility: "管理家园" }),
        call("upsert_node", node("HomeData")),
        call("upsert_path", { id: "home-data", title: "家园数据", nodes: [{ id: "home-data-save", title: "保存家园", kind: "动作", summary: "保存玩家家园数据", fileIds: ["HomeData"] }] }),
    ]).tree;
}
describe("project tree tools and identity", () => {
    it("creates protected system nodes and requires a project and business file", () => {
        const tree = createInitialTree("Paper", "1.21.4");
        expect(tree.nodes.map(n => n.id)).toEqual(["pom.xml", "plugin.yml", "Main"]);
        expect(validateProjectTree(tree).map(i => i.code)).toEqual(["PROJECT_NOT_SET", "NO_BUSINESS_NODE", "NO_BEHAVIOR_PATH"]);
        expect(javaVersionFor("1.21.4")).toBe("21"); expect(javaVersionFor("26.1")).toBe("25"); expect(javaVersionFor("1.12.2")).toBe("8");
        expect(javaVersionFor("1.19.4")).toBe("17"); expect(javaVersionFor("1.16.5")).toBe("11");
    });
    it("maps stable IDs to subpackages and exposes the behavior path tools", () => {
        const tree = fixture();
        expect(tree.project.packageName).toBe("com.tahai.homeplus");
        expect(nodePath(tree, tree.nodes.find(n => n.id === "HomeData")!)).toBe("src/main/java/com/tahai/homeplus/home/HomeData.java");
        expect(nodePath(tree, tree.nodes.find(n => n.id === "Main")!)).toBe("src/main/java/com/tahai/homeplus/Main.java");
        expect(treeToolDefinitions().map(t => t.function.name)).toEqual(["set_project", "upsert_module", "upsert_node", "upsert_path", "remove_path", "remove_items", "merge_nodes", "finish_tree"]);
    });
    it("rejects invalid identities independently without mutating input", () => {
        const tree = fixture(), before = structuredClone(tree);
        const result = applyTreeToolCalls(tree, [call("upsert_node", node("lowercase")), call("upsert_module", { id: "class", title: "错误", responsibility: "错误" }), call("upsert_node", node("Main")), call("upsert_node", node("HOMEDATA")), call("upsert_node", node("plugin.yml", { moduleId: "_resources", kind: "ConfigGen" })), call("upsert_node", node("HomeManager"))]);
        expect(result.results.map(r => r.ok)).toEqual([false, false, false, false, false, true]);
        expect(tree).toEqual(before);
        expect(result.tree.revision).toBe(tree.revision + 1);
    });
    it("accepts qualified event names and case-sensitive configuration paths", () => {
        const result = applyTreeToolCalls(fixture(), [call("upsert_node", node("ChatListener", { kind: "ListenerGen", contract: { ...emptyNodeContract(), events: ["io.papermc.paper.event.player.AsyncChatEvent", "AsyncChatEvent"], configKeys: ["rewardAmount", "messages.rewardText"] } }))]);
        expect(result.results[0]).toMatchObject({ ok: true, changed: true });
        expect(result.tree.nodes.find(node => node.id === "ChatListener")?.contract).toMatchObject({ events: ["AsyncChatEvent"], configKeys: ["rewardAmount", "messages.rewardText"] });
        const schema = treeToolDefinitions().find(tool => tool.function.name === "upsert_node")!.function.parameters as any;
        expect(new RegExp(schema.properties.contract.properties.events.items.pattern).test("io.papermc.paper.event.player.AsyncChatEvent")).toBe(true);
        expect(new RegExp(schema.properties.contract.properties.configKeys.items.pattern).test("messages.rewardText")).toBe(true);
    });
    it.each([
        ["contract.events", { events: ["onChat(AsyncChatEvent event)"] }],
        ["contract.configKeys", { configKeys: ["reward..amount"] }],
        ["contract.commands.aliases", { commands: [{ name: "reward", aliases: ["/reward"], permission: "", usage: "", description: "" }] }],
    ])("reports the offending %s field without mutating the tree", (field, contract) => {
        const tree = fixture();
        const result = applyTreeToolCalls(tree, [call("upsert_node", node("ChatListener", { contract: { ...emptyNodeContract(), ...contract } }))]);
        expect(result.results[0]).toMatchObject({ ok: false, changed: false, errorCode: "TREE_TOOL_ARGUMENT_INVALID", field });
        expect(result.results[0].error).toContain(field);
        expect(result.tree).toEqual(tree);
    });
    it("does not count identical module writes as a structure change", () => {
        const tree = fixture();
        const result = applyTreeToolCalls(tree, [call("upsert_module", tree.modules.find(module => module.id === "home"))]);
        expect(result.results[0]).toMatchObject({ ok: true, changed: false });
        expect(result.tree.revision).toBe(tree.revision);
        expect(result.tree).toEqual(tree);
    });
    it("limits each batch and rejects every locked edit", () => {
        const calls = Array.from({ length: 62 }, () => call("finish_tree", { summary: "完成" }));
        const result = applyTreeToolCalls(fixture(), calls);
        expect(result.results.filter(r => r.ok)).toHaveLength(MAX_TREE_TOOL_CALLS);
        expect(result.results.at(-1)?.error).toBe("超出单轮工具调用上限");
        result.tree.status = "locked";
        expect(applyTreeToolCalls(result.tree, calls.slice(0, 1)).results[0].ok).toBe(false);
    });
    it("cascades removal and cleans dependencies, protecting system nodes", () => {
        const tree = fixture(); tree.nodes[2].depends = ["HomeData"];
        const result = applyTreeToolCalls(tree, [call("remove_items", { moduleIds: ["home"], nodeIds: [], reason: "删除家园" }), call("remove_items", { moduleIds: [], nodeIds: ["Main"], reason: "不允许" })]);
        expect(result.tree.nodes).toHaveLength(3); expect(result.tree.nodes[2].depends).toEqual([]); expect(result.results[1].ok).toBe(false);
    });
    it("merges atomically and rewrites dependencies and GUI pairs", () => {
        const tree = applyTreeToolCalls(fixture(), [call("upsert_node", node("HomeInfo")), call("upsert_node", node("HomeView", { depends: ["HomeData", "HomeInfo"], tag: "gui", pairId: "HomeData" }))]).tree;
        const result = applyTreeToolCalls(tree, [call("merge_nodes", { sourceIds: ["HomeData", "HomeInfo"], target: node("HomeState"), reason: "合并" })]);
        const view = result.tree.nodes.find(n => n.id === "HomeView")!;
        expect(view.depends).toEqual(["HomeState"]); expect(view.pairId).toBe("HomeState");
        const failure = applyTreeToolCalls(tree, [call("merge_nodes", { sourceIds: ["HomeData", "HomeInfo"], target: node("bad"), reason: "非法" })]);
        expect(failure.tree).toEqual(tree);
    });
});
describe("tree validation and derivation", () => {
    const issueCases: [string, (tree: ProjectTree) => void][] = [
        ["PROJECT_NOT_SET", t => { t.project.projectName = ""; }], ["NO_BUSINESS_NODE", t => { t.nodes = t.nodes.filter(n => n.origin === "system"); }],
        ["EMPTY_MODULE", t => { t.nodes = t.nodes.filter(n => n.id !== "HomeData"); }],
        ["DANGLING_DEPEND", t => { t.nodes[3].depends = ["Missing"]; }], ["SELF_DEPEND", t => { t.nodes[3].depends = ["HomeData"]; }],
        ["DEPEND_CYCLE", t => { t.nodes[3].depends = ["Main"]; t.nodes[2].depends = ["HomeData"]; }],
        ["GUI_PAIR_INVALID", t => { t.nodes[3].tag = "gui"; }], ["COMMAND_CONTRACT_MISSING", t => { t.nodes[3].kind = "CommandGen"; }],
        ["EVENT_CONTRACT_MISSING", t => { t.nodes[3].kind = "ListenerGen"; }], ["SCHEDULE_MISSING", t => { t.nodes[3].kind = "TaskGen"; }],
        ["DUPLICATE_COMMAND", t => { t.nodes[3].contract.commands = [{ name: "home", aliases: ["home"], permission: "", usage: "", description: "" }]; }],
        ["CONFIG_FILE_REQUIRED", t => { t.nodes[3].contract.configKeys = ["home.limit"]; }],
        ["LIMIT_EXCEEDED", t => { t.modules.push(...Array.from({ length: 10 }, (_, i) => ({ id: `mod${i}`, title: "模块", responsibility: "职责", kind: "business" as const }))); }],
        ["KIND_MODULE_MISMATCH", t => { t.nodes[3].moduleId = "_root"; }],
    ];
    it.each(issueCases)("reports %s", (code, change) => { const tree = fixture(); change(tree); expect(validateProjectTree(tree).map(i => i.code)).toContain(code); });
    it("sorts by dependencies, keeps Main alone last, and derives contracts", () => {
        const tree = fixture();
        tree.nodes.push({ ...tree.nodes[3], id: "HomeCommand", kind: "CommandGen", depends: ["HomeData"], contract: { ...emptyNodeContract(), commands: [{ name: "home", aliases: [], permission: "", usage: "/home", description: "回家" }] } });
        tree.nodes.push({ ...tree.nodes[3], id: "JoinListener", kind: "ListenerGen", contract: { ...emptyNodeContract(), events: ["PlayerJoinEvent"] } });
        tree.nodes.push({ ...tree.nodes[3], id: "SaveTask", kind: "TaskGen", contract: { ...emptyNodeContract(), schedule: { mode: "timer", periodTicks: 1200, delayTicks: 0 } } });
        const { plan, buckets, mainBlueprint } = deriveGenerationPlan(tree);
        expect(buckets.at(-1)?.map(f => f.nodeId)).toEqual(["Main"]);
        expect(plan.findIndex(f => f.nodeId === "HomeData")).toBeLessThan(plan.findIndex(f => f.nodeId === "HomeCommand"));
        expect(mainBlueprint.commands[0].name).toBe("home"); expect(mainBlueprint.events[0].event).toBe("PlayerJoinEvent"); expect(mainBlueprint.tasks[0].periodTicks).toBe(1200);
        expect(mainBlueprint.fqcn?.HomeCommand).toBe("com.tahai.homeplus.home.HomeCommand");
    });
    it("keeps a listener's plugin reference without inventing a Main registration cycle", () => {
        const tree = fixture();
        tree.nodes.push({ ...tree.nodes[3], id: "ChatRewardListener", kind: "ListenerGen", depends: ["Main"], contract: { ...emptyNodeContract(), constructors: [{ params: "JavaPlugin plugin" }], events: ["AsyncChatEvent"] } });
        const before = structuredClone(tree);
        expect(validateProjectTree(tree)).toEqual([]);
        const { plan, buckets, mainBlueprint } = deriveGenerationPlan(tree);
        expect(tree).toEqual(before);
        expect(buckets.at(-1)?.map(file => file.nodeId)).toEqual(["Main"]);
        expect(plan.filter(file => file.nodeId === "Main")).toHaveLength(1);
        expect(plan.find(file => file.nodeId === "ChatRewardListener")?.depends).toEqual(["Main"]);
        expect(mainBlueprint.events).toContainEqual({ event: "AsyncChatEvent", listenerClass: "ChatRewardListener" });
        expect(mainBlueprint.fqcn).not.toHaveProperty("Main");
    });
    it("appends review nodes in the referencing module or common, with stable duplicates and a cap", () => {
        const tree = fixture(); tree.status = "locked";
        const appended = appendReviewNode(tree, { className: "HomeStorage", referencedByNodeId: "HomeData" });
        expect(appended?.node.moduleId).toBe("home"); expect(appended?.node.origin).toBe("review");
        expect(appendReviewNode(tree, { className: "HOMESTORAGE", referencedByNodeId: "HomeData" })?.created).toBe(false);
        expect(appendReviewNode(tree, { className: "SharedHelper", referencedByNodeId: "Main" })?.node.moduleId).toBe("common");
        for (let i = 0; i < 8; i++) appendReviewNode(tree, { className: `Helper${i}`, referencedByNodeId: "Main" });
        expect(appendReviewNode(tree, { className: "TooMany", referencedByNodeId: "Main" })).toBeNull();
    });
});
