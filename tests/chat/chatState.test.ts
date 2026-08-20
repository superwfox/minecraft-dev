import {beforeEach, describe, expect, it} from "vitest";
import {
    appendToDraft,
    createDraftBlock,
    resetChat,
} from "../../src/logic/chatState";

beforeEach(() => resetChat());

describe("chat draft replacement", () => {
    it("replaces an incomplete draft instead of duplicating the original requirement", () => {
        const draft = createDraftBlock("原始需求");
        draft.phase = "needs_input";

        expect(appendToDraft("已补全并整理后的完整需求")).toBe(draft);
        expect(draft.userMessages).toEqual(["已补全并整理后的完整需求"]);
    });
});
