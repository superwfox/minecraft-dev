import { readFileSync } from "node:fs";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { LearningJobRecord } from "../../functions/_lib/learning/types";

const mocks = vi.hoisted(() => ({
    raw: "", job: null as LearningJobRecord | null, active: [] as { lookupKey: string; knowledgeId: string; revision: number }[],
    canAutoLearn: true, mutatePomOnLease: false, getLogs: vi.fn(), createJob: vi.fn(), discover: vi.fn(), model: vi.fn(),
}));
vi.mock("../../functions/_lib/github", () => ({ getRunJobs: async () => [{ id: 452, conclusion: "failure" }], getJobLogs: mocks.getLogs }));
vi.mock("../../functions/_lib/llm", async (original) => ({ ...await original<Record<string, unknown>>(),
    resolveTaskLLM: async () => ({ providerId: "deepseek", url: "https://model.test/chat/completions", apiKey: "test", byok: true,
        credentialId: "test", learningCacheRead: true, canAutoLearn: mocks.canAutoLearn, modelFor: () => "test-model" }),
}));
vi.mock("../../functions/_lib/taskStore", async (original) => ({ ...await original<Record<string, unknown>>(),
    getOwnedTask: async () => mocks.raw,
    acquireTaskOperationLease: async (_env: unknown, _id: string, _uid: string, token: string) => {
        const state = JSON.parse(mocks.raw); state.__taskOperationFence = token;
        if (mocks.mutatePomOnLease) {
            state.generatedFiles.find((file: { path: string }) => file.path === "pom.xml").content =
                state.generatedFiles.find((file: { path: string }) => file.path === "pom.xml").content.replace("1.21-R0.1-SNAPSHOT", "1.21.4-R0.1-SNAPSHOT");
            mocks.mutatePomOnLease = false;
        }
        mocks.raw = JSON.stringify(state); return "kv";
    },
    putTaskWithOperationLease: async (_env: unknown, _id: string, raw: string) => { mocks.raw = raw; return true; },
    putTaskState: async (_env: unknown, _id: string, state: unknown) => { mocks.raw = JSON.stringify(state); },
    releaseTaskOperationLease: async () => true, renewTaskOperationLease: async () => true,
}));
vi.mock("../../functions/_lib/learning/context", async (original) => ({ ...await original<Record<string, unknown>>(),
    loadKnowledgeContext: async (input: { needs: { scope: { dependency?: string } }[] }) => {
        const used = input.needs.some((need) => need.scope.dependency === "io.papermc.paper:paper-api:1.21-R0.1-SNAPSHOT") ? mocks.active : [];
        return { context: used.length ? "VERIFIED PUBLIC API FACT" : "", used, lookupKeys: [] };
    },
    recordKnowledgeContextUsage: async () => undefined,
}));
vi.mock("../../functions/_lib/learning/store", async (original) => ({ ...await original<Record<string, unknown>>(),
    findActiveKnowledge: async () => mocks.active,
    createOrGetLearningJob: mocks.createJob,
    getLearningJob: async () => mocks.job,
    getLatestLearningJobForTask: async () => mocks.job,
    getKnowledgeItemsByIds: async () => [], listLearningSources: async () => [],
    acquireLearningJobLease: async (_env: unknown, input: { leaseToken: string }) => ({ ...mocks.job, leaseToken: input.leaseToken }),
    completeLearningJobStep: async (_env: unknown, input: Partial<LearningJobRecord>) => {
        mocks.job = { ...mocks.job!, ...input, revision: mocks.job!.revision + 1 };
        return mocks.job;
    },
}));
vi.mock("../../functions/_lib/deepseekResponses", async (original) => ({ ...await original<Record<string, unknown>>(), discoverLearningSources: mocks.discover }));

import { onRequestPost as fixBuild } from "../../functions/api/generate/fix";
import { onRequestPost as startLearning } from "../../functions/api/learning/start";
import { onRequestPost as stepLearning } from "../../functions/api/learning/step";
import { onRequestGet as learningStatus } from "../../functions/api/learning/status";
import { knowledgeLookupKey } from "../../functions/_lib/learning/assessment";

const rawLog = readFileSync(new URL("../fixtures/build-failures/javac-missing-class.log", import.meta.url), "utf8");
const filePath = "src/main/java/com/tahai/maceshieldbreak/ShieldBlockListener.java";
const originalSource = "package com.tahai.maceshieldbreak; import io.papermc.paper.event.player.PlayerShieldBlockEvent; class ShieldBlockListener {}";
const fixedSource = "package com.tahai.maceshieldbreak; class ShieldBlockListener { void start() {} }";

function context(path: string, body?: unknown): { context: any; waits: Promise<unknown>[] } {
    const waits: Promise<unknown>[] = [];
    return { waits, context: {
        request: new Request(`https://example.test${path}`, body === undefined ? {} : {
            method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body),
        }), data: { uid: "user-1" },
        env: { DB: {}, TASKS: {}, GITHUB_PAT: "test", DEEPSEEK_API_KEY: "test" },
        waitUntil(promise: Promise<unknown>) { waits.push(promise); },
    } };
}
async function fix(mode: "diagnose" | "repair", extra: Record<string, unknown> = {}): Promise<any> {
    const current = JSON.parse(mocks.raw);
    const call = context("/api/generate/fix", { taskId: "task-1", mode,
        ...(mode === "repair" ? { repairAuthorization: current.fixRepairAuthorization } : {}), ...extra });
    const response = await fixBuild(call.context);
    const text = await response.text(); await Promise.all(call.waits);
    if (response.headers.get("Content-Type")?.includes("application/json")) return JSON.parse(text);
    const events = text.split("\n").filter((line) => line.startsWith("data: {")).map((line) => JSON.parse(line.slice(6)));
    return events.findLast((event) => event.type === "result");
}
async function learnStep(): Promise<any> {
    const call = context("/api/learning/step", { taskId: "task-1", jobId: mocks.job!.jobId, revision: mocks.job!.revision });
    return (await stepLearning(call.context)).json();
}

beforeEach(() => {
    mocks.canAutoLearn = true; mocks.mutatePomOnLease = false; mocks.active = []; mocks.job = null;
    mocks.raw = JSON.stringify({ taskId: "task-1", uid: "user-1", status: "error", runId: 452, repairAttempts: 0,
        coreType: "paper", version: "1.21", packageName: "com.tahai.maceshieldbreak", projectName: "MaceShieldBreak",
        grade: { vector: { external_deps: [] } }, logs: [], generatedFiles: [
            { path: filePath, content: originalSource }, { path: "pom.xml", content: "<project><dependencies><dependency><groupId>io.papermc.paper</groupId><artifactId>paper-api</artifactId><version>1.21-R0.1-SNAPSHOT</version><scope>provided</scope></dependency></dependencies></project>" },
        ] });
    mocks.getLogs.mockResolvedValue(rawLog);
    mocks.createJob.mockImplementation(async (_env: unknown, input: any) => {
        if (mocks.job) return mocks.job;
        mocks.job = { ...input, jobId: "learning-452", status: "queued", resultIds: [], revision: 0,
            leaseToken: "", leaseUntil: 0, error: "", createdAt: Date.now(), updatedAt: Date.now() };
        return mocks.job;
    });
    mocks.model.mockImplementation(async () => new Response(
        `data: ${JSON.stringify({ choices: [{ delta: { content: fixedSource } }] })}\n\ndata: [DONE]\n\n`, { status: 200 }));
    vi.stubGlobal("fetch", mocks.model);
});
afterEach(() => { vi.clearAllMocks(); vi.unstubAllGlobals(); });

describe("compiler-driven learning before the first Fixer call", () => {
    it("reuses an exact request across refresh, drives start/step/status, and safely repairs after discovery failure", async () => {
        await fix("diagnose");
        const first = await fix("repair");
        const requestId = first.learningToolRequests[0].requestId;
        expect(first.learningToolRequests[0].trigger).toBe("compile_diagnostic");
        expect(JSON.parse(mocks.raw).repairAttempts).toBe(0);
        expect(mocks.model).not.toHaveBeenCalled();
        expect((await fix("repair")).learningToolRequests[0].requestId).toBe(requestId);

        const start = context("/api/learning/start", { taskId: "task-1", stage: "tool", toolRequestId: requestId });
        expect(await (await startLearning(start.context)).json()).toMatchObject({ learningProgress: { status: "queued" } });
        const repeatedStart = context("/api/learning/start", { taskId: "task-1", stage: "tool", toolRequestId: requestId });
        expect(await (await startLearning(repeatedStart.context)).json()).toMatchObject({ learningProgress: { jobId: "learning-452" } });
        const progressedState = JSON.parse(mocks.raw);
        progressedState.modelLearningRequests[requestId].createdAt = Date.now() - 360_000;
        mocks.raw = JSON.stringify(progressedState);
        expect((await fix("repair", { learningToolJobs: { [requestId]: "learning-452" } })).learningToolRequests[0].requestId).toBe(requestId);
        expect((await fix("repair")).learningToolRequests[0].requestId).toBe(requestId);
        expect(mocks.model).not.toHaveBeenCalled();
        expect(await learnStep()).toMatchObject({ learningProgress: { status: "discovering" } });
        mocks.discover.mockResolvedValue({ ok: false, reasonCode: "discovery_timeout", attempts: [], candidates: [], usageEntries: [] });
        expect(await learnStep()).toMatchObject({ learningProgress: { status: "deferred", reasonCode: "discovery_timeout" } });
        const status = context("/api/learning/status?taskId=task-1&stage=tool&jobId=learning-452");
        expect(await (await learningStatus(status.context)).json()).toMatchObject({ learningProgress: { status: "deferred" } });
        const repaired = await fix("repair", { learningToolJobs: { [requestId]: "learning-452" } });
        expect(repaired.changed).toBe(1);
        expect(mocks.model).toHaveBeenCalledTimes(1);
        expect(JSON.parse(mocks.raw).repairAttempts).toBe(1);
        expect(JSON.parse(mocks.raw).fixLearningOutcome.reasonCode).toBe("discovery_timeout");
    });

    it("uses an exact cache hit before learning and supplies verified facts to the first Fixer", async () => {
        await fix("diagnose");
        const need = JSON.parse(mocks.raw).fixKnowledgeNeeds[0];
        mocks.active = [{ knowledgeId: "knowledge-452", revision: 1, lookupKey: knowledgeLookupKey(need) }];
        expect((await fix("repair")).changed).toBe(1);
        expect(mocks.createJob).not.toHaveBeenCalled();
        expect(JSON.parse(mocks.raw).fixLearningOutcome.reasonCode).toBe("knowledge_cache_hit");
        expect(String(mocks.model.mock.calls[0][1].body)).toContain("VERIFIED PUBLIC API FACT");
    });

    it("shows disabled learning honestly and does not charge an unchanged candidate as a repair", async () => {
        mocks.canAutoLearn = false;
        mocks.model.mockResolvedValue(new Response(`data: ${JSON.stringify({ choices: [{ delta: { content: originalSource } }] })}\n\ndata: [DONE]\n\n`));
        await fix("diagnose");
        expect((await fix("repair")).changed).toBe(0);
        expect(JSON.parse(mocks.raw).repairAttempts).toBe(0);
        expect(JSON.parse(mocks.raw).fixLearningOutcome.reasonCode).toBe("auto_learning_disabled");
        expect(mocks.createJob).not.toHaveBeenCalled();
    });

    it("invalidates a pending preflight when the declared dependency context changes", async () => {
        await fix("diagnose");
        const first = await fix("repair");
        const state = JSON.parse(mocks.raw);
        state.generatedFiles.find((file: { path: string }) => file.path === "pom.xml").content += "<!-- classpath revised -->";
        mocks.raw = JSON.stringify(state);
        const next = await fix("repair");
        expect(next.learningToolRequests[0].requestId).not.toBe(first.learningToolRequests[0].requestId);
        expect(JSON.parse(mocks.raw).repairAttempts).toBe(0);
    });

    it("releases a terminal client networking failure without restarting the same request", async () => {
        await fix("diagnose");
        const first = await fix("repair");
        const requestId = first.learningToolRequests[0].requestId;
        expect((await fix("repair", { learningToolFailures: { [requestId]: "client_network" } })).changed).toBe(1);
        expect(JSON.parse(mocks.raw).fixLearningOutcome.reasonCode).toBe("client_network");
        expect(mocks.discover).not.toHaveBeenCalled();
    });

    it("rechecks dependency identity after acquiring a lease before adopting preflight facts", async () => {
        await fix("diagnose");
        const first = await fix("repair");
        const requestId = first.learningToolRequests[0].requestId;
        const state = JSON.parse(mocks.raw);
        const request = state.modelLearningRequests[requestId];
        request.result = { status: "ready" };
        mocks.raw = JSON.stringify(state);
        mocks.active = [{ knowledgeId: "old-fact", revision: 1, lookupKey: knowledgeLookupKey(request.needs[0]) }];
        mocks.mutatePomOnLease = true;
        expect((await fix("repair")).changed).toBe(1);
        expect(String(mocks.model.mock.calls[0][1].body)).not.toContain("VERIFIED PUBLIC API FACT");
    });
});
