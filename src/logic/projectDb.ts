import { reactive } from "vue";
import { authState } from "./auth";
export const projectStorage = reactive({ error: "", persistent: false, ready: false });
export type StoreName = "projects" | "versions" | "blobs" | "events" | "drafts" | "meta";
let database: Promise<IDBDatabase>;
export const projectOwner = () => authState.user?.login ? `${location.pathname.includes("preview") ? "preview" : "live"}:${authState.user.id || authState.user.login.toLowerCase()}` : "";
function fail(error: unknown) {
    projectStorage.error = (error as any)?.name === "QuotaExceededError" ? "浏览器空间不足，工程尚未保存。请导出或删除不需要的历史。" : "本地工程保存失败，请勿清除页面；可先下载源码与 Debug。";
}
function openDb() {
    return database ??= new Promise<IDBDatabase>((resolve, reject) => {
        if (typeof indexedDB === "undefined") { reject(new Error("IndexedDB unavailable")); return; }
        const request = indexedDB.open("tahai-projects", 1);
        request.onupgradeneeded = () => { for (const name of ["projects", "versions", "blobs", "events", "drafts", "meta"]) request.result.createObjectStore(name); };
        request.onerror = () => { database = undefined; reject(request.error); };
        request.onblocked = () => { projectStorage.error = "工程数据库升级被其他标签页阻止，请关闭旧标签页。"; };
        request.onsuccess = () => { request.result.onversionchange = () => { request.result.close(); database = undefined; }; projectStorage.ready = true; resolve(request.result); };
    });
}
export async function dbGet<T>(store: StoreName, key: string): Promise<T | undefined> {
    try { const db = await openDb(); return await new Promise((resolve, reject) => { const req = db.transaction(store).objectStore(store).get(key); req.onsuccess = () => resolve(req.result); req.onerror = () => reject(req.error); }); }
    catch (error) { fail(error); throw error; }
}
export async function dbPut(store: StoreName, key: string, value: unknown) {
    try {
        const db = await openDb(); await new Promise<void>((resolve, reject) => { const tx = db.transaction(store, "readwrite"); tx.objectStore(store).put(value, key); tx.oncomplete = () => resolve(); tx.onabort = tx.onerror = () => reject(tx.error); }); projectStorage.error = "";
    } catch (error) { fail(error); throw error; }
}
export async function dbPutMany(entries: Array<{ store: StoreName; key: string; value: unknown }>) {
    try {
        const db = await openDb(); await new Promise<void>((resolve, reject) => {
            const tx = db.transaction([...new Set(entries.map(entry => entry.store))], "readwrite");
            for (const entry of entries) tx.objectStore(entry.store).put(entry.value, entry.key);
            tx.oncomplete = () => resolve(); tx.onabort = tx.onerror = () => reject(tx.error);
        });
        projectStorage.error = "";
    } catch (error) { fail(error); throw error; }
}
export async function dbList<T>(store: StoreName, prefix: string, select?: (value: any) => T): Promise<Array<{ key: string; value: T }>> {
    const db = await openDb(); return new Promise((resolve, reject) => {
        const request = db.transaction(store).objectStore(store).openCursor(IDBKeyRange.bound(prefix, `${prefix}\uffff`));
        const rows: Array<{ key: string; value: T }> = [];
        request.onsuccess = () => { const cursor = request.result; if (!cursor) { resolve(rows); return; } rows.push({ key: String(cursor.key), value: select ? select(cursor.value) : cursor.value }); cursor.continue(); };
        request.onerror = () => reject(request.error);
    });
}
export async function deleteProjectData(owner: string, id: string) {
    const db = await openDb(), prefix = `${owner}:${id}`;
    await new Promise<void>((resolve, reject) => {
        const tx = db.transaction(["projects", "versions", "blobs", "events", "drafts", "meta"], "readwrite");
        const active = tx.objectStore("meta").get(`${owner}:active`);
        active.onsuccess = () => { if (active.result === id) tx.objectStore("meta").delete(`${owner}:active`); };
        for (const name of ["projects", "versions", "blobs", "events", "drafts"]) {
            const store = tx.objectStore(name); store.delete(prefix);
            const req = store.openKeyCursor(IDBKeyRange.bound(`${prefix}:`, `${prefix}:\uffff`));
            req.onsuccess = () => { const cursor = req.result; if (cursor) { store.delete(cursor.primaryKey); cursor.continue(); } };
        }
        tx.oncomplete = () => resolve(); tx.onerror = tx.onabort = () => reject(tx.error);
    });
}
export async function requestProjectPersistence() { try { projectStorage.persistent = await navigator.storage?.persist?.() || false; } catch {} }
