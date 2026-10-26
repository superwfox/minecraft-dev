import { beforeEach, afterEach, describe, expect, it, vi } from "vitest";
import { readFileSync } from "node:fs";
import { sqliteD1 } from "../learning/sqliteD1";
import { journalRecorder } from "../../functions/_lib/projectJournal";
import { onRequestGet as readJournal } from "../../functions/api/generate/journal";
import { submission, lockSubmission, saveSubmission, unlockSubmission } from "../../functions/_lib/projectSubmission";
const git = vi.hoisted(() => vi.fn());
vi.mock("../../functions/_lib/projectGithub", async importOriginal => ({ ...await importOriginal<any>(), projectGit: git }));
import { onRequestPost as feedback } from "../../functions/api/generate/feedback";
import JSZip from "jszip";
let sql: ReturnType<typeof sqliteD1>;
beforeEach(async () => {
    sql = sqliteD1();
    const migration = readFileSync(new URL("../../migrations/0006_project_journal_feedback.sql", import.meta.url), "utf8");
    for (const statement of migration.split(";").filter(s => s.trim())) await sql.db.prepare(statement).run();
    git.mockReset();
});
afterEach(() => sql.close());
describe("persistent journal and publication", () => {
    it("records chunked output even after request body was consumed, without credentials", async () => {
        const request = new Request("https://app.test/api/generate/bucket", { method: "POST", headers: { "Content-Type": "application/json", "X-LLM-Key": "provider-private-value" }, body: JSON.stringify({ taskId: "task-one" }) });
        await request.json();
        const recorder = journalRecorder({ request, env: { DB: sql.db }, data: { uid: "alice", journalInput: { taskId: "task-one" } } });
        await recorder.record("model.response", { text: "x".repeat(180000), keyInError: "provider-private-value" });
        const query = async (uid: string) => readJournal({ request: new Request("https://app.test/api/generate/journal?taskId=task-one"), env: { DB: sql.db }, data: { uid } } as any);
        const mine: any = await (await query("alice")).json();
        expect(mine.events).toHaveLength(2); expect(mine.events[0].parts).toBe(2);
        expect(mine.events.map(e => e.text).join("")).not.toContain("provider-private-value");
        expect((await (await query("bob")).json() as any).events).toEqual([]);
    });
    it("fences concurrent submissions and binds submission ID to owner and payload", async () => {
        const item = await submission(sql.db, "request-1234567890", "alice", "feedback", "hash-one");
        const token = await lockSubmission(sql.db, item.id, "alice"); expect(token).not.toBe("");
        expect(await lockSubmission(sql.db, item.id, "alice")).toBe("");
        await expect(submission(sql.db, item.id, "bob", "feedback", "hash-one")).rejects.toThrow();
        await expect(submission(sql.db, item.id, "alice", "feedback", "hash-two")).rejects.toThrow();
        item.leaseToken = token; item.state.commit = "one"; await saveSubmission(sql.db, item, "alice");
        await unlockSubmission(sql.db, item.id, "alice", token);
        expect(await lockSubmission(sql.db, item.id, "alice")).not.toBe("");
        await expect(saveSubmission(sql.db, item, "alice")).rejects.toThrow();
    });
    it("reports expired unsynchronized events even while newer events remain available", async () => {
        const recorder = journalRecorder({ request: new Request("https://app.test/api/generate/bucket?taskId=expiry"), env: { DB: sql.db }, data: { uid: "alice" } });
        await recorder.record("first", { value: 1 }); await recorder.record("second", { value: 2 });
        await sql.db.prepare("UPDATE project_journal SET expires_at=0 WHERE kind='first'").run();
        const read = (cursor: number) => readJournal({ request: new Request(`https://app.test/api/generate/journal?taskId=expiry&cursor=${cursor}`), env: { DB: sql.db }, data: { uid: "alice" } } as any);
        expect(await (await read(0)).json()).toMatchObject({ incomplete: true, reason: "journal_retention_gap" });
        expect(await (await read(1)).json()).toMatchObject({ incomplete: false });
    });
    it("reuses uploaded files and creates only one Issue across retry", async () => {
        let parent: string | null = null; let issues: any[] = [];
        git.mockImplementation(async (_token, _repo, path, method = "GET", body) => {
            if (path === "/git/blobs") return { sha: "blob" };
            if (path === "/git/ref/heads/feedback-data") { if (!parent) { const error: any = new Error("missing"); error.status = 404; throw error; } return { object: { sha: parent } }; }
            if (path === "/git/trees") return { sha: "tree" };
            if (path === "/git/commits") return { sha: "commit" };
            if (path === "/git/refs") { parent = body.sha; return {}; }
            if (path.startsWith("/issues?")) return issues;
            if (path === "/issues") { const issue = { html_url: "https://github.com/superwfox/minecraft-dev/issues/1", number: 1, body: body.body }; issues.push(issue); return issue; }
            throw new Error(`unexpected ${method} ${path}`);
        });
        const invoke = () => feedback({ request: new Request("https://app.test/api/generate/feedback", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ submissionId: "feedback-1234567890", publicConsent: true, description: "游戏实测失败", files: [{ path: "source/Main.java", content: "class Main {}" }] }) }), env: { DB: sql.db, GITHUB_FEEDBACK_TOKEN: "server-token", FEEDBACK_DATA_BRANCH_READY: "true" }, data: { uid: "alice", login: "alice" } } as any);
        expect((await invoke()).status).toBe(200); expect((await invoke()).status).toBe(200);
        expect(git.mock.calls.filter(call => call[2] === "/issues")).toHaveLength(1);
        expect(git.mock.calls.filter(call => call[2] === "/git/blobs")).toHaveLength(0);
        expect(git.mock.calls.find(call => call[2] === "/git/trees")?.[4].tree[0].content).toBe("class Main {}");
        expect(git.mock.calls.find(call => call[2] === "/git/commits")?.[4].parents).toEqual([]);
    });
    it("refuses publication until deployment branch exclusions are acknowledged", async () => {
        const response = await feedback({ request: new Request("https://app.test/api/generate/feedback", { method: "POST" }), env: { DB: sql.db, GITHUB_FEEDBACK_TOKEN: "token" }, data: { uid: "alice" } } as any);
        expect(response.status).toBe(503); expect(git).not.toHaveBeenCalled();
    });
    it("publishes automatic ZIPs after server redaction and mentions only the signed-in author", async () => {
        let issues: any[] = []; let blobs = 0;
        git.mockImplementation(async (_token, _repo, path, _method, body) => {
            if (path === "/git/blobs") return { sha: "blob-" + ++blobs };
            if (path === "/git/ref/heads/feedback-data") { const error: any = new Error("missing"); error.status = 404; throw error; }
            if (path === "/git/trees") return { sha: "tree" };
            if (path === "/git/commits") return { sha: "commit" };
            if (path === "/git/refs") return {};
            if (path.startsWith("/issues?")) return issues;
            if (path === "/issues") { const issue = { html_url: "https://github.com/superwfox/minecraft-dev/issues/3", number: 3, body: body.body }; issues.push(issue); return issue; }
            throw new Error("Unexpected GitHub operation");
        });
        const payload = { submissionId: "feedback-bundle-v2-123", bundleVersion: 2, publicConsent: true, login: "wrong-user", description: "生成失败的自动诊断", files: [
            { path: "project.json", content: JSON.stringify({ projectName: "Example" }) },
            { path: "manifest.json", content: JSON.stringify({ journalIncomplete: false, missing: [] }) },
            { path: "source/Main.java", content: "// server-token\nclass Main {}" },
        ] };
        const invoke = (publicConsent = true) => feedback({ request: new Request("https://app.test/api/generate/feedback", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ ...payload, publicConsent }) }), env: { DB: sql.db, GITHUB_FEEDBACK_TOKEN: "server-token", FEEDBACK_DATA_BRANCH_READY: "true" }, data: { uid: "alice", login: "trusted-user" } } as any);
        expect((await invoke(false)).status).toBe(400); expect(git).not.toHaveBeenCalled();
        expect((await invoke()).status).toBe(200); expect((await invoke()).status).toBe(200);
        expect(blobs).toBe(2); expect(issues).toHaveLength(1);
        expect(issues[0].body).toContain("反馈用户：@trusted-user"); expect(issues[0].body).not.toContain("@wrong-user");
        expect(issues[0].body).toContain("源码 ZIP"); expect(issues[0].body).toContain("diagnostics.zip?raw=true");
        const blob = git.mock.calls.find(call => call[2] === "/git/blobs")![4];
        const source = await JSZip.loadAsync(blob.content, { base64: true });
        expect(await source.file("Example/Main.java")!.async("string")).toContain("[REDACTED]");
        expect(git.mock.calls.find(call => call[2] === "/git/trees")![4].tree.map(file => file.path)).toEqual([payload.submissionId + "/source.zip", payload.submissionId + "/diagnostics.zip"]);
    });
    it.each([undefined, 2])("finds an Issue after a lost response without reuploading protocol %s attachments", async bundleVersion => {
        let issues: any[] = [];
        git.mockImplementation(async (_token, _repo, path, _method, body) => {
            if (path === "/git/blobs") return { sha: "blob" };
            if (path === "/git/ref/heads/feedback-data") { const error: any = new Error("missing"); error.status = 404; throw error; }
            if (path === "/git/trees") return { sha: "tree" };
            if (path === "/git/commits") return { sha: "commit" };
            if (path === "/git/refs") return {};
            if (path.startsWith("/issues?")) return issues;
            if (path === "/issues") { issues.push({ html_url: "https://github.com/superwfox/minecraft-dev/issues/2", number: 2, body: body.body }); throw new Error("network interrupted after creation"); }
            throw Error(`Unexpected ${path}`);
        });
        const invoke = () => feedback({ request: new Request("https://app.test/api/generate/feedback", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ submissionId: "feedback-ambiguous-123", bundleVersion, publicConsent: true, description: "实测反馈", files: [{ path: "source/Main.java", content: "class Main {}" }] }) }), env: { DB: sql.db, GITHUB_FEEDBACK_TOKEN: "server-token", FEEDBACK_DATA_BRANCH_READY: "true" }, data: { uid: "alice" } } as any);
        expect((await invoke()).status).toBe(400);
        const retry = await invoke(); expect(retry.status).toBe(200);
        expect(await retry.json()).toMatchObject({ issueNumber: 2 });
        expect(git.mock.calls.filter(call => call[2] === "/issues")).toHaveLength(1);
        expect(git.mock.calls.filter(call => call[2] === "/git/blobs")).toHaveLength(bundleVersion === 2 ? 2 : 0);
        expect(git.mock.calls.filter(call => call[2] === "/git/commits")).toHaveLength(1);
    });
});
