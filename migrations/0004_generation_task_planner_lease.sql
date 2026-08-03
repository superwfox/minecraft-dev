ALTER TABLE generation_tasks
ADD COLUMN planner_lease_token TEXT NOT NULL DEFAULT '';

ALTER TABLE generation_tasks
ADD COLUMN planner_lease_until INTEGER NOT NULL DEFAULT 0;
