CREATE TABLE IF NOT EXISTS project_journal (
    sequence INTEGER PRIMARY KEY AUTOINCREMENT, event_id TEXT NOT NULL UNIQUE, task_id TEXT NOT NULL, owner_uid TEXT NOT NULL,
    recorded_at INTEGER NOT NULL, kind TEXT NOT NULL, payload TEXT NOT NULL,
    expires_at INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS project_journal_task ON project_journal(owner_uid, task_id, recorded_at, event_id);
CREATE TABLE IF NOT EXISTS project_journal_health (
    task_id TEXT NOT NULL, owner_uid TEXT NOT NULL, expected_events INTEGER NOT NULL DEFAULT 0,
    completed_events INTEGER NOT NULL DEFAULT 0, failed_events INTEGER NOT NULL DEFAULT 0, pruned_through INTEGER NOT NULL DEFAULT 0,
    PRIMARY KEY(task_id,owner_uid)
);
CREATE TABLE IF NOT EXISTS project_submissions (
    submission_id TEXT PRIMARY KEY, owner_uid TEXT NOT NULL, kind TEXT NOT NULL,
    payload_hash TEXT NOT NULL, state_json TEXT NOT NULL, updated_at INTEGER NOT NULL,
    lease_until INTEGER NOT NULL DEFAULT 0, lease_token TEXT NOT NULL DEFAULT ''
);
