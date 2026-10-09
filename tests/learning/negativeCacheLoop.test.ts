import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { sqliteD1 } from "./sqliteD1";
import { attestedReport, fixtureReport, FILES, COORDINATE, MISSING, FINGERPRINT } from "./compileEvidenceFixtures";
import { createDiagnosticLearningRequest, putModelLearningRequest } from "../../functions/_lib/learning/tool";
import { knowledgeLookupKey } from "../../functions/_lib/learning/assessment";
import { compileNegativeEvidence } from "../../functions/_lib/learning/compileApiEvidence";
import { prepareVerifiedNegativeApiFact } from "../../functions/_lib/learning/negativeApiFacts";
import { completeLearningJobStep, getLearningJob } from "../../functions/_lib/learning/store";
import { resolveModelLearningRequest } from "../../functions/_lib/learning/toolRuntime";
import { makeNeed } from "./testData";

const memory = vi.hoisted(() => ({ states: new Map<string, any>() }));
const discover = vi.hoisted(() => vi.fn());
const verifier = vi.hoisted(() => vi.fn());
vi.mock("../../functions/_lib/taskStore", async original => ({ ...await original<Record<string, unknown>>(),
    getOwnedTask: async (_env: any, taskId: string, uid: string) => memory.states.get(taskId)?.uid === uid ? JSON.stringify(memory.states.get(taskId)) : null,
    putTaskState: async (_env: any, taskId: string, state: any) => memory.states.set(taskId, JSON.parse(JSON.stringify(state))),
}));
vi.mock("../../functions/_lib/llm", async original => ({ ...await original<Record<string, unknown>>(), resolveTaskLLM: async () => null }));
vi.mock("../../functions/_lib/deepseekResponses", async original => ({ ...await original<Record<string, unknown>>(), discoverLearningSources: discover }));
vi.mock("../../functions/_lib/learning/verification", async original => ({ ...await original<Record<string, unknown>>(), verifyKnowledgeNeed: verifier }));

import { onRequestPost as start } from "../../functions/api/learning/start";
import { onRequestPost as step } from "../../functions/api/learning/step";
import { onRequestGet as status } from "../../functions/api/learning/status";

let database: ReturnType<typeof sqliteD1>;
const uid = "user-test";
beforeEach(() => { database = sqliteD1(); memory.states.clear(); discover.mockReset(); verifier.mockReset(); });
afterEach(() => database.close());

async function task(taskId: string, fingerprint = FINGERPRINT, runId = 452) {
    const report = await fixtureReport({ runId, headSha: String(runId % 10).repeat(40) });
    report.dependencies[0].fingerprint = fingerprint;
    const evidence = await attestedReport(report);
    const needs = [MISSING, "org.bukkit.Particle#SLIME"].map((symbol, index) => makeNeed({ id: `missing-${index}`,
        trigger: "contract_miss", integrationKind: "public_api", triggerReason: "compile_api_gap",
        scope: { coreType: "paper", mcVersion: "1.21", dependency: COORDINATE, packageName: symbol.startsWith("io.") ? "io.papermc.paper.event.player" : "org.bukkit", symbol },
        claim: { subject: symbol, question: `What is the exact Paper 1.21 API signature for ${symbol}?` } }));
    const request = await createDiagnosticLearningRequest({ originKey: `fix:${runId}:preflight:${report.pomHash}:${evidence.contextHash}`, needs });
    const state: any = { uid, coreType: "paper", version: "1.21", javaVersion: "21", generatedFiles: FILES,
        runId, buildHeadSha: evidence.headSha, buildBranch: `build-${taskId}`, compileApiEvidence: evidence,
        __taskOperationFence: `fence:${taskId}`, __taskOperationLeaseUntil: 0,
        status: "error", repairAttempts: 0, projectName: "PrivateDemo", packageName: "example.privateproject", userPrompt: "" };
    putModelLearningRequest(state, request);
    memory.states.set(taskId, state);
    await database.db.prepare("INSERT INTO generation_tasks VALUES (?1, ?2, ?3)").bind(taskId, uid, state.__taskOperationFence).run();
    return { state, request, evidence };
}
function context(taskId: string, body: any = {}, endpoint = "start") {
    return { request: endpoint === "status" ? new Request(`https://test.local/api/learning/status?taskId=${taskId}&jobId=${body.jobId}&stage=tool`)
        : new Request(`https://test.local/api/learning/${endpoint}`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ taskId, ...body }) }),
        env: { DB: database.db, TASKS: {} as KVNamespace }, data: { uid }, waitUntil: vi.fn() } as any;
}
async function begin(taskId: string, requestId: string) {
    const response = await start(context(taskId, { stage: "tool", toolRequestId: requestId }));
    expect(response.status).toBe(200);
    return response.json() as Promise<any>;
}
async function advance(taskId: string, snapshot: any) {
    const response = await step(context(taskId, { jobId: snapshot.learningProgress.jobId, revision: snapshot.learningProgress.revision }, "step"));
    expect(response.status).toBe(200);
    return response.json() as Promise<any>;
}
async function facts() { return (await database.db.prepare("SELECT * FROM negative_api_facts").all<any>()).results; }

describe("automatic negative cache closed loop against real SQLite", () => {
    it("A writes, B caches, C changes SNAPSHOT fingerprint without any model call", async () => {
        const first = await task("task-A");
        const queued = await begin("task-A", first.request.requestId);
        expect(queued.learningProgress.status).toBe("queued");
        const ready = await advance("task-A", queued);
        expect(ready.learningProgress).toMatchObject({ status: "ready", completedNeeds: 2 });
        expect(ready.negativeFactsUsed).toHaveLength(2);
        expect(ready.negativeFactsUsed.every((item: any) => item.source === "verified")).toBe(true);
        expect(ready.knowledgeUsed).toEqual([]);
        expect(await facts()).toHaveLength(2);
        const refreshed = await status(context("task-A", { jobId: ready.learningProgress.jobId }, "status"));
        expect((await refreshed.json() as any).negativeFactsUsed).toHaveLength(2);
        const resumed = await resolveModelLearningRequest({ env: context("task-A").env, state: memory.states.get("task-A"), uid,
            taskId: "task-A", requestId: first.request.requestId, jobId: ready.learningProgress.jobId });
        expect(resumed.status).toBe("resolved");
        if (resumed.status === "resolved") {
            expect(resumed.result.knowledgeContext).toContain(MISSING);
            expect(resumed.negativeFactsUsed.every(fact => fact.source === "verified")).toBe(true);
        }

        const second = await task("task-B", FINGERPRINT, 453);
        const cached = await begin("task-B", second.request.requestId);
        expect(cached.learningProgress.status).toBe("ready");
        expect(cached.learningProgress.message).toContain("命中不可用 API 缓存");
        expect(cached.negativeFactsUsed.map((item: any) => item.factId).sort()).toEqual(ready.negativeFactsUsed.map((item: any) => item.factId).sort());
        expect(cached.negativeFactsUsed.every((item: any) => item.source === "cache")).toBe(true);
        expect((await database.db.prepare("SELECT * FROM learning_jobs").all()).results).toHaveLength(1);

        const third = await task("task-C", "sha256:" + "c".repeat(64), 454);
        const changed = await begin("task-C", third.request.requestId);
        expect(changed.learningProgress.status).toBe("queued");
        expect(changed.negativeFactsUsed).toBeUndefined();
        await advance("task-C", changed);
        expect(await facts()).toHaveLength(4);
        expect(discover).not.toHaveBeenCalled(); expect(verifier).not.toHaveBeenCalled();
        expect(memory.states.get("task-A").repairAttempts).toBe(0);
    });

    it("rejects changed POM authorization before any public write", async () => {
        const first = await task("task-A");
        const queued = await begin("task-A", first.request.requestId);
        memory.states.get("task-A").generatedFiles = [{ path: "pom.xml", content: FILES[0].content + " " }];
        const response = await step(context("task-A", { jobId: queued.learningProgress.jobId, revision: queued.learningProgress.revision }, "step"));
        expect(response.status).toBe(409);
        expect(await facts()).toEqual([]);
    });

    it("rejects a public proof containing a private task identity without partial writes", async () => {
        const first = await task("task-A");
        const queued = await begin("task-A", first.request.requestId);
        memory.states.get("task-A").projectName = "PlayerShieldBlockEvent";
        const deferred = await advance("task-A", queued);
        expect(deferred.learningProgress.status).toBe("deferred");
        expect(await facts()).toEqual([]);
        expect((await database.db.prepare("SELECT * FROM learning_sources").all()).results).toEqual([]);
    });

    it("never reports invalidated or expired committed results as ready", async () => {
        const first = await task("task-A");
        const ready = await advance("task-A", await begin("task-A", first.request.requestId));
        await database.db.prepare("UPDATE negative_api_facts SET status = 'invalidated'").run();
        const response = await status(context("task-A", { jobId: ready.learningProgress.jobId }, "status"));
        const snapshot = await response.json() as any;
        expect(snapshot.learningProgress).toMatchObject({ status: "deferred", completedNeeds: 0 });
        expect(snapshot.negativeFactsUsed).toEqual([]);
        const resumed = await resolveModelLearningRequest({ env: context("task-A").env, state: first.state, uid,
            taskId: "task-A", requestId: first.request.requestId, jobId: ready.learningProgress.jobId });
        expect(resumed).toMatchObject({ status: "resolved", result: { status: "deferred", knowledgeContext: "" }, negativeFactsUsed: [] });
    });

    it("revalidates a saved cache result before model continuation", async () => {
        const first = await task("task-A");
        await advance("task-A", await begin("task-A", first.request.requestId));
        const second = await task("task-B", FINGERPRINT, 453);
        await begin("task-B", second.request.requestId);
        await database.db.prepare("UPDATE negative_api_facts SET expires_at = 1").run();
        const resumed = await resolveModelLearningRequest({ env: context("task-B").env, state: memory.states.get("task-B"), uid,
            taskId: "task-B", requestId: second.request.requestId });
        expect(resumed).toMatchObject({ status: "resolved", result: { status: "deferred", knowledgeContext: "" }, negativeFactsUsed: [] });
    });

    it("refreshes expired records and explicitly revalidates suspended records without duplication", async () => {
        const first = await task("task-A");
        await advance("task-A", await begin("task-A", first.request.requestId));
        await database.db.prepare("UPDATE negative_api_facts SET expires_at = 1, status = 'suspended', updated_at = 1").run();
        const next = await task("task-B", FINGERPRINT, 453);
        const ready = await advance("task-B", await begin("task-B", next.request.requestId));
        expect(ready.learningProgress.status).toBe("ready");
        expect(await facts()).toHaveLength(2);
        expect((await facts()).every(row => row.status === "active" && row.expires_at > Date.now())).toBe(true);
    });

    it("suspends automatic adoption for an exact positive/negative artifact conflict", async () => {
        const first = await task("task-A");
        const need = first.request.needs[0];
        await database.db.prepare(`INSERT INTO knowledge_items (knowledge_id, kind, lookup_key, scope_json, payload_json, summary, risk, confidence, status, valid_from, created_at, updated_at)
            VALUES ('positive-conflict', 'fact', ?1, ?2, ?3, 'Existing positive claim', 'medium', 1, 'active', 0, 0, 0)`)
            .bind(knowledgeLookupKey(need), JSON.stringify(need.scope), JSON.stringify({ assertion: "available", dependencyFingerprint: FINGERPRINT })).run();
        const deferred = await advance("task-A", await begin("task-A", first.request.requestId));
        expect(deferred.learningProgress.status).toBe("deferred");
        expect((await facts()).some(row => row.symbol === need.scope.symbol)).toBe(false);
    });
});

describe("negative writes share the existing atomic Learning lease", () => {
    async function guardedInput() {
        const first = await task("task-A");
        const queued = await begin("task-A", first.request.requestId);
        const jobId = queued.learningProgress.jobId;
        await database.db.prepare("UPDATE learning_jobs SET lease_token = 'lease-current', lease_until = ?1").bind(Date.now() + 60000).run();
        const proof = compileNegativeEvidence(first.request.needs[0], first.evidence)!;
        const prepared = await prepareVerifiedNegativeApiFact(proof);
        return { jobId, ownerUid: uid, expectedRevision: queued.learningProgress.revision, leaseToken: "lease-current", status: "ready" as const,
            taskStateFence: first.state.__taskOperationFence,
            work: { ...(await getLearningJob({ DB: database.db }, jobId, uid))!.work, negativeResultIds: { [first.request.needs[0].id]: prepared.fact.factId } },
            sources: [{ ...proof.source, jobId }], negativeFacts: [proof] };
    }
    for (const race of ["cancellation", "expired_lease", "wrong_revision"]) {
        it(`blocks public writes on ${race}`, async () => {
            const input = await guardedInput();
            if (race === "cancellation") await database.db.prepare("UPDATE generation_tasks SET planner_lease_token = 'cancelled'").run();
            if (race === "expired_lease") await database.db.prepare("UPDATE learning_jobs SET lease_until = 1").run();
            if (race === "wrong_revision") input.expectedRevision++;
            expect(await completeLearningJobStep({ DB: database.db }, input)).toBeNull();
            expect(await facts()).toEqual([]);
            expect((await database.db.prepare("SELECT * FROM learning_sources").all()).results).toEqual([]);
        });
    }
    it("rolls back all negative/source side effects when the transaction fails", async () => {
        const input = await guardedInput();
        const db = database.db;
        const broken = { prepare: db.prepare.bind(db), batch: (statements: D1PreparedStatement[]) =>
            db.batch([...statements.slice(0, -1), db.prepare("INSERT INTO missing_table VALUES (1)"), statements.at(-1)!]) } as D1Database;
        await expect(completeLearningJobStep({ DB: broken }, input)).rejects.toThrow();
        expect(await facts()).toEqual([]);
        expect((await db.prepare("SELECT * FROM learning_sources").all()).results).toEqual([]);
    });
    it("is idempotent when a completion is replayed", async () => {
        const input = await guardedInput();
        expect(await completeLearningJobStep({ DB: database.db }, input)).not.toBeNull();
        expect(await completeLearningJobStep({ DB: database.db }, input)).toBeNull();
        expect(await facts()).toHaveLength(1);
    });
});
