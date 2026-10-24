import { describe, expect, it } from "vitest";
import { createInitialTree, emptyNodeContract, type TreeNode } from "../../functions/_lib/projectTree";
import { checkNodeContract, nodeGenerationContext, parameterCount } from "../../functions/_lib/projectTreeContract";

const tree = createInitialTree("Paper", "1.21.4"); tree.project.packageName = "com.tahai.home";
const base: TreeNode = { id: "HomeManager", moduleId: "home", kind: "ManagerGen", title: "家园", responsibility: "保存家园", depends: [], contract: emptyNodeContract(), tag: null, pairId: "", origin: "planner" };
tree.nodes.push(base);
const source = (body: string) => `package com.tahai.home.home;\npublic class HomeManager ${body}`;
describe("deterministic node contract checks", () => {
    it("requires actual declarations rather than the summary fallback", () => {
        expect(checkNodeContract(tree, base, "// HomeManager").passed).toBe(0);
        expect(checkNodeContract(tree, base, source("{}"))).toMatchObject({ passed: 2, total: 2 });
        expect(checkNodeContract(tree, base, "package wrong;\npublic class HomeManager {} ").items.find(i => i.key === "package")?.ok).toBe(false);
    });
    it("counts generic commas correctly for public methods and constructors", () => {
        const node = { ...base, contract: { ...emptyNodeContract(), methods: [{ name: "save", params: "Map<String, List<Integer>> values, UUID id", returns: "void", isStatic: false }], constructors: [{ params: "Map<String, Integer> values" }] } };
        expect(parameterCount(node.contract.methods[0].params)).toBe(2);
        const good = source("{\n public HomeManager(Map<String, Integer> values) {}\n public void save(Map<String, List<Integer>> values, UUID id) {}\n}");
        expect(checkNodeContract(tree, node, good).passed).toBe(4);
        expect(checkNodeContract(tree, node, source("{\n public void save() {}\n}")).passed).toBe(2);
    });
    it.each([
        ["ListenerGen", "implements Listener {\n @EventHandler\n public void join(PlayerJoinEvent event) {}\n}", "{}", { ...emptyNodeContract(), events: ["PlayerJoinEvent"] }],
        ["CommandGen", "implements CommandExecutor, TabCompleter {}", "implements CommandExecutor {}", emptyNodeContract()],
        ["TaskGen", "extends BukkitRunnable {}", "{}", emptyNodeContract()],
    ] as const)("checks %s", (kind, good, bad, contract) => {
        const node: TreeNode = { ...base, kind, contract: { ...contract, events: [...contract.events] } };
        const ok = checkNodeContract(tree, node, source(good)); expect(ok.passed).toBe(ok.total);
        const fail = checkNodeContract(tree, node, source(bad)); expect(fail.passed).toBeLessThan(fail.total);
    });
    it("requires Main registrations and imports FQCN context", () => {
        const listener: TreeNode = { ...base, id: "JoinListener", kind: "ListenerGen", contract: { ...emptyNodeContract(), events: ["PlayerJoinEvent"], commands: [{ name: "home", aliases: [], usage: "/home", permission: "", description: "回家" }] } };
        const t = structuredClone(tree); t.nodes.push(listener);
        const main = t.nodes.find(n => n.id === "Main")!; main.depends = ["JoinListener"];
        const good = checkNodeContract(t, main, 'package com.tahai.home;\npublic class Main extends JavaPlugin { void enable() { getCommand("home"); new JoinListener(); HomeManager m; } }');
        expect(good.passed).toBe(good.total);
        const bad = checkNodeContract(t, main, "package com.tahai.home;\npublic class Main {}"); expect(bad.passed).toBeLessThan(bad.total);
        expect(nodeGenerationContext(t, main)).toContain("import com.tahai.home.home.JoinListener;");
    });
    it("checks plugin commands within their section and config leaves, with no pom contract", () => {
        const t = structuredClone(tree); t.nodes[3].contract.commands.push({ name: "home", aliases: [], usage: "", permission: "", description: "" }); t.nodes[3].contract.configKeys.push("home.limit");
        const plugin = t.nodes[1];
        expect(checkNodeContract(t, plugin, "main: com.tahai.home.Main\ncommands:\n  home:\n    usage: /home\n").passed).toBe(2);
        expect(checkNodeContract(t, plugin, "main: wrong.Main\npermissions:\n  home:\n").passed).toBe(0);
        const config = { ...plugin, id: "config.yml" };
        expect(checkNodeContract(t, config, "home:\n  limit: 3").passed).toBe(1);
        expect(checkNodeContract(t, config, "other: 3").passed).toBe(0);
        expect(checkNodeContract(t, t.nodes[0], "").total).toBe(0);
    });
});
