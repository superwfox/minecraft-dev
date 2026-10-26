import { watch } from "vue";
import { genTask, resetGenTask, restoreGenTask } from "./generateState";
import { chatBlocks, rehydrateBlocks, resetChat } from "./chatState";
import { authState } from "./auth";
import { selected, setSelectedSkills } from "./skills";
import { dbGet, dbPut, dbPutMany, dbList, projectOwner, projectStorage, requestProjectPersistence } from "./projectDb";
import { loadPromptHistory, migratePromptHistory, type PromptHistoryEntry } from "./promptHistory";
import { redact } from "../../shared/projectArchive";
import { deepSeekKeyState, fetchWithByokFallback } from "./byok";
export interface LocalProject { schemaVersion: 1; meta: PromptHistoryEntry; ui: any; chat: any[]; skills: string[]; checkpoint?: any; seal?: string; journalCursor?: number; journalCursors?: Record<string, number>; journalIncomplete?: boolean; journalPending?: boolean }
let activeId = "", timer: ReturnType<typeof setTimeout>, started = false, switching = false;
let queue = Promise.resolve();
const clone = <T>(value: T): T => JSON.parse(JSON.stringify(value));
export const activeProjectId = () => activeId;
export const activeProjectKey = () => activeId && projectOwner() ? `${projectOwner()}:${activeId}` : "";
export async function currentProject() { const key = activeProjectKey(); return key ? dbGet<LocalProject>("projects", key) : undefined; }
export async function saveProjectNow() {
    const owner = projectOwner(); if (!owner || switching || !genTask.userPrompt || genTask.phase === "idle") return;
    activeId ||= crypto.randomUUID();
    const id = activeId, key = `${owner}:${id}`, snapshot = clone(redact(genTask, [deepSeekKeyState.key])), chat = clone(redact(chatBlocks, [deepSeekKeyState.key])), skills = [...selected];
    queue = queue.catch(() => {}).then(async () => {
        const existing = await dbGet<LocalProject>("projects", key);
        const record: LocalProject = { ...existing, schemaVersion: 1, meta: { id, prompt: snapshot.userPrompt, coreType: snapshot.coreType, version: snapshot.version, skillIds: skills, createdAt: existing?.meta.createdAt || Date.now(), lastUsedAt: Date.now(), available: true, phase: snapshot.phase, taskId: snapshot.taskId }, ui: snapshot, chat, skills };
        await dbPutMany([{ store: "projects", key, value: record }, { store: "meta", key: `${owner}:active`, value: id }]);
        if (projectOwner() === owner) await loadPromptHistory();
    });
    return queue;
}
let syncing: Promise<void> | null = null, resync = false;
export function syncProjectCheckpoint(): Promise<void> {
    if (syncing) { resync = true; return syncing; }
    syncing = (async () => { do { resync = false; await syncCheckpointOnce(); } while (resync); })().finally(() => { syncing = null; });
    return syncing;
}
async function syncCheckpointOnce() {
        await saveProjectNow(); const key = activeProjectKey(), taskId = genTask.taskId;
        if (!key || !taskId) return;
        const previousContents = new Map(genTask.files.map(file => [file.path, file.content]));
        const response = await fetchWithByokFallback(`/api/generate/checkpoint?taskId=${encodeURIComponent(taskId)}`);
        if (!response.ok) return;
        const payload: any = await response.json(), record = await dbGet<LocalProject>("projects", key);
        if (!record || record.meta.taskId !== taskId) return;
        record.checkpoint = payload.checkpoint; record.seal = payload.seal;
        const files = new Map<string, string>((payload.checkpoint.generatedFiles || []).map((file: any) => [file.path, file.content]));
        record.ui.files = record.ui.files.map((file: any) => files.has(file.path) ? { ...file, content: files.get(file.path) } : file);
        if (activeProjectKey() === key && genTask.taskId === taskId && genTask.tree?.revision === payload.checkpoint.tree?.revision) for (const file of genTask.files) if (files.has(file.path) && file.content === previousContents.get(file.path)) file.content = files.get(file.path);
        let cursor = record.journalCursors?.[taskId] || 0, more = true;
        while (more) {
            const result: any = await fetch(`/api/generate/journal?taskId=${encodeURIComponent(taskId)}&cursor=${cursor}`).then(r => r.ok ? r.json() : null);
            if (!result) { record.journalIncomplete = true; break; }
            for (const event of result.events || []) await dbPut("events", `${key}:${taskId}:${String(event.sequence).padStart(14, "0")}`, event);
            record.journalIncomplete ||= !!result.incomplete; record.journalPending = !!result.pending; cursor = result.cursor; more = result.more;
        }
        queue = queue.catch(() => {}).then(async () => {
            const latest = await dbGet<LocalProject>("projects", key); if (!latest || latest.meta.taskId !== taskId) return;
            await dbPutMany([
                { store: "projects", key, value: { ...latest, checkpoint: record.checkpoint, seal: record.seal, journalCursor: cursor, journalCursors: { ...latest.journalCursors, [taskId]: cursor }, journalIncomplete: record.journalIncomplete || latest.journalIncomplete, journalPending: record.journalPending } },
                { store: "versions", key: `${key}:${payload.checkpoint.revisionId || "initial"}`, value: { checkpoint: payload.checkpoint, seal: payload.seal, savedAt: Date.now(), ui: latest.ui } },
            ]);
        });
        await queue;
}
export async function archiveCurrentVersion() { await syncProjectCheckpoint(); }
export async function restoreLocalProject(id: string) {
    await saveProjectNow(); const owner = projectOwner(), key = `${owner}:${id}`, record = await dbGet<LocalProject>("projects", key);
    if (projectOwner() !== owner) return;
    if (!record?.ui) throw new Error("旧记录没有工程快照，仅能复制提示词");
    switching = true;
    try {
        resetGenTask();
        const saved = clone(record.ui);
        for (const key of Object.keys(genTask)) {
            const value = saved[key], original = (genTask as any)[key];
            if (value !== undefined && (Array.isArray(original) ? Array.isArray(value) : original === null ? value === null || typeof value === "object" : typeof value === typeof original)) (genTask as any)[key] = value;
        }
        if (!["idle", "creating", "clarifying", "awaiting_input", "tree_planning", "tree_confirming", "generating", "verifying", "uploading", "building", "fixing", "interrupted", "done", "error"].includes(genTask.phase)) genTask.phase = "error";
        for (const file of genTask.files) { const source = record.checkpoint?.generatedFiles?.find((item: any) => item.path === file.path); if (source && file.content === undefined) file.content = source.content; }
        if (!["done", "error", "idle", "interrupted"].includes(genTask.phase)) { genTask.interruptedFrom = genTask.phase as Exclude<typeof genTask.phase, "interrupted">; genTask.phase = "interrupted"; }
        genTask.streamingPhase = ""; genTask.preflightActive = false;
        rehydrateBlocks(clone(record.chat || [])); setSelectedSkills(record.skills || []); activeId = id;
        await dbPut("meta", `${owner}:active`, id);
        window.dispatchEvent(new Event("project-restored"));
    } finally { switching = false; }
}
export async function beginLocalProject() { await saveProjectNow(); activeId = crypto.randomUUID(); }
export async function localVersions() { const key = activeProjectKey(); return key ? dbList<any>("versions", `${key}:`, value => ({ savedAt: value.savedAt, checkpoint: { revisionId: value.checkpoint?.revisionId } })) : []; }
export function startProjectPersistence() {
    if (started) return; started = true;
    (globalThis as any).__tahaiProjectPersistence = true;
    window.addEventListener("project-checkpoint", () => { if (!switching) saveProjectNow().catch(() => {}); });
    window.addEventListener("pagehide", () => { saveProjectNow().catch(() => {}); });
    document.addEventListener("visibilitychange", () => { if (document.hidden) saveProjectNow().catch(() => {}); });
    watch(() => authState.user?.id || authState.user?.login, async (login, previous) => {
        switching = true;
        try {
            if (previous !== undefined && previous !== login) { window.dispatchEvent(new Event("project-owner-change")); resetGenTask(); resetChat(); }
            activeId = ""; if (!login) { await loadPromptHistory(); return; }
            const owner = projectOwner();
            await requestProjectPersistence(); await migratePromptHistory(owner);
            const legacyKey = location.pathname === "/.tree-preview.html" ? "tahai-gentask-preview" : "tahai-gentask";
            if (localStorage.getItem(legacyKey)) {
                restoreGenTask(); switching = false;
                if (genTask.userPrompt) await saveProjectNow();
                switching = true; localStorage.removeItem(legacyKey); localStorage.removeItem("tahai-session-v1");
            }
            const id = await dbGet<string>("meta", `${owner}:active`);
            switching = false;
            if (id && (await dbGet<LocalProject>("projects", `${owner}:${id}`))?.ui) await restoreLocalProject(id);
            await loadPromptHistory();
        } catch (error) { projectStorage.error = `工程恢复失败：${String(error)}`; } finally { switching = false; }
    }, { immediate: true });
    watch([genTask, chatBlocks], () => { if (switching) return; clearTimeout(timer); timer = setTimeout(() => saveProjectNow().catch(() => {}), 400); }, { deep: true });
    watch(() => [genTask.phase, genTask.currentIndex, genTask.tree?.revision, genTask.currentBucket], () => {
        if (!switching && genTask.taskId) queueMicrotask(() => syncProjectCheckpoint().catch(() => { projectStorage.error ||= "服务端工程快照尚未同步，本地已保存的内容仍可恢复。"; }));
    });
}
