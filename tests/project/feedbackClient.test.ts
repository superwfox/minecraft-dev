import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
vi.mock("../../src/logic/projectSession", () => ({ activeProjectKey: () => "live:alice:project", currentProject: vi.fn(), saveProjectNow: vi.fn(async () => {}), syncProjectCheckpoint: vi.fn(async () => {}) }));
vi.mock("../../src/logic/projectDb", () => ({ dbGet: vi.fn(), dbList: vi.fn(), dbPut: vi.fn(async () => {}) }));
vi.mock("../../src/logic/generateState", () => ({ genTask: { taskId: "task", phase: "error", files: [], projectName: "Example", coreType: "PAPER", version: "1.21.4", error: "编译失败：类型不匹配" } }));
vi.mock("../../src/logic/byok", () => ({ deepSeekKeyState: { key: "" } }));
import { newFeedback, submitFeedback, prepareFeedback, feedbackDraft, type FeedbackDraft, type FeedbackReview } from "../../src/logic/projectFeedback";
import { currentProject } from "../../src/logic/projectSession";
import { dbGet, dbList } from "../../src/logic/projectDb";
import { genTask } from "../../src/logic/generateState";

const reviewed = (draft: FeedbackDraft): FeedbackReview => ({ payload: JSON.stringify({ submissionId: draft.submissionId, bundleVersion: 2, publicConsent: true, description: draft.description, files: draft.files }), description: draft.description, kind: "failure", projectKey: "live:alice:project", taskId: "task", sourceBytes: 1, diagnosticBytes: 1, sourceCount: 1, imageCount: 0, incomplete: false, missing: [], legacy: false });
beforeEach(() => {
    vi.mocked(currentProject).mockResolvedValue({ checkpoint: { revisionId: "r1", projectName: "Example", generatedFiles: [{ path: "Main.java", content: "class Main {}" }], resources: [] }, ui: {} } as any);
    vi.mocked(dbList).mockResolvedValue([]); vi.mocked(dbGet).mockResolvedValue(undefined);
    Object.assign(genTask, { phase: "error", tree: null, error: "编译失败：类型不匹配" });
});
afterEach(() => vi.unstubAllGlobals());
describe("feedback client retries", () => {
    it("sends the original reviewed payload after an ambiguous network failure", async () => {
        const send = vi.fn().mockRejectedValueOnce(new Error("network interrupted")).mockResolvedValueOnce(new Response(JSON.stringify({ issueUrl: "https://github.com/example/issues/1" })));
        vi.stubGlobal("fetch", send);
        const draft = newFeedback(); draft.description = "原始描述"; draft.files = [{ path: "source/Main.java", content: "class Main {}", selected: true }];
        await expect(submitFeedback(draft, reviewed(draft), true)).rejects.toThrow("network interrupted");
        const frozen = draft.submittedPayload; expect(frozen).toContain("原始描述");
        draft.description = "迟到的编辑";
        await submitFeedback(draft, reviewed(draft), true);
        expect(send.mock.calls[1][1].body).toBe(frozen);
        expect(draft.issueUrl).toContain("issues/1");
    });
    it("allows editing again when configuration rejects the request before publication", async () => {
        vi.stubGlobal("fetch", vi.fn(async () => new Response(JSON.stringify({ error: "尚未配置" }), { status: 503 })));
        const draft = newFeedback(); draft.description = "待提交";
        await expect(submitFeedback(draft, reviewed(draft), true)).rejects.toThrow("尚未配置");
        expect(draft.submittedPayload).toBeUndefined();
        expect(draft.description).toBe("待提交");
    });
    it("requires the public dialog confirmation before any network publication", async () => {
        const send = vi.fn(); vi.stubGlobal("fetch", send); const draft = newFeedback();
        await expect(submitFeedback(draft, reviewed(draft), false)).rejects.toThrow("确认公开范围");
        expect(send).not.toHaveBeenCalled(); expect(draft.submittedPayload).toBeUndefined();
    });
    it("prepares a failure with zero user input and preserves missing-record evidence", async () => {
        const draft = newFeedback(), review = await prepareFeedback(draft), payload = JSON.parse(review.payload);
        expect(review.kind).toBe("failure"); expect(review.description).toContain("类型不匹配");
        expect(payload.bundleVersion).toBe(2); expect(review.sourceCount).toBe(1);
        expect(review.incomplete).toBe(true); expect(review.missing).toContain("execution-journal");
        expect(draft.submittedPayload).toBeUndefined();
    });
    it("attaches the selected behavioral step and its implementation file", async () => {
        Object.assign(genTask, { phase: "done", tree: { paths: [{ id: "reward", title: "聊天奖励", nodes: [{ id: "grant", title: "发放奖励", fileIds: ["reward-file"] }] }], nodes: [{ id: "reward-file", path: "Reward.java" }] } });
        const draft = newFeedback(); draft.pathId = "reward"; draft.stepId = "grant"; draft.description = "预期奖励落地，实际消失";
        const review = await prepareFeedback(draft), payload = JSON.parse(review.payload), context = JSON.parse(payload.files.find(file => file.path === "feedback.json").content);
        expect(review.kind).toBe("implementation"); expect(context.location.filePaths).toEqual(["Reward.java"]);
        expect(review.description).toContain("发放奖励");
    });
    it("converts old editable fields to one Markdown draft without restoring a file picker", async () => {
        vi.mocked(dbGet).mockResolvedValue({ submissionId: "old", description: "描述", expected: "预期", actual: "实际", steps: "步骤", files: [{ path: "source/Main.java", content: "old" }] });
        const draft = await feedbackDraft(); expect(draft.schemaVersion).toBe(2); expect(draft.description).toContain("## 预期行为\n预期"); expect(draft.files).toEqual([]);
    });
});
