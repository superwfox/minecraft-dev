import { reactive } from "vue";

export type PromptHistoryEntry = {
    id: string;
    prompt: string;
    coreType: string;
    version: string;
    skillIds: string[];
    createdAt: number;
    lastUsedAt: number;
};

type PromptHistoryInput = Pick<PromptHistoryEntry, "prompt" | "coreType" | "version" | "skillIds">;

const STORAGE_KEY = "tahai-task-prompt-history-v1";
const MAX_ENTRIES = 20;
const MAX_FIELD_LENGTH = 100;
const MAX_ID_LENGTH = 160;

export const promptHistory = reactive<PromptHistoryEntry[]>([]);

function normalizePrompt(value: unknown): string {
    return typeof value === "string" ? value.replace(/\r\n?/g, "\n").trim() : "";
}

function normalizeField(value: unknown): string {
    if (typeof value !== "string") return "";
    const normalized = value.trim();
    return normalized.length <= MAX_FIELD_LENGTH ? normalized : "";
}

function normalizeId(value: unknown): string {
    if (typeof value !== "string") return "";
    const normalized = value.trim();
    return normalized.length <= MAX_ID_LENGTH ? normalized : "";
}

function normalizeSkillIds(value: unknown): string[] {
    if (!Array.isArray(value)) return [];
    const seen = new Set<string>();
    const result: string[] = [];
    for (const raw of value) {
        const id = normalizeField(raw);
        if (!id || seen.has(id)) continue;
        seen.add(id);
        result.push(id);
        if (result.length >= 32) break;
    }
    return result;
}

function normalizeTime(value: unknown): number {
    const timestamp = Number(value);
    return Number.isFinite(timestamp) && timestamp > 0 ? Math.floor(timestamp) : 0;
}

function normalizeEntry(value: unknown): PromptHistoryEntry | null {
    if (!value || typeof value !== "object") return null;
    const raw = value as Record<string, unknown>;
    const id = normalizeId(raw.id);
    const prompt = normalizePrompt(raw.prompt);
    const coreType = normalizeField(raw.coreType);
    const version = normalizeField(raw.version);
    const createdAt = normalizeTime(raw.createdAt);
    const lastUsedAt = normalizeTime(raw.lastUsedAt);
    if (!id || !prompt || !coreType || !version || !createdAt || !lastUsedAt) {
        return null;
    }
    return {
        id,
        prompt,
        coreType,
        version,
        skillIds: normalizeSkillIds(raw.skillIds),
        createdAt,
        lastUsedAt,
    };
}

function readEntries(): PromptHistoryEntry[] {
    try {
        const raw = localStorage.getItem(STORAGE_KEY);
        if (!raw) return [];
        const parsed = JSON.parse(raw);
        if (!Array.isArray(parsed)) return [];
        return parsed
            .map(normalizeEntry)
            .filter((entry): entry is PromptHistoryEntry => !!entry)
            .sort((a, b) => b.lastUsedAt - a.lastUsedAt)
            .slice(0, MAX_ENTRIES);
    } catch {
        return [];
    }
}

function writeEntries(entries: PromptHistoryEntry[]): PromptHistoryEntry[] {
    const stored = entries.slice(0, MAX_ENTRIES);
    const fallback = [...stored];
    while (stored.length > 0) {
        try {
            localStorage.setItem(STORAGE_KEY, JSON.stringify(stored));
            return stored;
        } catch {
            stored.pop();
        }
    }
    if (fallback.length === 0) {
        try { localStorage.removeItem(STORAGE_KEY); } catch { /* ignore */ }
    }
    return fallback;
}

function syncPromptHistory(entries: PromptHistoryEntry[]) {
    promptHistory.splice(0, promptHistory.length, ...entries);
}

function entrySignature(entry: PromptHistoryInput): string {
    return JSON.stringify([entry.prompt, entry.coreType, entry.version, entry.skillIds]);
}

function createEntryId(now: number): string {
    try {
        if (typeof crypto?.randomUUID === "function") return crypto.randomUUID();
    } catch { /* fallback below */ }
    return `${now}-${Math.random().toString(36).slice(2, 10)}`;
}

export function loadPromptHistory(): void {
    syncPromptHistory(readEntries());
}

export function recordPromptHistory(input: PromptHistoryInput): PromptHistoryEntry | null {
    const normalized: PromptHistoryInput = {
        prompt: normalizePrompt(input.prompt),
        coreType: normalizeField(input.coreType),
        version: normalizeField(input.version),
        skillIds: normalizeSkillIds(input.skillIds),
    };
    if (!normalized.prompt || !normalized.coreType || !normalized.version) return null;

    const entries = readEntries();
    const signature = entrySignature(normalized);
    const existingIndex = entries.findIndex(entry => entrySignature(entry) === signature);
    const existing = existingIndex >= 0 ? entries.splice(existingIndex, 1)[0] : null;
    const now = Date.now();
    const entry: PromptHistoryEntry = {
        id: existing?.id || createEntryId(now),
        ...normalized,
        createdAt: existing?.createdAt || now,
        lastUsedAt: now,
    };
    entries.unshift(entry);
    const stored = writeEntries(entries);
    syncPromptHistory(stored);
    return stored.find(item => item.id === entry.id) || null;
}

export function removePromptHistoryEntry(id: string): void {
    if (!id) return;
    const entries = readEntries().filter(entry => entry.id !== id);
    syncPromptHistory(writeEntries(entries));
}
