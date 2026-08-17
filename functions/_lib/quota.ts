import {
    addTaskCostInD1,
    getTaskCostFromD1,
    setTaskCostConsumedInD1,
    TaskOwnershipError,
    type TaskStoreEnv,
} from "./taskStore";

// 用户额度与限流继续使用 KV；高频任务成本优先存入 D1。
//
// 模型：
//   - 免费额度已取消，freeRemaining 固定返回 0 以兼容旧客户端；
//   - 充值额度：订单兑换得来的永久余额，不随月清零（存于 user:<uid>）；
//   - 共享 DeepSeek 仅消耗充值余额，用户自带 key 的请求由调用方跳过额度与计费；
//   - 徽章档位按「累计充值金额」判定
//   - 订单去重：order:<outTradeNo> 标记已兑换
//
// 注意：KV 最终一致 + 读改写有竞态窗口，这里做的是「软限额」。
// 严格限流请叠加 Cloudflare WAF Rate Limiting。

export const FREE_MONTHLY = 0;
export const YUAN_PER_QUOTA = 1; // 1 元 = 1 件额度

// 单任务按金额累积扣费：跨过 COST_PER_QUOTA 元即追扣下一件
export const COST_PER_QUOTA = 0.8;

// DeepSeek 单价（元 / 百万 token）。cacheHit = 缓存命中输入，input = 未命中输入，output = 输出
export const MODEL_PRICING: Record<string, { cacheHit: number; input: number; output: number }> = {
    "deepseek-v4-flash": { cacheHit: 0.02, input: 1, output: 2 },
    "deepseek-v4-pro": { cacheHit: 0.025, input: 3, output: 6 },
};

// 构建端硬上限（单用户每日；不限制单任务次数）
export const MAX_BUILDS_PER_USER_DAY = 30;

export type Tier = "diamond" | "gold" | "silver" | "none";
const TIERS: { name: Exclude<Tier, "none">; min: number }[] = [
    { name: "diamond", min: 100 },
    { name: "gold", min: 50 },
    { name: "silver", min: 25 },
];

const IP_LIMIT_PER_MIN = 120;

export function yyyymmdd(d = new Date()): string {
    return `${d.getUTCFullYear()}${String(d.getUTCMonth() + 1).padStart(2, "0")}${String(d.getUTCDate()).padStart(2, "0")}`;
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
    return {
        freeRemaining: 0,
        paidBalance: user.paidBalance,
        totalRecharged: user.totalRecharged,
        remaining: user.paidBalance,
        tier: tierOf(user.totalRecharged),
    };
}

/** 仅检查会员档位时读取用户充值记录。 */
export async function getTier(kv: KVNamespace, uid: string): Promise<Tier> {
    return tierOf((await getUser(kv, uid)).totalRecharged);
}

/** 扣 1 件充值额度。返回是否成功。 */
export async function consume(kv: KVNamespace, uid: string): Promise<boolean> {
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
export async function ipAllow(
    kv: KVNamespace, ip: string, scope = "api", limit = IP_LIMIT_PER_MIN,
): Promise<boolean> {
    const window = Math.floor(Date.now() / 60000);
    // 按资源分 key，避免 plan → clarify 等相邻阶段在 1 秒内写同一个 KV key。
    const key = `ip:${scope}:${ip}:${window}`;
    const raw = await kv.get(key);
    const n = raw ? parseInt(raw) || 0 : 0;
    if (n >= limit) return false;
    await kv.put(key, String(n + 1), { expirationTtl: 120 });
    return true;
}

// ─── 按金额累积扣费 ───────────────────────────────────────

interface TaskCost { uid: string; total: number; consumed: number; }

function parseOwnedTaskCost(raw: string | null, uid: string): TaskCost {
    if (!raw) return { uid, total: 0, consumed: 0 };
    try {
        const parsed = JSON.parse(raw) as Partial<TaskCost>;
        if (parsed.uid && parsed.uid !== uid) throw new TaskOwnershipError();
        return {
            uid,
            total: Number(parsed.total) || 0,
            consumed: Number(parsed.consumed) || 0,
        };
    } catch (error) {
        if (error instanceof TaskOwnershipError) throw error;
        return { uid, total: 0, consumed: 0 };
    }
}

export interface UsageBreakdown {
    prompt_tokens?: number;
    completion_tokens?: number;
    prompt_cache_hit_tokens?: number;
    prompt_cache_miss_tokens?: number;
}

export interface UsageCostEntry {
    model: string;
    usage?: UsageBreakdown;
}

export function usageCost(model: string, u: UsageBreakdown): number {
    const p = MODEL_PRICING[model];
    if (!p) return 0;
    const hit = u.prompt_cache_hit_tokens ?? 0;
    const miss = u.prompt_cache_miss_tokens ?? Math.max(0, (u.prompt_tokens ?? 0) - hit);
    const out = u.completion_tokens ?? 0;
    return (hit * p.cacheHit + miss * p.input + out * p.output) / 1_000_000;
}

async function settleD1TaskQuota(
    env: TaskStoreEnv,
    uid: string,
    taskId: string,
    record: { total: number; consumed: number },
    prepaid = true,
): Promise<{ consumed: number; total: number; outOfQuota: boolean }> {
    let consumed = record.consumed;
    let outOfQuota = false;
    const target = prepaid
        ? Math.floor(record.total / COST_PER_QUOTA)
        : Math.ceil(record.total / COST_PER_QUOTA);
    while (consumed < target) {
        const ok = await consume(env.TASKS, uid);
        if (!ok) { outOfQuota = true; break; }
        consumed++;
    }
    if (consumed !== record.consumed) {
        let persisted = false;
        for (let attempt = 0; attempt < 3 && !persisted; attempt++) {
            persisted = await setTaskCostConsumedInD1(env, taskId, uid, consumed);
        }
        if (!persisted) {
            const latest = await getTaskCostFromD1(env, taskId, uid);
            if (!latest || latest.consumed < consumed) {
                throw new Error("D1 task quota settlement cursor update failed");
            }
        }
    }
    return { consumed, total: record.total, outOfQuota };
}

/** Reconcile quota consumption after a fenced operation atomically records its cost. */
export async function settleTaskCostQuota(
    env: TaskStoreEnv,
    uid: string,
    taskId: string,
): Promise<{ consumed: number; total: number; outOfQuota: boolean }> {
    const record = await getTaskCostFromD1(env, taskId, uid);
    if (!record) throw new Error("D1 task cost is unavailable");
    return settleD1TaskQuota(env, uid, taskId, record);
}

/**
 * 累积单任务 LLM 成本；跨过 COST_PER_QUOTA 阈值时自动扣额度。
 * 共享 DeepSeek 的 mode-1（plan 新建任务）已预扣 1 件覆盖首个 0~0.8 元区间，
 * 所以从第 2 件起按差额追扣；BYOK 请求不会进入本函数。
 * 余额耗尽时返回 outOfQuota=true，调用方应在 state 上打标记，下次入口拒绝。
 */
export async function accumulateCosts(
    env: TaskStoreEnv, uid: string, taskId: string,
    entries: UsageCostEntry[],
    prepaid = true,
): Promise<{ consumed: number; total: number; outOfQuota: boolean; delta: number }> {
    if (!entries.length || !taskId || !uid) return { consumed: 0, total: 0, outOfQuota: false, delta: 0 };
    const cost = entries.reduce((sum, entry) => sum + (entry.usage ? usageCost(entry.model, entry.usage) : 0), 0);
    if (cost <= 0) {
        const d1Rec = await getTaskCostFromD1(env, taskId, uid);
        if (d1Rec) return { ...d1Rec, outOfQuota: false, delta: 0 };
        const raw = await env.TASKS.get(`taskCost:${taskId}`);
        const rec = parseOwnedTaskCost(raw, uid);
        return { consumed: rec.consumed, total: rec.total, outOfQuota: false, delta: 0 };
    }

    const d1Rec = await addTaskCostInD1(env, taskId, uid, cost);
    if (d1Rec) {
        const settled = await settleD1TaskQuota(env, uid, taskId, d1Rec, prepaid);
        return { ...settled, delta: cost };
    }

    const key = `taskCost:${taskId}`;
    const raw = await env.TASKS.get(key);
    const rec = parseOwnedTaskCost(raw, uid);
    rec.total += cost;

    let outOfQuota = false;
    const target = prepaid
        ? Math.floor(rec.total / COST_PER_QUOTA)
        : Math.ceil(rec.total / COST_PER_QUOTA);
    while (rec.consumed < target) {
        const ok = await consume(env.TASKS, uid);
        if (!ok) { outOfQuota = true; break; }
        rec.consumed++;
    }
    await env.TASKS.put(key, JSON.stringify(rec), { expirationTtl: 3 * 24 * 3600 });
    return { consumed: rec.consumed, total: rec.total, outOfQuota, delta: cost };
}

/** 单次调用兼容入口；同一请求包含多次 LLM 调用时优先使用 accumulateCosts 批量结算。 */
export async function accumulateCost(
    env: TaskStoreEnv, uid: string, taskId: string,
    model: string, usage?: UsageBreakdown, prepaid = true,
): Promise<{ consumed: number; total: number; outOfQuota: boolean; delta: number }> {
    if (!usage) return { consumed: 0, total: 0, outOfQuota: false, delta: 0 };
    return accumulateCosts(env, uid, taskId, [{ model, usage }], prepaid);
}

export async function getTaskCost(
    env: TaskStoreEnv, taskId: string,
): Promise<{ total: number; consumed: number }> {
    const d1Rec = await getTaskCostFromD1(env, taskId);
    if (d1Rec) return d1Rec;
    const raw = await env.TASKS.get(`taskCost:${taskId}`);
    if (!raw) return { total: 0, consumed: 0 };
    try {
        const r = JSON.parse(raw);
        return { total: r.total || 0, consumed: r.consumed || 0 };
    } catch {
        return { total: 0, consumed: 0 };
    }
}

// ─── 构建端日上限 ─────────────────────────────────────────

/** 单用户每日构建次数：返回 false 即拒绝；不预扣，仅在通过其它检查后再 increment。 */
export async function userBuildCheck(
    kv: KVNamespace, uid: string, limit = MAX_BUILDS_PER_USER_DAY,
): Promise<{ ok: boolean; used: number }> {
    const day = yyyymmdd();
    const key = `userBuild:${uid}:${day}`;
    const raw = await kv.get(key);
    const used = raw ? parseInt(raw) || 0 : 0;
    return { ok: used < limit, used };
}

export async function userBuildIncrement(
    kv: KVNamespace, uid: string, currentUsed: number,
): Promise<void> {
    const day = yyyymmdd();
    const key = `userBuild:${uid}:${day}`;
    await kv.put(key, String(currentUsed + 1), { expirationTtl: 2 * 24 * 3600 });
}
