import { describe, expect, it } from "vitest";
import { applyTreeToolCalls, createInitialTree, nodePath } from "../../functions/_lib/projectTree";
import { emptyNodeContract } from "../../functions/_lib/projectTree";
import { parsePathReview, publicPathChecks, queuePathReview, sourceFingerprint, type PathReviewState } from "../../functions/_lib/projectPathReview";
import type { PlanFileItem } from "../../functions/_lib/prompts";

async function fixture() {
    const tool = (name: string, args: unknown) => ({ id: name, type: "function" as const, function: { name, arguments: JSON.stringify(args) } });
    const tree = applyTreeToolCalls(createInitialTree("Paper", "1.21.4"), [
        tool("set_project", { projectName: "HomePlus", summary: "家园数据", externalDeps: [] }),
        tool("upsert_module", { id: "home", title: "家园", responsibility: "家园数据" }),
        tool("upsert_node", { id: "HomeData", moduleId: "home", kind: "ModelGen", title: "数据", responsibility: "保存家园", depends: [], contract: emptyNodeContract(), tag: "none", pairId: "" }),
        tool("upsert_path", { id: "save-home", title: "保存家园", nodes: [{ id: "save-home-data", title: "保存数据", kind: "动作", summary: "保存玩家家园数据", fileIds: ["HomeData"] }] }),
    ]).tree;
    tree.status = "locked"; tree.lockedRevision = tree.revision;
    const state: PathReviewState & { buckets: PlanFileItem[][]; fileStatuses: Record<string, string>; generationCheckpoints: Record<string, unknown>; currentBucket: number } = {
        tree, generatedFiles: tree.nodes.map(node => ({ path: nodePath(tree, node), content: node.id === "Main" ? "package com.tahai.homeplus; public class Main extends JavaPlugin {}" : node.id === "plugin.yml" ? "main: com.tahai.homeplus.Main\n" : node.id === "HomeData" ? "package com.tahai.homeplus.home; public class HomeData {}" : "<project/>" })),
        pathReviews: {}, buckets: [], fileStatuses: {}, generationCheckpoints: {}, currentBucket: 0,
    };
    state.sourceFingerprint = await sourceFingerprint(state);
    return state;
}
const report = { passed: true, summary: "实现与路径一致", steps: [{ id: "save-home-data", passed: true, detail: "HomeData 提供该路径的数据表示；Main 已实现生命周期入口" }] };

describe("path review evidence", () => {
    it("requires static review and matching successful compilation", async () => {
        const state = await fixture();
        state.pathReviews["save-home"] = parsePathReview(JSON.stringify(report), state, state.tree.paths[0]);
        expect(publicPathChecks(state)["save-home"].status).toBe("pending");
        state.compileCheck = { fingerprint: state.sourceFingerprint, headSha: "commit", status: "passed" };
        expect(publicPathChecks(state)["save-home"].status).toBe("passed");
        state.generatedFiles[3].content += "\n// changed";
        state.sourceFingerprint = await sourceFingerprint(state);
        expect(publicPathChecks(state)["save-home"]).toMatchObject({ status: "pending", staticStatus: "pending", compileStatus: "pending" });
    });
    it("never accepts missing steps or a contract violation as a passed path", async () => {
        const state = await fixture();
        expect(() => parsePathReview(JSON.stringify({ ...report, steps: [] }), state, state.tree.paths[0])).toThrow();
        state.generatedFiles[3].content = "public class WrongName {}";
        expect(parsePathReview(JSON.stringify(report), state, state.tree.paths[0]).passed).toBe(false);
    });
    it("reuses an active review bucket instead of enqueueing duplicate model work", async () => {
        const state = await fixture();
        expect(queuePathReview(state)).toBe(0);
        expect(queuePathReview(state)).toBe(0);
        expect(state.buckets).toHaveLength(1);
        state.pathReviews["save-home"] = parsePathReview(JSON.stringify(report), state, state.tree.paths[0]);
        expect(queuePathReview(state)).toBeUndefined();
    });
});
