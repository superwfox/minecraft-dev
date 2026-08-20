import {afterEach, beforeEach, describe, expect, it, vi} from "vitest";
import {chatBlocks, resetChat} from "../../src/logic/chatState";
import {restoreSession} from "../../src/logic/sessionPersist";
import {
    genTask,
    persistGenTaskNow,
    resetGenTask,
    restoreGenTask,
} from "../../src/logic/generateState";

const SESSION_KEY = "tahai-session-v1";
const GEN_KEY = "tahai-gentask";

function memoryStorage(): Storage {
    const values = new Map<string, string>();
    return {
        get length() {
            return values.size;
        },
        clear() {
            values.clear();
        },
        getItem(key) {
            return values.get(key) ?? null;
        },
        key(index) {
            return [...values.keys()][index] ?? null;
        },
        removeItem(key) {
            values.delete(key);
        },
        setItem(key, value) {
            values.set(key, String(value));
        },
    };
}

beforeEach(() => {
    vi.useFakeTimers();
    vi.stubGlobal("localStorage", memoryStorage());
    resetChat();
    resetGenTask();
});

afterEach(() => {
    resetChat();
    resetGenTask();
    vi.clearAllTimers();
    vi.useRealTimers();
    vi.unstubAllGlobals();
});

describe("chat session persistence", () => {
    it("restores all active draft phases as interrupted without losing the original input", () => {
        const phases = ["analyzing", "fetching", "rendering", "streaming"] as const;
        localStorage.setItem(SESSION_KEY, JSON.stringify({
            chatBlocks: phases.map((phase, index) => ({
                id: index,
                userMessages: [`原始需求 ${index + 1}`, `补充需求 ${index + 1}`],
                draft: true,
                phase,
                streamText: "partial output",
                rawMsg: "partial raw",
                thinkingText: "partial thinking",
                outputText: "partial structured output",
                streamStage: "analysis",
                error: "stale error",
            })),
        }));

        restoreSession();

        expect(chatBlocks).toHaveLength(phases.length);
        expect(chatBlocks.map(block => block.phase)).toEqual(phases.map(() => "interrupted"));
        expect(chatBlocks.map(block => block.userMessages)).toEqual(phases.map((_, index) => [
            `原始需求 ${index + 1}`,
            `补充需求 ${index + 1}`,
        ]));
        for (const block of chatBlocks) {
            expect(block).toMatchObject({
                draft: true,
                streamText: "",
                rawMsg: "",
                thinkingText: "",
                outputText: "",
                streamStage: "",
            });
            expect(block.error).toBeUndefined();
        }

        const persisted = JSON.parse(localStorage.getItem(SESSION_KEY) || "{}");
        expect(persisted.chatBlocks.map((block: {phase: string}) => block.phase))
            .toEqual(phases.map(() => "interrupted"));
    });
});

describe("generation state persistence", () => {
    function persistModeOneSnapshot(phase: "planning" | "interrupted") {
        genTask.userPrompt = "创建一个唯一 Boss 插件";
        genTask.coreType = "PAPER";
        genTask.version = "1.21.4";
        genTask.taskId = "";
        genTask.phase = phase;
        genTask.interruptedFrom = phase === "interrupted" ? "planning" : "";
        persistGenTaskNow();
        return localStorage.getItem(GEN_KEY);
    }

    it("restores an active mode-one planning snapshot as manually resumable interrupted state", () => {
        const snapshot = persistModeOneSnapshot("planning");
        expect(snapshot).not.toBeNull();

        resetGenTask();
        localStorage.setItem(GEN_KEY, snapshot!);

        expect(restoreGenTask()).toBe(true);
        expect(genTask).toMatchObject({
            taskId: "",
            phase: "interrupted",
            interruptedFrom: "planning",
            userPrompt: "创建一个唯一 Boss 插件",
            coreType: "PAPER",
            version: "1.21.4",
            preflightActive: false,
        });
        expect(genTask.logs.at(-1)).toContain("已暂停等待手动继续");
    });

    it("restores an already interrupted mode-one planning snapshot without auto-resuming", () => {
        const snapshot = persistModeOneSnapshot("interrupted");
        expect(snapshot).not.toBeNull();

        resetGenTask();
        localStorage.setItem(GEN_KEY, snapshot!);

        expect(restoreGenTask()).toBe(true);
        expect(genTask).toMatchObject({
            taskId: "",
            phase: "interrupted",
            interruptedFrom: "planning",
            userPrompt: "创建一个唯一 Boss 插件",
            coreType: "PAPER",
            version: "1.21.4",
        });
        expect(genTask.logs).not.toContain("■ 上次页面离开时任务仍在进行，已暂停等待手动继续");
    });
});
