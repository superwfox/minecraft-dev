import type {
    KnowledgeItemRecord,
    KnowledgeNeed,
    KnowledgeStatus,
    LearningEvidenceItem,
    LearningJobRecord,
    LearningJobStatus,
    LearningJobWork,
    LearningSourceRecord,
    LearningStage,
} from "./types";

export interface LearningStoreEnv {
    DB?: D1Database;
}

interface LearningJobRow {
    job_id: string;
    owner_uid: string;
    generation_task_id: string;
    stage: string;
    lookup_hash: string;
    status: string;
    needs_json: string;
    work_json: string;
    result_ids_json: string;
    revision: number;
    lease_token: string;
    lease_until: number;
    error: string;
    created_at: number;
    updated_at: number;
}

interface KnowledgeItemRow {
    knowledge_id: string;
    kind: string;
    lookup_key: string;
    scope_json: string;
    payload_json: string;
    summary: string;
    risk: string;
    confidence: number;
    status: string;
    valid_from: number;
    expires_at: number;
    supersedes_id: string | null;
    revision: number;
    review_note: string;
    created_at: number;
    updated_at: number;
}

interface KnowledgeReviewRow extends KnowledgeItemRow {
    latest_revision: number;
    has_ground_truth: number;
    active_predecessor_id: string | null;
}

export class LearningStoreUnavailableError extends Error {
    constructor() {
        super("Learning store is unavailable");
        this.name = "LearningStoreUnavailableError";
    }
}

function dbOf(env: LearningStoreEnv): D1Database {
    if (!env.DB) throw new LearningStoreUnavailableError();
    return env.DB;
}

function parseJson<T>(raw: string, fallback: T): T {
    try { return JSON.parse(raw) as T; } catch { return fallback; }
}

function newId(prefix: string): string {
    return `${prefix}_${crypto.randomUUID().replace(/-/g, "")}`;
}

function mapJob(row: LearningJobRow): LearningJobRecord {
    return {
        jobId: row.job_id,
        ownerUid: row.owner_uid,
        generationTaskId: row.generation_task_id,
        stage: row.stage as LearningStage,
        lookupHash: row.lookup_hash,
        status: row.status as LearningJobStatus,
        needs: parseJson<KnowledgeNeed[]>(row.needs_json, []),
        work: parseJson<LearningJobWork>(row.work_json, {}),
        resultIds: parseJson<string[]>(row.result_ids_json, []),
        revision: Number(row.revision) || 0,
        leaseToken: row.lease_token || "",
        leaseUntil: Number(row.lease_until) || 0,
        error: row.error || "",
        createdAt: Number(row.created_at) || 0,
        updatedAt: Number(row.updated_at) || 0,
    };
}

function mapKnowledge(row: KnowledgeItemRow): KnowledgeItemRecord {
    return {
        knowledgeId: row.knowledge_id,
        kind: row.kind as KnowledgeItemRecord["kind"],
        lookupKey: row.lookup_key,
        scope: parseJson(row.scope_json, {}),
        payload: parseJson(row.payload_json, {}),
        summary: row.summary,
        risk: row.risk as KnowledgeItemRecord["risk"],
        confidence: Number(row.confidence) || 0,
        status: row.status as KnowledgeStatus,
        validFrom: Number(row.valid_from) || 0,
        expiresAt: Number(row.expires_at) || 0,
        supersedesId: row.supersedes_id || undefined,
        revision: Number(row.revision) || 1,
        reviewNote: row.review_note || "",
        createdAt: Number(row.created_at) || 0,
        updatedAt: Number(row.updated_at) || 0,
    };
}

export function canReviewKnowledgeTransition(
    item: Pick<KnowledgeItemRecord, "kind" | "status" | "revision">,
    latestRevision: number,
    status: "active" | "rejected" | "deprecated",
): boolean {
    if (status === "deprecated" && item.status === "active") return true;
    return item.status === "needs_review"
        && item.revision === latestRevision
        && (status !== "active" || item.kind === "fact");
}

export function reviewedKnowledgeExpiresAt(input: {
    hasGroundTruth: boolean;
    currentExpiresAt: number;
    now: number;
}): number {
    if (input.currentExpiresAt > input.now) return input.currentExpiresAt;
    return input.hasGroundTruth ? 0 : input.now + 90 * 86_400_000;
}

export function knowledgeIdForLearningResult(jobId: string, needIndex: number): string {
    const jobKey = jobId.replace(/^learn_/i, "").replace(/[^a-z0-9]/gi, "").toLowerCase();
    if (!jobKey) throw new Error("invalid_learning_job_id");
    const normalizedIndex = Number.isFinite(needIndex)
        ? Math.min(1_295, Math.max(0, Math.floor(needIndex)))
        : 0;
    const index = normalizedIndex.toString(36).padStart(2, "0");
    return `know_${jobKey.slice(0, 48)}${index}`;
}

export function knowledgeStatusAt(
    item: Pick<KnowledgeItemRecord, "status" | "expiresAt">,
    now = Date.now(),
): KnowledgeStatus {
    return item.status === "active" && item.expiresAt > 0 && item.expiresAt <= now
        ? "expired"
        : item.status;
}

export async function createOrGetLearningJob(
    env: LearningStoreEnv,
    input: {
        ownerUid: string;
        generationTaskId: string;
        stage: LearningStage;
        lookupHash: string;
        needs: KnowledgeNeed[];
        work?: LearningJobWork;
        now?: number;
    },
): Promise<LearningJobRecord> {
    const db = dbOf(env);
    const now = input.now ?? Date.now();
    const jobId = newId("learn");
    await db.prepare(`
        INSERT OR IGNORE INTO learning_jobs (
            job_id, owner_uid, generation_task_id, stage, lookup_hash, status,
            needs_json, work_json, result_ids_json, revision, lease_token,
            lease_until, error, created_at, updated_at
        ) VALUES (?1, ?2, ?3, ?4, ?5, 'queued', ?6, ?7, '[]', 0, '', 0, '', ?8, ?8)
    `).bind(
        jobId,
        input.ownerUid,
        input.generationTaskId,
        input.stage,
        input.lookupHash,
        JSON.stringify(input.needs),
        JSON.stringify(input.work ?? {}),
        now,
    ).run();

    const row = await db.prepare(`
        SELECT * FROM learning_jobs
        WHERE generation_task_id = ?1 AND stage = ?2 AND lookup_hash = ?3
    `).bind(input.generationTaskId, input.stage, input.lookupHash).first<LearningJobRow>();
    if (!row || row.owner_uid !== input.ownerUid) throw new Error("Learning job ownership conflict");
    return mapJob(row);
}

export async function getLearningJob(
    env: LearningStoreEnv,
    jobId: string,
    ownerUid: string,
): Promise<LearningJobRecord | null> {
    const row = await dbOf(env).prepare(`
        SELECT * FROM learning_jobs WHERE job_id = ?1 AND owner_uid = ?2
    `).bind(jobId, ownerUid).first<LearningJobRow>();
    return row ? mapJob(row) : null;
}

export async function getLatestLearningJobForTask(
    env: LearningStoreEnv,
    generationTaskId: string,
    ownerUid: string,
    stage?: LearningStage,
): Promise<LearningJobRecord | null> {
    const statement = stage
        ? dbOf(env).prepare(`
            SELECT * FROM learning_jobs
            WHERE generation_task_id = ?1 AND owner_uid = ?2 AND stage = ?3
            ORDER BY updated_at DESC LIMIT 1
        `).bind(generationTaskId, ownerUid, stage)
        : dbOf(env).prepare(`
            SELECT * FROM learning_jobs
            WHERE generation_task_id = ?1 AND owner_uid = ?2
            ORDER BY updated_at DESC LIMIT 1
        `).bind(generationTaskId, ownerUid);
    const row = await statement.first<LearningJobRow>();
    return row ? mapJob(row) : null;
}

export async function acquireLearningJobLease(
    env: LearningStoreEnv,
    input: {
        jobId: string;
        ownerUid: string;
        expectedRevision: number;
        leaseToken: string;
        leaseMs?: number;
        now?: number;
    },
): Promise<LearningJobRecord | null> {
    const now = input.now ?? Date.now();
    const leaseUntil = now + Math.max(5_000, input.leaseMs ?? 45_000);
    const row = await dbOf(env).prepare(`
        UPDATE learning_jobs
        SET lease_token = ?4,
            lease_until = ?5,
            revision = revision + 1,
            updated_at = ?6
        WHERE job_id = ?1
          AND owner_uid = ?2
          AND revision = ?3
          AND (lease_until <= ?6 OR lease_token = ?4)
        RETURNING *
    `).bind(
        input.jobId,
        input.ownerUid,
        input.expectedRevision,
        input.leaseToken,
        leaseUntil,
        now,
    ).first<LearningJobRow>();
    return row ? mapJob(row) : null;
}

export async function completeLearningJobStep(
    env: LearningStoreEnv,
    input: {
        jobId: string;
        ownerUid: string;
        expectedRevision: number;
        leaseToken: string;
        status: LearningJobStatus;
        work: LearningJobWork;
        resultIds?: string[];
        error?: string;
        now?: number;
    },
): Promise<LearningJobRecord | null> {
    const now = input.now ?? Date.now();
    const row = await dbOf(env).prepare(`
        UPDATE learning_jobs
        SET status = ?5,
            work_json = ?6,
            result_ids_json = ?7,
            error = ?8,
            lease_token = '',
            lease_until = 0,
            revision = revision + 1,
            updated_at = ?9
        WHERE job_id = ?1
          AND owner_uid = ?2
          AND revision = ?3
          AND lease_token = ?4
        RETURNING *
    `).bind(
        input.jobId,
        input.ownerUid,
        input.expectedRevision,
        input.leaseToken,
        input.status,
        JSON.stringify(input.work),
        JSON.stringify(input.resultIds ?? []),
        input.error ?? "",
        now,
    ).first<LearningJobRow>();
    return row ? mapJob(row) : null;
}

export async function insertLearningSources(
    env: LearningStoreEnv,
    sources: LearningSourceRecord[],
): Promise<void> {
    if (!sources.length) return;
    const db = dbOf(env);
    await db.batch(sources.map((source) => db.prepare(`
        INSERT OR REPLACE INTO learning_sources (
            source_id, job_id, need_id, canonical_url, domain, source_type,
            authority, title, published_at, fetched_at, content_hash, excerpt,
            verification_state
        ) VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11, ?12, ?13)
    `).bind(
        source.sourceId,
        source.jobId,
        source.needId,
        source.canonicalUrl,
        source.domain,
        source.sourceType,
        source.authority,
        source.title,
        source.publishedAt ?? null,
        source.fetchedAt,
        source.contentHash,
        source.excerpt,
        source.verificationState,
    )));
}

export async function listLearningSources(
    env: LearningStoreEnv,
    jobId: string,
    ownerUid: string,
): Promise<LearningSourceRecord[]> {
    const rows = await dbOf(env).prepare(`
        SELECT s.*
        FROM learning_sources AS s
        JOIN learning_jobs AS j ON j.job_id = s.job_id
        WHERE s.job_id = ?1 AND j.owner_uid = ?2
        ORDER BY s.fetched_at ASC
    `).bind(jobId, ownerUid).all<any>();
    return rows.results.map((row) => ({
        sourceId: row.source_id,
        jobId: row.job_id,
        needId: row.need_id,
        canonicalUrl: row.canonical_url,
        domain: row.domain,
        sourceType: row.source_type,
        authority: row.authority,
        title: row.title || "",
        publishedAt: row.published_at == null ? undefined : Number(row.published_at),
        fetchedAt: Number(row.fetched_at) || 0,
        contentHash: row.content_hash,
        excerpt: row.excerpt,
        verificationState: row.verification_state,
    }));
}

export async function createKnowledgeItem(
    env: LearningStoreEnv,
    input: Omit<KnowledgeItemRecord, "knowledgeId" | "revision" | "createdAt" | "updatedAt" | "reviewNote"> & {
        knowledgeId?: string;
        reviewNote?: string;
        evidence?: { sourceId: string; relation: string; locator: string; excerpt: string }[];
        now?: number;
    },
): Promise<KnowledgeItemRecord> {
    const db = dbOf(env);
    const now = input.now ?? Date.now();
    const knowledgeId = input.knowledgeId ?? newId("know");
    const existing = await db.prepare(`SELECT * FROM knowledge_items WHERE knowledge_id = ?1`)
        .bind(knowledgeId).first<KnowledgeItemRow>();
    if (existing) {
        if (existing.lookup_key !== input.lookupKey) throw new Error("Knowledge item ID conflict");
        await addKnowledgeEvidence(env, knowledgeId, input.evidence ?? []);
        return mapKnowledge(existing);
    }

    const statements = [
        db.prepare(`
            INSERT OR IGNORE INTO knowledge_items (
                knowledge_id, kind, lookup_key, scope_json, payload_json, summary,
                risk, confidence, status, valid_from, expires_at, supersedes_id,
                revision, review_note, created_at, updated_at
            ) VALUES (
                ?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11,
                CASE
                    WHEN ?9 = 'active' THEN COALESCE(
                        ?12,
                        (
                            SELECT knowledge_id
                            FROM knowledge_items
                            WHERE lookup_key = ?3 AND status = 'active'
                            ORDER BY revision DESC
                            LIMIT 1
                        )
                    )
                    ELSE ?12
                END,
                (SELECT COALESCE(MAX(revision), 0) + 1 FROM knowledge_items WHERE lookup_key = ?3),
                ?13, ?14, ?14
            )
        `).bind(
            knowledgeId,
            input.kind,
            input.lookupKey,
            JSON.stringify(input.scope),
            JSON.stringify(input.payload),
            input.summary,
            input.risk,
            input.confidence,
            input.status,
            input.validFrom,
            input.expiresAt,
            input.supersedesId ?? null,
            input.reviewNote ?? "",
            now,
        ),
        db.prepare(`
            UPDATE knowledge_items
            SET status = 'deprecated', updated_at = ?3
            WHERE ?4 = 'active'
              AND lookup_key = ?1
              AND knowledge_id <> ?2
              AND status = 'active'
        `).bind(input.lookupKey, knowledgeId, now, input.status),
        ...(input.evidence ?? []).map((item) => db.prepare(`
            INSERT OR REPLACE INTO knowledge_evidence (
                knowledge_id, source_id, relation, locator, excerpt
            ) VALUES (?1, ?2, ?3, ?4, ?5)
        `).bind(knowledgeId, item.sourceId, item.relation, item.locator, item.excerpt)),
    ];
    await db.batch(statements);
    const row = await db.prepare(`SELECT * FROM knowledge_items WHERE knowledge_id = ?1`)
        .bind(knowledgeId).first<KnowledgeItemRow>();
    if (!row) throw new Error("Knowledge item was not persisted");
    if (row.lookup_key !== input.lookupKey) throw new Error("Knowledge item ID conflict");
    return mapKnowledge(row);
}

export async function addKnowledgeEvidence(
    env: LearningStoreEnv,
    knowledgeId: string,
    evidence: { sourceId: string; relation: string; locator: string; excerpt: string }[],
): Promise<void> {
    if (!evidence.length) return;
    const db = dbOf(env);
    await db.batch(evidence.map((item) => db.prepare(`
        INSERT OR REPLACE INTO knowledge_evidence (
            knowledge_id, source_id, relation, locator, excerpt
        ) VALUES (?1, ?2, ?3, ?4, ?5)
    `).bind(knowledgeId, item.sourceId, item.relation, item.locator, item.excerpt)));
}

export async function findActiveKnowledge(
    env: LearningStoreEnv,
    lookupKeys: string[],
    now = Date.now(),
): Promise<KnowledgeItemRecord[]> {
    const unique = [...new Set(lookupKeys.filter(Boolean))];
    if (!unique.length) return [];
    const placeholders = unique.map((_, index) => `?${index + 1}`).join(", ");
    const rows = await dbOf(env).prepare(`
        SELECT k.*
        FROM knowledge_items AS k
        JOIN (
            SELECT lookup_key, MAX(revision) AS revision
            FROM knowledge_items
            WHERE lookup_key IN (${placeholders})
              AND status = 'active'
              AND kind = 'fact'
              AND valid_from <= ?${unique.length + 1}
              AND (expires_at = 0 OR expires_at > ?${unique.length + 1})
            GROUP BY lookup_key
        ) AS latest
          ON latest.lookup_key = k.lookup_key AND latest.revision = k.revision
        WHERE k.status = 'active'
          AND k.kind = 'fact'
          AND k.valid_from <= ?${unique.length + 1}
          AND (k.expires_at = 0 OR k.expires_at > ?${unique.length + 1})
        ORDER BY k.confidence DESC, k.updated_at DESC
    `).bind(...unique, now).all<KnowledgeItemRow>();
    return rows.results.map(mapKnowledge);
}

export async function listReviewableKnowledge(
    env: LearningStoreEnv,
    limit = 50,
    now = Date.now(),
): Promise<KnowledgeItemRecord[]> {
    const bounded = Math.max(1, Math.min(100, Math.floor(limit)));
    const rows = await dbOf(env).prepare(`
        SELECT k.*
        FROM knowledge_items AS k
        LEFT JOIN (
            SELECT lookup_key, MAX(revision) AS revision
            FROM knowledge_items
            GROUP BY lookup_key
        ) AS latest ON latest.lookup_key = k.lookup_key
        WHERE (k.status = 'needs_review' AND latest.revision = k.revision)
           OR k.status = 'active'
        ORDER BY CASE WHEN k.status = 'needs_review' THEN 0 ELSE 1 END,
                 k.updated_at ASC
        LIMIT ?1
    `).bind(bounded).all<KnowledgeItemRow>();
    return rows.results.map(mapKnowledge).map((item) => ({
        ...item,
        status: knowledgeStatusAt(item, now),
    }));
}

export async function reviewKnowledgeItem(
    env: LearningStoreEnv,
    input: {
        knowledgeId: string;
        status: "active" | "rejected" | "deprecated";
        note?: string;
        now?: number;
    },
): Promise<KnowledgeItemRecord | null> {
    const db = dbOf(env);
    const now = input.now ?? Date.now();
    const note = input.note?.trim() ?? "";
    const target = await db.prepare(`
        SELECT k.*,
               (
                   SELECT MAX(revision)
                   FROM knowledge_items
                   WHERE lookup_key = k.lookup_key
               ) AS latest_revision,
               EXISTS (
                   SELECT 1
                   FROM knowledge_evidence AS evidence
                   JOIN learning_sources AS source ON source.source_id = evidence.source_id
                   WHERE evidence.knowledge_id = k.knowledge_id
                     AND evidence.relation = 'supports'
                     AND source.authority = 'ground_truth'
               ) AS has_ground_truth,
               (
                   SELECT prior.knowledge_id
                   FROM knowledge_items AS prior
                   WHERE prior.lookup_key = k.lookup_key
                     AND prior.knowledge_id <> k.knowledge_id
                     AND prior.status = 'active'
                   ORDER BY prior.revision DESC
                   LIMIT 1
               ) AS active_predecessor_id
        FROM knowledge_items AS k
        WHERE k.knowledge_id = ?1
    `).bind(input.knowledgeId).first<KnowledgeReviewRow>();
    if (!target || !canReviewKnowledgeTransition(
        mapKnowledge(target),
        Number(target.latest_revision) || 0,
        input.status,
    )) return null;
    const approvedExpiresAt = reviewedKnowledgeExpiresAt({
        hasGroundTruth: !!target.has_ground_truth,
        currentExpiresAt: Number(target.expires_at) || 0,
        now,
    });

    if (input.status === "active") {
        const results = await db.batch([
            db.prepare(`
                UPDATE knowledge_items
                SET status = 'deprecated', updated_at = ?2
                WHERE status = 'active'
                  AND knowledge_id <> ?1
                  AND lookup_key = (
                      SELECT lookup_key FROM knowledge_items WHERE knowledge_id = ?1
                  )
                  AND EXISTS (
                      SELECT 1
                      FROM knowledge_items AS target
                      WHERE target.knowledge_id = ?1
                        AND target.kind = 'fact'
                        AND target.status = 'needs_review'
                        AND target.revision = (
                            SELECT MAX(revision)
                            FROM knowledge_items
                            WHERE lookup_key = target.lookup_key
                        )
                  )
            `).bind(input.knowledgeId, now),
            db.prepare(`
                UPDATE knowledge_items
                SET status = 'active',
                    review_note = ?2,
                    supersedes_id = COALESCE(supersedes_id, ?4),
                    expires_at = ?5,
                    updated_at = ?3
                WHERE knowledge_id = ?1
                  AND kind = 'fact'
                  AND status = 'needs_review'
                  AND revision = (
                      SELECT MAX(revision)
                      FROM knowledge_items
                      WHERE lookup_key = (
                          SELECT lookup_key FROM knowledge_items WHERE knowledge_id = ?1
                      )
                  )
            `).bind(
                input.knowledgeId,
                note,
                now,
                target.active_predecessor_id,
                approvedExpiresAt,
            ),
        ]);
        if (Number(results[1]?.meta?.changes) === 0) return null;
    } else if (target.status === "active") {
        const result = await db.prepare(`
            UPDATE knowledge_items
            SET status = 'deprecated', review_note = ?2, updated_at = ?3
            WHERE knowledge_id = ?1 AND status = 'active'
        `).bind(input.knowledgeId, note, now).run();
        if (Number(result.meta?.changes) === 0) return null;
    } else {
        const result = await db.prepare(`
            UPDATE knowledge_items
            SET status = ?2, review_note = ?3, updated_at = ?4
            WHERE knowledge_id = ?1
              AND status = 'needs_review'
              AND revision = (
                  SELECT MAX(revision)
                  FROM knowledge_items
                  WHERE lookup_key = (
                      SELECT lookup_key FROM knowledge_items WHERE knowledge_id = ?1
                  )
              )
        `).bind(input.knowledgeId, input.status, note, now).run();
        if (Number(result.meta?.changes) === 0) return null;
    }

    const row = await db.prepare(`SELECT * FROM knowledge_items WHERE knowledge_id = ?1`)
        .bind(input.knowledgeId).first<KnowledgeItemRow>();
    return row ? mapKnowledge(row) : null;
}

export async function getKnowledgeItemsByIds(
    env: LearningStoreEnv,
    knowledgeIds: string[],
): Promise<KnowledgeItemRecord[]> {
    const unique = [...new Set(knowledgeIds.filter(Boolean))];
    if (!unique.length) return [];
    const placeholders = unique.map((_, index) => `?${index + 1}`).join(", ");
    const rows = await dbOf(env).prepare(`
        SELECT * FROM knowledge_items
        WHERE knowledge_id IN (${placeholders})
        ORDER BY updated_at DESC
    `).bind(...unique).all<KnowledgeItemRow>();
    return rows.results.map(mapKnowledge).map((item) => ({
        ...item,
        status: knowledgeStatusAt(item),
    }));
}

export async function getLearningEvidenceItems(
    env: LearningStoreEnv,
    knowledgeIds: string[],
): Promise<LearningEvidenceItem[]> {
    const unique = [...new Set(knowledgeIds.filter(Boolean))];
    if (!unique.length) return [];
    const placeholders = unique.map((_, index) => `?${index + 1}`).join(", ");
    const rows = await dbOf(env).prepare(`
        SELECT
            k.knowledge_id, k.summary, k.kind, k.confidence, k.status, k.scope_json, k.expires_at,
            s.source_id, s.title, s.canonical_url, s.source_type, s.authority,
            s.published_at, s.fetched_at,
            e.excerpt AS evidence_excerpt, e.relation
        FROM knowledge_items AS k
        LEFT JOIN knowledge_evidence AS e ON e.knowledge_id = k.knowledge_id
        LEFT JOIN learning_sources AS s ON s.source_id = e.source_id
        WHERE k.knowledge_id IN (${placeholders})
        ORDER BY k.updated_at DESC, s.fetched_at ASC
    `).bind(...unique).all<any>();
    const items = new Map<string, LearningEvidenceItem>();
    for (const row of rows.results) {
        let item = items.get(row.knowledge_id);
        if (!item) {
            item = {
                knowledgeId: row.knowledge_id,
                summary: row.summary,
                kind: row.kind,
                confidence: Number(row.confidence) || 0,
                status: knowledgeStatusAt({
                    status: row.status as KnowledgeStatus,
                    expiresAt: Number(row.expires_at) || 0,
                }),
                scope: row.scope_json,
                sources: [],
            };
            items.set(row.knowledge_id, item);
        }
        if (row.source_id) {
            item.sources.push({
                sourceId: row.source_id,
                title: row.title || row.canonical_url,
                url: row.canonical_url,
                sourceType: row.source_type,
                authority: row.authority,
                publishedAt: row.published_at == null ? undefined : Number(row.published_at),
                fetchedAt: Number(row.fetched_at) || 0,
                excerpt: row.evidence_excerpt || "",
                relation: row.relation || "supports",
            });
        }
    }
    return [...items.values()];
}

export async function recordKnowledgeUsage(
    env: LearningStoreEnv,
    input: {
        knowledgeId: string;
        generationTaskId: string;
        stage: string;
        outcome?: string;
        diagnosticBefore?: string;
        diagnosticAfter?: string;
        appliedAt?: number;
    },
): Promise<void> {
    const appliedAt = input.appliedAt ?? Date.now();
    await dbOf(env).prepare(`
        INSERT OR IGNORE INTO knowledge_usage (
            usage_id, knowledge_id, generation_task_id, stage,
            diagnostic_before, diagnostic_after, outcome, applied_at, evaluated_at
        ) VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, NULL)
    `).bind(
        newId("use"),
        input.knowledgeId,
        input.generationTaskId,
        input.stage,
        input.diagnosticBefore ?? "",
        input.diagnosticAfter ?? "",
        input.outcome ?? "applied",
        appliedAt,
    ).run();
}

export async function evaluateKnowledgeUsage(
    env: LearningStoreEnv,
    input: {
        knowledgeId: string;
        generationTaskId: string;
        stage: string;
        diagnosticBefore?: string;
        diagnosticAfter?: string;
        outcome: string;
        evaluatedAt?: number;
    },
): Promise<void> {
    await dbOf(env).prepare(`
        UPDATE knowledge_usage
        SET diagnostic_after = ?5,
            outcome = ?6,
            evaluated_at = ?7
        WHERE knowledge_id = ?1
          AND generation_task_id = ?2
          AND stage = ?3
          AND diagnostic_before = ?4
          AND evaluated_at IS NULL
    `).bind(
        input.knowledgeId,
        input.generationTaskId,
        input.stage,
        input.diagnosticBefore ?? "",
        input.diagnosticAfter ?? "",
        input.outcome,
        input.evaluatedAt ?? Date.now(),
    ).run();
}
