CREATE TABLE IF NOT EXISTS generation_tasks (
    task_id TEXT PRIMARY KEY,
    owner_uid TEXT NOT NULL DEFAULT '',
    cost_total REAL NOT NULL DEFAULT 0,
    cost_consumed INTEGER NOT NULL DEFAULT 0,
    created_at INTEGER NOT NULL,
    updated_at INTEGER NOT NULL,
    expires_at INTEGER NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_generation_tasks_expires_at
    ON generation_tasks (expires_at);

CREATE TABLE IF NOT EXISTS generation_task_chunks (
    task_id TEXT NOT NULL,
    chunk_index INTEGER NOT NULL,
    payload TEXT NOT NULL,
    PRIMARY KEY (task_id, chunk_index)
) WITHOUT ROWID;

