import { reactive, ref } from "vue";

export type Tier = "diamond" | "gold" | "silver" | "none";

export interface QuotaInfo {
    freeRemaining: number;
    paidBalance: number;
    totalRecharged: number;
    remaining: number;
    tier: Tier;
}

export const AFDIAN_URL = "https://afdian.com/a/beijihug";

export const authState = reactive({
    loaded: false,
    user: null as { login: string } | null,
    quota: null as QuotaInfo | null,
});

// 额度用尽弹窗开关
export const showSponsorModal = ref(false);

export const tierIcon: Record<Tier, string> = {
    diamond: "/diamond.png",
    gold: "/gold.png",
    silver: "/silver.png",
    none: "/icon.png",
};

export function currentLogo(): string {
    const tier = authState.quota?.tier ?? "none";
    return tierIcon[tier] ?? "/icon.png";
}

export async function fetchMe(): Promise<void> {
    try {
        const resp = await fetch("/api/auth/me");
        const data = await resp.json();
        authState.user = data.user ?? null;
        authState.quota = data.quota ?? null;
    } catch {
        /* 网络异常时保持未登录态 */
    } finally {
        authState.loaded = true;
    }
}

export function login(): void {
    const returnTo = location.pathname + location.search;
    location.href = `/api/auth/login?return_to=${encodeURIComponent(returnTo)}`;
}

export async function logout(): Promise<void> {
    try { await fetch("/api/auth/logout", { method: "POST" }); } catch { /* ignore */ }
    authState.user = null;
    authState.quota = null;
}

export async function redeemOrder(orderNo: string): Promise<{ ok: boolean; reason?: string; added?: number }> {
    const resp = await fetch("/api/sponsor/bind", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ orderNo }),
    });
    const data = await resp.json().catch(() => ({ ok: false, reason: "网络错误" }));
    if (data.ok && data.quota) authState.quota = data.quota;
    return data;
}
