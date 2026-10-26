import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
const storage = vi.hoisted(() => new Map<string, any>());
vi.mock("../../src/logic/projectDb", () => ({
    dbGet: vi.fn(async (store: string, key: string) => storage.get(`${store}:${key}`)),
    dbPut: vi.fn(async (store: string, key: string, value: unknown) => { storage.set(`${store}:${key}`, value); }),
}));
import { loadBuildArtifact } from "../../src/logic/projectArtifacts";
const target = { projectKey: "live:alice:project", taskId: "task", revisionId: "revision-one", remoteAvailable: true };
beforeEach(() => { storage.clear(); storage.set(`projects:${target.projectKey}`, { meta: { taskId: "task" } }); });
afterEach(() => vi.unstubAllGlobals());
describe("local build artifacts", () => {
    it("persists the first download and works without the remote task afterwards", async () => {
        const remote = vi.fn(async () => new Response("jar-zip")); vi.stubGlobal("fetch", remote);
        const first = await loadBuildArtifact(target);
        expect(storage.get(`blobs:${target.projectKey}:build:revision-one`)).toBe(first);
        remote.mockRejectedValue(new Error("expired"));
        expect(await loadBuildArtifact({ ...target, remoteAvailable: false })).toBe(first);
        expect(remote).toHaveBeenCalledTimes(1);
    });
    it("deduplicates a click while background caching is downloading", async () => {
        let finish!: (response: Response) => void;
        const remote = vi.fn(() => new Promise<Response>(resolve => { finish = resolve; })); vi.stubGlobal("fetch", remote);
        const first = loadBuildArtifact(target), second = loadBuildArtifact(target);
        await vi.waitFor(() => expect(remote).toHaveBeenCalledTimes(1));
        finish(new Response("jar-zip"));
        expect(await first).toBe(await second);
    });
    it("keeps previous versions isolated and never fetches them using the current task", async () => {
        const remote = vi.fn(); vi.stubGlobal("fetch", remote);
        const previous = new Blob(["previous-build"]);
        storage.set(`blobs:${target.projectKey}:build:older`, previous);
        expect(await loadBuildArtifact({ ...target, revisionId: "older", remoteAvailable: false })).toBe(previous);
        await expect(loadBuildArtifact({ ...target, revisionId: "missing", remoteAvailable: false })).rejects.toThrow("尚未缓存在本地");
        expect(remote).not.toHaveBeenCalled();
    });
    it("does not save an artifact into a deleted or replaced project", async () => {
        vi.stubGlobal("fetch", vi.fn(async () => { storage.delete(`projects:${target.projectKey}`); return new Response("jar-zip"); }));
        await expect(loadBuildArtifact(target)).rejects.toThrow("工程已删除");
        expect(storage.has(`blobs:${target.projectKey}:build:revision-one`)).toBe(false);
    });
});
