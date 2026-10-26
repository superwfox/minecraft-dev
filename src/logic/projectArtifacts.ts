import { dbGet, dbPut } from "./projectDb";

export interface BuildArtifactTarget {
    projectKey: string;
    revisionId: string;
    taskId: string;
    remoteAvailable: boolean;
}

const pending = new Map<string, Promise<Blob>>();

/** Downloads and background caching share one request; saved revisions work offline. */
export async function loadBuildArtifact(target: BuildArtifactTarget): Promise<Blob> {
    const key = `${target.projectKey}:build:${target.revisionId}`;
    const cached = await dbGet<Blob>("blobs", key);
    if (cached) return cached;
    if (!target.remoteAvailable) throw new Error("此版本的构建产物尚未缓存在本地；已有源码仍可下载。");
    const existing = pending.get(key);
    if (existing) return existing;
    const request = (async () => {
        const query = new URLSearchParams({ taskId: target.taskId, revisionId: target.revisionId });
        const response = await fetch(`/api/generate/download?${query}`);
        if (!response.ok) throw new Error("构建产物尚未缓存在本地，远程制品已过期或暂时无法下载。");
        const blob = await response.blob();
        if (!blob.size) throw new Error("构建产物为空，尚未保存到本地。");
        const project = await dbGet<any>("projects", target.projectKey);
        if (!project || project.meta.taskId !== target.taskId) throw new Error("工程已删除或远程任务已变更，已取消产物保存。");
        await dbPut("blobs", key, blob);
        return blob;
    })();
    pending.set(key, request);
    try { return await request; }
    finally { if (pending.get(key) === request) pending.delete(key); }
}
