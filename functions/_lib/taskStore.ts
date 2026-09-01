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
    planner_lease_token: string;
    planner_lease_until: number;
}

export interface StoredTaskCost {
    total: number;
    consumed: number;
}

export type TaskOperationLeaseMode = "d1";
export type TaskPlannerLeaseMode = TaskOperationLeaseMode;

export interface TaskOperationLease {
    token: string;
    leaseUntil: number;
}

export const TASK_STATE_TTL_SECONDS = 3600;
const STATE_TTL_SECONDS = TASK_STATE_TTL_SECONDS;
const CHUNK_CHARACTERS = 300_000;
// Free plan allows 50 D1 statements per invocation. Reserve headroom for task read/cost/cleanup.
const MAX_CHUNKS = 40;
const TASK_OPERATION_FENCE_FIELD = "__taskOperationFence";
const TASK_OPERATION_LEASE_UNTIL_FIELD = "__taskOperationLeaseUntil";
const D1_NOW_MS_SQL = "CAST(strftime('%s', 'now') AS INTEGER) * 1000";
const verifiedTaskSchemas = new WeakSet<object>();

export class TaskOwnershipError extends Error {
    constructor() {
        super("Task ownership conflict");
        this.name = "TaskOwnershipError";
    }
}

export class TaskStoreUnavailableError extends Error {
    constructor(message = "D1 is required for task operation leases") {
        super(message);
        this.name = "TaskStoreUnavailableError";
    }
}

/**
 * Bound D1 databases must be migrated before accepting a new task. Without this
 * check, mode-1 can write a task successfully and the following Clarify read can
 * fail on a newer column, then incorrectly fall back to an empty KV record.
 */
export async function assertBoundTaskStoreSchema(env: TaskStoreEnv): Promise<void> {
    if (!env.DB) return;
    const dbKey = env.DB as unknown as object;
    if (verifiedTaskSchemas.has(dbKey)) return;

    try {
        const [tableResult, columnResult] = await Promise.all([
            env.DB.prepare(`
                SELECT name
                FROM sqlite_master
                WHERE type = 'table'
                  AND name IN ('generation_tasks', 'generation_task_chunks')
            `).all<{ name: string }>(),
            env.DB.prepare("PRAGMA table_info(generation_tasks)").all<{ name: string }>(),
        ]);

        const tables = new Set((tableResult.results ?? []).map(row => String(row.name ?? "")));
        const columns = new Set((columnResult.results ?? []).map(row => String(row.name ?? "")));
        const requiredTables = ["generation_tasks", "generation_task_chunks"];
        const requiredColumns = [
            "task_id",
            "owner_uid",
            "cost_total",
            "cost_consumed",
            "created_at",
            "updated_at",
            "expires_at",
            "quota_exhausted",
            "planner_lease_token",
            "planner_lease_until",
        ];
        const missingTables = requiredTables.filter(name => !tables.has(name));
        const missingColumns = requiredColumns.filter(name => !columns.has(name));

        if (missingTables.length || missingColumns.length) {
            const migrations = new Set<string>();
            if (missingTables.length || missingColumns.some(name => ![
                "quota_exhausted",
                "planner_lease_token",
                "planner_lease_until",
            ].includes(name))) {
                migrations.add("0001_generation_tasks.sql");
            }
            if (missingColumns.includes("quota_exhausted")) {
                migrations.add("0003_generation_task_quota.sql");
            }
            if (missingColumns.includes("planner_lease_token")
                || missingColumns.includes("planner_lease_until")) {
                migrations.add("0004_generation_task_planner_lease.sql");
            }
            throw new TaskStoreUnavailableError(
                `D1 数据库未完成升级，请执行 ${[...migrations].join("、")}`,
            );
        }

        verifiedTaskSchemas.add(dbKey);
    } catch (error) {
        if (error instanceof TaskStoreUnavailableError) throw error;
        console.warn("D1 task schema check failed", error);
        throw new TaskStoreUnavailableError("无法校验 D1 任务数据库结构，请检查 DB binding 与 migrations");
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

function applyAuthoritativeTaskQuota(raw: string, exhausted: boolean): string {
    if (exhausted) return applyTaskQuotaExhausted(raw, true);
    try {
        const state = JSON.parse(raw) as Record<string, unknown>;
        if (!state || typeof state !== "object" || Array.isArray(state)) return raw;
        if (!("quotaExhausted" in state)) return raw;
        delete state.quotaExhausted;
        return JSON.stringify(state);
    } catch {
        return raw;
    }
}

function parseTaskState(raw: string): Record<string, unknown> | null {
    try {
        const state = JSON.parse(raw) as unknown;
        return state && typeof state === "object" && !Array.isArray(state)
            ? state as Record<string, unknown>
            : null;
    } catch {
        return null;
    }
}

function prepareTaskStateForStorage(raw: string): { raw: string; expectedFence: string } {
    const state = parseTaskState(raw);
    if (!state) return { raw, expectedFence: "" };
    const expectedFence = typeof state[TASK_OPERATION_FENCE_FIELD] === "string"
        ? String(state[TASK_OPERATION_FENCE_FIELD])
        : "";
    delete state[TASK_OPERATION_FENCE_FIELD];
    delete state[TASK_OPERATION_LEASE_UNTIL_FIELD];
    return { raw: JSON.stringify(state), expectedFence };
}

function applyTaskOperationMetadataToState(
    state: Record<string, unknown>,
    token: string,
    leaseUntil: number,
): void {
    state[TASK_OPERATION_FENCE_FIELD] = token;
    state[TASK_OPERATION_LEASE_UNTIL_FIELD] = Math.max(0, Number(leaseUntil) || 0);
}

function applyTaskOperationMetadata(raw: string, token: string, leaseUntil: number): string {
    const state = parseTaskState(raw);
    if (!state) return raw;
    applyTaskOperationMetadataToState(state, token, leaseUntil);
    return JSON.stringify(state);
}

export function taskOperationLeaseFromState(state: unknown): TaskOperationLease | null {
    if (!state || typeof state !== "object" || Array.isArray(state)) return null;
    const record = state as Record<string, unknown>;
    const hasFence = Object.prototype.hasOwnProperty.call(record, TASK_OPERATION_FENCE_FIELD);
    const hasLeaseUntil = Object.prototype.hasOwnProperty.call(record, TASK_OPERATION_LEASE_UNTIL_FIELD);
    if (!hasFence && !hasLeaseUntil) return null;
    const token = typeof record[TASK_OPERATION_FENCE_FIELD] === "string"
        ? String(record[TASK_OPERATION_FENCE_FIELD])
        : "";
    const leaseUntil = Math.max(0, Number(record[TASK_OPERATION_LEASE_UNTIL_FIELD]) || 0);
    return { token, leaseUntil };
}

function operationCompletionFence(leaseToken: string): string {
    return `fence:${leaseToken}`;
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

async function readD1TaskIgnoringExpiration(db: D1Database, taskId: string): Promise<string | null> {
    const result = await db.prepare(`
        SELECT c.payload
        FROM generation_tasks AS t
        JOIN generation_task_chunks AS c ON c.task_id = t.task_id
        WHERE t.task_id = ?1
        ORDER BY c.chunk_index ASC
    `).bind(taskId).all<{ payload: string }>();
    if (!result.results.length) return null;
    return result.results.map(row => row.payload).join("");
}

async function readD1Task(db: D1Database, taskId: string, ownerUid?: string): Promise<string | null> {
    const statement = ownerUid
        ? db.prepare(`
            SELECT c.payload, t.quota_exhausted,
                   t.planner_lease_token, t.planner_lease_until
            FROM generation_tasks AS t
            JOIN generation_task_chunks AS c ON c.task_id = t.task_id
            WHERE t.task_id = ?1 AND t.owner_uid = ?3 AND t.expires_at > ?2
            ORDER BY c.chunk_index ASC
        `).bind(taskId, Date.now(), ownerUid)
        : db.prepare(`
            SELECT c.payload, t.quota_exhausted,
                   t.planner_lease_token, t.planner_lease_until
            FROM generation_tasks AS t
            JOIN generation_task_chunks AS c ON c.task_id = t.task_id
            WHERE t.task_id = ?1 AND t.expires_at > ?2
            ORDER BY c.chunk_index ASC
        `).bind(taskId, Date.now());
    const result = await statement.all<TaskChunkRow>();
    if (!result.results.length) return null;
    const raw = result.results.map((row) => row.payload).join("");
    const first = result.results[0];
    return applyTaskOperationMetadata(
        applyAuthoritativeTaskQuota(raw, !!first?.quota_exhausted),
        String(first?.planner_lease_token ?? ""),
        Number(first?.planner_lease_until) || 0,
    );
}

async function writeD1Task(
    db: D1Database,
    taskId: string,
    raw: string,
    expirationTtl = STATE_TTL_SECONDS,
    ownerUid = "",
    legacyCost?: TaskCostRecord,
): Promise<string> {
    const preparedState = prepareTaskStateForStorage(raw);
    const chunks = splitState(preparedState.raw);
    const createdAt = Date.now();
    const expirationMs = Math.max(60, expirationTtl) * 1000;
    const total = legacyCost?.total ?? 0;
    const consumed = legacyCost?.consumed ?? 0;
    const owner = ownerUid || legacyCost?.uid || "";
    const writeToken = `write:${crypto.randomUUID()}`;
    const finalFence = `state:${crypto.randomUUID()}`;

    const statements: D1PreparedStatement[] = [
        db.prepare(`
            INSERT INTO generation_tasks (
                task_id, owner_uid, cost_total, cost_consumed, created_at, updated_at, expires_at,
                planner_lease_token, planner_lease_until
            ) VALUES (
                ?1, ?2, ?3, ?4, ?5, ${D1_NOW_MS_SQL}, ${D1_NOW_MS_SQL} + ?6, ?7, 0
            )
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
                updated_at = ${D1_NOW_MS_SQL},
                expires_at = ${D1_NOW_MS_SQL} + ?6,
                planner_lease_token = ?7,
                planner_lease_until = 0
            WHERE (generation_tasks.owner_uid = ''
               OR generation_tasks.owner_uid = excluded.owner_uid)
              AND (generation_tasks.expires_at <= ${D1_NOW_MS_SQL}
               OR (generation_tasks.planner_lease_token = ?8
                AND generation_tasks.planner_lease_until <= ${D1_NOW_MS_SQL}))
        `).bind(
            taskId,
            owner,
            total,
            consumed,
            createdAt,
            expirationMs,
            writeToken,
            preparedState.expectedFence,
        ),
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
        `).bind(taskId, index, chunks[index], owner, writeToken));
    }
    statements.push(db.prepare(`
        DELETE FROM generation_task_chunks
        WHERE task_id = ?1 AND chunk_index >= ?2
          AND EXISTS (
              SELECT 1 FROM generation_tasks
              WHERE task_id = ?1 AND owner_uid = ?3 AND planner_lease_token = ?4
          )
    `).bind(taskId, chunks.length, owner, writeToken));
    statements.push(db.prepare(`
        UPDATE generation_tasks
        SET planner_lease_token = ?3, planner_lease_until = 0,
            updated_at = ${D1_NOW_MS_SQL}, expires_at = ${D1_NOW_MS_SQL} + ?4
        WHERE task_id = ?1 AND owner_uid = ?2 AND planner_lease_token = ?5
    `).bind(taskId, owner, finalFence, expirationMs, writeToken));

    const results = await db.batch(statements);
    const committed = Number(results[0]?.meta?.changes) > 0
        && Number(results[results.length - 1]?.meta?.changes) > 0;
    if (!committed) throw new TaskOwnershipError();
    return finalFence;
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

async function writeD1TaskWithOperationLease(
    db: D1Database,
    taskId: string,
    raw: string,
    leaseToken: string,
    expirationTtl: number,
    ownerUid: string,
    releaseLease: boolean,
    costDelta = 0,
): Promise<boolean> {
    const preparedState = prepareTaskStateForStorage(raw);
    const chunks = splitState(preparedState.raw);
    const expirationMs = Math.max(60, expirationTtl) * 1000;
    const writeToken = `write:${crypto.randomUUID()}`;
    const finalToken = releaseLease ? operationCompletionFence(leaseToken) : leaseToken;
    const normalizedCostDelta = Number.isFinite(costDelta) ? Math.max(0, costDelta) : 0;
    const statements: D1PreparedStatement[] = [
        db.prepare(`
            UPDATE generation_tasks
            SET planner_lease_token = ?4,
                cost_total = cost_total + ?6,
                updated_at = ${D1_NOW_MS_SQL},
                expires_at = ${D1_NOW_MS_SQL} + ?5
            WHERE task_id = ?1 AND owner_uid = ?2
              AND planner_lease_token = ?3
              AND planner_lease_until > ${D1_NOW_MS_SQL}
        `).bind(taskId, ownerUid, leaseToken, writeToken, expirationMs, normalizedCostDelta),
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
        `).bind(taskId, index, chunks[index], ownerUid, writeToken));
    }
    statements.push(db.prepare(`
        DELETE FROM generation_task_chunks
        WHERE task_id = ?1 AND chunk_index >= ?2
          AND EXISTS (
              SELECT 1 FROM generation_tasks
              WHERE task_id = ?1 AND owner_uid = ?3 AND planner_lease_token = ?4
          )
    `).bind(taskId, chunks.length, ownerUid, writeToken));
    statements.push(db.prepare(`
        UPDATE generation_tasks
        SET planner_lease_token = ?3,
            planner_lease_until = CASE WHEN ?4 = 1 THEN 0 ELSE planner_lease_until END,
            updated_at = ${D1_NOW_MS_SQL},
            expires_at = ${D1_NOW_MS_SQL} + ?5
        WHERE task_id = ?1 AND owner_uid = ?2 AND planner_lease_token = ?6
    `).bind(taskId, ownerUid, finalToken, releaseLease ? 1 : 0, expirationMs, writeToken));

    const results = await db.batch(statements);
    return Number(results[0]?.meta?.changes) > 0
        && Number(results[results.length - 1]?.meta?.changes) > 0;
}

export async function acquireTaskOperationLease(
    env: TaskStoreEnv,
    taskId: string,
    ownerUid: string,
    leaseToken: string,
    leaseMs: number,
): Promise<TaskOperationLeaseMode | null> {
    if (!taskId || !ownerUid || !leaseToken) throw new TaskOwnershipError();
    if (!env.DB) throw new TaskStoreUnavailableError();

    const requestedLeaseMs = Number.isFinite(leaseMs) ? Math.floor(leaseMs) : 360_000;
    const boundedLeaseMs = Math.max(30_000, Math.min(600_000, requestedLeaseMs));

    try {
        const row = await env.DB.prepare(`
            UPDATE generation_tasks
            SET planner_lease_token = ?3,
                planner_lease_until = ${D1_NOW_MS_SQL} + ?4,
                updated_at = ${D1_NOW_MS_SQL},
                expires_at = MAX(expires_at, ${D1_NOW_MS_SQL} + ?4)
            WHERE task_id = ?1 AND owner_uid = ?2
              AND planner_lease_until <= ${D1_NOW_MS_SQL}
            RETURNING planner_lease_token
        `).bind(taskId, ownerUid, leaseToken, boundedLeaseMs)
            .first<{ planner_lease_token: string }>();
        if (row) return "d1";
        const storedOwner = await readD1TaskOwner(env.DB, taskId);
        if (storedOwner !== null && storedOwner !== ownerUid) throw new TaskOwnershipError();
        return null;
    } catch (error) {
        if (error instanceof TaskOwnershipError) throw error;
        console.warn("D1 task operation lease acquisition failed", error);
        throw error;
    }
}

export async function renewTaskOperationLease(
    env: TaskStoreEnv,
    taskId: string,
    ownerUid: string,
    leaseToken: string,
    leaseMs: number,
): Promise<boolean> {
    if (!taskId || !ownerUid || !leaseToken) throw new TaskOwnershipError();
    if (!env.DB) throw new TaskStoreUnavailableError();

    const requestedLeaseMs = Number.isFinite(leaseMs) ? Math.floor(leaseMs) : 360_000;
    const boundedLeaseMs = Math.max(30_000, Math.min(600_000, requestedLeaseMs));
    const row = await env.DB.prepare(`
        UPDATE generation_tasks
        SET planner_lease_until = ${D1_NOW_MS_SQL} + ?4,
            updated_at = ${D1_NOW_MS_SQL},
            expires_at = MAX(expires_at, ${D1_NOW_MS_SQL} + ?4)
        WHERE task_id = ?1 AND owner_uid = ?2
          AND planner_lease_token = ?3
          AND planner_lease_until > ${D1_NOW_MS_SQL}
        RETURNING planner_lease_token
    `).bind(taskId, ownerUid, leaseToken, boundedLeaseMs)
        .first<{ planner_lease_token: string }>();
    return !!row;
}

export async function acquireTaskPlannerLease(
    env: TaskStoreEnv,
    taskId: string,
    ownerUid: string,
    leaseToken: string,
    leaseMs: number,
): Promise<TaskPlannerLeaseMode | null> {
    return acquireTaskOperationLease(env, taskId, ownerUid, leaseToken, leaseMs);
}

export async function renewTaskPlannerLease(
    env: TaskStoreEnv,
    taskId: string,
    ownerUid: string,
    leaseToken: string,
    leaseMs: number,
): Promise<boolean> {
    return renewTaskOperationLease(env, taskId, ownerUid, leaseToken, leaseMs);
}

export async function getTaskOperationLease(
    env: TaskStoreEnv,
    taskId: string,
    ownerUid: string,
): Promise<TaskOperationLease | null> {
    if (!taskId || !ownerUid) throw new TaskOwnershipError();
    if (!env.DB) throw new TaskStoreUnavailableError();
    const row = await env.DB.prepare(`
        SELECT planner_lease_token, planner_lease_until
        FROM generation_tasks
        WHERE task_id = ?1 AND owner_uid = ?2
    `).bind(taskId, ownerUid).first<{
        planner_lease_token: string;
        planner_lease_until: number;
    }>();
    if (row) {
        return {
            token: String(row.planner_lease_token ?? ""),
            leaseUntil: Math.max(0, Number(row.planner_lease_until) || 0),
        };
    }
    const storedOwner = await readD1TaskOwner(env.DB, taskId);
    if (storedOwner !== null && storedOwner !== ownerUid) throw new TaskOwnershipError();
    return null;
}

export async function putTaskWithOperationLease(
    env: TaskStoreEnv,
    taskId: string,
    raw: string,
    leaseToken: string,
    leaseMode: TaskOperationLeaseMode,
    expirationTtl = STATE_TTL_SECONDS,
    ownerUid = "",
    releaseLease = false,
): Promise<boolean> {
    if (!taskId || !ownerUid || !leaseToken) throw new TaskOwnershipError();
    if (leaseMode !== "d1" || !env.DB) return false;
    return writeD1TaskWithOperationLease(
        env.DB,
        taskId,
        raw,
        leaseToken,
        expirationTtl,
        ownerUid,
        releaseLease,
    );
}

/** Atomically persist fenced task state and add one already-priced LLM cost delta. */
export async function putTaskWithOperationLeaseAndCost(
    env: TaskStoreEnv,
    taskId: string,
    raw: string,
    leaseToken: string,
    leaseMode: TaskOperationLeaseMode,
    costDelta: number,
    expirationTtl = STATE_TTL_SECONDS,
    ownerUid = "",
    releaseLease = false,
): Promise<boolean> {
    if (!taskId || !ownerUid || !leaseToken) throw new TaskOwnershipError();
    if (leaseMode !== "d1" || !env.DB) return false;
    return writeD1TaskWithOperationLease(
        env.DB,
        taskId,
        raw,
        leaseToken,
        expirationTtl,
        ownerUid,
        releaseLease,
        costDelta,
    );
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
    return putTaskWithOperationLease(
        env,
        taskId,
        raw,
        leaseToken,
        leaseMode,
        expirationTtl,
        ownerUid,
        true,
    );
}

export async function releaseTaskOperationLease(
    env: TaskStoreEnv,
    taskId: string,
    ownerUid: string,
    leaseToken: string,
    leaseMode: TaskOperationLeaseMode,
): Promise<boolean> {
    if (!taskId || !ownerUid || !leaseToken || leaseMode !== "d1" || !env.DB) return false;
    const result = await env.DB.prepare(`
        UPDATE generation_tasks
        SET planner_lease_token = ?4, planner_lease_until = 0,
            updated_at = ${D1_NOW_MS_SQL}
        WHERE task_id = ?1 AND owner_uid = ?2 AND planner_lease_token = ?3
    `).bind(taskId, ownerUid, leaseToken, operationCompletionFence(leaseToken)).run();
    return Number(result.meta?.changes) > 0;
}

export async function releaseTaskPlannerLease(
    env: TaskStoreEnv,
    taskId: string,
    ownerUid: string,
    leaseToken: string,
    leaseMode: TaskPlannerLeaseMode,
): Promise<boolean> {
    return releaseTaskOperationLease(env, taskId, ownerUid, leaseToken, leaseMode);
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
            const fence = await writeD1Task(
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
            return applyTaskOperationMetadata(legacyRaw, fence, 0);
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
                const fence = await writeD1Task(env.DB, taskId, raw, STATE_TTL_SECONDS, ownerUid);
                const promotedRaw = applyTaskOperationMetadata(raw, fence, 0);
                return applyStoredTaskQuotaMarker(env, taskId, promotedRaw, ownerUid);
            }

            const legacyRaw = await readKvTask(env, taskId);
            if (!legacyRaw) return null;
            const parsed = JSON.parse(legacyRaw) as { uid?: unknown };
            if (parsed.uid !== ownerUid) return null;
            const legacyCostRaw = await env.TASKS.get(`taskCost:${taskId}`);
            const fence = await writeD1Task(
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
            return applyTaskOperationMetadata(legacyRaw, fence, 0);
        } catch (error) {
            if (error instanceof TaskOwnershipError) return null;
            console.warn("D1 owned task read failed", error);
            throw new TaskStoreUnavailableError("D1 task state read failed");
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

/** Extend an active owned task without reviving expired or incomplete state. */
export async function renewOwnedTask(
    env: TaskStoreEnv,
    taskId: string,
    ownerUid: string,
    expirationTtl = STATE_TTL_SECONDS,
): Promise<number | null> {
    if (!taskId || !ownerUid) return null;
    const ttlSeconds = Math.max(60, Math.floor(expirationTtl));

    if (env.DB) {
        try {
            const expirationMs = ttlSeconds * 1000;
            const row = await env.DB.prepare(`
                UPDATE generation_tasks
                SET expires_at = MAX(expires_at, ${D1_NOW_MS_SQL} + ?3)
                WHERE task_id = ?1
                  AND owner_uid = ?2
                  AND expires_at > ${D1_NOW_MS_SQL}
                  AND EXISTS (
                      SELECT 1
                      FROM generation_task_chunks AS c
                      WHERE c.task_id = generation_tasks.task_id
                  )
                RETURNING expires_at
            `).bind(taskId, ownerUid, expirationMs).first<{ expires_at: number }>();
            const expiresAt = Number(row?.expires_at);
            return Number.isFinite(expiresAt) && expiresAt > 0 ? expiresAt : null;
        } catch (error) {
            console.warn("D1 task renewal failed", error);
            throw new TaskStoreUnavailableError("D1 task renewal failed");
        }
    }

    const raw = await env.TASKS.get(taskId);
    if (!raw) return null;
    try {
        const parsed = JSON.parse(raw) as { uid?: unknown };
        if (parsed.uid !== ownerUid) return null;
    } catch {
        return null;
    }
    await env.TASKS.put(taskId, raw, { expirationTtl: ttlSeconds });
    return Date.now() + ttlSeconds * 1000;
}

/** Check deletion ownership without treating an expired task as absent. */
export async function hasOwnedTask(
    env: TaskStoreEnv,
    taskId: string,
    ownerUid: string,
): Promise<boolean> {
    if (!ownerUid) return false;
    if (env.DB) {
        try {
            const storedOwner = await readD1TaskOwner(env.DB, taskId);
            if (storedOwner !== null) {
                if (storedOwner) return storedOwner === ownerUid;

                // Legacy D1 rows may have an empty owner column. Read their state
                // without the normal expiry filter, then promote the verified owner
                // so the owner-scoped DELETE can remove the row atomically.
                const raw = await readD1TaskIgnoringExpiration(env.DB, taskId);
                if (!raw) return false;
                const parsed = JSON.parse(raw) as { uid?: unknown };
                if (parsed.uid !== ownerUid) return false;
                await writeD1Task(env.DB, taskId, raw, STATE_TTL_SECONDS, ownerUid);
                return true;
            }
        } catch (error) {
            if (error instanceof TaskOwnershipError) return false;
            console.warn("D1 task ownership check for deletion failed", error);
            throw new TaskStoreUnavailableError("D1 task ownership check for deletion failed");
        }
    }

    const raw = await env.TASKS.get(taskId);
    if (!raw) return false;
    try {
        const parsed = JSON.parse(raw) as { uid?: unknown };
        return parsed.uid === ownerUid;
    } catch {
        return false;
    }
}

async function storeTask(
    env: TaskStoreEnv,
    taskId: string,
    raw: string,
    expirationTtl: number,
    ownerUid: string,
): Promise<string | null> {
    if (env.DB) {
        try {
            return await writeD1Task(env.DB, taskId, raw, expirationTtl, ownerUid);
        } catch (error) {
            if (error instanceof TaskOwnershipError) throw error;
            console.warn("D1 task write failed", error);
            throw new TaskStoreUnavailableError("D1 task state write failed");
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
    await env.TASKS.put(taskId, prepareTaskStateForStorage(raw).raw, { expirationTtl });
    return null;
}

/** Store task state in D1, with KV fallback for unbound preview/local environments. */
export async function putTask(
    env: TaskStoreEnv,
    taskId: string,
    raw: string,
    expirationTtl = STATE_TTL_SECONDS,
    ownerUid = "",
): Promise<void> {
    await storeTask(env, taskId, raw, expirationTtl, ownerUid);
}

/** Store a mutable task state and advance its in-memory D1 fence for sequential writes. */
export async function putTaskState(
    env: TaskStoreEnv,
    taskId: string,
    state: Record<string, any>,
    expirationTtl = STATE_TTL_SECONDS,
    ownerUid = "",
): Promise<void> {
    const fence = await storeTask(env, taskId, JSON.stringify(state), expirationTtl, ownerUid);
    if (fence) applyTaskOperationMetadataToState(state, fence, 0);
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

/** Clear quota locks for a user after paid balance is restored. */
export async function clearUserTaskQuotaExhausted(
    env: TaskStoreEnv,
    ownerUid: string,
): Promise<void> {
    if (!ownerUid || !env.DB) return;

    const active = await env.DB.prepare(`
        SELECT task_id
        FROM generation_tasks
        WHERE owner_uid = ?1 AND expires_at > ?2
    `).bind(ownerUid, Date.now()).all<{ task_id: string }>();

    await env.DB.prepare(`
        UPDATE generation_tasks
        SET quota_exhausted = 0, updated_at = ?2
        WHERE owner_uid = ?1 AND quota_exhausted != 0
    `).bind(ownerUid, Date.now()).run();

    await Promise.all((active.results ?? []).map((row) =>
        env.TASKS.delete(taskQuotaKey(String(row.task_id ?? ""))),
    ));
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
            console.warn("D1 task delete failed", error);
            throw new TaskStoreUnavailableError("D1 task delete failed");
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
        const result = await env.DB.prepare(`
            UPDATE generation_tasks
            SET cost_consumed = MAX(cost_consumed, ?3), updated_at = ?4
            WHERE task_id = ?1 AND owner_uid = ?2
        `).bind(taskId, ownerUid, consumed, Date.now()).run();
        return Number(result.meta?.changes) > 0;
    } catch (error) {
        console.warn("D1 consumed-cost update failed", error);
        return false;
    }
}
