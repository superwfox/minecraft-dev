// BYOK（自带 key）：银牌+ 用户可外接自己的 GLM key，所有 LLM 调用走自己的 key、跳过额度。
// 仅前端存储 + 每次请求带头；后端 _lib/llm.ts 再做银牌门校验。

import { reactive } from "vue";

const STORAGE_KEY = "tahai-byok";

export interface ByokState {
    enabled: boolean;
    provider: string; // 目前只有 "glm"
    key: string;
}

function load(): ByokState {
    try {
        const raw = localStorage.getItem(STORAGE_KEY);
        if (raw) {
            const o = JSON.parse(raw);
            return { enabled: !!o.enabled, provider: o.provider || "glm", key: o.key || "" };
        }
    } catch { /* ignore */ }
    return { enabled: false, provider: "glm", key: "" };
}

export const byok = reactive<ByokState>(load());

export function saveByok() {
    try {
        localStorage.setItem(STORAGE_KEY, JSON.stringify({ enabled: byok.enabled, provider: byok.provider, key: byok.key }));
    } catch { /* ignore */ }
}

/** 启用且有 key 时，返回要附加到 LLM 请求上的 BYOK 头；否则空对象 */
export function byokHeaders(): Record<string, string> {
    if (byok.enabled && byok.key.trim()) {
        return { "X-LLM-Provider": byok.provider, "X-LLM-Key": byok.key.trim() };
    }
    return {};
}
