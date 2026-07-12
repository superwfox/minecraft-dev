export interface TaskStoreEnv {
    DB?: D1Database;
    TASKS: KVNamespace;
}

interface TaskCostRecord {
    uid: string;
    total: number;
    consumed: number;
}

export interface StoredTaskCost {
    total: number;
    consumed: number;
}

const STATE_TTL_SECONDS = 3600;
const CHUNK_CHARACTERS = 300_000;
// Free plan allows 50 D1 statements per invocation. Reserve headroom for task read/cost/cleanup.
const MAX_CHUNKS = 40;

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

async function readD1Task(db: D1Database, taskId: string): Promise<string | null> {
    const result = await db.prepare(`
        SELECT c.payload
        FROM generation_tasks AS t
        JOIN generation_task_chunks AS c ON c.task_id = t.task_id
        WHERE t.task_id = ?1 AND t.expires_at > ?2
        ORDER BY c.chunk_index ASC
    `).bind(taskId, Date.now()).all<{ payload: string }>();
    if (!result.results.length) return null;
    return result.results.map((row) => row.payload).join("");
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
        `).bind(taskId, owner, total, consumed, now, expiresAt),
    ];

    for (let index = 0; index < chunks.length; index++) {
        statements.push(db.prepare(`
            INSERT INTO generation_task_chunks (task_id, chunk_index, payload)
            VALUES (?1, ?2, ?3)
            ON CONFLICT(task_id, chunk_index) DO UPDATE SET payload = excluded.payload
        `).bind(taskId, index, chunks[index]));
    }
    statements.push(db.prepare(`
        DELETE FROM generation_task_chunks
        WHERE task_id = ?1 AND chunk_index >= ?2
    `).bind(taskId, chunks.length));

    await db.batch(statements);
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
            if (raw !== null) return raw;

            const legacyRaw = await env.TASKS.get(taskId);
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
            ]);
            return legacyRaw;
        } catch (error) {
            console.warn("D1 task read failed; falling back to KV", error);
        }
    }
    return env.TASKS.get(taskId);
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
            console.warn("D1 task write failed; falling back to KV", error);
        }
    }
    await env.TASKS.put(taskId, raw, { expirationTtl });
}

/** Delete completed task data. Legacy KV entries expire naturally after the rollout window. */
export async function deleteTask(env: TaskStoreEnv, taskId: string): Promise<void> {
    if (env.DB) {
        try {
            await env.DB.batch([
                env.DB.prepare("DELETE FROM generation_task_chunks WHERE task_id = ?1").bind(taskId),
                env.DB.prepare("DELETE FROM generation_tasks WHERE task_id = ?1").bind(taskId),
            ]);
            return;
        } catch (error) {
            console.warn("D1 task delete failed; falling back to KV", error);
        }
    }
    await Promise.all([
        env.TASKS.delete(taskId),
        env.TASKS.delete(`taskCost:${taskId}`),
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
            RETURNING cost_total AS total, cost_consumed AS consumed
        `).bind(taskId, uid, delta, now, now + STATE_TTL_SECONDS * 1000)
            .first<{ total: number; consumed: number }>();
        return row
            ? { total: Number(row.total) || 0, consumed: Number(row.consumed) || 0 }
            : null;
    } catch (error) {
        console.warn("D1 task cost update failed; falling back to KV", error);
        return null;
    }
}

export async function getTaskCostFromD1(
    env: TaskStoreEnv,
    taskId: string,
): Promise<StoredTaskCost | null> {
    if (!env.DB) return null;
    try {
        const row = await env.DB.prepare(`
            SELECT cost_total AS total, cost_consumed AS consumed
            FROM generation_tasks
            WHERE task_id = ?1 AND expires_at > ?2
        `).bind(taskId, Date.now()).first<{ total: number; consumed: number }>();
        return row
            ? { total: Number(row.total) || 0, consumed: Number(row.consumed) || 0 }
            : null;
    } catch (error) {
        console.warn("D1 task cost read failed; falling back to KV", error);
        return null;
    }
}

export async function setTaskCostConsumedInD1(
    env: TaskStoreEnv,
    taskId: string,
    consumed: number,
): Promise<boolean> {
    if (!env.DB) return false;
    try {
        await env.DB.prepare(`
            UPDATE generation_tasks
            SET cost_consumed = MAX(cost_consumed, ?2), updated_at = ?3
            WHERE task_id = ?1
        `).bind(taskId, consumed, Date.now()).run();
        return true;
    } catch (error) {
        console.warn("D1 consumed-cost update failed", error);
        return false;
    }
}
