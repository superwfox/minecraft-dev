import {afterEach, describe, expect, it, vi} from "vitest";

afterEach(() => {
    vi.unstubAllGlobals();
});

describe("formatUserPrompt", () => {
    it("uses the server-owned formatter contract and forwards cancellation", async () => {
        vi.stubGlobal("localStorage", {
            getItem: () => null,
            setItem: () => undefined,
            removeItem: () => undefined,
        });
        const fetchMock = vi.fn(async () => new Response(JSON.stringify({
            markdown: "# Boss 插件\n\n## 核心目标\n- 实现 **唯一 Boss**",
        }), {
            status: 200,
            headers: {"Content-Type": "application/json"},
        })) as unknown as typeof fetch;
        vi.stubGlobal("fetch", fetchMock);
        const controller = new AbortController();
        const {formatUserPrompt} = await import("../../src/api/deepseek");

        await expect(formatUserPrompt("做一个唯一 Boss", controller.signal)).resolves.toContain("# Boss 插件");

        expect(fetchMock).toHaveBeenCalledOnce();
        const [url, init] = vi.mocked(fetchMock).mock.calls[0];
        expect(url).toBe("/api/chat");
        expect(init?.signal).toBe(controller.signal);
        expect(JSON.parse(String(init?.body))).toEqual({
            purpose: "format_prompt",
            input: "做一个唯一 Boss",
        });
    });
});
