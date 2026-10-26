import { reactive } from "vue";
import { dbList, dbPut, deleteProjectData, projectOwner } from "./projectDb";
export type PromptHistoryEntry = {
    id: string; prompt: string; coreType: string; version: string; skillIds: string[];
    createdAt: number; lastUsedAt: number; available?: boolean; phase?: string; taskId?: string;
};
export const promptHistory = reactive<PromptHistoryEntry[]>([]);
export async function loadPromptHistory() {
    const owner = projectOwner(); promptHistory.splice(0);
    if (!owner) return;
    const rows = await dbList<PromptHistoryEntry>("projects", `${owner}:`, value => value.meta);
    if (projectOwner() !== owner) return;
    promptHistory.push(...rows.map(row => row.value).sort((a, b) => b.lastUsedAt - a.lastUsedAt));
}
// New entries are recorded with real task snapshots rather than deduplicated prompts.
export function recordPromptHistory(_input: unknown) { return null; }
export async function removePromptHistoryEntry(id: string) {
    const owner = projectOwner(); if (!owner) return;
    const entry = promptHistory.find(row => row.id === id);
    await deleteProjectData(owner, id);
    if (entry?.taskId) await fetch(`/api/generate/task?taskId=${encodeURIComponent(entry.taskId)}`, { method: "DELETE" }).catch(() => {});
    if (projectOwner() === owner) await loadPromptHistory();
}
export async function migratePromptHistory(owner: string) {
    const key = "tahai-task-prompt-history-v1", raw = localStorage.getItem(key); if (!raw) return;
    const entries: any[] = JSON.parse(raw); if (!Array.isArray(entries)) return;
    for (const entry of entries) if (entry && typeof entry.prompt === "string" && typeof entry.id === "string") {
        const id = `legacy_${entry.id}`;
        await dbPut("projects", `${owner}:${id}`, { schemaVersion: 1, meta: { ...entry, id, available: false, phase: "legacy" } });
    }
    localStorage.removeItem(key);
}
