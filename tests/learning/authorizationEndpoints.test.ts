import { afterEach, describe, expect, it, vi } from "vitest";
import type { LearningJobRecord, LearningJobStatus } from "../../functions/_lib/learning/types";
import { makeNeed } from "./testData";

const getLearningJobMock = vi.hoisted(() => vi.fn());
const createOrGetLearningJobMock = vi.hoisted(() => vi.fn());
const findActiveKnowledgeMock = vi.hoisted(() => vi.fn());
const acquireLearningJobLeaseMock = vi.hoisted(() => vi.fn());
const completeLearningJobStepMock = vi.hoisted(() => vi.fn());
const getKnowledgeItemsByIdsMock = vi.hoisted(() => vi.fn());
const listLearningSourcesMock = vi.hoisted(() => vi.fn());
const resolveLLMMock = vi.hoisted(() => vi.fn());
const discoverLearningSourcesMock = vi.hoisted(() => vi.fn());
const fetchLearningSourcesMock = vi.hoisted(() => vi.fn());
const verifyKnowledgeNeedMock = vi.hoisted(() => vi.fn());

vi.mock("../../functions/_lib/learning/store", async (importOriginal) => ({
    ...await importOriginal<Record<string, unknown>>(),
    acquireLearningJobLease: acquireLearningJobLeaseMock,
    completeLearningJobStep: completeLearningJobStepMock,
    createOrGetLearningJob: createOrGetLearningJobMock,
    findActiveKnowledge: findActiveKnowledgeMock,
    getKnowledgeItemsByIds: getKnowledgeItemsByIdsMock,
    getLearningJob: getLearningJobMock,
    listLearningSources: listLearningSourcesMock,
}));

vi.mock("../../functions/_lib/llm", async (importOriginal) => ({
    ...await importOriginal<Record<string, unknown>>(),
    resolveLLM: resolveLLMMock,
}));

vi.mock("../../functions/_lib/deepseekResponses", async (importOriginal) => ({
    ...await importOriginal<Record<string, unknown>>(),
    discoverLearningSources: discoverLearningSourcesMock,
}));

vi.mock("../../functions/_lib/learning/sourceFetch", async (importOriginal) => ({
    ...await importOriginal<Record<string, unknown>>(),
    fetchLearningSources: fetchLearningSourcesMock,
}));

vi.mock("../../functions/_lib/learning/verification", async (importOriginal) => ({
    ...await importOriginal<Record<string, unknown>>(),
    verifyKnowledgeNeed: verifyKnowledgeNeedMock,
}));

import { onRequestPost as startLearning } from "../../functions/api/learning/start";
import { onRequestGet as getLearningStatus } from "../../functions/api/learning/status";
import { onRequestPost as stepLearning } from "../../functions/api/learning/step";

function terminalJob(): LearningJobRecord {
    return {
        jobId: "learn-old",
        ownerUid: "user-1",
        generationTaskId: "task-1",
        stage: "fix",
        lookupHash: "old-lookup",
        status: "ready",
        needs: [],
        work: {
            taskStateFence: "state:old",
            fixAuthorization: {
                runId: 202,
                previousRunId: 101,
                diagnosticsFingerprint: "a1b2c3d4",
                repairAttempts: 1,
            },
        },
        resultIds: ["know-old"],
        revision: 7,
        leaseToken: "",
        leaseUntil: 0,
        error: "",
        createdAt: 1_800_000_000_000,
        updatedAt: 1_800_000_001_000,
    };
}

function context(request: Request, raw = JSON.stringify({
    uid: "user-1",
    __taskOperationFence: "state:current",
    __taskOperationLeaseUntil: 0,
})): any {
    return {
        request,
        data: { uid: "user-1" },
        env: {
            TASKS: {
                get: async (key: string) => key === "task-1" ? raw : null,
                put: async () => undefined,
                delete: async () => undefined,
            } as unknown as KVNamespace,
            DEEPSEEK_API_KEY: "",
        },
    };
}

function contextWithTaskStates(request: Request, states: string[]): any {
    let index = 0;
    return {
        request,
        data: { uid: "user-1" },
        env: {
            TASKS: {
                get: async (key: string) => {
                    if (key !== "task-1") return null;
                    const value = states[Math.min(index, states.length - 1)] ?? null;
                    index++;
                    return value;
                },
                put: async () => undefined,
                delete: async () => undefined,
            } as unknown as KVNamespace,
            DEEPSEEK_API_KEY: "test-key",
        },
    };
}

function fixState(overrides: Record<string, unknown> = {}): string {
    const authorization = {
        runId: 202,
        previousRunId: 101,
        diagnosticsFingerprint: "a1b2c3d4",
        repairAttempts: 1,
    };
    return JSON.stringify({
        uid: "user-1",
        status: "error",
        runId: 202,
        repairAttempts: 1,
        coreType: "paper",
        version: "1.21.4",
        __taskOperationFence: "state:current",
        __taskOperationLeaseUntil: 0,
        fixDiagnosticsFingerprint: "a1b2c3d4",
        fixLearningAuthorization: authorization,
        pendingFixSnapshot: {
            attempt: 1,
            runId: 101,
            diagnostics: [{ key: "compile:a" }],
        },
        fixKnowledgeNeeds: [makeNeed({
            trigger: "diagnostic_repeat",
            integrationKind: "external_plugin",
            triggerReason: "persistent_diagnostic_gap",
            claim: {
                subject: "FancyHooksAPI#resolve",
                question: "What is the exact FancyHooksAPI#resolve contract for Paper 1.21.4?",
            },
            scope: {
                dependency: "FancyHooks",
                packageName: "dev.fancy.hooks",
                symbol: "dev.fancy.hooks.FancyHooksAPI#resolve",
            },
        })],
        grade: { vector: { external_deps: ["FancyHooks"] } },
        ...overrides,
    });
}

function activeFixJob(status: LearningJobStatus): LearningJobRecord {
    const need = makeNeed({
        trigger: "diagnostic_repeat",
        integrationKind: "external_plugin",
        triggerReason: "persistent_diagnostic_gap",
        claim: {
            subject: "FancyHooksAPI#resolve",
            question: "What is the exact FancyHooksAPI#resolve contract for Paper 1.21.4?",
        },
        scope: {
            dependency: "FancyHooks",
            packageName: "dev.fancy.hooks",
            symbol: "dev.fancy.hooks.FancyHooksAPI#resolve",
        },
    });
    const now = Date.now();
    return {
        jobId: "learn-active",
        ownerUid: "user-1",
        generationTaskId: "task-1",
        stage: "fix",
        lookupHash: "active-lookup",
        status,
        needs: [need],
        work: {
            taskStateFence: "state:current",
            fixAuthorization: {
                runId: 202,
                previousRunId: 101,
                diagnosticsFingerprint: "a1b2c3d4",
                repairAttempts: 1,
            },
            lastProgressAt: now,
            inactivityDeadlineAt: now + 300_000,
            ...(status === "fetching" ? {
                candidates: [{
                    needId: need.id,
                    sources: [{
                        url: "https://docs.example.test/fancy-hooks",
                        reason: "Official FancyHooks API documentation",
                    }],
                }],
            } : {}),
            ...(status === "verifying" ? {
                sourceIds: ["source-1"],
                completedNeeds: 0,
            } : {}),
        },
        resultIds: [],
        revision: 4,
        leaseToken: "",
        leaseUntil: 0,
        error: "",
        createdAt: now,
        updatedAt: now,
    };
}

function plannerState(taskStateFence: string): string {
    return JSON.stringify({
        uid: "user-1",
        __taskOperationFence: taskStateFence,
        __taskOperationLeaseUntil: 0,
        coreType: "paper",
        version: "1.21.4",
        userPrompt: "Integrate FancyHooks into the plugin.",
        grade: {
            gateRequired: false,
            paths: [],
            vector: { external_deps: ["FancyHooks"] },
            knowledgeNeeds: [makeNeed({
                integrationKind: "external_plugin",
                triggerReason: "external_plugin_contract",
                claim: {
                    subject: "FancyHooksAPI#resolve",
                    question: "What is the exact FancyHooksAPI#resolve contract for Paper 1.21.4?",
                },
                scope: {
                    dependency: "FancyHooks",
                    packageName: "dev.fancy.hooks",
                    symbol: "dev.fancy.hooks.FancyHooksAPI#resolve",
                },
                searchQueries: ["FancyHooksAPI resolve Paper 1.21.4 official documentation"],
            })],
        },
    });
}

afterEach(() => {
    getLearningJobMock.mockReset();
    createOrGetLearningJobMock.mockReset();
    findActiveKnowledgeMock.mockReset();
    acquireLearningJobLeaseMock.mockReset();
    completeLearningJobStepMock.mockReset();
    getKnowledgeItemsByIdsMock.mockReset();
    listLearningSourcesMock.mockReset();
    resolveLLMMock.mockReset();
    discoverLearningSourcesMock.mockReset();
    fetchLearningSourcesMock.mockReset();
    verifyKnowledgeNeedMock.mockReset();
});

describe("learning endpoint authorization", () => {
    it("changes the deduplication identity when the task-state fence changes", async () => {
        findActiveKnowledgeMock.mockResolvedValue([]);
        resolveLLMMock.mockResolvedValue({ canAutoLearn: true, providerId: "deepseek" });
        createOrGetLearningJobMock.mockImplementation(async (_env: unknown, input: any) => ({
            jobId: `learn-${createOrGetLearningJobMock.mock.calls.length}`,
            ownerUid: "user-1",
            generationTaskId: "task-1",
            stage: input.stage,
            lookupHash: input.lookupHash,
            status: "queued",
            needs: input.needs,
            work: input.work,
            resultIds: [],
            revision: 0,
            leaseToken: "",
            leaseUntil: 0,
            error: "",
            createdAt: input.now,
            updatedAt: input.now,
        } satisfies LearningJobRecord));

        for (const fence of ["state:old", "state:new", "state:new"]) {
            const response = await startLearning(context(new Request(
                "https://example.test/api/learning/start",
                {
                    method: "POST",
                    headers: { "Content-Type": "application/json" },
                    body: JSON.stringify({ taskId: "task-1", stage: "planner" }),
                },
            ), plannerState(fence)));
            expect(response.status).toBe(200);
        }

        const inputs = createOrGetLearningJobMock.mock.calls.map((call) => call[1] as any);
        expect(inputs).toHaveLength(3);
        expect(inputs[0].lookupHash).toMatch(/^[a-f0-9]{64}$/);
        expect(inputs[1].lookupHash).toMatch(/^[a-f0-9]{64}$/);
        expect(inputs[0].lookupHash).not.toBe(inputs[1].lookupHash);
        expect(inputs[1].lookupHash).toBe(inputs[2].lookupHash);
        expect(inputs.map((input) => input.work.taskStateFence)).toEqual([
            "state:old",
            "state:new",
            "state:new",
        ]);
    });

    it("rejects an obsolete terminal job from status reconciliation", async () => {
        getLearningJobMock.mockResolvedValue(terminalJob());
        const response = await getLearningStatus(context(new Request(
            "https://example.test/api/learning/status?taskId=task-1&jobId=learn-old&stage=fix",
        )));

        expect(response.status).toBe(404);
        expect(await response.json()).toMatchObject({
            reasonCode: "fix_authorization_expired",
        });
    });

    it("checks authorization before returning a terminal step snapshot", async () => {
        getLearningJobMock.mockResolvedValue(terminalJob());
        const response = await stepLearning(context(new Request(
            "https://example.test/api/learning/step",
            {
                method: "POST",
                headers: { "Content-Type": "application/json" },
                body: JSON.stringify({
                    taskId: "task-1",
                    jobId: "learn-old",
                    revision: 7,
                }),
            },
        )));

        expect(response.status).toBe(409);
        expect(await response.json()).toMatchObject({
            reasonCode: "fix_authorization_expired",
        });
    });

    it("binds Fix learning start to the complete authorization tuple", async () => {
        const response = await startLearning(context(new Request(
            "https://example.test/api/learning/start",
            {
                method: "POST",
                headers: { "Content-Type": "application/json" },
                body: JSON.stringify({
                    taskId: "task-1",
                    stage: "fix",
                    fixAuthorization: {
                        runId: 202,
                        previousRunId: 100,
                        diagnosticsFingerprint: "a1b2c3d4",
                        repairAttempts: 1,
                    },
                }),
            },
        ), fixState()));

        expect(response.status).toBe(409);
        expect(await response.json()).toMatchObject({
            reasonCode: "fix_authorization_expired",
        });
        expect(findActiveKnowledgeMock).not.toHaveBeenCalled();
        expect(createOrGetLearningJobMock).not.toHaveBeenCalled();
    });

    it.each(["discovering", "fetching", "verifying"] as LearningJobStatus[])(
        "revalidates Fix authorization immediately before the %s outbound call",
        async (status) => {
            const job = activeFixJob(status);
            const staleState = fixState({ runId: 203 });
            getLearningJobMock.mockResolvedValue(job);
            acquireLearningJobLeaseMock.mockResolvedValue(job);
            completeLearningJobStepMock.mockImplementation(async (_env: unknown, input: any) => ({
                ...job,
                status: input.status,
                work: input.work,
                resultIds: input.resultIds,
                error: input.error,
                revision: job.revision + 1,
            }));
            getKnowledgeItemsByIdsMock.mockResolvedValue([]);
            listLearningSourcesMock.mockResolvedValue(status === "verifying" ? [{
                sourceId: "source-1",
                jobId: job.jobId,
                needId: job.needs[0].id,
                url: "https://docs.example.test/fancy-hooks",
                title: "FancyHooks API",
                sourceType: "official_docs",
                authority: "primary",
                excerpt: "FancyHooksAPI resolve official contract for Paper 1.21.4.",
                contentHash: "source-hash",
                fetchedAt: Date.now(),
            }] : []);
            resolveLLMMock.mockResolvedValue({
                providerId: "deepseek",
                url: "https://api.deepseek.com/chat/completions",
                apiKey: "test-key",
                byok: false,
                learningCacheRead: true,
                canAutoLearn: true,
                modelFor: () => "deepseek-v4-flash",
            });

            const response = await stepLearning(contextWithTaskStates(new Request(
                "https://example.test/api/learning/step",
                {
                    method: "POST",
                    headers: { "Content-Type": "application/json" },
                    body: JSON.stringify({
                        taskId: "task-1",
                        jobId: job.jobId,
                        revision: job.revision,
                    }),
                },
            ), [fixState(), staleState]));

            expect(response.status).toBe(200);
            expect(await response.json()).toMatchObject({
                learningProgress: {
                    status: "deferred",
                    reasonCode: "fix_authorization_expired",
                },
            });
            expect(discoverLearningSourcesMock).not.toHaveBeenCalled();
            expect(fetchLearningSourcesMock).not.toHaveBeenCalled();
            expect(verifyKnowledgeNeedMock).not.toHaveBeenCalled();
        },
    );
});
