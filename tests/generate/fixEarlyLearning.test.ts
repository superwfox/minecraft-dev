import { readFileSync } from "node:fs";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { KnowledgeItemRecord, LearningJobRecord } from "../../functions/_lib/learning/types";
import type { NegativeApiFact } from "../../functions/_lib/learning/negativeApiFacts";

const mocks = vi.hoisted(() => ({
    raw: "", job: null as LearningJobRecord | null,
    active: [] as (Pick<KnowledgeItemRecord, "lookupKey" | "knowledgeId" | "revision"> & Partial<KnowledgeItemRecord>)[],
    sharedNegativeFacts: [] as NegativeApiFact[],
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
vi.mock("../../functions/_lib/learning/negativeApiFacts", async (original) => ({ ...await original<Record<string, unknown>>(),
    findActiveNegativeApiFacts: async () => mocks.sharedNegativeFacts,
}));

import { onRequestPost as fixBuild } from "../../functions/api/generate/fix";
import { onRequestPost as startLearning } from "../../functions/api/learning/start";
import { onRequestPost as stepLearning } from "../../functions/api/learning/step";
import { onRequestGet as learningStatus } from "../../functions/api/learning/status";
import { knowledgeLookupKey } from "../../functions/_lib/learning/assessment";

const rawLog = readFileSync(new URL("../fixtures/build-failures/javac-missing-class.log", import.meta.url), "utf8");
const filePath = "src/main/java/com/tahai/maceshieldbreak/ShieldBlockListener.java";
const originalSource = "package com.tahai.maceshieldbreak; import io.papermc.paper.event.player.PlayerShieldBlockEvent; class ShieldBlockListener {}";
const fixedSource = "package com.tahai.maceshieldbreak; class ShieldBlockListener { void start() {} }";
const unavailableSymbol = "io.papermc.paper.event.player.PlayerShieldBlockEvent";

function modelResponse(content: string): Response {
    return new Response(`data: ${JSON.stringify({ choices: [{ delta: { content } }] })}\n\ndata: [DONE]\n\n`, { status: 200 });
}

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
    mocks.canAutoLearn = true; mocks.mutatePomOnLease = false; mocks.active = []; mocks.job = null; mocks.sharedNegativeFacts = [];
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
    mocks.model.mockImplementation(async () => modelResponse(fixedSource));
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
        mocks.model.mockImplementation(async () => modelResponse(originalSource));
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

describe("compiler-scoped unavailable symbols in the actual Fixer endpoint", () => {
    it("deduplicates current-task compiler facts and replaces a rejected first candidate in one repair", async () => {
        mocks.canAutoLearn = false;
        await fix("diagnose");
        const diagnosed = JSON.parse(mocks.raw);
        expect(diagnosed.negativeApiFacts).toHaveLength(1);
        const factId = diagnosed.negativeApiFacts[0].factId;
        expect(diagnosed.negativeApiFacts[0]).toMatchObject({
            symbol: unavailableSymbol, taskId: "task-1", compileRunId: 452, coreType: "paper", mcVersion: "1.21",
            dependencyIdentity: "io.papermc.paper:paper-api:1.21-R0.1-SNAPSHOT",
            assertion: "unavailable", assertionScope: "compile_environment", evidenceKind: "compiler", status: "active",
        });
        expect(diagnosed.negativeApiFacts[0].classpathFingerprint).toMatch(/^sha256:[a-f0-9]{64}$/);
        expect(diagnosed.negativeApiFacts[0]).not.toHaveProperty("dependencyFingerprint");
        await fix("diagnose");
        expect(JSON.parse(mocks.raw).negativeApiFacts).toHaveLength(1);
        expect(JSON.parse(mocks.raw).negativeApiFacts[0].factId).toBe(factId);

        mocks.model.mockImplementationOnce(async () => modelResponse(originalSource))
            .mockImplementationOnce(async () => modelResponse(fixedSource));
        expect((await fix("repair")).changed).toBe(1);
        const stored = JSON.parse(mocks.raw);
        expect(mocks.model).toHaveBeenCalledTimes(2);
        expect(stored.repairAttempts).toBe(1);
        expect(stored.pendingFixSnapshot.changedFiles).toEqual([filePath]);
        expect(stored.generatedFiles.find((file: { path: string }) => file.path === filePath).content).toBe(fixedSource);
        expect(String(mocks.model.mock.calls[0][1].body)).toContain("已确认以下完整限定符号在当前编译依赖环境中不可用");
        expect(mocks.createJob).not.toHaveBeenCalled();
    });

    it("rejects two candidates that repeat the exact unavailable symbol without a rebuild attempt", async () => {
        mocks.canAutoLearn = false;
        await fix("diagnose");
        mocks.model.mockImplementation(async () => modelResponse(originalSource));
        const rejected = await fix("repair");
        expect(rejected.changed).toBe(0);
        expect(mocks.model).toHaveBeenCalledTimes(2);
        const stored = JSON.parse(mocks.raw);
        expect(stored.repairAttempts).toBe(0);
        expect(stored.status).toBe("error");
        expect(stored).not.toHaveProperty("pendingFixSnapshot");
        expect(stored.generatedFiles.find((file: { path: string }) => file.path === filePath).content).toBe(originalSource);
        expect(stored.buildFixHistory.at(-1)).toMatchObject({ status: "no-change", changedFiles: [] });
        expect(mocks.createJob).not.toHaveBeenCalled();
    });

    it("suspends exact-scope positive and negative conflicts before constructing model context", async () => {
        mocks.canAutoLearn = false;
        await fix("diagnose");
        const state = JSON.parse(mocks.raw);
        const fact = state.negativeApiFacts[0];
        const now = Date.now();
        mocks.active = [{
            knowledgeId: "conflicting-positive", lookupKey: knowledgeLookupKey(state.fixKnowledgeNeeds[0]), revision: 1,
            kind: "fact", status: "active", scope: { symbol: unavailableSymbol, coreType: "paper", mcVersion: "1.21",
                dependency: fact.dependencyIdentity },
            payload: { assertion: "available", dependencyIdentity: fact.dependencyIdentity, classpathFingerprint: fact.classpathFingerprint },
            summary: "CONFLICTING POSITIVE ASSERTS EVENT EXISTS", risk: "medium", confidence: 1,
            validFrom: now, expiresAt: now + 86_400_000, reviewNote: "", createdAt: now, updatedAt: now,
        }];
        expect((await fix("repair")).changed).toBe(1);
        expect(mocks.model).toHaveBeenCalledTimes(1);
        const body = String(mocks.model.mock.calls[0][1].body);
        expect(body).not.toContain("VERIFIED PUBLIC API FACT");
        expect(body).not.toContain("CONFLICTING POSITIVE ASSERTS EVENT EXISTS");
        expect(body).not.toContain("已确认以下完整限定符号在当前编译依赖环境中不可用");
        expect(JSON.parse(mocks.raw).negativeApiConflicts).toEqual([{ symbol: unavailableSymbol, dependencyIdentity: fact.dependencyIdentity }]);
        expect(JSON.parse(mocks.raw).knowledgeUsed ?? []).not.toEqual(expect.arrayContaining([expect.objectContaining({ knowledgeId: "conflicting-positive" })]));
    });

    it("restores all provisional edits when the combined candidate still references an unavailable symbol", async () => {
        mocks.canAutoLearn = false;
        const secondPath = "src/main/java/com/tahai/maceshieldbreak/SecondListener.java";
        const secondSource = `package com.tahai.maceshieldbreak; import ${unavailableSymbol}; class SecondListener {}`;
        const initial = JSON.parse(mocks.raw);
        initial.generatedFiles.push({ path: secondPath, content: secondSource });
        mocks.raw = JSON.stringify(initial);
        mocks.getLogs.mockResolvedValue(`${rawLog}\n${secondPath}:3: error: cannot find symbol\nimport ${unavailableSymbol};\n                                     ^\n  symbol: class PlayerShieldBlockEvent\n  location: package io.papermc.paper.event.player`);
        await fix("diagnose");
        expect(JSON.parse(mocks.raw).negativeApiFacts).toHaveLength(1);
        mocks.model.mockImplementationOnce(async () => modelResponse(fixedSource))
            .mockImplementationOnce(async () => modelResponse(secondSource))
            .mockImplementationOnce(async () => modelResponse(secondSource));
        const rejected = await fix("repair");
        expect(rejected.changed).toBe(0);
        expect(mocks.model).toHaveBeenCalledTimes(3);
        const stored = JSON.parse(mocks.raw);
        expect(stored.status).toBe("error");
        expect(stored.repairAttempts).toBe(0);
        expect(stored).not.toHaveProperty("pendingFixSnapshot");
        expect(stored.generatedFiles.find((file: { path: string }) => file.path === filePath).content).toBe(originalSource);
        expect(stored.generatedFiles.find((file: { path: string }) => file.path === secondPath).content).toBe(secondSource);
    });

    it("records and rejects the first imported enum miss with a canonical member identity", async () => {
        mocks.canAutoLearn = false;
        const enumSource = "package com.tahai.maceshieldbreak; import org.bukkit.Particle; class ShieldBlockListener { Object effect = Particle.SLIME; }";
        const initial = JSON.parse(mocks.raw);
        initial.generatedFiles.find((file: { path: string }) => file.path === filePath).content = enumSource;
        mocks.raw = JSON.stringify(initial);
        mocks.getLogs.mockResolvedValue([
            `2026-10-08T17:31:57.0453551Z ${filePath}:3: error: cannot find symbol`,
            "2026-10-08T17:31:57.0474643Z     Object effect = Particle.SLIME;",
            "2026-10-08T17:31:57.0484340Z                             ^",
            "2026-10-08T17:31:57.0514268Z   symbol: variable SLIME",
            "2026-10-08T17:31:57.0515110Z   location: class Particle",
        ].join("\n"));
        await fix("diagnose");
        expect(JSON.parse(mocks.raw).negativeApiFacts).toEqual([expect.objectContaining({
            symbol: "org.bukkit.Particle#SLIME", assertionScope: "compile_environment", evidenceKind: "compiler",
            dependencyIdentity: "io.papermc.paper:paper-api:1.21-R0.1-SNAPSHOT", taskId: "task-1", compileRunId: 452,
        })]);
        mocks.model.mockImplementation(async () => modelResponse(enumSource));
        const rejected = await fix("repair");
        expect(rejected.changed).toBe(0);
        expect(mocks.model).toHaveBeenCalledTimes(2);
        const stored = JSON.parse(mocks.raw);
        expect(stored.repairAttempts).toBe(0);
        expect(stored).not.toHaveProperty("pendingFixSnapshot");
        expect(stored.generatedFiles.find((file: { path: string }) => file.path === filePath).content).toBe(enumSource);
        expect(String(mocks.model.mock.calls[0][1].body)).toContain("org.bukkit.Particle#SLIME");
    });

    it("answers a model signature lookup from exact shared unavailable knowledge without discovery", async () => {
        const initial = JSON.parse(mocks.raw);
        initial.generatedFiles.find((file: { path: string }) => file.path === "pom.xml").content =
            initial.generatedFiles.find((file: { path: string }) => file.path === "pom.xml").content.replace("1.21-R0.1-SNAPSHOT", "1.21-R0.1");
        mocks.raw = JSON.stringify(initial);
        const coordinate = "io.papermc.paper:paper-api:1.21-R0.1";
        const now = Date.now();
        mocks.sharedNegativeFacts = [{ factId: "official-absence", symbol: unavailableSymbol,
            coreType: "paper", mcVersion: "1.21", dependencyIdentity: coordinate,
            assertion: "unavailable", assertionScope: "versioned_api", evidenceKind: "official",
            confidence: 1, status: "active", createdAt: now - 1, expiresAt: now + 86_400_000,
            verificationMethod: "official_versioned_inventory", verifiedBy: "deterministic",
        }];
        await fix("diagnose");
        const args = { subject: unavailableSymbol,
            question: `What is the exact ${unavailableSymbol} API signature in ${coordinate}?`,
            answerType: "signature", sourcePolicy: "api_signature", integrationKind: "public_api",
            dependency: coordinate, packageName: "io.papermc.paper.event.player", symbol: unavailableSymbol,
            searchQueries: [`${unavailableSymbol} ${coordinate} official versioned Javadoc`],
            acceptanceCriteria: [`Official versioned API documentation confirms the signature for ${coordinate}.`],
        };
        mocks.model.mockImplementationOnce(async () => new Response(`data: ${JSON.stringify({ choices: [{ delta: {
            tool_calls: [{ index: 0, id: "call-shared-absence", type: "function", function: {
                name: "learn_public_api", arguments: JSON.stringify(args),
            } }],
        } }] })}\n\ndata: [DONE]\n\n`, { status: 200 }))
            .mockImplementationOnce(async () => modelResponse(fixedSource));
        const repaired = await fix("repair");
        expect(repaired.changed).toBe(1);
        expect(repaired).not.toHaveProperty("learningToolRequests");
        expect(mocks.model).toHaveBeenCalledTimes(2);
        expect(mocks.createJob).not.toHaveBeenCalled();
        expect(mocks.discover).not.toHaveBeenCalled();
        const stored = JSON.parse(mocks.raw);
        expect(stored.repairAttempts).toBe(1);
        expect(stored).not.toHaveProperty("fixLearningRequestId");
        expect(stored).not.toHaveProperty("modelLearningRequests");
        const secondRequest = JSON.parse(String(mocks.model.mock.calls[1][1].body));
        const toolMessage = secondRequest.messages.find((message: { role: string }) => message.role === "tool");
        expect(toolMessage.tool_call_id).toBe("call-shared-absence");
        expect(JSON.parse(toolMessage.content)).toMatchObject({ status: "ready", reasonCode: "knowledge_cache_hit" });
        expect(JSON.parse(toolMessage.content).verifiedKnowledge).toContain("当前编译依赖环境中不可用");
        expect(JSON.parse(toolMessage.content).verifiedKnowledge).toContain(unavailableSymbol);
        expect(secondRequest).not.toHaveProperty("tools");
    });
});
