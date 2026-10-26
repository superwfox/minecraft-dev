import { describe, expect, it } from "vitest";
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { spawnSync } from "node:child_process";
import { createInitialTree, nodePath } from "../../functions/_lib/projectTree";

describe("diagnostic replay from an existing checkpoint", () => {
    it("checks the final source contract even without a new tree tool event", () => {
        const directory = mkdtempSync(join(tmpdir(), "tahai-replay-"));
        try {
            const tree = createInitialTree("PAPER", "1.21.4"); tree.project.packageName = "test.plugin";
            const node = tree.nodes.find(node => node.kind === "MainGen")!;
            const source = join(directory, "source", nodePath(tree, node)); mkdirSync(dirname(source), { recursive: true });
            writeFileSync(join(directory, "events.json"), "[]");
            writeFileSync(join(directory, "manifest.json"), JSON.stringify({ journalIncomplete: false }));
            writeFileSync(join(directory, "project.json"), JSON.stringify({ tree }));
            const run = () => {
                const output = join(directory, "output");
                const process = spawnSync(globalThis.process.execPath, [resolve("scripts/replay-project.mjs"), directory, output], { encoding: "utf8" });
                expect(process.error).toBeUndefined();
                return { status: process.status, report: JSON.parse(readFileSync(join(output, "report.json"), "utf8")) };
            };
            writeFileSync(source, "package test.plugin; public class Main extends JavaPlugin {}");
            const valid = run(); expect(valid.status).toBe(0); expect(valid.report.contractChecks).toHaveLength(1);
            writeFileSync(source, "package wrong; public class Broken {}");
            const invalid = run(); expect(invalid.status).toBe(2); expect(invalid.report.passed).toBe(false);
            expect(invalid.report.contractChecks[0].check.items.some((item: { ok: boolean }) => !item.ok)).toBe(true);
        } finally { rmSync(directory, { recursive: true, force: true }); }
    });
});
