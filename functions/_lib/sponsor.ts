// 个人收款（支付宝 / 微信）+ 手动后台审批。
// 用户选档位 → 生成唯一备注码 → 存 pending → 转账时备注该码 →
// 站长在后台核对收款记录后一键「通过」→ 复用 quota.redeem(以备注码为去重 key) 发额度。
//
// KV（复用 TASKS 命名空间）：
//   pending:<code>      = { uid, login, amount, code, ts }   待审记录
//   pendingUser:<uid>   = <code>                              该用户当前备注码（稳定，便于复用）

export const SPONSOR_TIERS: { id: string; amount: number }[] = [
    { id: "t25", amount: 25 }, // 银徽
    { id: "t50", amount: 50 }, // 金徽
];

export function tierAmount(id: string): number | null {
    const t = SPONSOR_TIERS.find(x => x.id === id);
    return t ? t.amount : null;
}

// 自定义金额：不处理小数，floor 取整；范围 [1, 99999]
const MAX_CUSTOM = 99999;
export function normalizeAmount(raw: any): number | null {
    const n = Math.floor(Number(raw));
    if (!Number.isFinite(n) || n < 1) return null;
    return Math.min(n, MAX_CUSTOM);
}

export interface Pending {
    uid: string;
    login: string;
    amount: number;
    code: string;
    ts: number;
}

// 去掉易混字符 0/O/1/I
const CODE_CHARS = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789";
export function genCode(): string {
    const buf = new Uint8Array(6);
    crypto.getRandomValues(buf);
    let s = "";
    for (let i = 0; i < 6; i++) s += CODE_CHARS[buf[i] % CODE_CHARS.length];
    return "TH-" + s;
}

/** 站长鉴权：会话 uid == env.ADMIN_UID。宽容匹配——带不带 gh_ 前缀都认、忽略首尾空格，
 *  支持逗号分隔多个管理员。你的 uid 形如 gh_65709399（gh_ + GitHub 数字 id）。 */
export function isAdmin(uid: string | undefined | null, env: { ADMIN_UID?: string }): boolean {
    if (!uid || !env.ADMIN_UID) return false;
    const strip = (s: string) => s.trim().replace(/^gh_/, "");
    const me = strip(String(uid));
    return env.ADMIN_UID.split(",").some(a => strip(a) === me && me !== "");
}

const PENDING_TTL = 7 * 24 * 3600; // 7 天

/** 创建/复用该用户的待审记录（备注码稳定，仅更新金额，避免改档位后旧码失配） */
export async function upsertPending(
    kv: KVNamespace, uid: string, login: string, amount: number,
): Promise<Pending> {
    let code = await kv.get(`pendingUser:${uid}`);
    if (!code || !(await kv.get(`pending:${code}`))) {
        code = genCode();
        await kv.put(`pendingUser:${uid}`, code, { expirationTtl: PENDING_TTL });
    }
    const rec: Pending = { uid, login, amount, code, ts: Date.now() };
    await kv.put(`pending:${code}`, JSON.stringify(rec), { expirationTtl: PENDING_TTL });
    return rec;
}

export async function getPending(kv: KVNamespace, code: string): Promise<Pending | null> {
    const raw = await kv.get(`pending:${code}`);
    if (!raw) return null;
    try { return JSON.parse(raw) as Pending; } catch { return null; }
}

export async function deletePending(kv: KVNamespace, code: string, uid: string): Promise<void> {
    await kv.delete(`pending:${code}`);
    await kv.delete(`pendingUser:${uid}`);
}

export async function listPending(kv: KVNamespace): Promise<Pending[]> {
    const out: Pending[] = [];
    let cursor: string | undefined;
    do {
        const res = await kv.list({ prefix: "pending:", cursor });
        for (const k of res.keys) {
            const raw = await kv.get(k.name);
            if (!raw) continue;
            try { out.push(JSON.parse(raw) as Pending); } catch { /* skip */ }
        }
        cursor = "cursor" in res ? res.cursor : undefined;
    } while (cursor);
    out.sort((a, b) => b.ts - a.ts);
    return out;
}
