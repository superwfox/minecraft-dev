// 额度与限流（基于 KV，复用 TASKS 命名空间，键各自前缀隔离）。
//
// 模型：
//   - 免费额度：每月 FREE_MONTHLY 件，每月 1 号清零（key free:<uid>:<yyyymm>）
//   - 充值额度：订单兑换得来的永久余额，不随月清零（存于 user:<uid>）
//   - 剩余 = 免费剩余 + 充值余额；扣费先扣免费、再扣充值
//   - 徽章档位按「累计充值金额」判定
//   - 订单去重：order:<outTradeNo> 标记已兑换
//
// 注意：KV 最终一致 + 读改写有竞态窗口，这里做的是「软限额」。
// 严格限流请叠加 Cloudflare WAF Rate Limiting。

export const FREE_MONTHLY = 5;
export const YUAN_PER_QUOTA = 1; // 1 元 = 1 件额度

export type Tier = "diamond" | "gold" | "silver" | "none";
const TIERS: { name: Exclude<Tier, "none">; min: number }[] = [
    { name: "diamond", min: 100 },
    { name: "gold", min: 50 },
    { name: "silver", min: 25 },
];

const IP_LIMIT_PER_MIN = 120;

function yyyymm(d = new Date()): string {
    return `${d.getUTCFullYear()}${String(d.getUTCMonth() + 1).padStart(2, "0")}`;
}

interface UserRec {
    paidBalance: number;     // 充值余额（件）
    totalRecharged: number;  // 累计充值金额（元）
}

async function getUser(kv: KVNamespace, uid: string): Promise<UserRec> {
    const raw = await kv.get(`user:${uid}`);
    if (!raw) return { paidBalance: 0, totalRecharged: 0 };
    try {
        const r = JSON.parse(raw);
        return { paidBalance: r.paidBalance || 0, totalRecharged: r.totalRecharged || 0 };
    } catch {
        return { paidBalance: 0, totalRecharged: 0 };
    }
}

async function putUser(kv: KVNamespace, uid: string, rec: UserRec): Promise<void> {
    await kv.put(`user:${uid}`, JSON.stringify(rec));
}

export function tierOf(totalRecharged: number): Tier {
    for (const t of TIERS) if (totalRecharged >= t.min) return t.name;
    return "none";
}

export interface QuotaInfo {
    freeRemaining: number;
    paidBalance: number;
    totalRecharged: number;
    remaining: number;
    tier: Tier;
}

export async function getQuota(kv: KVNamespace, uid: string): Promise<QuotaInfo> {
    const user = await getUser(kv, uid);
    const usedRaw = await kv.get(`free:${uid}:${yyyymm()}`);
    const used = usedRaw ? parseInt(usedRaw) || 0 : 0;
    const freeRemaining = Math.max(0, FREE_MONTHLY - used);
    return {
        freeRemaining,
        paidBalance: user.paidBalance,
        totalRecharged: user.totalRecharged,
        remaining: freeRemaining + user.paidBalance,
        tier: tierOf(user.totalRecharged),
    };
}

/** 扣 1 件：先扣免费，再扣充值。返回是否成功。 */
export async function consume(kv: KVNamespace, uid: string): Promise<boolean> {
    const month = yyyymm();
    const usedRaw = await kv.get(`free:${uid}:${month}`);
    const used = usedRaw ? parseInt(usedRaw) || 0 : 0;
    if (used < FREE_MONTHLY) {
        await kv.put(`free:${uid}:${month}`, String(used + 1), { expirationTtl: 40 * 24 * 3600 });
        return true;
    }
    const user = await getUser(kv, uid);
    if (user.paidBalance > 0) {
        user.paidBalance -= 1;
        await putUser(kv, uid, user);
        return true;
    }
    return false;
}

/** 兑换订单：增加充值余额与累计充值。订单去重。 */
export async function redeem(
    kv: KVNamespace, uid: string, outTradeNo: string, amount: number,
): Promise<{ ok: boolean; reason?: string; added?: number; quota?: QuotaInfo }> {
    const marker = await kv.get(`order:${outTradeNo}`);
    if (marker) return { ok: false, reason: "该订单已被兑换" };

    const added = Math.floor(amount * YUAN_PER_QUOTA);
    if (added <= 0) return { ok: false, reason: "订单金额无效" };

    const user = await getUser(kv, uid);
    user.paidBalance += added;
    user.totalRecharged += amount;
    await putUser(kv, uid, user);
    await kv.put(`order:${outTradeNo}`, uid); // 永久标记已兑换

    const quota = await getQuota(kv, uid);
    return { ok: true, added, quota };
}

/** 简单 IP 限流：每分钟窗口计数，超限返回 false。 */
export async function ipAllow(kv: KVNamespace, ip: string, limit = IP_LIMIT_PER_MIN): Promise<boolean> {
    const window = Math.floor(Date.now() / 60000);
    const key = `ip:${ip}:${window}`;
    const raw = await kv.get(key);
    const n = raw ? parseInt(raw) || 0 : 0;
    if (n >= limit) return false;
    await kv.put(key, String(n + 1), { expirationTtl: 120 });
    return true;
}
