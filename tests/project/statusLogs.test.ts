import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
const mock = vi.hoisted(() => ({ record: vi.fn(), logs: vi.fn(), put: vi.fn(), jobs: vi.fn() }));
vi.mock("../../functions/_lib/taskStore", () => ({ getOwnedTask: async () => JSON.stringify({ status: "building", runId: 42, logs: [] }), putTaskState: mock.put }));
vi.mock("../../functions/_lib/github", () => ({
    getRunStatus: async () => ({ status: "completed", conclusion: "success", headSha: "commit" }), getArtifactInfo: async () => ({ id: 13 }),
    getRunJobs: mock.jobs, getJobLogs: mock.logs, deleteBranch: vi.fn(), findRunByBranch: vi.fn(),
}));
vi.mock("../../functions/_lib/projectJournal", () => ({ journalRecorder: () => ({ record: mock.record }) }));
import { onRequestGet } from "../../functions/api/generate/status";
afterEach(() => vi.clearAllMocks());
beforeEach(() => { mock.jobs.mockResolvedValue([{ id: 17, name: "verify", conclusion: "success" }]); });
const invoke = () => onRequestGet({ request: new Request("https://app.test/api/generate/status?taskId=task"), env: { GITHUB_PAT: "token" }, data: { uid: "alice" }, waitUntil: vi.fn() } as any);
describe("terminal build diagnostic checkpoint", () => {
    it("does not return a completed checkpoint before its logs are persisted", async () => {
        let release!: () => void; const pending = new Promise<void>(resolve => { release = resolve; });
        mock.logs.mockResolvedValue("actual compile log"); mock.record.mockImplementation(async () => { await pending; return true; });
        let settled = false; const response = Promise.resolve(invoke()).then(value => { settled = true; return value; });
        await vi.waitFor(() => expect(mock.record).toHaveBeenCalled());
        expect(settled).toBe(false); expect(mock.put).not.toHaveBeenCalled();
        release(); expect(await (await response).json()).toMatchObject({ status: "done" });
        expect(mock.record.mock.calls[0]).toEqual(["build.logs", expect.objectContaining({ runId: 42, jobId: 17, content: "actual compile log" })]);
    });
    it("persists an explicit diagnostic gap before returning when log retrieval fails", async () => {
        mock.logs.mockRejectedValueOnce(new Error("storage unavailable")); mock.record.mockResolvedValue(true);
        expect(await (await invoke()).json()).toMatchObject({ status: "done" });
        expect(mock.record).toHaveBeenCalledWith("build.logs", expect.objectContaining({ runId: 42, gap: "build_log_unavailable" }), true);
    });
    it("records skipped jobs without attempting to download nonexistent logs", async () => {
        mock.jobs.mockResolvedValue([{ id: 17, name: "verify", conclusion: "failure" }, { id: 18, name: "package", conclusion: "skipped" }]);
        mock.logs.mockResolvedValue("actual compiler failure"); mock.record.mockResolvedValue(true);
        await invoke();
        expect(mock.logs.mock.calls).toEqual([["token", 17]]);
        expect(mock.record).toHaveBeenCalledWith("build.logs", expect.objectContaining({ jobId: 18, conclusion: "skipped", content: "", noLogReason: "job_not_executed" }));
        expect(mock.record).toHaveBeenCalledWith("build.logs.complete", expect.objectContaining({ jobIds: [17, 18] }));
        expect(mock.record.mock.calls.some(call => call[2] === true)).toBe(false);
    });
    it("retains the remaining job logs when one download fails", async () => {
        mock.jobs.mockResolvedValue([{ id: 17, conclusion: "failure" }, { id: 18, conclusion: "success" }]);
        mock.logs.mockRejectedValueOnce(new Error("unavailable")).mockResolvedValueOnce("remaining log"); mock.record.mockResolvedValue(true);
        await invoke();
        expect(mock.record).toHaveBeenCalledWith("build.logs", expect.objectContaining({ jobId: 17, gap: "build_log_unavailable" }), true);
        expect(mock.record).toHaveBeenCalledWith("build.logs", expect.objectContaining({ jobId: 18, content: "remaining log" }));
        expect(mock.record.mock.calls.some(call => call[0] === "build.logs.complete")).toBe(false);
    });
    it("does not mark an absent job inventory as complete", async () => {
        mock.jobs.mockResolvedValue([]); mock.record.mockResolvedValue(true);
        await invoke();
        expect(mock.record).toHaveBeenCalledWith("build.logs", expect.objectContaining({ gap: "build_log_unavailable" }), true);
        expect(mock.record.mock.calls.some(call => call[0] === "build.logs.complete")).toBe(false);
    });
});
