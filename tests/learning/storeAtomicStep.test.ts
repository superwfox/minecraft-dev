import { describe, expect, it } from "vitest";
import { completeLearningJobStep } from "../../functions/_lib/learning/store";
import type { KnowledgeStatus, LearningSourceRecord } from "../../functions/_lib/learning/types";
import { makeKnowledgeItem, makeSource } from "./testData";

interface JobRow {
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

interface SourceRow {
    source_id: string;
    job_id: string;
    need_id: string;
    canonical_url: string;
    domain: string;
    source_type: string;
    authority: string;
    title: string;
    published_at: number | null;
    fetched_at: number;
    content_hash: string;
    excerpt: string;
    verification_state: string;
}

interface KnowledgeRow {
    knowledge_id: string;
    kind: string;
    lookup_key: string;
    scope_json: string;
    payload_json: string;
    summary: string;
    risk: string;
    confidence: number;
    status: KnowledgeStatus;
    valid_from: number;
    expires_at: number;
    supersedes_id: string | null;
    revision: number;
    review_note: string;
    created_at: number;
    updated_at: number;
}

interface EvidenceRow {
    knowledge_id: string;
    source_id: string;
    relation: string;
    locator: string;
    excerpt: string;
}

interface AtomicState {
    job: JobRow;
    taskFence: string;
    sources: Map<string, SourceRow>;
    knowledge: Map<string, KnowledgeRow>;
    evidence: Map<string, EvidenceRow>;
}

interface RecordedStatement {
    sql: string;
    args: unknown[];
}

const NOW = 1_800_000_000_000;

function makeJob(overrides: Partial<JobRow> = {}): JobRow {
    return {
        job_id: "learn-test",
        owner_uid: "user-1",
        generation_task_id: "task-1",
        stage: "planner",
        lookup_hash: "lookup-hash",
        status: "verifying",
        needs_json: "[]",
        work_json: "{}",
        result_ids_json: "[]",
        revision: 4,
        lease_token: "lease-current",
        lease_until: NOW + 60_000,
        error: "",
        created_at: NOW - 10_000,
        updated_at: NOW - 1_000,
        ...overrides,
    };
}

function sourceRow(source: LearningSourceRecord): SourceRow {
    return {
        source_id: source.sourceId,
        job_id: source.jobId,
        need_id: source.needId,
        canonical_url: source.canonicalUrl,
        domain: source.domain,
        source_type: source.sourceType,
        authority: source.authority,
        title: source.title,
        published_at: source.publishedAt ?? null,
        fetched_at: source.fetchedAt,
        content_hash: source.contentHash,
        excerpt: source.excerpt,
        verification_state: source.verificationState,
    };
}

function knowledgeRow(overrides: Partial<KnowledgeRow> = {}): KnowledgeRow {
    const item = makeKnowledgeItem();
    return {
        knowledge_id: item.knowledgeId,
        kind: item.kind,
        lookup_key: item.lookupKey,
        scope_json: JSON.stringify(item.scope),
        payload_json: JSON.stringify(item.payload),
        summary: item.summary,
        risk: item.risk,
        confidence: item.confidence,
        status: item.status,
        valid_from: item.validFrom,
        expires_at: item.expiresAt,
        supersedes_id: item.supersedesId ?? null,
        revision: item.revision,
        review_note: item.reviewNote,
        created_at: item.createdAt,
        updated_at: item.updatedAt,
        ...overrides,
    };
}

function evidenceKey(row: Pick<EvidenceRow, "knowledge_id" | "source_id" | "relation">): string {
    return JSON.stringify([row.knowledge_id, row.source_id, row.relation]);
}

function cloneState(state: AtomicState): AtomicState {
    return {
        job: { ...state.job },
        taskFence: state.taskFence,
        sources: new Map([...state.sources].map(([key, value]) => [key, { ...value }])),
        knowledge: new Map([...state.knowledge].map(([key, value]) => [key, { ...value }])),
        evidence: new Map([...state.evidence].map(([key, value]) => [key, { ...value }])),
    };
}

function leaseMatches(
    state: AtomicState,
    jobId: unknown,
    ownerUid: unknown,
    revision: unknown,
    leaseToken: unknown,
    now: unknown,
): boolean {
    return state.job.job_id === jobId
        && state.job.owner_uid === ownerUid
        && state.job.revision === revision
        && state.job.lease_token === leaseToken
        && state.job.lease_until > Number(now);
}

function activePredecessor(
    state: AtomicState,
    lookupKey: string,
    excludedId: string,
): string | null {
    return [...state.knowledge.values()]
        .filter((row) => row.lookup_key === lookupKey
            && row.knowledge_id !== excludedId
            && row.status === "active")
        .sort((left, right) => right.revision - left.revision)[0]?.knowledge_id ?? null;
}

function createAtomicLearningD1(
    initial: AtomicState,
    options: { failOnKnowledgeInsert?: boolean } = {},
) {
    let current = cloneState(initial);
    let lastBatch: RecordedStatement[] = [];

    const prepared = (sql: string, args: unknown[] = []): any => ({
        sql,
        args,
        bind: (...bound: unknown[]) => prepared(sql, bound),
        first: async () => {
            if (sql.includes("SELECT * FROM knowledge_items WHERE knowledge_id = ?1")) {
                const row = current.knowledge.get(String(args[0]));
                return row ? { ...row } : null;
            }
            throw new Error(`unexpected first query: ${sql}`);
        },
    });

    const database = {
        prepare(sql: string) {
            return prepared(sql);
        },
        async batch(statements: any[]) {
            lastBatch = statements.map((statement) => ({
                sql: String(statement.sql),
                args: [...statement.args],
            }));
            const draft = cloneState(current);
            const results: any[] = [];

            for (const statement of lastBatch) {
                const sql = statement.sql.replace(/\s+/g, " ").trim();
                const args = statement.args;
                let changes = 0;
                let rows: JobRow[] = [];

                if (sql.startsWith("UPDATE learning_jobs SET lease_until = CASE")) {
                    if (leaseMatches(draft, args[0], args[1], args[2], args[3], args[4])) {
                        if (draft.taskFence !== args[5]) draft.job.lease_until = 0;
                        changes = 1;
                    }
                } else if (sql.startsWith("DELETE FROM learning_sources")) {
                    if (leaseMatches(draft, args[0], args[1], args[2], args[3], args[4])) {
                        for (const [sourceId, row] of draft.sources) {
                            if (row.job_id === args[0]) draft.sources.delete(sourceId);
                        }
                        changes = 1;
                    }
                } else if (sql.startsWith("INSERT OR REPLACE INTO learning_sources")) {
                    if (leaseMatches(draft, args[13], args[14], args[15], args[16], args[17])) {
                        const row: SourceRow = {
                            source_id: String(args[0]),
                            job_id: String(args[1]),
                            need_id: String(args[2]),
                            canonical_url: String(args[3]),
                            domain: String(args[4]),
                            source_type: String(args[5]),
                            authority: String(args[6]),
                            title: String(args[7]),
                            published_at: args[8] == null ? null : Number(args[8]),
                            fetched_at: Number(args[9]),
                            content_hash: String(args[10]),
                            excerpt: String(args[11]),
                            verification_state: String(args[12]),
                        };
                        draft.sources.set(row.source_id, row);
                        changes = 1;
                    }
                } else if (sql.startsWith("INSERT INTO knowledge_items")) {
                    if (options.failOnKnowledgeInsert) {
                        throw new Error("UNIQUE constraint failed: knowledge_items.lookup_key, knowledge_items.revision");
                    }
                    if (leaseMatches(draft, args[14], args[15], args[16], args[17], args[18])) {
                        const knowledgeId = String(args[0]);
                        const lookupKey = String(args[2]);
                        const revision = Math.max(0, ...[...draft.knowledge.values()]
                            .filter((row) => row.lookup_key === lookupKey)
                            .map((row) => row.revision)) + 1;
                        if (draft.knowledge.has(knowledgeId)
                            || [...draft.knowledge.values()].some((row) =>
                                row.lookup_key === lookupKey && row.revision === revision)) {
                            throw new Error("UNIQUE constraint failed: knowledge_items.lookup_key, knowledge_items.revision");
                        }
                        const status = String(args[8]) as KnowledgeStatus;
                        draft.knowledge.set(knowledgeId, {
                            knowledge_id: knowledgeId,
                            kind: String(args[1]),
                            lookup_key: lookupKey,
                            scope_json: String(args[3]),
                            payload_json: String(args[4]),
                            summary: String(args[5]),
                            risk: String(args[6]),
                            confidence: Number(args[7]),
                            status,
                            valid_from: Number(args[9]),
                            expires_at: Number(args[10]),
                            supersedes_id: status === "active"
                                ? String(args[11] ?? activePredecessor(draft, lookupKey, knowledgeId) ?? "") || null
                                : args[11] == null ? null : String(args[11]),
                            revision,
                            review_note: String(args[12]),
                            created_at: Number(args[13]),
                            updated_at: Number(args[13]),
                        });
                        changes = 1;
                    }
                } else if (sql.startsWith("UPDATE knowledge_items SET kind = ?2")) {
                    if (leaseMatches(draft, args[14], args[15], args[16], args[17], args[18])) {
                        const knowledgeId = String(args[0]);
                        const lookupKey = String(args[2]);
                        const row = draft.knowledge.get(knowledgeId);
                        if (row?.lookup_key === lookupKey) {
                            const status = String(args[8]) as KnowledgeStatus;
                            Object.assign(row, {
                                kind: String(args[1]),
                                scope_json: String(args[3]),
                                payload_json: String(args[4]),
                                summary: String(args[5]),
                                risk: String(args[6]),
                                confidence: Number(args[7]),
                                status,
                                valid_from: Number(args[9]),
                                expires_at: Number(args[10]),
                                supersedes_id: status === "active"
                                    ? String(args[11] ?? activePredecessor(draft, lookupKey, knowledgeId) ?? "") || null
                                    : args[11] == null ? null : String(args[11]),
                                review_note: String(args[12]),
                                updated_at: Number(args[13]),
                            });
                            changes = 1;
                        }
                    }
                } else if (sql.startsWith("UPDATE knowledge_items SET status = 'deprecated'")) {
                    if (leaseMatches(draft, args[4], args[5], args[6], args[7], args[8])
                        && args[3] === "active") {
                        const lookupKey = String(args[0]);
                        const knowledgeId = String(args[1]);
                        if (draft.knowledge.get(knowledgeId)?.lookup_key === lookupKey) {
                            for (const row of draft.knowledge.values()) {
                                if (row.lookup_key === lookupKey
                                    && row.knowledge_id !== knowledgeId
                                    && row.status === "active") {
                                    row.status = "deprecated";
                                    row.updated_at = Number(args[2]);
                                    changes++;
                                }
                            }
                        }
                    }
                } else if (sql.startsWith("DELETE FROM knowledge_evidence")) {
                    if (leaseMatches(draft, args[1], args[2], args[3], args[4], args[5])) {
                        for (const [key, row] of draft.evidence) {
                            if (row.knowledge_id === args[0]) draft.evidence.delete(key);
                        }
                        changes = 1;
                    }
                } else if (sql.startsWith("INSERT OR REPLACE INTO knowledge_evidence")) {
                    const knowledgeId = String(args[0]);
                    const sourceId = String(args[1]);
                    const jobId = String(args[5]);
                    if (leaseMatches(draft, jobId, args[6], args[7], args[8], args[9])
                        && draft.knowledge.get(knowledgeId)?.lookup_key === args[10]
                        && draft.sources.get(sourceId)?.job_id === jobId) {
                        const row: EvidenceRow = {
                            knowledge_id: knowledgeId,
                            source_id: sourceId,
                            relation: String(args[2]),
                            locator: String(args[3]),
                            excerpt: String(args[4]),
                        };
                        draft.evidence.set(evidenceKey(row), row);
                        changes = 1;
                    }
                } else if (sql.startsWith("UPDATE learning_jobs SET status = ?5")) {
                    if (leaseMatches(draft, args[0], args[1], args[2], args[3], args[8])) {
                        draft.job = {
                            ...draft.job,
                            status: String(args[4]),
                            work_json: String(args[5]),
                            result_ids_json: String(args[6]),
                            error: String(args[7]),
                            lease_token: "",
                            lease_until: 0,
                            revision: draft.job.revision + 1,
                            updated_at: Number(args[8]),
                        };
                        changes = 1;
                        rows = [{ ...draft.job }];
                    }
                } else {
                    throw new Error(`unexpected batch query: ${sql}`);
                }
                results.push({ meta: { changes }, results: rows });
            }

            current = draft;
            return results;
        },
    } as unknown as D1Database;

    return {
        database,
        snapshot: () => cloneState(current),
        statements: () => lastBatch,
    };
}

function baseState(overrides: Partial<AtomicState> = {}): AtomicState {
    return {
        job: makeJob(),
        taskFence: "state:current",
        sources: new Map(),
        knowledge: new Map(),
        evidence: new Map(),
        ...overrides,
    };
}

function knowledgeInput(overrides: Record<string, unknown> = {}) {
    return {
        knowledgeId: "know-current",
        kind: "fact" as const,
        lookupKey: "lookup-test",
        scope: { coreType: "paper", mcVersion: "1.21.4" },
        payload: { signature: "sendMessage(String)" },
        summary: "Current verified signature.",
        risk: "medium" as const,
        confidence: 0.97,
        status: "active" as const,
        validFrom: NOW,
        expiresAt: 0,
        evidence: [{
            sourceId: "src-current",
            relation: "supports",
            locator: "method summary",
            excerpt: "sendMessage(java.lang.String message)",
        }],
        now: NOW,
        ...overrides,
    };
}

describe("atomic learning step persistence", () => {
    it("keeps every side effect at zero when revision or lease identity is stale", async () => {
        const oldSource = sourceRow(makeSource({ sourceId: "src-old" }));
        const initial = baseState({ sources: new Map([[oldSource.source_id, oldSource]]) });
        const d1 = createAtomicLearningD1(initial);
        const before = d1.snapshot();

        const completed = await completeLearningJobStep({ DB: d1.database }, {
            jobId: "learn-test",
            ownerUid: "user-1",
            expectedRevision: 3,
            leaseToken: "lease-current",
            status: "ready",
            work: { completedNeeds: 1 },
            resultIds: ["know-current"],
            sources: [makeSource({ sourceId: "src-current" })],
            knowledge: knowledgeInput(),
            now: NOW,
        });

        expect(completed).toBeNull();
        expect(d1.snapshot()).toEqual(before);
        for (const statement of d1.statements()) {
            expect(statement.sql).toContain("owner_uid");
            expect(statement.sql).toContain("revision");
            expect(statement.sql).toContain("lease_token");
            expect(statement.sql).toContain("lease_until >");
        }
    });

    it("publishes no learning side effects when the task-state fence changed", async () => {
        const oldSource = sourceRow(makeSource({ sourceId: "src-old" }));
        const d1 = createAtomicLearningD1(baseState({
            sources: new Map([[oldSource.source_id, oldSource]]),
        }));

        const completed = await completeLearningJobStep({ DB: d1.database }, {
            jobId: "learn-test",
            ownerUid: "user-1",
            expectedRevision: 4,
            leaseToken: "lease-current",
            status: "ready",
            work: { completedNeeds: 1 },
            resultIds: ["know-current"],
            taskStateFence: "state:stale",
            sources: [makeSource({ sourceId: "src-current" })],
            knowledge: knowledgeInput(),
            now: NOW,
        });

        const state = d1.snapshot();
        expect(completed).toBeNull();
        expect([...state.sources.keys()]).toEqual(["src-old"]);
        expect(state.knowledge.size).toBe(0);
        expect(state.evidence.size).toBe(0);
        expect(state.job).toMatchObject({
            status: "verifying",
            revision: 4,
            work_json: "{}",
            result_ids_json: "[]",
            lease_token: "lease-current",
            lease_until: 0,
        });
    });

    it("atomically replaces the source set while completing the fetching step", async () => {
        const oldA = sourceRow(makeSource({ sourceId: "src-old-a" }));
        const oldB = sourceRow(makeSource({ sourceId: "src-old-b" }));
        const d1 = createAtomicLearningD1(baseState({
            job: makeJob({ status: "fetching" }),
            sources: new Map([[oldA.source_id, oldA], [oldB.source_id, oldB]]),
        }));
        const currentSource = makeSource({ sourceId: "src-current", fetchedAt: NOW });

        const completed = await completeLearningJobStep({ DB: d1.database }, {
            jobId: "learn-test",
            ownerUid: "user-1",
            expectedRevision: 4,
            leaseToken: "lease-current",
            status: "verifying",
            work: { sourceIds: [currentSource.sourceId] },
            sources: [currentSource],
            now: NOW,
        });

        expect(completed?.status).toBe("verifying");
        expect(completed?.revision).toBe(5);
        expect([...d1.snapshot().sources.keys()]).toEqual(["src-current"]);
        expect(d1.snapshot().job.lease_token).toBe("");
    });

    it("publishes knowledge, evidence, predecessor status, and job completion together", async () => {
        const source = sourceRow(makeSource({ sourceId: "src-current" }));
        const predecessor = knowledgeRow({
            knowledge_id: "know-previous",
            lookup_key: "lookup-test",
            revision: 1,
            status: "active",
        });
        const d1 = createAtomicLearningD1(baseState({
            sources: new Map([[source.source_id, source]]),
            knowledge: new Map([[predecessor.knowledge_id, predecessor]]),
        }));

        const completed = await completeLearningJobStep({ DB: d1.database }, {
            jobId: "learn-test",
            ownerUid: "user-1",
            expectedRevision: 4,
            leaseToken: "lease-current",
            status: "ready",
            work: { completedNeeds: 1 },
            resultIds: ["know-current"],
            knowledge: knowledgeInput(),
            now: NOW,
        });

        const state = d1.snapshot();
        expect(completed?.status).toBe("ready");
        expect(state.knowledge.get("know-current")).toMatchObject({
            revision: 2,
            status: "active",
            supersedes_id: "know-previous",
        });
        expect(state.knowledge.get("know-previous")?.status).toBe("deprecated");
        expect([...state.evidence.values()]).toEqual([expect.objectContaining({
            knowledge_id: "know-current",
            source_id: "src-current",
            relation: "supports",
        })]);
        expect(JSON.parse(state.job.result_ids_json)).toEqual(["know-current"]);
    });

    it("refreshes a deterministic orphan item and replaces its stale evidence", async () => {
        const source = sourceRow(makeSource({ sourceId: "src-current" }));
        const predecessor = knowledgeRow({
            knowledge_id: "know-previous",
            lookup_key: "lookup-test",
            revision: 1,
            status: "active",
        });
        const orphan = knowledgeRow({
            knowledge_id: "know-current",
            lookup_key: "lookup-test",
            payload_json: JSON.stringify({ stale: true }),
            summary: "stale orphan",
            confidence: 0.2,
            status: "needs_review",
            revision: 2,
            created_at: NOW - 50_000,
        });
        const staleEvidence: EvidenceRow = {
            knowledge_id: "know-current",
            source_id: "src-stale",
            relation: "supports",
            locator: "old",
            excerpt: "old excerpt",
        };
        const d1 = createAtomicLearningD1(baseState({
            sources: new Map([[source.source_id, source]]),
            knowledge: new Map([
                [predecessor.knowledge_id, predecessor],
                [orphan.knowledge_id, orphan],
            ]),
            evidence: new Map([[evidenceKey(staleEvidence), staleEvidence]]),
        }));

        await completeLearningJobStep({ DB: d1.database }, {
            jobId: "learn-test",
            ownerUid: "user-1",
            expectedRevision: 4,
            leaseToken: "lease-current",
            status: "ready",
            work: { completedNeeds: 1 },
            resultIds: ["know-current"],
            knowledge: knowledgeInput(),
            now: NOW,
        });

        const state = d1.snapshot();
        expect(state.knowledge.get("know-current")).toMatchObject({
            payload_json: JSON.stringify({ signature: "sendMessage(String)" }),
            summary: "Current verified signature.",
            confidence: 0.97,
            status: "active",
            supersedes_id: "know-previous",
            revision: 2,
            created_at: NOW - 50_000,
        });
        expect(state.knowledge.get("know-previous")?.status).toBe("deprecated");
        expect([...state.evidence.values()]).toEqual([expect.objectContaining({
            knowledge_id: "know-current",
            source_id: "src-current",
        })]);
    });

    it("rolls back source and job mutations when knowledge insertion fails", async () => {
        const oldSource = sourceRow(makeSource({ sourceId: "src-old" }));
        const d1 = createAtomicLearningD1(
            baseState({ sources: new Map([[oldSource.source_id, oldSource]]) }),
            { failOnKnowledgeInsert: true },
        );
        const before = d1.snapshot();

        await expect(completeLearningJobStep({ DB: d1.database }, {
            jobId: "learn-test",
            ownerUid: "user-1",
            expectedRevision: 4,
            leaseToken: "lease-current",
            status: "ready",
            work: { completedNeeds: 1 },
            resultIds: ["know-current"],
            sources: [makeSource({ sourceId: "src-current" })],
            knowledge: knowledgeInput(),
            now: NOW,
        })).rejects.toThrow("UNIQUE constraint failed");

        expect(d1.snapshot()).toEqual(before);
    });
});
