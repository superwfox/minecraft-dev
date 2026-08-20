import {describe, expect, it} from "vitest";
import {
    actionMessageMetaForError,
    legacyActionMessageMeta,
    normalizeActionMessageMeta,
} from "../../src/logic/actionMessages";

describe("action message metadata", () => {
    it("keeps credential failures distinct from login failures", () => {
        expect(actionMessageMetaForError({code: "LLM_AUTH_FAILED", status: 401})).toEqual({
            kind: "credential_required",
            code: "LLM_AUTH_FAILED",
            status: 401,
        });
        expect(actionMessageMetaForError({code: "AUTH_REQUIRED", status: 401})).toEqual({
            kind: "auth_required",
            code: "AUTH_REQUIRED",
            status: 401,
        });
    });

    it("maps quota and recoverable state responses to actionable tones", () => {
        expect(actionMessageMetaForError({code: "QUOTA_REQUIRED", status: 402}).kind)
            .toBe("quota_required");
        expect(actionMessageMetaForError({code: "PLAN_REQUEST_CONFLICT", status: 409}).kind)
            .toBe("warning");
        expect(actionMessageMetaForError({code: "RATE_LIMITED", status: 429}).kind)
            .toBe("warning");
    });

    it("leaves genuine service failures in the error tone", () => {
        expect(actionMessageMetaForError({code: "UPSTREAM_FAILED", status: 502}).kind)
            .toBe("error");
    });

    it("normalizes persisted metadata and rejects unknown kinds", () => {
        expect(normalizeActionMessageMeta({kind: "warning", code: " TASK_CONFLICT ", status: 409}))
            .toEqual({kind: "warning", code: "TASK_CONFLICT", status: 409});
        expect(normalizeActionMessageMeta({kind: "fatal", status: 500})).toBeUndefined();
    });

    it("migrates the previous login message without broad text matching", () => {
        expect(legacyActionMessageMeta("请先登录后再使用（点击右上角「登录」）")).toEqual({
            kind: "auth_required",
            code: "AUTH_REQUIRED",
            status: 401,
        });
        expect(legacyActionMessageMeta("其它失败")).toBeUndefined();
    });
});
