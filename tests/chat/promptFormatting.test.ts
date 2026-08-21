import {afterEach, describe, expect, it, vi} from "vitest";
import {
    createIdlePromptScheduler,
    normalizeFormattedPrompt,
    normalizePrecheckPayload,
    shouldAcceptFormattedPrompt,
} from "../../src/logic/promptFormatting";

afterEach(() => {
    vi.useRealTimers();
});

describe("prompt formatting helpers", () => {
    it("normalizes structured precheck guidance", () => {
        expect(normalizePrecheckPayload({
            complete: false,
            heading: "  需要确认  ",
            items: [
                {topic: "1. Boss 数量", detail: " 是否只允许一个？ "},
                {topic: "Boss 数量", detail: "是否只允许一个？"},
                {topic: "- 护盾规则", detail: "抵挡比例还是吸收固定伤害？"},
            ],
        })).toEqual({
            complete: false,
            guidance: {
                heading: "需要确认",
                items: [
                    {topic: "Boss 数量", detail: "是否只允许一个？"},
                    {topic: "护盾规则", detail: "抵挡比例还是吸收固定伤害？"},
                ],
            },
        });
    });

    it("keeps compatibility with legacy semicolon hints", () => {
        expect(normalizePrecheckPayload({
            complete: false,
            hint: "请补充：1) 创建时机；2) Boss 是否唯一；3) 护盾抵挡规则",
        })?.guidance?.items).toEqual([
            {topic: "创建时机", detail: ""},
            {topic: "Boss 是否唯一", detail: ""},
            {topic: "护盾抵挡规则", detail: ""},
        ]);
    });

    it("keeps compatibility with legacy string item arrays", () => {
        expect(normalizePrecheckPayload({
            complete: false,
            items: ["Boss 数量：是否只允许一个", "护盾规则"],
        })?.guidance?.items).toEqual([
            {topic: "Boss 数量", detail: "是否只允许一个"},
            {topic: "护盾规则", detail: ""},
        ]);
    });

    it("caps incomplete guidance at three genuinely blocking questions", () => {
        expect(normalizePrecheckPayload({
            complete: false,
            items: [
                "核心目标：插件要实现什么",
                "触发行为：玩家如何触发",
                "目标对象：效果作用于谁",
                "反馈方式：是否发送消息",
                "持久化：是否保存记录",
            ],
        })?.guidance?.items).toEqual([
            {topic: "核心目标", detail: "插件要实现什么"},
            {topic: "触发行为", detail: "玩家如何触发"},
            {topic: "目标对象", detail: "效果作用于谁"},
        ]);
    });

    it("strips a single Markdown fence from formatted output", () => {
        expect(normalizeFormattedPrompt("```markdown\n# 标题\n\n**核心需求**\n```"))
            .toBe("# 标题\n\n**核心需求**");
    });

    it("rejects stale, aborted, or self-identical formatter responses", () => {
        const base = {
            source: "原始需求",
            current: "原始需求",
            requestRevision: 3,
            currentRevision: 3,
            formatted: "# 原始需求",
            aborted: false,
            composing: false,
            disabled: false,
        };
        expect(shouldAcceptFormattedPrompt(base)).toBe(true);
        expect(shouldAcceptFormattedPrompt({...base, current: "用户继续输入"})).toBe(false);
        expect(shouldAcceptFormattedPrompt({...base, currentRevision: 4})).toBe(false);
        expect(shouldAcceptFormattedPrompt({...base, aborted: true})).toBe(false);
        expect(shouldAcceptFormattedPrompt({...base, composing: true})).toBe(false);
        expect(shouldAcceptFormattedPrompt({...base, formatted: " 原始需求 "})).toBe(false);
    });
});

describe("idle prompt formatter scheduler", () => {
    it("waits the full 3000ms before requesting", () => {
        vi.useFakeTimers();
        const request = vi.fn();
        const scheduler = createIdlePromptScheduler(request, 3_000);

        expect(scheduler.schedule("Boss 插件")).toBe("debouncing");
        vi.advanceTimersByTime(2_999);
        expect(request).not.toHaveBeenCalled();
        vi.advanceTimersByTime(1);
        expect(request).toHaveBeenCalledWith("Boss 插件");
    });

    it("restarts the idle window when the user keeps typing", () => {
        vi.useFakeTimers();
        const request = vi.fn();
        const scheduler = createIdlePromptScheduler(request, 3_000);

        scheduler.schedule("Boss");
        vi.advanceTimersByTime(2_999);
        scheduler.schedule("Boss 插件");
        vi.advanceTimersByTime(2_999);
        expect(request).not.toHaveBeenCalled();
        vi.advanceTimersByTime(1);
        expect(request).toHaveBeenCalledOnce();
        expect(request).toHaveBeenCalledWith("Boss 插件");
    });

    it("does not request the same text twice", () => {
        vi.useFakeTimers();
        const request = vi.fn();
        const scheduler = createIdlePromptScheduler(request, 3_000);

        scheduler.schedule("Boss 插件");
        vi.advanceTimersByTime(3_000);
        expect(scheduler.lastRequestedText()).toBe("Boss 插件");
        expect(scheduler.schedule("Boss 插件")).toBe("idle");
        vi.advanceTimersByTime(3_000);
        expect(request).toHaveBeenCalledOnce();
    });

    it("suppresses programmatic backfills without creating a formatting loop", () => {
        vi.useFakeTimers();
        const request = vi.fn();
        const scheduler = createIdlePromptScheduler(request, 3_000);

        scheduler.suppressNext("# Boss 插件");
        expect(scheduler.schedule("# Boss 插件")).toBe("idle");
        expect(scheduler.schedule("# Boss 插件")).toBe("idle");
        vi.advanceTimersByTime(6_000);
        expect(request).not.toHaveBeenCalled();
    });
});
