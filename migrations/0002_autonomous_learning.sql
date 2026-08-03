CREATE TABLE IF NOT EXISTS learning_jobs (
    job_id TEXT PRIMARY KEY,
    owner_uid TEXT NOT NULL,
    generation_task_id TEXT NOT NULL,
    stage TEXT NOT NULL,
    lookup_hash TEXT NOT NULL,
    status TEXT NOT NULL,
    needs_json TEXT NOT NULL,
    work_json TEXT NOT NULL DEFAULT '{}',
    result_ids_json TEXT NOT NULL DEFAULT '[]',
    revision INTEGER NOT NULL DEFAULT 0,
    lease_token TEXT NOT NULL DEFAULT '',
    lease_until INTEGER NOT NULL DEFAULT 0,
    error TEXT NOT NULL DEFAULT '',
    created_at INTEGER NOT NULL,
    updated_at INTEGER NOT NULL
);

CREATE UNIQUE INDEX IF NOT EXISTS idx_learning_jobs_dedupe
    ON learning_jobs (generation_task_id, stage, lookup_hash);

CREATE INDEX IF NOT EXISTS idx_learning_jobs_owner_updated
    ON learning_jobs (owner_uid, updated_at DESC);

CREATE INDEX IF NOT EXISTS idx_learning_jobs_status_updated
    ON learning_jobs (status, updated_at ASC);

CREATE TABLE IF NOT EXISTS learning_sources (
    source_id TEXT PRIMARY KEY,
    job_id TEXT NOT NULL,
    need_id TEXT NOT NULL,
    canonical_url TEXT NOT NULL,
    domain TEXT NOT NULL,
    source_type TEXT NOT NULL,
    authority TEXT NOT NULL,
    title TEXT NOT NULL DEFAULT '',
    published_at INTEGER,
    fetched_at INTEGER NOT NULL,
    content_hash TEXT NOT NULL,
    excerpt TEXT NOT NULL,
    verification_state TEXT NOT NULL DEFAULT 'pending'
);

CREATE INDEX IF NOT EXISTS idx_learning_sources_job_need
    ON learning_sources (job_id, need_id);

CREATE INDEX IF NOT EXISTS idx_learning_sources_hash
    ON learning_sources (content_hash);

CREATE TABLE IF NOT EXISTS knowledge_items (
    knowledge_id TEXT PRIMARY KEY,
    kind TEXT NOT NULL,
    lookup_key TEXT NOT NULL,
    scope_json TEXT NOT NULL,
    payload_json TEXT NOT NULL,
    summary TEXT NOT NULL,
    risk TEXT NOT NULL,
    confidence REAL NOT NULL,
    status TEXT NOT NULL,
    valid_from INTEGER NOT NULL,
    expires_at INTEGER NOT NULL DEFAULT 0,
    supersedes_id TEXT,
    revision INTEGER NOT NULL DEFAULT 1,
    review_note TEXT NOT NULL DEFAULT '',
    created_at INTEGER NOT NULL,
    updated_at INTEGER NOT NULL
);

CREATE UNIQUE INDEX IF NOT EXISTS idx_knowledge_items_lookup_revision
    ON knowledge_items (lookup_key, revision);

CREATE INDEX IF NOT EXISTS idx_knowledge_items_lookup_status
    ON knowledge_items (lookup_key, status, expires_at);

CREATE INDEX IF NOT EXISTS idx_knowledge_items_review
    ON knowledge_items (status, updated_at DESC);

CREATE TABLE IF NOT EXISTS knowledge_evidence (
    knowledge_id TEXT NOT NULL,
    source_id TEXT NOT NULL,
    relation TEXT NOT NULL,
    locator TEXT NOT NULL DEFAULT '',
    excerpt TEXT NOT NULL,
    PRIMARY KEY (knowledge_id, source_id, relation)
) WITHOUT ROWID;

CREATE INDEX IF NOT EXISTS idx_knowledge_evidence_source
    ON knowledge_evidence (source_id);

CREATE TABLE IF NOT EXISTS knowledge_usage (
    usage_id TEXT PRIMARY KEY,
    knowledge_id TEXT NOT NULL,
    generation_task_id TEXT NOT NULL,
    stage TEXT NOT NULL,
    diagnostic_before TEXT NOT NULL DEFAULT '',
    diagnostic_after TEXT NOT NULL DEFAULT '',
    outcome TEXT NOT NULL,
    applied_at INTEGER NOT NULL,
    evaluated_at INTEGER
);

CREATE INDEX IF NOT EXISTS idx_knowledge_usage_task
    ON knowledge_usage (generation_task_id, applied_at ASC);

CREATE INDEX IF NOT EXISTS idx_knowledge_usage_knowledge
    ON knowledge_usage (knowledge_id, applied_at DESC);

CREATE UNIQUE INDEX IF NOT EXISTS idx_knowledge_usage_once
    ON knowledge_usage (knowledge_id, generation_task_id, stage, diagnostic_before);
