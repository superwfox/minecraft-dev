-- Only verified public artifact/API absence is stored here. Compiler observations
-- remain in the private generation task state and never enter this table.
CREATE TABLE IF NOT EXISTS negative_api_facts (
    fact_id TEXT PRIMARY KEY,
    symbol TEXT NOT NULL,
    core_type TEXT NOT NULL,
    mc_version TEXT NOT NULL,
    dependency_identity TEXT NOT NULL,
    dependency_fingerprint TEXT NOT NULL DEFAULT '',
    assertion TEXT NOT NULL CHECK (assertion = 'unavailable'),
    assertion_scope TEXT NOT NULL CHECK (assertion_scope = 'versioned_api'),
    evidence_kind TEXT NOT NULL CHECK (evidence_kind IN ('artifact', 'official')),
    evidence_source_id TEXT NOT NULL,
    evidence_content_hash TEXT NOT NULL,
    evidence_source_url TEXT NOT NULL,
    verification_method TEXT NOT NULL CHECK (verification_method IN ('artifact_symbol_inventory', 'official_versioned_inventory')),
    verified_by TEXT NOT NULL CHECK (verified_by IN ('deterministic', 'human_review')),
    confidence REAL NOT NULL,
    status TEXT NOT NULL CHECK (status IN ('active', 'suspended', 'invalidated')),
    created_at INTEGER NOT NULL,
    expires_at INTEGER NOT NULL,
    updated_at INTEGER NOT NULL,
    UNIQUE (symbol, core_type, mc_version, dependency_identity, dependency_fingerprint)
);

CREATE INDEX IF NOT EXISTS idx_negative_api_facts_symbol_dependency
    ON negative_api_facts (symbol, dependency_identity, core_type, mc_version, status, expires_at);

CREATE INDEX IF NOT EXISTS idx_negative_api_facts_dependency_fingerprint
    ON negative_api_facts (dependency_identity, dependency_fingerprint, status);

CREATE INDEX IF NOT EXISTS idx_negative_api_facts_expiry
    ON negative_api_facts (status, expires_at);
