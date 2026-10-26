import { afterEach, describe, expect, it, vi } from "vitest";
import { getJobLogs } from "../../functions/_lib/github";
afterEach(() => vi.unstubAllGlobals());
describe("Actions job log downloads", () => {
    it("does not forward the GitHub credential to signed storage", async () => {
        const remote = vi.fn().mockResolvedValueOnce(new Response(null, { status: 302, headers: { Location: "https://logs.blob.core.windows.net/job?signature=test" } })).mockResolvedValueOnce(new Response("actual Maven diagnostics"));
        vi.stubGlobal("fetch", remote);
        expect(await getJobLogs("private-token", 42)).toBe("actual Maven diagnostics");
        expect(remote.mock.calls[0][1].redirect).toBe("manual");
        expect(remote.mock.calls[0][1].headers.Authorization).toBe("Bearer private-token");
        expect(remote.mock.calls[1][1].headers).toBeUndefined();
    });
    it("does not download job logs over an insecure redirect", async () => {
        const remote = vi.fn(async () => new Response(null, { status: 302, headers: { Location: "http://logs.example/job" } })); vi.stubGlobal("fetch", remote);
        await expect(getJobLogs("private-token", 42)).rejects.toThrow("Invalid job log");
        expect(remote).toHaveBeenCalledTimes(1);
    });
    it("reports unavailable signed storage instead of treating the response as a log", async () => {
        vi.stubGlobal("fetch", vi.fn().mockResolvedValueOnce(new Response(null, { status: 302, headers: { Location: "https://logs.example/job" } })).mockResolvedValueOnce(new Response("denied", { status: 401 })));
        await expect(getJobLogs("private-token", 42)).rejects.toThrow("401");
    });
});
