// 蓝图持久化 —— 前端 IndexedDB(bluemap §2.5 必含节点位置)。
// 用独立库 tahai-blueprint,避免与 useIDEStore 的 tahai-ide(version 1)升级冲突。

import { openDB, type IDBPDatabase } from "idb";
import type { BlueprintDoc } from "./model";

const DB_NAME = "tahai-blueprint";
const STORE = "docs";
let dbPromise: Promise<IDBPDatabase<any>> | null = null;

function getDB() {
    if (!dbPromise) {
        dbPromise = openDB(DB_NAME, 1, {
            upgrade(db) {
                if (!db.objectStoreNames.contains(STORE)) {
                    db.createObjectStore(STORE, { keyPath: "taskId" });
                }
            },
        });
    }
    return dbPromise;
}

export async function loadDoc(taskId: string): Promise<BlueprintDoc | null> {
    if (!taskId) return null;
    try {
        const db = await getDB();
        const raw = await db.get(STORE, taskId);
        return (raw as BlueprintDoc) || null;
    } catch {
        return null;
    }
}

export async function saveDoc(doc: BlueprintDoc): Promise<void> {
    if (!doc.taskId) return;
    try {
        const db = await getDB();
        // 存普通对象,剥离可能的响应式包装
        await db.put(STORE, JSON.parse(JSON.stringify(doc)));
    } catch { /* IndexedDB 不可用时忽略 */ }
}
