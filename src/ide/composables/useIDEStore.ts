import {openDB, type IDBPDatabase} from "idb";
import {reactive, computed} from "vue";
import type {GeneratorType} from "../../logic/generateState";

export type IDEFile = {
    path: string;
    content: string;
    dirty: boolean;
    updatedAt: number;
    generatorType?: GeneratorType | null;
    role?: string;
};

export type IDESeedFile = {
    path: string;
    content: string;
    generatorType?: GeneratorType | null;
    role?: string;
};

export type ViewMode = "category" | "folder";

type StoreSchema = {
    files: {
        key: string;
        value: {
            taskId: string;
            path: string;
            content: string;
            updatedAt: number;
            generatorType?: GeneratorType | null;
            role?: string;
        };
    };
};

const DB_NAME = "tahai-ide";
const STORE = "files";
let dbPromise: Promise<IDBPDatabase<any>> | null = null;

function getDB() {
    if (!dbPromise) {
        dbPromise = openDB<StoreSchema>(DB_NAME, 1, {
            upgrade(db) {
                if (!db.objectStoreNames.contains(STORE)) {
                    const s = db.createObjectStore(STORE, {keyPath: ["taskId", "path"]});
                    s.createIndex("byTask", "taskId");
                }
            },
        });
    }
    return dbPromise;
}

const state = reactive<{
    taskId: string;
    files: IDEFile[];
    currentPath: string;
    openTabs: string[];
    collapsedFolders: Record<string, boolean>;
    collapsedCategories: Record<string, boolean>;
    cursor: { line: number; col: number };
    loading: boolean;
    sidebarWidth: number;
    viewMode: ViewMode;
}>({
    taskId: "",
    files: [],
    currentPath: "",
    openTabs: [],
    collapsedFolders: {},
    collapsedCategories: {},
    cursor: {line: 1, col: 1},
    loading: false,
    sidebarWidth: 280,
    viewMode: "category",
});

async function loadFromTask(taskId: string, seed: IDESeedFile[] = []) {
    state.loading = true;
    state.taskId = taskId;
    const db = await getDB();
    const idx = db.transaction(STORE).store.index("byTask");
    const saved = await idx.getAll(taskId);
    const savedMap = new Map(saved.map((r: any) => [r.path, r]));

    const merged: IDEFile[] = [];
    for (const f of seed) {
        const s = savedMap.get(f.path) as any;
        if (s) {
            merged.push({
                path: f.path,
                content: s.content,
                dirty: s.content !== f.content,
                updatedAt: s.updatedAt,
                generatorType: f.generatorType ?? s.generatorType ?? null,
                role: f.role ?? s.role ?? "",
            });
            savedMap.delete(f.path);
        } else {
            merged.push({
                path: f.path,
                content: f.content,
                dirty: false,
                updatedAt: Date.now(),
                generatorType: f.generatorType ?? null,
                role: f.role ?? "",
            });
        }
    }
    for (const extra of savedMap.values() as any) {
        merged.push({
            path: extra.path,
            content: extra.content,
            dirty: false,
            updatedAt: extra.updatedAt,
            generatorType: extra.generatorType ?? null,
            role: extra.role ?? "",
        });
    }

    state.files = merged;
    if (!state.currentPath && merged.length) state.currentPath = merged[0].path;
    if (state.currentPath && !state.openTabs.includes(state.currentPath)) {
        state.openTabs = [state.currentPath];
    }
    state.loading = false;
}

function updateContent(path: string, content: string) {
    const f = state.files.find(f => f.path === path);
    if (!f) return;
    f.content = content;
    f.dirty = true;
}

async function saveAll() {
    if (!state.taskId) return;
    const db = await getDB();
    const tx = db.transaction(STORE, "readwrite");
    const now = Date.now();
    for (const f of state.files) {
        if (f.dirty) {
            await tx.store.put({
                taskId: state.taskId,
                path: f.path,
                content: f.content,
                updatedAt: now,
                generatorType: f.generatorType ?? null,
                role: f.role ?? "",
            });
            f.dirty = false;
            f.updatedAt = now;
        }
    }
    await tx.done;
}

function toggleCategory(key: string) {
    state.collapsedCategories[key] = !state.collapsedCategories[key];
}

function setViewMode(m: ViewMode) {
    state.viewMode = m;
}

async function upsertFile(file: IDESeedFile) {
    const existing = state.files.find(f => f.path === file.path);
    if (existing) {
        existing.content = file.content;
        existing.dirty = true;
        if (file.generatorType !== undefined) existing.generatorType = file.generatorType;
        if (file.role !== undefined) existing.role = file.role;
    } else {
        state.files.push({
            path: file.path,
            content: file.content,
            dirty: true,
            updatedAt: Date.now(),
            generatorType: file.generatorType ?? null,
            role: file.role ?? "",
        });
    }
    state.currentPath = file.path;
    if (!state.openTabs.includes(file.path)) state.openTabs.push(file.path);
}

async function resetTask(taskId: string) {
    const db = await getDB();
    const tx = db.transaction(STORE, "readwrite");
    const idx = tx.store.index("byTask");
    let cur = await idx.openCursor(taskId);
    while (cur) {
        await cur.delete();
        cur = await cur.continue();
    }
    await tx.done;
    if (state.taskId === taskId) {
        state.files = [];
        state.openTabs = [];
        state.currentPath = "";
    }
}

function openFile(path: string) {
    state.currentPath = path;
    if (!state.openTabs.includes(path)) state.openTabs.push(path);
}

function closeTab(path: string) {
    const idx = state.openTabs.indexOf(path);
    if (idx === -1) return;
    state.openTabs.splice(idx, 1);
    if (state.currentPath === path) {
        state.currentPath = state.openTabs[idx] || state.openTabs[idx - 1] || state.openTabs[0] || "";
    }
}

function toggleFolder(folderPath: string) {
    state.collapsedFolders[folderPath] = !state.collapsedFolders[folderPath];
}

function setCursor(line: number, col: number) {
    state.cursor.line = line;
    state.cursor.col = col;
}

function setSidebarWidth(w: number) {
    state.sidebarWidth = Math.max(180, Math.min(600, w));
}

const currentFile = computed(() => state.files.find(f => f.path === state.currentPath) || null);
const dirtyCount = computed(() => state.files.filter(f => f.dirty).length);

export function useIDEStore() {
    return {
        state,
        currentFile,
        dirtyCount,
        loadFromTask,
        saveAll,
        updateContent,
        resetTask,
        openFile,
        closeTab,
        toggleFolder,
        toggleCategory,
        setCursor,
        setSidebarWidth,
        setViewMode,
        upsertFile,
    };
}
