import type {
    ImplementationRecipeV1,
    KnowledgeItemRecord,
    KnowledgeNeed,
    KnowledgeStatus,
    LearningEvidenceItem,
    LearningEvidenceReason,
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

export type KnowledgeItemCreateInput = Omit<
    KnowledgeItemRecord,
    "knowledgeId" | "revision" | "createdAt" | "updatedAt" | "reviewNote"
> & {
    knowledgeId?: string;
    reviewNote?: string;
    evidence?: { sourceId: string; relation: string; locator: string; excerpt: string }[];
    now?: number;
};

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
    const requestedLeaseMs = Number(input.leaseMs);
    const leaseMs = Number.isFinite(requestedLeaseMs) && requestedLeaseMs > 0
        ? Math.floor(requestedLeaseMs)
        : 45_000;
    const leaseUntil = now + Math.max(1, leaseMs);
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
        taskStateFence?: string;
        sources?: LearningSourceRecord[];
        knowledge?: KnowledgeItemCreateInput & { knowledgeId: string };
        now?: number;
    },
): Promise<LearningJobRecord | null> {
    const db = dbOf(env);
    const now = input.now ?? Date.now();
    const statements: D1PreparedStatement[] = [];
    const sources = input.sources ?? [];
    const knowledge = input.knowledge;

    if ((input.sources || knowledge) && input.taskStateFence) {
        statements.push(db.prepare(`
            UPDATE learning_jobs
            SET lease_until = CASE
                WHEN EXISTS (
                    SELECT 1
                    FROM generation_tasks AS task
                    JOIN learning_jobs AS authorized_job
                      ON authorized_job.generation_task_id = task.task_id
                    WHERE authorized_job.job_id = ?1
                      AND authorized_job.owner_uid = ?2
                      AND task.owner_uid = ?2
                      AND task.planner_lease_token = ?6
                ) THEN lease_until
                ELSE 0
            END
            WHERE job_id = ?1
              AND owner_uid = ?2
              AND revision = ?3
              AND lease_token = ?4
              AND lease_until > ?5
        `).bind(
            input.jobId,
            input.ownerUid,
            input.expectedRevision,
            input.leaseToken,
            now,
            input.taskStateFence,
        ));
    }

    if (input.sources) {
        statements.push(db.prepare(`
            DELETE FROM learning_sources
            WHERE job_id = ?1
              AND EXISTS (
                  SELECT 1 FROM learning_jobs
                  WHERE job_id = ?1
                    AND owner_uid = ?2
                    AND revision = ?3
                    AND lease_token = ?4
                    AND lease_until > ?5
              )
        `).bind(
            input.jobId,
            input.ownerUid,
            input.expectedRevision,
            input.leaseToken,
            now,
        ));
    }

    for (const source of sources) {
        statements.push(db.prepare(`
            INSERT OR REPLACE INTO learning_sources (
                source_id, job_id, need_id, canonical_url, domain, source_type,
                authority, title, published_at, fetched_at, content_hash, excerpt,
                verification_state
            )
            SELECT ?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11, ?12, ?13
            WHERE EXISTS (
                SELECT 1
                FROM learning_jobs
                WHERE job_id = ?14
                  AND owner_uid = ?15
                  AND revision = ?16
                  AND lease_token = ?17
                  AND lease_until > ?18
            )
        `).bind(
            source.sourceId,
            input.jobId,
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
            input.jobId,
            input.ownerUid,
            input.expectedRevision,
            input.leaseToken,
            now,
        ));
    }

    if (knowledge) {
        const knowledgeNow = knowledge.now ?? now;
        const existing = await db.prepare(`SELECT * FROM knowledge_items WHERE knowledge_id = ?1`)
            .bind(knowledge.knowledgeId).first<KnowledgeItemRow>();
        if (existing && existing.lookup_key !== knowledge.lookupKey) {
            throw new Error("Knowledge item ID conflict");
        }
        if (!existing) {
            statements.push(db.prepare(`
                INSERT INTO knowledge_items (
                    knowledge_id, kind, lookup_key, scope_json, payload_json, summary,
                    risk, confidence, status, valid_from, expires_at, supersedes_id,
                    revision, review_note, created_at, updated_at
                )
                SELECT
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
                FROM learning_jobs AS lease
                WHERE lease.job_id = ?15
                  AND lease.owner_uid = ?16
                  AND lease.revision = ?17
                  AND lease.lease_token = ?18
                  AND lease.lease_until > ?19
            `).bind(
                knowledge.knowledgeId,
                knowledge.kind,
                knowledge.lookupKey,
                JSON.stringify(knowledge.scope),
                JSON.stringify(knowledge.payload),
                knowledge.summary,
                knowledge.risk,
                knowledge.confidence,
                knowledge.status,
                knowledge.validFrom,
                knowledge.expiresAt,
                knowledge.supersedesId ?? null,
                knowledge.reviewNote ?? "",
                knowledgeNow,
                input.jobId,
                input.ownerUid,
                input.expectedRevision,
                input.leaseToken,
                now,
            ));
            statements.push(db.prepare(`
                UPDATE knowledge_items
                SET status = 'deprecated', updated_at = ?3
                WHERE ?4 = 'active'
                  AND lookup_key = ?1
                  AND knowledge_id <> ?2
                  AND status = 'active'
                  AND EXISTS (
                      SELECT 1 FROM knowledge_items
                      WHERE knowledge_id = ?2 AND lookup_key = ?1
                  )
                  AND EXISTS (
                      SELECT 1 FROM learning_jobs
                      WHERE job_id = ?5
                        AND owner_uid = ?6
                        AND revision = ?7
                        AND lease_token = ?8
                        AND lease_until > ?9
                  )
            `).bind(
                knowledge.lookupKey,
                knowledge.knowledgeId,
                knowledgeNow,
                knowledge.status,
                input.jobId,
                input.ownerUid,
                input.expectedRevision,
                input.leaseToken,
                now,
            ));
        } else {
            statements.push(db.prepare(`
                UPDATE knowledge_items
                SET kind = ?2,
                    scope_json = ?4,
                    payload_json = ?5,
                    summary = ?6,
                    risk = ?7,
                    confidence = ?8,
                    status = ?9,
                    valid_from = ?10,
                    expires_at = ?11,
                    supersedes_id = CASE
                        WHEN ?9 = 'active' THEN COALESCE(
                            ?12,
                            (
                                SELECT knowledge_id
                                FROM knowledge_items
                                WHERE lookup_key = ?3
                                  AND knowledge_id <> ?1
                                  AND status = 'active'
                                ORDER BY revision DESC
                                LIMIT 1
                            )
                        )
                        ELSE ?12
                    END,
                    review_note = ?13,
                    updated_at = ?14
                WHERE knowledge_id = ?1
                  AND lookup_key = ?3
                  AND EXISTS (
                      SELECT 1 FROM learning_jobs
                      WHERE job_id = ?15
                        AND owner_uid = ?16
                        AND revision = ?17
                        AND lease_token = ?18
                        AND lease_until > ?19
                  )
            `).bind(
                knowledge.knowledgeId,
                knowledge.kind,
                knowledge.lookupKey,
                JSON.stringify(knowledge.scope),
                JSON.stringify(knowledge.payload),
                knowledge.summary,
                knowledge.risk,
                knowledge.confidence,
                knowledge.status,
                knowledge.validFrom,
                knowledge.expiresAt,
                knowledge.supersedesId ?? null,
                knowledge.reviewNote ?? "",
                knowledgeNow,
                input.jobId,
                input.ownerUid,
                input.expectedRevision,
                input.leaseToken,
                now,
            ));
            statements.push(db.prepare(`
                UPDATE knowledge_items
                SET status = 'deprecated', updated_at = ?3
                WHERE ?4 = 'active'
                  AND lookup_key = ?1
                  AND knowledge_id <> ?2
                  AND status = 'active'
                  AND EXISTS (
                      SELECT 1 FROM knowledge_items
                      WHERE knowledge_id = ?2 AND lookup_key = ?1
                  )
                  AND EXISTS (
                      SELECT 1 FROM learning_jobs
                      WHERE job_id = ?5
                        AND owner_uid = ?6
                        AND revision = ?7
                        AND lease_token = ?8
                        AND lease_until > ?9
                  )
            `).bind(
                knowledge.lookupKey,
                knowledge.knowledgeId,
                knowledgeNow,
                knowledge.status,
                input.jobId,
                input.ownerUid,
                input.expectedRevision,
                input.leaseToken,
                now,
            ));
        }
        statements.push(db.prepare(`
            DELETE FROM knowledge_evidence
            WHERE knowledge_id = ?1
              AND EXISTS (
                  SELECT 1 FROM learning_jobs
                  WHERE job_id = ?2
                    AND owner_uid = ?3
                    AND revision = ?4
                    AND lease_token = ?5
                    AND lease_until > ?6
              )
        `).bind(
            knowledge.knowledgeId,
            input.jobId,
            input.ownerUid,
            input.expectedRevision,
            input.leaseToken,
            now,
        ));
        for (const evidence of knowledge.evidence ?? []) {
            statements.push(db.prepare(`
                INSERT OR REPLACE INTO knowledge_evidence (
                    knowledge_id, source_id, relation, locator, excerpt
                )
                SELECT ?1, ?2, ?3, ?4, ?5
                WHERE EXISTS (
                    SELECT 1 FROM knowledge_items
                    WHERE knowledge_id = ?1 AND lookup_key = ?11
                )
                  AND EXISTS (
                      SELECT 1 FROM learning_sources
                      WHERE source_id = ?2 AND job_id = ?6
                  )
                  AND EXISTS (
                      SELECT 1 FROM learning_jobs
                      WHERE job_id = ?6
                        AND owner_uid = ?7
                        AND revision = ?8
                        AND lease_token = ?9
                        AND lease_until > ?10
                  )
            `).bind(
                knowledge.knowledgeId,
                evidence.sourceId,
                evidence.relation,
                evidence.locator,
                evidence.excerpt,
                input.jobId,
                input.ownerUid,
                input.expectedRevision,
                input.leaseToken,
                now,
                knowledge.lookupKey,
            ));
        }
    }

    statements.push(db.prepare(`
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
          AND lease_until > ?9
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
    ));

    const results = await db.batch(statements);
    const completion = results[results.length - 1] as D1Result<LearningJobRow>;
    const row = completion.results?.[0];
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
    input: KnowledgeItemCreateInput,
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

const PUBLIC_LEARNING_REASON_CODES = new Set<LearningEvidenceReason["code"]>([
    "nms_version_sensitive",
    "reflection_contract",
    "external_plugin_contract",
    "persistent_diagnostic_gap",
]);
const PUBLIC_INTEGRATION_KINDS = new Set<ImplementationRecipeV1["integrationKind"]>([
    "public_api",
    "nms",
    "craftbukkit",
    "version_reflection",
    "external_plugin",
]);

function publicPayloadText(value: unknown, max: number): string {
    return typeof value === "string"
        ? value.replace(/[\x00-\x08\x0b\x0c\x0e-\x1f]/g, " ").trim().slice(0, max)
        : "";
}

function publicPayloadList(value: unknown, maxItems: number, maxLength: number): string[] | null {
    if (!Array.isArray(value) || value.length > maxItems) return null;
    const items = value.map((item) => publicPayloadText(item, maxLength));
    return items.every(Boolean) ? items : null;
}

function publicRecipeText(value: unknown, max: number): string {
    if (typeof value !== "string" || /[\x00-\x08\x0b\x0c\x0e-\x1f]/.test(value)) return "";
    const normalized = value.trim();
    return normalized.length <= max ? normalized : "";
}

function publicRecipeList(value: unknown, maxItems: number, maxLength: number): string[] | null {
    if (!Array.isArray(value) || value.length === 0 || value.length > maxItems) return null;
    const items = value.map((item) => publicRecipeText(item, maxLength));
    return items.every(Boolean) ? items : null;
}

function publicLearningReason(payload: Record<string, unknown>): LearningEvidenceReason | undefined {
    const value = payload.learningReason;
    if (!value || typeof value !== "object" || Array.isArray(value)) return undefined;
    const raw = value as Record<string, unknown>;
    const code = typeof raw.code === "string" && PUBLIC_LEARNING_REASON_CODES.has(raw.code as LearningEvidenceReason["code"])
        ? raw.code as LearningEvidenceReason["code"]
        : undefined;
    const message = publicPayloadText(raw.message, 500);
    return code && message ? { code, message } : undefined;
}

function publicImplementationRecipe(payload: Record<string, unknown>): ImplementationRecipeV1 | undefined {
    const value = payload.recipe;
    if (!value || typeof value !== "object" || Array.isArray(value)) return undefined;
    const raw = value as Record<string, unknown>;
    const integrationKind = typeof raw.integrationKind === "string"
        && PUBLIC_INTEGRATION_KINDS.has(raw.integrationKind as ImplementationRecipeV1["integrationKind"])
        ? raw.integrationKind as ImplementationRecipeV1["integrationKind"]
        : undefined;
    const title = publicRecipeText(raw.title, 160);
    const code = publicRecipeText(raw.code, 10_000);
    const imports = publicRecipeList(raw.imports, 24, 240);
    const versionScope = publicRecipeText(raw.versionScope, 300);
    const prerequisites = publicRecipeList(raw.prerequisites, 8, 400);
    const notes = publicRecipeList(raw.notes, 8, 500);
    const sourceIds = publicRecipeList(raw.sourceIds, 6, 100);
    if (raw.schemaVersion !== "implementation_recipe.v1"
        || raw.language !== "java"
        || !integrationKind
        || !title
        || !code
        || !imports
        || !versionScope
        || !prerequisites
        || !notes
        || !sourceIds) return undefined;
    return {
        schemaVersion: "implementation_recipe.v1",
        language: "java",
        integrationKind,
        title,
        code,
        imports,
        versionScope,
        prerequisites,
        notes,
        sourceIds,
    };
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
            k.knowledge_id, k.summary, k.kind, k.confidence, k.status, k.scope_json,
            k.payload_json, k.expires_at,
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
            const payload = parseJson<Record<string, unknown>>(row.payload_json, {});
            const reason = publicLearningReason(payload);
            const recipe = publicImplementationRecipe(payload);
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
                ...(reason ? { reason } : {}),
                ...(recipe ? { recipe } : {}),
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
