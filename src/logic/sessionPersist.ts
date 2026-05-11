import { watch } from "vue";
import { chatBlocks, rehydrateBlocks } from "./chatState";
import type { ChatBlock } from "./chatState";
import { genTask } from "./generateState";
import type { GenPhase, GenTask } from "./generateState";

const STORAGE_KEY = "tahai-session-v1";

const INTERRUPTED_PHASES: GenPhase[] = [
    "planning", "clarifying", "awaiting_input",
    "generating", "verifying", "uploading",
    "building", "polling", "fixing",
];

let saveTimer: any = null;

function snapshot() {
    return {
        chatBlocks: chatBlocks.map(b => ({ ...b })),
        genTask: { ...genTask, files: genTask.files.map(f => ({ ...f })) },
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

    if (data.genTask && typeof data.genTask === "object") {
        const restored = data.genTask as Partial<GenTask>;
        Object.assign(genTask, restored);

        // 中断的进行中阶段 → error，避免 UI 永远卡住等 SSE/promise
        if (INTERRUPTED_PHASES.includes(genTask.phase)) {
            genTask.phase = "error";
            genTask.error = "刷新中断，请重新生成";
            genTask.streamingContent = "";
            genTask.streamingPhase = "";
            genTask.streamingFile = "";
            genTask.reasoningContent = "";
            genTask.clarifyTodos = [];
            genTask.moreInputHint = "";
        }
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
    watch(genTask, schedulePersist, { deep: true });
}
