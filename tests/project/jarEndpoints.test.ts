import { beforeEach, afterEach, describe, expect, it, vi } from "vitest";
import { readFileSync } from "node:fs";
import JSZip from "jszip";
import { sqliteD1 } from "../learning/sqliteD1";
const mock = vi.hoisted(() => ({ git: vi.fn(), publish: vi.fn(), artifact: vi.fn(), put: vi.fn(), states: new Map<string, any>() }));
vi.mock("../../functions/_lib/projectGithub", async original => ({ ...await original<any>(), projectGit: mock.git, publishDataCommit: mock.publish }));
vi.mock("../../functions/_lib/github", async original => ({ ...await original<any>(), downloadArtifact: mock.artifact }));
vi.mock("../../functions/_lib/taskStore", async original => ({ ...await original<any>(), getOwnedTask: async (_env: unknown, id: string) => mock.states.has(id) ? JSON.stringify(mock.states.get(id)) : null, acquireTaskOperationLease: async () => "d1", putTaskWithOperationLease: mock.put, releaseTaskOperationLease: async () => {} }));
import { onRequestPost, onRequestGet } from "../../functions/api/generate/jar";
let sql: ReturnType<typeof sqliteD1>, publicRepo: boolean, runs: any[], dispatchError: boolean;
const jobId = "jar-job-1234567890";
beforeEach(async () => {
    sql = sqliteD1();
    for (const statement of readFileSync(new URL("../../migrations/0006_project_journal_feedback.sql", import.meta.url), "utf8").split(";").filter(s => s.trim())) await sql.db.prepare(statement).run();
    mock.states.clear(); mock.states.set("original", { status: "clarifying", coreType: "PAPER", version: "1.21.4", logs: [] });
    publicRepo = true; runs = []; dispatchError = false;
    mock.git.mockReset(); mock.publish.mockReset().mockResolvedValue("input-commit"); mock.artifact.mockReset(); mock.put.mockReset().mockResolvedValue(true);
    mock.git.mockImplementation(async (_token, _repo, path) => {
        if (!path) return { private: publicRepo ? false : true, default_branch: "main" };
        if (path === "/actions/workflows/resolve-jar.yml") return { id: 1 };
        if (path === "/git/blobs") return { sha: "blob" };
        if (path.endsWith("/dispatches")) { if (dispatchError) throw new Error("network interrupted"); return null; }
        if (path.includes("/runs?")) return { workflow_runs: runs };
        if (path.endsWith("/artifacts")) return { artifacts: [{ id: 42, name: `resolved-${jobId}`, expired: false }] };
        throw Error(`Unexpected GitHub call ${path}`);
    });
});
afterEach(() => sql.close());
async function post(consent = true) {
    const zip = new JSZip(), options = { date: new Date("2020-01-01T00:00:00Z"), createFolders: false }; zip.file("plugin.yml", "name: Example\nmain: test.plugin.Entry\n", options); zip.file("test/plugin/Entry.class", "fixture", options);
    const form = new FormData(); form.set("jar", new File([await zip.generateAsync({ type: "arraybuffer" })], "example.jar")); form.set("taskId", "original"); form.set("submissionId", jobId); form.set("publicConsent", String(consent));
    return onRequestPost({ request: new Request("https://app.test/api/generate/jar", { method: "POST", body: form }), env: { DB: sql.db, GITHUB_PAT: "server-token", TASKS: {} }, data: { uid: "alice" } } as any);
}
describe("ResolveJAR upload and recovery", () => {
    it("does not upload to a public repository without explicit consent", async () => {
        expect((await post(false)).status).toBe(409);
        expect(mock.publish).not.toHaveBeenCalled();
        expect(mock.git.mock.calls.filter(call => call[2] === "/git/blobs")).toHaveLength(0);
    });
    it("reuses the same upload and dispatch across retries", async () => {
        expect((await post()).status).toBe(200); expect((await post()).status).toBe(200);
        expect(mock.publish).toHaveBeenCalledOnce();
        expect(mock.git.mock.calls.filter(call => call[2].endsWith("/dispatches"))).toHaveLength(1);
    });
    it("reconciles an ambiguous dispatch instead of blindly dispatching again", async () => {
        dispatchError = true;
        expect((await post()).status).toBe(400);
        expect((await post()).status).toBe(409);
        runs = [{ id: 19, display_title: `ResolveJAR ${jobId}`, status: "in_progress" }];
        expect((await post()).status).toBe(200);
        expect(mock.git.mock.calls.filter(call => call[2].endsWith("/dispatches"))).toHaveLength(1);
    });
    it("attaches extracted resources and a failed baseline to an owned restored task", async () => {
        await post();
        const row: any = await sql.db.prepare("SELECT state_json FROM project_submissions WHERE submission_id=?").bind(jobId).first();
        const saved = JSON.parse(row.state_json);
        const result = new JSZip(); result.file("resolved-project.json", JSON.stringify({ inputSha256: saved.inputSha256, mainClass: "test.plugin.Entry", projectName: "Example", files: [{ path: "src/main/java/test/plugin/Entry.java", content: "package test.plugin; public class Entry {}" }, { path: "src/main/resources/image.png", content: "cG5n", encoding: "base64" }], report: { baseline: { status: "failed" }, blockers: ["missing_dependency"] } }));
        mock.artifact.mockImplementation(async () => new Response(await result.generateAsync({ type: "arraybuffer" })));
        runs = [{ id: 19, display_title: `ResolveJAR ${jobId}`, status: "completed" }];
        mock.states.set("restored", { status: "clarifying", coreType: "PAPER", version: "1.21.4", logs: [] });
        const response = await onRequestGet({ request: new Request(`https://app.test/api/generate/jar?submissionId=${jobId}&taskId=restored`), env: { DB: sql.db, GITHUB_PAT: "server-token", TASKS: {} }, data: { uid: "alice" } } as any);
        const value: any = await response.json();
        expect(response.status).toBe(200); expect(value.taskId).toBe("restored");
        expect(value.state.resources[0].encoding).toBe("base64");
        expect(value.state.importReport.blockers).toContain("missing_dependency");
        expect(value.state.compileCheck).toBeUndefined();
        expect(mock.put).toHaveBeenCalledOnce();
    });
    it("does not overwrite work started in another tab while the JAR was processing", async () => {
        await post();
        const row: any = await sql.db.prepare("SELECT state_json FROM project_submissions WHERE submission_id=?").bind(jobId).first();
        const result = new JSZip(); result.file("resolved-project.json", JSON.stringify({ inputSha256: JSON.parse(row.state_json).inputSha256, mainClass: "test.plugin.Entry", files: [] }));
        mock.artifact.mockImplementation(async () => new Response(await result.generateAsync({ type: "arraybuffer" })));
        runs = [{ id: 19, display_title: `ResolveJAR ${jobId}`, status: "completed" }];
        mock.states.set("original", { ...mock.states.get("original"), status: "generating", tree: { existingWork: true } });
        const response = await onRequestGet({ request: new Request(`https://app.test/api/generate/jar?submissionId=${jobId}`), env: { DB: sql.db, GITHUB_PAT: "server-token", TASKS: {} }, data: { uid: "alice" } } as any);
        expect(response.status).toBe(409); expect(await response.json()).toMatchObject({ code: "JAR_TARGET_CHANGED" });
        expect(mock.put).not.toHaveBeenCalled();
    });
});
