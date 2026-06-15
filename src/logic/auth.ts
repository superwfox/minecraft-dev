import { reactive, ref } from "vue";

export type Tier = "diamond" | "gold" | "silver" | "none";

export interface QuotaInfo {
    freeRemaining: number;
    paidBalance: number;
    totalRecharged: number;
    remaining: number;
    tier: Tier;
}

// 个人收款档位（1 元 = 1 件）
export const SPONSOR_TIERS: { id: string; amount: number; label: string; badge: string }[] = [
    { id: "t25", amount: 25, label: "¥25", badge: "银徽" },
    { id: "t50", amount: 50, label: "¥50", badge: "金徽" },
];

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

/** 选档位 → 拿到专属备注码（转账时填写），登记待审 */
export async function requestSponsor(tier: string): Promise<{ ok: boolean; code?: string; amount?: number; reason?: string }> {
    const resp = await fetch("/api/sponsor/request", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ tier }),
    });
    return resp.json().catch(() => ({ ok: false, reason: "网络错误" }));
}
