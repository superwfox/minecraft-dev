import { watch } from "vue";
import { chatBlocks, rehydrateBlocks } from "./chatState";
import type { ChatBlock } from "./chatState";
const STORAGE_KEY = "tahai-session-v1";

let saveTimer: any = null;

function snapshot() {
    return {
        chatBlocks: chatBlocks.map(b => ({ ...b })),
    };
}

export function persistSession() {
    try {
        localStorage.setItem(STORAGE_KEY, JSON.stringify(snapshot()));
    } catch {
        // 配额超限或隐私模式 — 静默忽略
    }
}

function schedulePersist() {
    if (saveTimer) clearTimeout(saveTimer);
    saveTimer = setTimeout(persistSession, 300);
}

export function restoreSession() {
    let raw: string | null;
    try {
        raw = localStorage.getItem(STORAGE_KEY);
    } catch {
        return;
    }
    if (!raw) return;

    let data: any;
    try {
        data = JSON.parse(raw);
    } catch {
        return;
    }

    if (Array.isArray(data.chatBlocks)) {
        const validated = (data.chatBlocks as any[]).filter(
            b => b && Array.isArray(b.userMessages) && typeof b.id === "number",
        ) as ChatBlock[];
        rehydrateBlocks(validated);
    }
}

export function clearSession() {
    try {
        localStorage.removeItem(STORAGE_KEY);
    } catch {
        // ignore
    }
}

export function startSessionPersistence() {
    watch(chatBlocks, schedulePersist, { deep: true });
}
