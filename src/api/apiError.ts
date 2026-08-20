export type ApiErrorInfo = {
    message: string;
    code: string;
};

const MAX_ERROR_TEXT_LENGTH = 600;
const HTML_BODY_RE = /^\s*(?:<!doctype\s+html|<html|<head|<body|<div\b)/i;

function compact(value: string, max = MAX_ERROR_TEXT_LENGTH): string {
    const normalized = value.trim().replace(/\s+/g, " ");
    return normalized.length > max ? `${normalized.slice(0, max)}…` : normalized;
}

function cloudflareRayId(value: string): string {
    const match = value.match(/Cloudflare Ray ID:\s*(?:<[^>]+>\s*)*([a-f0-9]{16,32})/i);
    return match?.[1] ?? "";
}

function cloudflareTimeoutMessage(raw: string): string {
    const rayId = cloudflareRayId(raw);
    return `模型服务响应超时（Cloudflare 524）${rayId ? `，Ray ID ${rayId}` : ""}，请稍后重试`;
}

export async function readApiError(
    response: Response,
    fallback = `请求失败（HTTP ${response.status}）`,
): Promise<ApiErrorInfo> {
    const raw = await response.text().catch(() => "");
    if (!raw) return { message: fallback, code: "" };

    try {
        const payload = JSON.parse(raw) as { error?: unknown; code?: unknown };
        return {
            message: typeof payload.error === "string" && payload.error.trim()
                ? compact(payload.error)
                : fallback,
            code: typeof payload.code === "string" ? payload.code : "",
        };
    } catch { /* upstream may return plain text or a Cloudflare HTML page */ }

    if (response.status === 524) {
        return { message: cloudflareTimeoutMessage(raw), code: "CLOUDFLARE_TIMEOUT" };
    }

    const contentType = response.headers.get("Content-Type")?.toLowerCase() ?? "";
    if (contentType.includes("text/html") || HTML_BODY_RE.test(raw)) {
        return { message: fallback, code: "HTML_ERROR_RESPONSE" };
    }

    return { message: compact(raw) || fallback, code: "" };
}

export async function responseError(
    response: Response,
    fallback = `请求失败（HTTP ${response.status}）`,
): Promise<Error> {
    const info = await readApiError(response, fallback);
    const error = new Error(info.message);
    (error as Error & { code?: string; status?: number }).code = info.code;
    (error as Error & { code?: string; status?: number }).status = response.status;
    return error;
}
