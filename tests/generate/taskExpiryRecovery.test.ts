import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const fetchWithByokFallbackMock = vi.hoisted(() => vi.fn());
const fetchMeMock = vi.hoisted(() => vi.fn());

vi.mock("../../src/logic/byok", () => ({
    fetchWithByokFallback: fetchWithByokFallbackMock,
    handleDeepSeekAccessFailure: vi.fn(() => null),
    handleDeepSeekAccessResponse: vi.fn(async () => null),
    hasDeepSeekKey: vi.fn(() => false),
    openDeepSeekKeyModal: vi.fn(),
}));

vi.mock("../../src/logic/auth", () => ({
    showSponsorModal: { value: false },
    login: vi.fn(),
    fetchMe: fetchMeMock,
}));

vi.mock("../../src/logic/skills", () => ({
    selected: new Set<string>(),
}));

import { startGenerate } from "../../src/logic/generateHandler";
import { genTask, persistGenTaskNow, resetGenTask } from "../../src/logic/generateState";

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
    vi.stubGlobal("localStorage", memoryStorage());
    resetGenTask();
    fetchWithByokFallbackMock.mockReset();
    fetchMeMock.mockReset();
});

afterEach(() => {
    resetGenTask();
    vi.unstubAllGlobals();
});

describe("expired generation task recovery", () => {
    it("clears the snapshot before Planner when server renewal rejects the task", async () => {
        const now = Date.now();
        genTask.taskId = "task-expired";
        genTask.taskExpiresAt = now - 1;
        genTask.phase = "planning";
        genTask.userPrompt = "创建一个唯一 Boss 插件";
        genTask.coreType = "PAPER";
        genTask.version = "1.21.4";
        persistGenTaskNow();

        fetchWithByokFallbackMock.mockImplementation(async (url: string) => {
            if (url === "/api/generate/task") {
                return new Response(JSON.stringify({
                    error: "任务已超过有效期或不存在，请重新开始生成",
                    code: "TASK_NOT_FOUND",
                }), {
                    status: 404,
                    headers: { "Content-Type": "application/json" },
                });
            }
            throw new Error(`unexpected request: ${url}`);
        });

        await startGenerate(
            genTask.userPrompt,
            genTask.coreType,
            genTask.version,
            { resumePrepared: true },
        );

        expect(fetchWithByokFallbackMock).toHaveBeenCalledOnce();
        expect(genTask).toMatchObject({
            taskId: "",
            taskExpiresAt: 0,
            phase: "error",
            userPrompt: "创建一个唯一 Boss 插件",
            error: "任务已超过服务端有效期或已被清理，请重新开始生成",
        });
        expect(localStorage.getItem(GEN_KEY)).toBeNull();
    });

    it("accepts server renewal after the local expiry hint and does not retry Planner 404", async () => {
        const now = Date.now();
        genTask.taskId = "task-expired";
        genTask.taskExpiresAt = now - 1;
        genTask.phase = "planning";
        genTask.userPrompt = "创建一个唯一 Boss 插件";
        genTask.coreType = "PAPER";
        genTask.version = "1.21.4";
        persistGenTaskNow();

        fetchWithByokFallbackMock.mockImplementation(async (url: string) => {
            if (url === "/api/generate/task") {
                return new Response(JSON.stringify({ expiresAt: now + 60 * 60_000 }), {
                    status: 200,
                    headers: { "Content-Type": "application/json" },
                });
            }
            if (url === "/api/generate/plan") {
                return new Response(JSON.stringify({
                    error: "任务已超过有效期或不存在，请重新开始生成",
                    code: "TASK_NOT_FOUND",
                }), {
                    status: 404,
                    headers: { "Content-Type": "application/json" },
                });
            }
            throw new Error(`unexpected request: ${url}`);
        });

        await startGenerate(
            genTask.userPrompt,
            genTask.coreType,
            genTask.version,
            { resumePrepared: true },
        );

        const plannerCalls = fetchWithByokFallbackMock.mock.calls
            .filter(([url]) => url === "/api/generate/plan");
        expect(plannerCalls).toHaveLength(1);
        expect(genTask).toMatchObject({
            taskId: "",
            taskExpiresAt: 0,
            phase: "error",
            userPrompt: "创建一个唯一 Boss 插件",
            coreType: "PAPER",
            version: "1.21.4",
            error: "任务已超过服务端有效期或已被清理，请重新开始生成",
        });
        expect(localStorage.getItem(GEN_KEY)).toBeNull();
    });
});
