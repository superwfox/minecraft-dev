import { describe, expect, it, vi } from "vitest";
import JSZip from "jszip";
import { inspectJar } from "../../shared/jarArchive";
import { missingBuildLogs, projectFiles, redact } from "../../shared/projectArchive";
import { checkpointSeal, validCheckpointSeal, checkpointView, incrementalPlan, restoredProject } from "../../functions/_lib/projectArchive";
import { createInitialTree, emptyNodeContract, nodePath, validateProjectTree } from "../../functions/_lib/projectTree";
import { seedJarProject } from "../../functions/_lib/jarProject";
import { journalRecorder, observeResponse } from "../../functions/_lib/projectJournal";
import { extractFileSummary } from "../../functions/_lib/fileSummary";
import { checkNodeContract, nodeGenerationContext } from "../../functions/_lib/projectTreeContract";
import { dispatchGen } from "../../functions/_lib/prompts";

function fixture() {
    const tree = createInitialTree("PAPER", "1.21.8");
    tree.project = { ...tree.project, projectName: "Example", packageName: "test.plugin" };
    tree.modules.push({ id: "business", title: "业务", responsibility: "业务实现", kind: "business" });
    tree.nodes.push({ id: "Reward", moduleId: "business", kind: "UtilGen", title: "奖励", responsibility: "发放奖励", depends: [], contract: emptyNodeContract(), tag: null, pairId: "", origin: "planner" });
    tree.paths = [{ id: "reward-path", title: "发奖励", nodes: [{ id: "give-reward", title: "发放", kind: "动作", summary: "发放奖励", fileIds: ["Reward"] }] }];
    tree.status = "locked"; tree.lockedRevision = tree.revision;
    return tree;
}
describe("project lifecycle boundaries", () => {
    it("does not treat a journal with silently missing build logs as complete", () => {
        const events: any[] = [{ kind: "build.configuration", data: { buildHeadSha: "commit" } }];
        expect(missingBuildLogs(events)).toEqual(["build-logs:commit"]);
        events.push({ kind: "build.logs.complete", data: { headSha: "commit", jobIds: [1, 2] } }, { kind: "build.logs", data: { headSha: "commit", jobId: 1, content: "verify log" } });
        expect(missingBuildLogs(events)).toEqual(["build-logs:commit"]);
        events.push({ kind: "build.logs", data: { headSha: "commit", jobId: 2, content: "package log" } });
        expect(missingBuildLogs(events)).toEqual([]);
    });
    it("requires an explicit nonexecution reason for jobs without logs", () => {
        const skipped = { kind: "build.logs", data: { headSha: "commit", jobId: 2, content: "", conclusion: "skipped", noLogReason: "" } };
        const events: any[] = [
            { kind: "build.configuration", data: { buildHeadSha: "commit" } },
            { kind: "build.logs.complete", data: { headSha: "commit", jobIds: [1, 2] } },
            { kind: "build.logs", data: { headSha: "commit", jobId: 1, content: "compiler failure" } }, skipped,
        ];
        expect(missingBuildLogs(events)).toEqual(["build-logs:commit"]);
        skipped.data.noLogReason = "job_not_executed";
        expect(missingBuildLogs(events)).toEqual([]);
        skipped.data.conclusion = "failure";
        expect(missingBuildLogs(events)).toEqual(["build-logs:commit"]);
    });
    it("keeps taskless chat working without treating it as a missing project journal", async () => {
        const remote = vi.spyOn(globalThis, "fetch").mockResolvedValue(new Response("chat-response"));
        try {
            const recorder = journalRecorder({ request: new Request("https://app.test/api/chat"), env: { DB: {} as D1Database }, data: { uid: "alice" } });
            expect(await (await recorder.fetch("https://model.test", { body: "{}", method: "POST" })).text()).toBe("chat-response");
            expect(remote).toHaveBeenCalledOnce();
        } finally { remote.mockRestore(); }
    });
    it("keeps explicit zero-argument constructors when checking retained source contracts", () => {
        expect(extractFileSummary("GreetingService.java", "public class GreetingService {\n public GreetingService() {}\n}").constructors).toEqual([{ params: "" }]);
        expect(extractFileSummary("GreetingService.java", "public class GreetingService {\n private GreetingService() {}\n}").constructors).toEqual([]);
    });
    it("binds recovery receipt to both owner and exact checkpoint", async () => {
        const value = { taskId: "old", files: ["source"] }, seal = await checkpointSeal("test-secret", "alice", value);
        expect(await validCheckpointSeal("test-secret", "alice", value, seal)).toBe(true);
        expect(await validCheckpointSeal("test-secret", "bob", value, seal)).toBe(false);
        expect(await validCheckpointSeal("test-secret", "alice", { ...value, taskId: "changed" }, seal)).toBe(false);
    });
    it("never archives credentials, leases, billing or arbitrary auth fields", () => {
        const output = checkpointView({ taskId: "x", totalCost: 50, consumedQuota: 3, leaseToken: "secret", apiKey: "secret", userPrompt: "hello" });
        expect(output).toEqual({ taskId: "x", userPrompt: "hello" });
        expect(redact({ token: "Bearer abcdefgh", messages: [{ content: "sk-abcdefghijklmno" }], authorization: "secret", reasoning_content: "private thought" })).toEqual({ token: "Bearer [REDACTED]", messages: [{ content: "[REDACTED]" }] });
    });
    it("rejects source traversal, executable workflow paths and duplicate names", () => {
        for (const path of ["../evil", "src/../../evil", ".github/workflows/evil.yml", "C:\\evil", "/tmp/evil"]) expect(() => projectFiles([{ path, content: "x" }])).toThrow();
        expect(() => projectFiles([{ path: "a.java", content: "1" }, { path: "A.java", content: "2" }])).toThrow();
    });
    it("preserves matching imported implementation and resources without treating baseline compile as path proof", () => {
        const seed = seedJarProject({ mainClass: "org.example.CustomEntry", projectName: "Example", files: [{ path: "src/main/java/org/example/CustomEntry.java", content: "package org.example; public class CustomEntry {}" }, { path: "src/main/resources/icon.png", content: "cG5n", encoding: "base64" }], report: { baseline: { status: "passed" } } }, "PAPER", "1.21.8");
        expect(nodePath(seed.tree, seed.tree.nodes.find(n => n.id === "Main")!)).toBe("src/main/java/org/example/CustomEntry.java");
        expect(seed.resources[0].encoding).toBe("base64");
        expect(seed).not.toHaveProperty("compileCheck");
    });
    it("does not count retained imported files against the new-generation limit or rename their Java classes", () => {
        const files = Array.from({ length: 45 }, (_, index) => ({ path: `src/main/java/test/plugin/Type${index}.java`, content: `package test.plugin; public class Type${index} {}` }));
        files.push({ path: "src/main/java/test/plugin/a.java", content: "package test.plugin; public class a {}" });
        const seed = seedJarProject({ mainClass: "test.plugin.Entry", projectName: "Example", files }, "PAPER", "1.21.4");
        expect(validateProjectTree(seed.tree).some(issue => issue.code === "LIMIT_EXCEEDED")).toBe(false);
        expect(seed.tree.nodes.find(node => node.sourceClass === "a")?.id).toBe("Importeda");
        expect(seed.generatedFiles.some(file => file.path.endsWith("/a.java"))).toBe(true);
    });
    it("keeps the imported main class in descriptor contracts and generation prompts", () => {
        const seed = seedJarProject({ mainClass: "org.example.CustomEntry", projectName: "Example", files: [] }, "PAPER", "1.21.4");
        const descriptor = seed.tree.nodes.find(node => node.id === "plugin.yml")!;
        const valid = checkNodeContract(seed.tree, descriptor, "name: Example\nmain: org.example.CustomEntry\n");
        expect(valid.passed).toBe(valid.total);
        expect(checkNodeContract(seed.tree, descriptor, "main: org.example.Main\n").passed).toBe(0);
        expect(nodeGenerationContext(seed.tree, descriptor)).toContain("main: org.example.CustomEntry");
        const prompt = dispatchGen({ path: "src/main/resources/plugin.yml", generatorType: "ConfigGen" } as any,
            { projectName: "Example", packageName: "org.example", mainClass: "org.example.CustomEntry", coreType: "PAPER", version: "1.21.4", javaVersion: "21" }, [], {} as any);
        expect(prompt.gen.system + prompt.gen.user).toContain("main: org.example.CustomEntry");
        expect(prompt.gen.system + prompt.gen.user).not.toContain("main: org.example.Main");
    });
    it("reuses unchanged files but invalidates implementation when a user requests behavioral change", () => {
        const tree = fixture(), path = nodePath(tree, tree.nodes.find(n => n.id === "Reward")!);
        const original = { tree: structuredClone(tree), revisionBase: { tree: structuredClone(tree) }, generatedFiles: [{ path, content: "package test.plugin.business; public class Reward {}" }] };
        const unchanged = incrementalPlan(original, tree);
        expect(unchanged.fileStatuses[path]).toBe("done");
        expect(unchanged.generatedFiles[0].content).toContain("class Reward");
        const changed = incrementalPlan({ ...original, changeRequest: "奖励两颗钻石" }, tree);
        expect(changed.fileStatuses[path]).toBe("pending");
        expect(changed.generatedFiles).toHaveLength(1);
        expect(changed.pathReviews).toEqual({}); expect(changed.compileCheck).toBeNull();
    });
    it("moves an imported text resource into editable files when the confirmed tree binds it", () => {
        const tree = fixture();
        tree.nodes.push({ id: "config.yml", moduleId: "_resources", kind: "ConfigGen", title: "配置", responsibility: "保留配置", depends: [], contract: emptyNodeContract(), tag: null, pairId: "", origin: "planner" });
        const result = incrementalPlan({ resources: [{ path: "src/main/resources/config.yml", content: "enabled: true" }, { path: "src/main/resources/icon.png", content: "cG5n", encoding: "base64" }], generatedFiles: [] }, tree);
        expect(result.generatedFiles.find(file => file.path.endsWith("config.yml"))?.content).toBe("enabled: true");
        expect(result.resources.map(file => file.path)).toEqual(["src/main/resources/icon.png"]);
    });
    it("drops local verified flags and remote execution authorizations on rematerialization", () => {
        const state = restoredProject({ userPrompt: "发奖励", coreType: "PAPER", version: "1.21.8", tree: fixture(), totalCost: 100, runId: 999, compileCheck: { status: "passed" }, generationCheckpoints: { forged: true }, generatedFiles: [] }, "new", "alice");
        expect(state).toMatchObject({ taskId: "new", uid: "alice", compileCheck: null, generationCheckpoints: {}, pathReviews: {} });
        expect(state.runId).toBeUndefined(); expect(state.totalCost).toBeUndefined();
    });
    it("retains the pending revision identity and requirement without trusting old execution results", () => {
        const state = restoredProject({ userPrompt: "追加需求", coreType: "PAPER", version: "1.21.4", tree: fixture(), generatedFiles: [], revisionRequestId: "revision-1234567890", changeRequest: "增加奖励", revisionBase: { tree: fixture() }, treeContext: "保留现有实现" }, "new", "alice");
        expect(state.revisionRequestId).toBe("revision-1234567890"); expect(state.changeRequest).toBe("增加奖励");
        expect(state.revisionBase.tree.nodes).toHaveLength(4); expect(state.treeContext).toBe("保留现有实现");
        expect(state.compileCheck).toBeNull();
    });
    it("inspects JAR directory before decompression and rejects unsafe paths", async () => {
        const valid = new JSZip(); valid.file("plugin.yml", "main: test.Plugin"); valid.file("test/Plugin.class", "class");
        expect(inspectJar(await valid.generateAsync({ type: "uint8array" })).entries.some(e => e.path === "plugin.yml")).toBe(true);
        const unsafe = new JSZip(); unsafe.file("plugin.yml", "main: test.Plugin"); unsafe.file("../escape", "bad");
        const bytes = await unsafe.generateAsync({ type: "uint8array" }); expect(() => inspectJar(bytes)).toThrow();
    });
    it("forwards model bytes unchanged while keeping private reasoning out of journal", async () => {
        const raw = `data: ${JSON.stringify({ choices: [{ delta: { reasoning_content: "private", content: "public" } }] })}\n\ndata: [DONE]\n\n`;
        const parts: any[] = [];
        const wrapped = observeResponse(new Response(raw, { headers: { "Content-Type": "text/event-stream" } }), async (data, incomplete) => { parts.push({ data, incomplete }); }, () => {});
        expect(await wrapped.text()).toBe(raw);
        expect(JSON.stringify(parts)).toContain("public"); expect(JSON.stringify(parts)).not.toContain("private");
    });
    it("does not claim a complete binary tool archive after omitting its payload", async () => {
        const flags: boolean[] = [], bytes = new Uint8Array([0, 255, 17]);
        const wrapped = observeResponse(new Response(bytes, { headers: { "Content-Type": "application/octet-stream" } }), async (_data, incomplete) => { flags.push(incomplete); }, () => {});
        expect(new Uint8Array(await wrapped.arrayBuffer())).toEqual(bytes); expect(flags).toContain(true);
    });
    it("does not mislabel cancellation while the final observed batch is being persisted", async () => {
        const raw = `data: ${JSON.stringify({ choices: [{ delta: { content: "x".repeat(170000) }, finish_reason: "stop" }], usage: { completion_tokens: 1 } })}\n\ndata: [DONE]\n\n`;
        const flags: boolean[] = []; let release: () => void;
        const pending = new Promise<void>(resolve => release = resolve);
        const wrapped = observeResponse(new Response(raw, { headers: { "Content-Type": "text/event-stream" } }), async (_data, incomplete) => { flags.push(incomplete); await pending; }, () => {});
        const reader = wrapped.body!.getReader(); await reader.read();
        const cancelled = reader.cancel(); release!(); await cancelled;
        expect(flags).not.toContain(true);
    });
    it("does not report a second error when EOF races with cancellation after DONE", async () => {
        const flags: boolean[] = []; let release!: () => void;
        const gate = new Promise<void>(resolve => release = resolve);
        const wrapped = observeResponse(new Response('data: {"choices":[{"delta":{"content":"ok"}}]}\n\ndata: [DONE]\n\n', { headers: { "Content-Type": "text/event-stream" } }), async (_data, incomplete) => { flags.push(incomplete); await gate; }, () => {});
        const reader = wrapped.body!.getReader(); await reader.read();
        await new Promise(resolve => setTimeout(resolve, 0));
        const cancelled = reader.cancel(); release(); await cancelled;
        await new Promise(resolve => setTimeout(resolve, 0));
        expect(flags).toEqual([false]);
    });
});
