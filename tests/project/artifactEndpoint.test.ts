import { afterEach, describe, expect, it, vi } from "vitest";
const mock = vi.hoisted(() => ({ state: {} as any, download: vi.fn() }));
vi.mock("../../functions/_lib/taskStore", () => ({ getOwnedTask: async () => JSON.stringify(mock.state) }));
vi.mock("../../functions/_lib/github", () => ({ downloadArtifact: mock.download, deleteBranch: vi.fn() }));
import { onRequestGet } from "../../functions/api/generate/download";
afterEach(() => vi.clearAllMocks());
const request = () => onRequestGet({ request: new Request("https://app.test/api/generate/download?taskId=task&revisionId=old"), env: {}, data: { uid: "alice" } } as any);
describe("build artifact revision binding", () => {
    it("does not cache a newer build under the requested old revision", async () => {
        mock.state = { status: "done", revisionId: "new", artifactId: 42 };
        expect((await request()).status).toBe(409);
        expect(mock.download).not.toHaveBeenCalled();
    });
    it("does not serve a previous success while the same task is being changed", async () => {
        mock.state = { status: "generating", revisionId: "old", artifactId: 42 };
        expect((await request()).status).toBe(409);
        expect(mock.download).not.toHaveBeenCalled();
    });
    it("returns matching completed artifacts with their revision", async () => {
        mock.state = { status: "done", revisionId: "old", artifactId: 42 };
        mock.download.mockResolvedValueOnce(new Response("jar-zip"));
        const response = await request();
        expect(response.status).toBe(200);
        expect(response.headers.get("X-Project-Revision")).toBe("old");
        expect(await response.text()).toBe("jar-zip");
    });
});
