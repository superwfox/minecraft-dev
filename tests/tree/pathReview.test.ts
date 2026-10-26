import { describe, expect, it } from "vitest";
import { applyTreeToolCalls, createInitialTree, nodePath } from "../../functions/_lib/projectTree";
import { emptyNodeContract } from "../../functions/_lib/projectTree";
import { activePathRepair, parsePathReview, pathReviewPrompt, publicPathChecks, queuePathRepair, queuePathReview, sourceFingerprint, type PathReviewState } from "../../functions/_lib/projectPathReview";
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
    it("provides retained text and binary resource evidence without placing binary payloads in prompts", async () => {
        const state = await fixture();
        state.resources = [{ path: "src/main/resources/config.yml", content: "enabled: true" }, { path: "src/main/resources/icon.png", encoding: "base64", content: "cHJpdmF0ZWJpbmFyeQ==" }];
        const prompt = pathReviewPrompt(state, state.tree.paths[0], "保留配置与图片");
        expect(prompt.user).toContain("enabled: true");
        expect(prompt.user).toContain("src/main/resources/icon.png");
        expect(prompt.user).not.toContain("cHJpdmF0ZWJpbmFyeQ==");
        const before = await sourceFingerprint(state);
        state.resources[1].content = "Y2hhbmdlZA==";
        expect(await sourceFingerprint(state)).not.toBe(before);
    });
    it("fingerprints the same effective files as compilation when a generated file replaces a resource", async () => {
        const state = await fixture();
        const config = { path: "src/main/resources/config.yml", content: "enabled: true" };
        state.generatedFiles.push(config); state.resources = [{ ...config, content: "stale: true" }];
        const before = await sourceFingerprint(state);
        state.resources[0].content = "obsolete: true";
        expect(await sourceFingerprint(state)).toBe(before);
        expect(pathReviewPrompt(state, state.tree.paths[0], "修改配置").user).not.toContain("obsolete: true");
    });
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
    it("reworks the files of failed steps once and reuses the active repair bucket", async () => {
        const state = await fixture();
        const failed = { passed: false, summary: "保存后未落盘", steps: [{ id: "save-home-data", passed: false, detail: "HomeData 缺少保存逻辑" }] };
        state.pathReviews["save-home"] = parsePathReview(JSON.stringify(failed), state, state.tree.paths[0]);
        const repairState = state as typeof state & { pathRepair?: { bucketIndex: number; files: string[] } | null; pathRepairAttempts?: number };
        const index = queuePathRepair(repairState);
        expect(index).toBe(0);
        const homeData = "src/main/java/com/tahai/homeplus/home/HomeData.java";
        expect(repairState.buckets[0].map(file => file.nodeId)).toEqual(["HomeData"]);
        expect(repairState.generationCheckpoints[homeData]).toMatchObject({ stage: "rework", lastReason: expect.stringContaining("HomeData 缺少保存逻辑") });
        expect(queuePathRepair(repairState)).toBe(0);
        expect(activePathRepair(repairState)).toBe(0);
        repairState.fileStatuses[homeData] = "done";
        expect(activePathRepair(repairState)).toBeUndefined();
        expect(queuePathRepair(repairState)).toBeUndefined();
        expect(repairState.pathRepairAttempts).toBe(1);
    });
});
