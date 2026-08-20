import {beforeEach, describe, expect, it, vi} from "vitest";

const precheckPromptMock = vi.hoisted(() => vi.fn());
const streamGetInfoMock = vi.hoisted(() => vi.fn());
const startGenerateMock = vi.hoisted(() => vi.fn(() => Promise.resolve()));
const fetchMeMock = vi.hoisted(() => vi.fn(() => Promise.resolve()));
const authStateMock = vi.hoisted(() => ({
    loaded: true,
    user: {login: "tester"} as {login: string} | null,
}));

vi.mock("../../src/api/deepseek", () => ({
    precheckPrompt: precheckPromptMock,
    streamGetInfo: streamGetInfoMock,
    consistChat: vi.fn(),
}));

vi.mock("../../src/logic/auth", () => ({
    authState: authStateMock,
    fetchMe: fetchMeMock,
}));

vi.mock("../../src/logic/generateHandler", () => ({
    startGenerate: startGenerateMock,
}));

vi.mock("../../src/logic/minecraftVersions", () => ({
    MINECRAFT_VERSIONS: ["1.21.4"],
}));

import {chatBlocks, resetChat} from "../../src/logic/chatState";
import {
    handleUserInput,
    interruptAnalyze,
    resumeInterruptedAnalysis,
} from "../../src/logic/chatHandler";

function deferred<T>() {
    let resolve!: (value: T) => void;
    const promise = new Promise<T>((done) => {
        resolve = done;
    });
    return {promise, resolve};
}

function centerRef() {
    return {value: ""} as any;
}

beforeEach(() => {
    resetChat();
    vi.clearAllMocks();
    authStateMock.loaded = true;
    authStateMock.user = {login: "tester"};
});

describe("chat analysis cancellation", () => {
    it("does not start precheck after cancellation while authentication is still loading", async () => {
        const auth = deferred<void>();
        authStateMock.loaded = false;
        fetchMeMock.mockReturnValueOnce(auth.promise);
        const center = centerRef();
        const pending = handleUserInput("实现一个唯一 Boss", center, vi.fn(), vi.fn());
        await vi.waitFor(() => expect(fetchMeMock).toHaveBeenCalledOnce());

        interruptAnalyze(center);
        authStateMock.loaded = true;
        auth.resolve(undefined);
        await pending;

        expect(chatBlocks).toHaveLength(1);
        expect(chatBlocks[0]).toMatchObject({
            phase: "interrupted",
            draft: true,
            userMessages: ["实现一个唯一 Boss"],
        });
        expect(precheckPromptMock).not.toHaveBeenCalled();
        expect(streamGetInfoMock).not.toHaveBeenCalled();
        expect(startGenerateMock).not.toHaveBeenCalled();
    });

    it("keeps the original draft and ignores a late precheck response", async () => {
        const precheck = deferred<{complete: boolean}>();
        precheckPromptMock.mockReturnValueOnce(precheck.promise);
        const center = centerRef();
        const pending = handleUserInput(
            "实现一个唯一 Boss",
            center,
            vi.fn(),
            vi.fn(),
        );
        await vi.waitFor(() => expect(chatBlocks).toHaveLength(1));

        interruptAnalyze(center);
        expect(chatBlocks[0]).toMatchObject({
            phase: "interrupted",
            draft: true,
            userMessages: ["实现一个唯一 Boss"],
        });

        precheck.resolve({complete: true});
        await pending;
        expect(chatBlocks[0].phase).toBe("interrupted");
        expect(streamGetInfoMock).not.toHaveBeenCalled();
        expect(startGenerateMock).not.toHaveBeenCalled();
    });

    it("ignores a late analysis response and only continues after manual resume", async () => {
        const analysis = deferred<string>();
        precheckPromptMock.mockResolvedValue({complete: true});
        streamGetInfoMock.mockReturnValueOnce(analysis.promise);
        const center = centerRef();
        const onNeedSelect = vi.fn();
        const onIncomplete = vi.fn();
        const pending = handleUserInput(
            "实现一个唯一 Boss",
            center,
            onNeedSelect,
            onIncomplete,
        );
        await vi.waitFor(() => expect(streamGetInfoMock).toHaveBeenCalledOnce());

        interruptAnalyze(center);
        analysis.resolve(JSON.stringify({
            coreType: "PAPER",
            version: "1.21.4",
            title: "Boss",
        }));
        await pending;
        expect(chatBlocks[0].phase).toBe("interrupted");
        expect(startGenerateMock).not.toHaveBeenCalled();

        precheckPromptMock.mockResolvedValueOnce({complete: true});
        streamGetInfoMock.mockResolvedValueOnce(JSON.stringify({
            coreType: "PAPER",
            version: "1.21.4",
            title: "Boss",
        }));
        await resumeInterruptedAnalysis(chatBlocks[0], center, onNeedSelect, onIncomplete);

        expect(startGenerateMock).toHaveBeenCalledOnce();
        expect(chatBlocks[0]).toMatchObject({phase: "done", draft: false});
    });
});
