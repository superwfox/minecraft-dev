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

    it("treats a simple join reward as complete and only allows blocking questions", async () => {
        const fetchMock = vi.fn(async () => new Response([
            'data: {"choices":[{"delta":{"content":"{\\"complete\\":true}"}}]}',
            "",
            "data: [DONE]",
            "",
        ].join("\n"), {
            status: 200,
            headers: {"Content-Type": "text/event-stream"},
        })) as unknown as typeof fetch;
        vi.stubGlobal("fetch", fetchMock);
        const {precheckPrompt} = await import("../../src/api/deepseek");

        await expect(precheckPrompt(
            "玩家进入服务器时发放 1 颗钻石，插件运行于 Paper 26.2",
        )).resolves.toEqual({complete: true});

        const [url, init] = vi.mocked(fetchMock).mock.calls[0];
        expect(url).toBe("/api/stream");
        const payload = JSON.parse(String(init?.body));
        expect(payload.model).toBe("deepseek-v4-flash");
        expect(payload.messages[0].content).toContain("你不是需求审计器");
        expect(payload.messages[0].content).toContain("必须返回 {\"complete\":true}");
        expect(payload.messages[0].content).toContain("不得追问反馈、防刷、重连、背包或已在线玩家");
        expect(payload.messages[0].content).toContain("1-3 个");
        expect(payload.messages[0].content).toContain("不得为凑数量添加问题");
    });

    it("keeps BYOK precheck on the same Flash model and server route", async () => {
        const fetchMock = vi.fn(async () => new Response([
            'data: {"choices":[{"delta":{"content":"{\\"complete\\":true}"}}]}',
            "",
            "data: [DONE]",
            "",
        ].join("\n"), {
            status: 200,
            headers: {"Content-Type": "text/event-stream"},
        })) as unknown as typeof fetch;
        vi.stubGlobal("fetch", fetchMock);
        const {precheckPrompt} = await import("../../src/api/deepseek");
        const {deepSeekKeyState} = await import("../../src/logic/byok");
        deepSeekKeyState.key = "user-deepseek-key";
        deepSeekKeyState.credentialId = "credential-1";

        try {
            await expect(precheckPrompt("玩家进服发放钻石"))
                .resolves.toEqual({complete: true});

            const [url, init] = vi.mocked(fetchMock).mock.calls[0];
            expect(url).toBe("/api/stream");
            expect(JSON.parse(String(init?.body)).model).toBe("deepseek-v4-flash");
            const headers = new Headers(init?.headers);
            expect(headers.get("X-LLM-Provider")).toBe("deepseek");
            expect(headers.get("X-LLM-Key")).toBe("user-deepseek-key");
        } finally {
            deepSeekKeyState.key = "";
            deepSeekKeyState.credentialId = "";
        }
    });
});
