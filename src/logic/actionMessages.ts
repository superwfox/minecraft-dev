export type ActionMessageKind =
    | "progress"
    | "guidance"
    | "action_required"
    | "auth_required"
    | "quota_required"
    | "credential_required"
    | "interrupted"
    | "assistant_content"
    | "warning"
    | "error"
    | "success"
    | "helper";

export type ActionMessageMeta = {
    kind: ActionMessageKind;
    code?: string;
    status?: number;
};

const ACTION_MESSAGE_KINDS = new Set<ActionMessageKind>([
    "progress",
    "guidance",
    "action_required",
    "auth_required",
    "quota_required",
    "credential_required",
    "interrupted",
    "assistant_content",
    "warning",
    "error",
    "success",
    "helper",
]);

function errorFields(error: unknown): {code: string; status: number; noRetry: boolean} {
    if (!error || typeof error !== "object") return {code: "", status: 0, noRetry: false};
    const record = error as Record<string, unknown>;
    return {
        code: typeof record.code === "string" ? record.code.trim() : "",
        status: Number.isFinite(Number(record.status)) ? Number(record.status) : 0,
        noRetry: record.noRetry === true || record.terminal === true,
    };
}

function inferredKind(code: string, status: number, noRetry: boolean): ActionMessageKind {
    if (code === "DEEPSEEK_KEY_REQUIRED" || code === "LLM_AUTH_FAILED" || status === 428) {
        return "credential_required";
    }
    if (code === "QUOTA_REQUIRED" || code === "INSUFFICIENT_QUOTA" || status === 402) {
        return "quota_required";
    }
    if (code === "AUTH_REQUIRED" || status === 401 || status === 403) {
        return "auth_required";
    }
    if (status === 409 || status === 429
        || code.endsWith("_CONFLICT")
        || code.endsWith("_RECOVERY_REQUIRED")
        || code.endsWith("_IN_PROGRESS")
        || code === "TASK_OPERATION_IN_PROGRESS"
        || noRetry) {
        return "warning";
    }
    return "error";
}

export function actionMessageMetaForError(
    error: unknown,
    explicitKind?: ActionMessageKind,
): ActionMessageMeta {
    const {code, status, noRetry} = errorFields(error);
    return {
        kind: explicitKind || inferredKind(code, status, noRetry),
        ...(code ? {code} : {}),
        ...(status ? {status} : {}),
    };
}

export function normalizeActionMessageMeta(value: unknown): ActionMessageMeta | undefined {
    if (!value || typeof value !== "object") return undefined;
    const record = value as Record<string, unknown>;
    if (typeof record.kind !== "string" || !ACTION_MESSAGE_KINDS.has(record.kind as ActionMessageKind)) {
        return undefined;
    }
    const code = typeof record.code === "string" ? record.code.trim().slice(0, 120) : "";
    const status = Number(record.status);
    return {
        kind: record.kind as ActionMessageKind,
        ...(code ? {code} : {}),
        ...(Number.isInteger(status) && status >= 100 && status <= 599 ? {status} : {}),
    };
}

export function legacyActionMessageMeta(message: unknown): ActionMessageMeta | undefined {
    if (typeof message !== "string") return undefined;
    switch (message.trim()) {
        case "请先登录后再使用":
        case "请先登录后再使用（点击右上角「登录」）":
        case "登录已过期，请重新登录":
            return {kind: "auth_required", code: "AUTH_REQUIRED", status: 401};
        case "DeepSeek API Key 无效，请重新填写":
        case "当前任务需要 DeepSeek API Key，请重新配置后重试":
            return {kind: "credential_required", code: "LLM_AUTH_FAILED", status: 401};
        case "DeepSeek 账户余额不足，请充值后重试":
        case "DeepSeek 账户余额不足，请前往 DeepSeek 平台充值":
            return {kind: "quota_required", code: "INSUFFICIENT_QUOTA", status: 402};
        case "充值额度已用尽，请充值或填写 DeepSeek API Key":
        case "可用额度不足，请充值或填写 DeepSeek API Key":
            return {kind: "quota_required", code: "QUOTA_REQUIRED", status: 402};
        default:
            return undefined;
    }
}
