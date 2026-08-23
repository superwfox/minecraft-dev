import {beforeEach, describe, expect, it, vi} from "vitest";
import {
    loadPromptHistory,
    promptHistory,
    recordPromptHistory,
    removePromptHistoryEntry,
} from "../../src/logic/promptHistory";

function memoryStorage(): Storage {
    const values = new Map<string, string>();
    return {
        get length() { return values.size; },
        clear() { values.clear(); },
        getItem(key: string) { return values.get(key) ?? null; },
        key(index: number) { return [...values.keys()][index] ?? null; },
        removeItem(key: string) { values.delete(key); },
        setItem(key: string, value: string) { values.set(key, String(value)); },
    };
}

describe("task prompt history", () => {
    beforeEach(() => {
        vi.restoreAllMocks();
        vi.stubGlobal("localStorage", memoryStorage());
        loadPromptHistory();
    });

    it("normalizes, deduplicates, and moves an identical invocation to the front", () => {
        vi.spyOn(Date, "now").mockReturnValueOnce(1_000).mockReturnValueOnce(2_000);
        recordPromptHistory({
            prompt: "  第一行\r\n第二行  ",
            coreType: " PAPER ",
            version: " 1.21.4 ",
            skillIds: ["economy", "economy", " quests "],
        });
        recordPromptHistory({
            prompt: "第一行\n第二行",
            coreType: "PAPER",
            version: "1.21.4",
            skillIds: ["economy", "quests"],
        });

        expect(promptHistory).toHaveLength(1);
        expect(promptHistory[0]).toMatchObject({
            prompt: "第一行\n第二行",
            coreType: "PAPER",
            version: "1.21.4",
            skillIds: ["economy", "quests"],
            createdAt: 1_000,
            lastUsedAt: 2_000,
        });
    });

    it("persists one browser-local history and reloads it", () => {
        recordPromptHistory({
            prompt: "本地插件需求",
            coreType: "PAPER",
            version: "1.21.4",
            skillIds: [],
        });
        promptHistory.splice(0, promptHistory.length);
        loadPromptHistory();
        expect(promptHistory.map(entry => entry.prompt)).toEqual(["本地插件需求"]);
    });

    it("keeps the newest twenty entries and supports deleting one record", () => {
        const now = vi.spyOn(Date, "now");
        for (let index = 0; index < 22; index++) {
            now.mockReturnValue(1_000 + index);
            recordPromptHistory({
                prompt: `需求 ${index}`,
                coreType: "PAPER",
                version: "1.21.4",
                skillIds: [],
            });
        }

        expect(promptHistory).toHaveLength(20);
        expect(promptHistory[0].prompt).toBe("需求 21");
        expect(promptHistory.at(-1)?.prompt).toBe("需求 2");

        const removedId = promptHistory[0].id;
        removePromptHistoryEntry(removedId);
        expect(promptHistory).toHaveLength(19);
        expect(promptHistory.some(entry => entry.id === removedId)).toBe(false);
    });
});
