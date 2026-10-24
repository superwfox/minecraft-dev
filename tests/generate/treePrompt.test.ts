import { expect, it } from "vitest";
import { treeBuilderPrompt } from "../../functions/_lib/prompts";
it("preserves minimal Paper structure rules and all refinement inputs", () => {
    const prompt = treeBuilderPrompt({ userPrompt: "家园插件", coreType: "Paper", version: "1.21.4", clarifyRounds: [{ todos: [{ id: "save", question: "怎么保存", options: [], allowCustom: true, multiSelect: false }], answers: { save: "YAML" } }], treeSnapshot: "home/HomeManager", issues: [{ code: "EMPTY_MODULE", message: "空模块" }], lastResults: [{ ok: false, error: "非法节点" }], mode: "refine", correction: "删除 delhome", focusIds: ["HomeCommand（家园命令）"], round: 2, maxRounds: 8 });
    for (const text of ["极简原则", "Paper / Bukkit 配套结构知识", "CommandExecutor", "TabCompleter", "InventoryClickEvent", "BukkitRunnable", "finish_tree", "common", "learn_public_api"]) expect(prompt.system).toContain(text);
    for (const text of ["家园插件", "怎么保存", "YAML", "home/HomeManager", "EMPTY_MODULE", "空模块", "非法节点", "删除 delhome", "HomeCommand（家园命令）", "第 2/8 轮"]) expect(prompt.user).toContain(text);
});
