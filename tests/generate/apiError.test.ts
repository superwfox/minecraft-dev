import { describe, expect, it } from "vitest";
import { readApiError, responseError } from "../../src/api/apiError";

describe("API error normalization", () => {
    it("preserves structured API errors", async () => {
        const response = new Response(JSON.stringify({
            error: "Planner 处理超时，请重试",
            code: "PLANNER_TIMEOUT",
        }), {
            status: 504,
            headers: { "Content-Type": "application/json" },
        });

        await expect(readApiError(response)).resolves.toEqual({
            message: "Planner 处理超时，请重试",
            code: "PLANNER_TIMEOUT",
        });
    });

    it("collapses a Cloudflare 524 HTML page and retains its Ray ID", async () => {
        const response = new Response(`<!doctype html><html><body>
            <span>Cloudflare Ray ID: <strong>a2b63de80a48bda0</strong></span>
        </body></html>`, {
            status: 524,
            headers: { "Content-Type": "text/html; charset=UTF-8" },
        });

        const result = await readApiError(response);
        expect(result).toEqual({
            message: "模型服务响应超时（Cloudflare 524），Ray ID a2b63de80a48bda0，请稍后重试",
            code: "CLOUDFLARE_TIMEOUT",
        });
        expect(result.message).not.toContain("<html>");
    });

    it("does not expose an arbitrary upstream HTML error body", async () => {
        const response = new Response("<html><body>proxy internals</body></html>", {
            status: 502,
            headers: { "Content-Type": "text/html" },
        });

        await expect(readApiError(response, "模型服务请求失败")).resolves.toEqual({
            message: "模型服务请求失败",
            code: "HTML_ERROR_RESPONSE",
        });
    });

    it("keeps short plain-text errors useful", async () => {
        const response = new Response("Task not found", { status: 404 });
        const error = await responseError(response);
        expect(error.message).toBe("Task not found");
        expect((error as Error & { code?: string }).code).toBe("");
    });
});
