export interface TaskStoreEnv {
    DB?: D1Database;
    TASKS: KVNamespace;
}

interface TaskCostRecord {
    uid: string;
    total: number;
    consumed: number;
}

interface TaskChunkRow {
    payload: string;
    quota_exhausted: number;
}

export interface StoredTaskCost {
    total: number;
    consumed: number;
}

export type TaskPlannerLeaseMode = "d1";

const STATE_TTL_SECONDS = 3600;
const CHUNK_CHARACTERS = 300_000;
// Free plan allows 50 D1 statements per invocation. Reserve headroom for task read/cost/cleanup.
const MAX_CHUNKS = 40;

export class TaskOwnershipError extends Error {
    constructor() {
        super("Task ownership conflict");
        this.name = "TaskOwnershipError";
    }
}

export class TaskStoreUnavailableError extends Error {
    constructor(message = "D1 is required for Planner leases") {
        super(message);
        this.name = "TaskStoreUnavailableError";
    }
}

export function applyTaskQuotaExhausted(raw: string, exhausted: boolean): string {
    if (!exhausted) return raw;
    try {
        const state = JSON.parse(raw) as Record<string, unknown>;
        if (!state || typeof state !== "object" || Array.isArray(state)) return raw;
        state.quotaExhausted = true;
        return JSON.stringify(state);
    } catch {
        return raw;
    }
}

function splitState(raw: string): string[] {
    const chunks: string[] = [];
    let offset = 0;
    while (offset < raw.length) {
        let end = Math.min(raw.length, offset + CHUNK_CHARACTERS);
        const lastCodeUnit = raw.charCodeAt(end - 1);
        const nextCodeUnit = raw.charCodeAt(end);
        if (lastCodeUnit >= 0xD800 && lastCodeUnit <= 0xDBFF
            && nextCodeUnit >= 0xDC00 && nextCodeUnit <= 0xDFFF) {
            end--;
        }
        chunks.push(raw.slice(offset, end));
        offset = end;
    }
    if (!chunks.length) chunks.push("");
    if (chunks.length > MAX_CHUNKS) {
        throw new Error(`Task state is too large for D1 (${chunks.length} chunks)`);
    }
    return chunks;
}

async function readD1TaskOwner(db: D1Database, taskId: string): Promise<string | null> {
    const row = await db.prepare(`
        SELECT owner_uid
        FROM generation_tasks
        WHERE task_id = ?1
    `).bind(taskId).first<{ owner_uid: string }>();
    return row ? String(row.owner_uid ?? "") : null;
}

async function readD1Task(db: D1Database, taskId: string, ownerUid?: string): Promise<string | null> {
    const statement = ownerUid
        ? db.prepare(`
            SELECT c.payload, t.quota_exhausted
            FROM generation_tasks AS t
            JOIN generation_task_chunks AS c ON c.task_id = t.task_id
            WHERE t.task_id = ?1 AND t.owner_uid = ?3 AND t.expires_at > ?2
            ORDER BY c.chunk_index ASC
        `).bind(taskId, Date.now(), ownerUid)
        : db.prepare(`
            SELECT c.payload, t.quota_exhausted
            FROM generation_tasks AS t
            JOIN generation_task_chunks AS c ON c.task_id = t.task_id
            WHERE t.task_id = ?1 AND t.expires_at > ?2
            ORDER BY c.chunk_index ASC
        `).bind(taskId, Date.now());
    const result = await statement.all<TaskChunkRow>();
    if (!result.results.length) return null;
    const raw = result.results.map((row) => row.payload).join("");
    return applyTaskQuotaExhausted(raw, !!result.results[0]?.quota_exhausted);
}

async function writeD1Task(
    db: D1Database,
    taskId: string,
    raw: string,
    expirationTtl = STATE_TTL_SECONDS,
    ownerUid = "",
    legacyCost?: TaskCostRecord,
): Promise<void> {
    const chunks = splitState(raw);
    const now = Date.now();
    const expiresAt = now + Math.max(60, expirationTtl) * 1000;
    const total = legacyCost?.total ?? 0;
    const consumed = legacyCost?.consumed ?? 0;
    const owner = ownerUid || legacyCost?.uid || "";

    const statements: D1PreparedStatement[] = [
        db.prepare(`
            INSERT INTO generation_tasks (
                task_id, owner_uid, cost_total, cost_consumed, created_at, updated_at, expires_at
            ) VALUES (?1, ?2, ?3, ?4, ?5, ?5, ?6)
            ON CONFLICT(task_id) DO UPDATE SET
                owner_uid = CASE
                    WHEN generation_tasks.owner_uid = '' THEN excluded.owner_uid
                    ELSE generation_tasks.owner_uid
                END,
                cost_total = CASE
                    WHEN generation_tasks.cost_total = 0 THEN excluded.cost_total
                    ELSE generation_tasks.cost_total
                END,
                cost_consumed = CASE
                    WHEN generation_tasks.cost_consumed = 0 THEN excluded.cost_consumed
                    ELSE generation_tasks.cost_consumed
                END,
                updated_at = excluded.updated_at,
                expires_at = excluded.expires_at
            WHERE generation_tasks.owner_uid = ''
               OR generation_tasks.owner_uid = excluded.owner_uid
        `).bind(taskId, owner, total, consumed, now, expiresAt),
    ];

    for (let index = 0; index < chunks.length; index++) {
        statements.push(db.prepare(`
            INSERT INTO generation_task_chunks (task_id, chunk_index, payload)
            SELECT ?1, ?2, ?3
            WHERE EXISTS (
                SELECT 1 FROM generation_tasks
                WHERE task_id = ?1 AND owner_uid = ?4
            )
            ON CONFLICT(task_id, chunk_index) DO UPDATE SET payload = excluded.payload
        `).bind(taskId, index, chunks[index], owner));
    }
    statements.push(db.prepare(`
        DELETE FROM generation_task_chunks
        WHERE task_id = ?1 AND chunk_index >= ?2
          AND EXISTS (
              SELECT 1 FROM generation_tasks
              WHERE task_id = ?1 AND owner_uid = ?3
          )
    `).bind(taskId, chunks.length, owner));

    const results = await db.batch(statements);
    if (Number(results[0]?.meta?.changes) === 0) throw new TaskOwnershipError();
}

function taskQuotaKey(taskId: string): string {
    return `taskQuotaExhausted:${taskId}`;
}

function taskPlannerLeaseKey(taskId: string): string {
    return `taskPlannerLease:${taskId}`;
}

async function applyStoredTaskQuotaMarker(
    env: TaskStoreEnv,
    taskId: string,
    raw: string,
    ownerUid = "",
): Promise<string> {
    const markerOwner = await env.TASKS.get(taskQuotaKey(taskId));
    if (!markerOwner || (ownerUid && markerOwner !== ownerUid)) return raw;

    const overlaid = applyTaskQuotaExhausted(raw, true);
    if (!env.DB || !ownerUid) return overlaid;

    try {
        const row = await env.DB.prepare(`
            UPDATE generation_tasks
            SET quota_exhausted = 1, updated_at = ?3
            WHERE task_id = ?1 AND owner_uid = ?2
            RETURNING task_id
        `).bind(taskId, ownerUid, Date.now()).first<{ task_id: string }>();
        if (row) await env.TASKS.delete(taskQuotaKey(taskId));
    } catch (error) {
        console.warn("D1 task quota marker promotion failed", error);
    }
    return overlaid;
}

async function writeD1TaskWithPlannerLease(
    db: D1Database,
    taskId: string,
    raw: string,
    leaseToken: string,
    expirationTtl: number,
    ownerUid: string,
): Promise<boolean> {
    const chunks = splitState(raw);
    const now = Date.now();
    const expiresAt = now + Math.max(60, expirationTtl) * 1000;
    const statements: D1PreparedStatement[] = [
        db.prepare(`
            UPDATE generation_tasks
            SET updated_at = ?4, expires_at = ?5
            WHERE task_id = ?1 AND owner_uid = ?2 AND planner_lease_token = ?3
        `).bind(taskId, ownerUid, leaseToken, now, expiresAt),
    ];

    for (let index = 0; index < chunks.length; index++) {
        statements.push(db.prepare(`
            INSERT INTO generation_task_chunks (task_id, chunk_index, payload)
            SELECT ?1, ?2, ?3
            WHERE EXISTS (
                SELECT 1 FROM generation_tasks
                WHERE task_id = ?1 AND owner_uid = ?4 AND planner_lease_token = ?5
            )
            ON CONFLICT(task_id, chunk_index) DO UPDATE SET payload = excluded.payload
        `).bind(taskId, index, chunks[index], ownerUid, leaseToken));
    }
    statements.push(db.prepare(`
        DELETE FROM generation_task_chunks
        WHERE task_id = ?1 AND chunk_index >= ?2
          AND EXISTS (
              SELECT 1 FROM generation_tasks
              WHERE task_id = ?1 AND owner_uid = ?3 AND planner_lease_token = ?4
          )
    `).bind(taskId, chunks.length, ownerUid, leaseToken));
    statements.push(db.prepare(`
        UPDATE generation_tasks
        SET planner_lease_token = '', planner_lease_until = 0,
            updated_at = ?4, expires_at = ?5
        WHERE task_id = ?1 AND owner_uid = ?2 AND planner_lease_token = ?3
    `).bind(taskId, ownerUid, leaseToken, now, expiresAt));

    const results = await db.batch(statements);
    return Number(results[0]?.meta?.changes) > 0;
}

export async function acquireTaskPlannerLease(
    env: TaskStoreEnv,
    taskId: string,
    ownerUid: string,
    leaseToken: string,
    leaseMs: number,
): Promise<TaskPlannerLeaseMode | null> {
    if (!taskId || !ownerUid || !leaseToken) throw new TaskOwnershipError();
    if (!env.DB) throw new TaskStoreUnavailableError();

    const now = Date.now();
    const requestedLeaseMs = Number.isFinite(leaseMs) ? Math.floor(leaseMs) : 360_000;
    const boundedLeaseMs = Math.max(30_000, Math.min(600_000, requestedLeaseMs));
    const expiresAt = now + boundedLeaseMs;

    try {
        const row = await env.DB.prepare(`
            UPDATE generation_tasks
            SET planner_lease_token = ?3,
                planner_lease_until = ?4,
                updated_at = ?5,
                expires_at = MAX(expires_at, ?4)
            WHERE task_id = ?1 AND owner_uid = ?2
              AND (planner_lease_token = '' OR planner_lease_until <= ?5)
            RETURNING planner_lease_token
        `).bind(taskId, ownerUid, leaseToken, expiresAt, now)
            .first<{ planner_lease_token: string }>();
        if (row) return "d1";
        const storedOwner = await readD1TaskOwner(env.DB, taskId);
        if (storedOwner !== null && storedOwner !== ownerUid) throw new TaskOwnershipError();
        return null;
    } catch (error) {
        if (error instanceof TaskOwnershipError) throw error;
        console.warn("D1 planner lease acquisition failed", error);
        throw error;
    }
}

export async function renewTaskPlannerLease(
    env: TaskStoreEnv,
    taskId: string,
    ownerUid: string,
    leaseToken: string,
    leaseMs: number,
): Promise<boolean> {
    if (!taskId || !ownerUid || !leaseToken) throw new TaskOwnershipError();
    if (!env.DB) throw new TaskStoreUnavailableError();

    const now = Date.now();
    const requestedLeaseMs = Number.isFinite(leaseMs) ? Math.floor(leaseMs) : 360_000;
    const boundedLeaseMs = Math.max(30_000, Math.min(600_000, requestedLeaseMs));
    const expiresAt = now + boundedLeaseMs;
    const row = await env.DB.prepare(`
        UPDATE generation_tasks
        SET planner_lease_until = ?4,
            updated_at = ?5,
            expires_at = MAX(expires_at, ?4)
        WHERE task_id = ?1 AND owner_uid = ?2 AND planner_lease_token = ?3
        RETURNING planner_lease_token
    `).bind(taskId, ownerUid, leaseToken, expiresAt, now)
        .first<{ planner_lease_token: string }>();
    return !!row;
}

export async function putTaskWithPlannerLease(
    env: TaskStoreEnv,
    taskId: string,
    raw: string,
    leaseToken: string,
    leaseMode: TaskPlannerLeaseMode,
    expirationTtl = STATE_TTL_SECONDS,
    ownerUid = "",
): Promise<boolean> {
    if (!taskId || !ownerUid || !leaseToken) throw new TaskOwnershipError();
    if (leaseMode !== "d1" || !env.DB) return false;
    return writeD1TaskWithPlannerLease(
        env.DB,
        taskId,
        raw,
        leaseToken,
        expirationTtl,
        ownerUid,
    );
}

export async function releaseTaskPlannerLease(
    env: TaskStoreEnv,
    taskId: string,
    ownerUid: string,
    leaseToken: string,
    leaseMode: TaskPlannerLeaseMode,
): Promise<void> {
    if (!taskId || !ownerUid || !leaseToken || leaseMode !== "d1" || !env.DB) return;
    await env.DB.prepare(`
        UPDATE generation_tasks
        SET planner_lease_token = '', planner_lease_until = 0, updated_at = ?4
        WHERE task_id = ?1 AND owner_uid = ?2 AND planner_lease_token = ?3
    `).bind(taskId, ownerUid, leaseToken, Date.now()).run();
}

async function readKvTask(env: TaskStoreEnv, taskId: string): Promise<string | null> {
    const [raw, exhausted] = await Promise.all([
        env.TASKS.get(taskId),
        env.TASKS.get(taskQuotaKey(taskId)),
    ]);
    return raw === null ? null : applyTaskQuotaExhausted(raw, !!exhausted);
}

function parseLegacyCost(raw: string | null, fallbackUid: string): TaskCostRecord {
    if (!raw) return { uid: fallbackUid, total: 0, consumed: 0 };
    try {
        const parsed = JSON.parse(raw);
        return {
            uid: typeof parsed.uid === "string" ? parsed.uid : fallbackUid,
            total: Number(parsed.total) || 0,
            consumed: Number(parsed.consumed) || 0,
        };
    } catch {
        return { uid: fallbackUid, total: 0, consumed: 0 };
    }
}

/**
 * Read task state from D1. Existing KV-only tasks are migrated lazily on first access.
 * If D1 is unavailable or the schema has not been applied yet, KV remains a safe fallback.
 */
export async function getTask(env: TaskStoreEnv, taskId: string): Promise<string | null> {
    if (env.DB) {
        try {
            const raw = await readD1Task(env.DB, taskId);
            if (raw !== null) {
                let ownerUid = "";
                try {
                    const parsed = JSON.parse(raw) as { uid?: unknown };
                    ownerUid = typeof parsed.uid === "string" ? parsed.uid : "";
                } catch { /* marker overlay still applies without promotion */ }
                return applyStoredTaskQuotaMarker(env, taskId, raw, ownerUid);
            }

            const legacyRaw = await readKvTask(env, taskId);
            if (!legacyRaw) return null;
            const parsed = JSON.parse(legacyRaw) as { uid?: unknown };
            const ownerUid = typeof parsed.uid === "string" ? parsed.uid : "";
            const legacyCostRaw = await env.TASKS.get(`taskCost:${taskId}`);
            await writeD1Task(
                env.DB,
                taskId,
                legacyRaw,
                STATE_TTL_SECONDS,
                ownerUid,
                parseLegacyCost(legacyCostRaw, ownerUid),
            );
            await Promise.all([
                env.TASKS.delete(taskId),
                legacyCostRaw ? env.TASKS.delete(`taskCost:${taskId}`) : Promise.resolve(),
                env.TASKS.delete(taskQuotaKey(taskId)),
                env.TASKS.delete(taskPlannerLeaseKey(taskId)),
            ]);
            return legacyRaw;
        } catch (error) {
            console.warn("D1 task read failed; falling back to KV", error);
        }
    }
    return readKvTask(env, taskId);
}

/**
 * Read a task without disclosing whether a missing result was absent or owned by another user.
 * D1 is authoritative; KV-only preview tasks fall back to the uid stored in their JSON state.
 */
export async function getOwnedTask(
    env: TaskStoreEnv,
    taskId: string,
    ownerUid: string,
): Promise<string | null> {
    if (!ownerUid) return null;
    if (env.DB) {
        try {
            const storedOwner = await readD1TaskOwner(env.DB, taskId);
            if (storedOwner !== null) {
                if (storedOwner && storedOwner !== ownerUid) return null;
                const raw = await readD1Task(env.DB, taskId, storedOwner || undefined);
                if (raw === null) return null;
                if (storedOwner === ownerUid) {
                    return applyStoredTaskQuotaMarker(env, taskId, raw, ownerUid);
                }

                const parsed = JSON.parse(raw) as { uid?: unknown };
                if (parsed.uid !== ownerUid) return null;
                await writeD1Task(env.DB, taskId, raw, STATE_TTL_SECONDS, ownerUid);
                return applyStoredTaskQuotaMarker(env, taskId, raw, ownerUid);
            }

            const legacyRaw = await readKvTask(env, taskId);
            if (!legacyRaw) return null;
            const parsed = JSON.parse(legacyRaw) as { uid?: unknown };
            if (parsed.uid !== ownerUid) return null;
            const legacyCostRaw = await env.TASKS.get(`taskCost:${taskId}`);
            await writeD1Task(
                env.DB,
                taskId,
                legacyRaw,
                STATE_TTL_SECONDS,
                ownerUid,
                parseLegacyCost(legacyCostRaw, ownerUid),
            );
            await Promise.all([
                env.TASKS.delete(taskId),
                legacyCostRaw ? env.TASKS.delete(`taskCost:${taskId}`) : Promise.resolve(),
                env.TASKS.delete(taskQuotaKey(taskId)),
                env.TASKS.delete(taskPlannerLeaseKey(taskId)),
            ]);
            return legacyRaw;
        } catch (error) {
            if (error instanceof TaskOwnershipError) return null;
            console.warn("D1 owned task read failed; falling back to KV", error);
        }
    }
    const raw = await readKvTask(env, taskId);
    if (!raw) return null;
    try {
        const parsed = JSON.parse(raw) as { uid?: unknown };
        return parsed.uid === ownerUid ? raw : null;
    } catch {
        return null;
    }
}

/** Store task state in D1, with KV fallback for unbound preview/local environments. */
export async function putTask(
    env: TaskStoreEnv,
    taskId: string,
    raw: string,
    expirationTtl = STATE_TTL_SECONDS,
    ownerUid = "",
): Promise<void> {
    if (env.DB) {
        try {
            await writeD1Task(env.DB, taskId, raw, expirationTtl, ownerUid);
            return;
        } catch (error) {
            if (error instanceof TaskOwnershipError) throw error;
            console.warn("D1 task write failed; falling back to KV", error);
        }
    }
    if (ownerUid) {
        const existing = await env.TASKS.get(taskId);
        if (existing) {
            try {
                const parsed = JSON.parse(existing) as { uid?: unknown };
                if (parsed.uid !== ownerUid) throw new TaskOwnershipError();
            } catch (error) {
                if (error instanceof TaskOwnershipError) throw error;
                throw new TaskOwnershipError();
            }
        }
    }
    await env.TASKS.put(taskId, raw, { expirationTtl });
}

export async function markTaskQuotaExhausted(
    env: TaskStoreEnv,
    taskId: string,
    ownerUid: string,
): Promise<void> {
    if (!taskId || !ownerUid) throw new TaskOwnershipError();
    if (env.DB) {
        try {
            const row = await env.DB.prepare(`
                UPDATE generation_tasks
                SET quota_exhausted = 1, updated_at = ?3
                WHERE task_id = ?1 AND owner_uid = ?2
                RETURNING task_id
            `).bind(taskId, ownerUid, Date.now()).first<{ task_id: string }>();
            if (!row) throw new TaskOwnershipError();
            await env.TASKS.delete(taskQuotaKey(taskId)).catch(error =>
                console.warn("stale task quota marker cleanup failed", error));
            return;
        } catch (error) {
            if (error instanceof TaskOwnershipError) throw error;
            console.warn("D1 task quota marker failed; falling back to KV", error);
        }
    }

    const raw = await env.TASKS.get(taskId);
    if (raw) {
        try {
            const parsed = JSON.parse(raw) as { uid?: unknown };
            if (parsed.uid !== ownerUid) throw new TaskOwnershipError();
        } catch (error) {
            if (error instanceof TaskOwnershipError) throw error;
            throw new TaskOwnershipError();
        }
    }
    await env.TASKS.put(taskQuotaKey(taskId), ownerUid, { expirationTtl: STATE_TTL_SECONDS });
}

/** Delete completed task data only when it belongs to the authenticated owner. */
export async function deleteTask(env: TaskStoreEnv, taskId: string, ownerUid: string): Promise<void> {
    if (!ownerUid) return;
    if (env.DB) {
        try {
            await env.DB.batch([
                env.DB.prepare(`
                    DELETE FROM generation_task_chunks
                    WHERE task_id IN (
                        SELECT task_id FROM generation_tasks
                        WHERE task_id = ?1 AND owner_uid = ?2
                    )
                `).bind(taskId, ownerUid),
                env.DB.prepare(`
                    DELETE FROM generation_tasks
                    WHERE task_id = ?1 AND owner_uid = ?2
                `).bind(taskId, ownerUid),
            ]);
        } catch (error) {
            console.warn("D1 task delete failed; falling back to KV", error);
        }
    }
    const raw = await env.TASKS.get(taskId);
    if (!raw) {
        await Promise.all([
            env.TASKS.delete(`taskCost:${taskId}`),
            env.TASKS.delete(taskQuotaKey(taskId)),
            env.TASKS.delete(taskPlannerLeaseKey(taskId)),
        ]);
        return;
    }
    try {
        const parsed = JSON.parse(raw) as { uid?: unknown };
        if (parsed.uid !== ownerUid) return;
    } catch {
        return;
    }
    await Promise.all([
        env.TASKS.delete(taskId),
        env.TASKS.delete(`taskCost:${taskId}`),
        env.TASKS.delete(taskQuotaKey(taskId)),
        env.TASKS.delete(taskPlannerLeaseKey(taskId)),
    ]);
}

/** Opportunistically remove abandoned task rows; intended to run once per new task. */
export async function cleanupExpiredTasks(env: TaskStoreEnv, limit = 25): Promise<void> {
    if (!env.DB) return;
    const now = Date.now();
    const boundedLimit = Math.max(1, Math.min(100, Math.floor(limit)));
    await env.DB.batch([
        env.DB.prepare(`
            DELETE FROM generation_task_chunks
            WHERE task_id IN (
                SELECT task_id FROM generation_tasks
                WHERE expires_at <= ?1 ORDER BY expires_at ASC LIMIT ?2
            )
        `).bind(now, boundedLimit),
        env.DB.prepare(`
            DELETE FROM generation_tasks
            WHERE task_id IN (
                SELECT task_id FROM generation_tasks
                WHERE expires_at <= ?1 ORDER BY expires_at ASC LIMIT ?2
            )
        `).bind(now, boundedLimit),
    ]);
}

/** Atomically add cost in D1. Returns null when D1 is unavailable so callers can use KV. */
export async function addTaskCostInD1(
    env: TaskStoreEnv,
    taskId: string,
    uid: string,
    delta: number,
): Promise<StoredTaskCost | null> {
    if (!env.DB) return null;
    const now = Date.now();
    try {
        const row = await env.DB.prepare(`
            INSERT INTO generation_tasks (
                task_id, owner_uid, cost_total, cost_consumed, created_at, updated_at, expires_at
            ) VALUES (?1, ?2, ?3, 0, ?4, ?4, ?5)
            ON CONFLICT(task_id) DO UPDATE SET
                owner_uid = CASE
                    WHEN generation_tasks.owner_uid = '' THEN excluded.owner_uid
                    ELSE generation_tasks.owner_uid
                END,
                cost_total = generation_tasks.cost_total + excluded.cost_total,
                updated_at = excluded.updated_at,
                expires_at = MAX(generation_tasks.expires_at, excluded.expires_at)
            WHERE generation_tasks.owner_uid = ''
               OR generation_tasks.owner_uid = excluded.owner_uid
            RETURNING cost_total AS total, cost_consumed AS consumed
        `).bind(taskId, uid, delta, now, now + STATE_TTL_SECONDS * 1000)
            .first<{ total: number; consumed: number }>();
        if (!row) throw new TaskOwnershipError();
        return { total: Number(row.total) || 0, consumed: Number(row.consumed) || 0 };
    } catch (error) {
        if (error instanceof TaskOwnershipError) throw error;
        console.warn("D1 task cost update failed; falling back to KV", error);
        return null;
    }
}

export async function getTaskCostFromD1(
    env: TaskStoreEnv,
    taskId: string,
    ownerUid = "",
): Promise<StoredTaskCost | null> {
    if (!env.DB) return null;
    try {
        if (ownerUid) {
            const storedOwner = await readD1TaskOwner(env.DB, taskId);
            if (storedOwner && storedOwner !== ownerUid) throw new TaskOwnershipError();
        }
        const row = await env.DB.prepare(`
            SELECT cost_total AS total, cost_consumed AS consumed
            FROM generation_tasks
            WHERE task_id = ?1 AND expires_at > ?2
              AND (?3 = '' OR owner_uid = ?3)
        `).bind(taskId, Date.now(), ownerUid).first<{ total: number; consumed: number }>();
        return row
            ? { total: Number(row.total) || 0, consumed: Number(row.consumed) || 0 }
            : null;
    } catch (error) {
        if (error instanceof TaskOwnershipError) throw error;
        console.warn("D1 task cost read failed; falling back to KV", error);
        return null;
    }
}

export async function setTaskCostConsumedInD1(
    env: TaskStoreEnv,
    taskId: string,
    ownerUid: string,
    consumed: number,
): Promise<boolean> {
    if (!env.DB) return false;
    try {
        await env.DB.prepare(`
            UPDATE generation_tasks
            SET cost_consumed = MAX(cost_consumed, ?3), updated_at = ?4
            WHERE task_id = ?1 AND owner_uid = ?2
        `).bind(taskId, ownerUid, consumed, Date.now()).run();
        return true;
    } catch (error) {
        console.warn("D1 consumed-cost update failed", error);
        return false;
    }
}
