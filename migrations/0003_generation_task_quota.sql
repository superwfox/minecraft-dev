ALTER TABLE generation_tasks
ADD COLUMN quota_exhausted INTEGER NOT NULL DEFAULT 0;
