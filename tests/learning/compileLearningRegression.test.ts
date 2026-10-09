import { readFileSync } from "node:fs";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { compareDiagnostics, diagnosticsFingerprint, formatDiagnostics, parseBuildDiagnostics } from "../../functions/_lib/buildDiagnostics";
import { assessCompileLearningEligibility, buildDiagnosticKnowledgeNeeds, knowledgeLookupKey, resolveCompileDependencyContext } from "../../functions/_lib/learning/assessment";
import { buildFixPrompt } from "../../functions/_lib/prompts";
import { buildKnowledgeContext, loadKnowledgeContext } from "../../functions/_lib/learning/context";
import { createDiagnosticLearningRequest, putModelLearningRequest, setModelLearningRequestResult } from "../../functions/_lib/learning/tool";
import { resolveModelLearningRequest } from "../../functions/_lib/learning/toolRuntime";
import { buildNegativeApiEnvironment, createCompilerNegativeApiFacts, mergeTaskNegativeApiFacts, negativeApiFactsContext, positiveApiFactsFromKnowledge, reconcileNegativeApiFacts, validateNegativeApiCandidate } from "../../functions/_lib/learning/negativeApiFacts";
import { makeKnowledgeItem } from "./testData";

const findActiveKnowledgeMock = vi.hoisted(() => vi.fn());
vi.mock("../../functions/_lib/learning/store", async (importOriginal) => ({
    ...await importOriginal<Record<string, unknown>>(),
    findActiveKnowledge: findActiveKnowledgeMock,
}));

const log = readFileSync(new URL("../fixtures/build-failures/javac-missing-class.log", import.meta.url), "utf8");
const symbol = "io.papermc.paper.event.player.PlayerShieldBlockEvent";
const path = "src/main/java/com/tahai/maceshieldbreak/ShieldBlockListener.java";
const pom = "<project><dependencies><dependency><groupId>io.papermc.paper</groupId><artifactId>paper-api</artifactId><version>1.21-R0.1-SNAPSHOT</version><scope>provided</scope></dependency></dependencies></project>";
const files = [{ path: "pom.xml", content: pom }, { path, content: `package com.tahai.maceshieldbreak;\nimport ${symbol};\nclass ShieldBlockListener { void onShieldBlock(PlayerShieldBlockEvent event) {} }` }];
const diagnostics = parseBuildDiagnostics(log);
const dependencies = resolveCompileDependencyContext(files);
const env = { DB: {} as D1Database, TASKS: {} as KVNamespace };

async function regressionContext() {
    const environment = await buildNegativeApiEnvironment({ coreType: "paper", mcVersion: "1.21", dependencies, pomContent: pom, compileRunId: 452 });
    const needs = buildDiagnosticKnowledgeNeeds({ diagnostics, coreType: "paper", mcVersion: "1.21", projectPackage: "com.tahai.maceshieldbreak", dependencies, generatedFiles: files });
    const facts = await createCompilerNegativeApiFacts({ taskId: "task-regression", compileRunId: 452, diagnostics, environment, dependencyForSymbol: (candidate) => candidate === symbol ? dependencies[0] : undefined });
    return { environment, needs, facts };
}

beforeEach(() => findActiveKnowledgeMock.mockReset().mockResolvedValue([]));

describe("real compiler log through the Learning and Fixer boundary", () => {
    it("keeps first-failure learning and safe candidate rejection working after an external timeout", async () => {
        const { environment, needs, facts } = await regressionContext();
        expect(diagnostics.map((item) => item.line)).toEqual([3, 22]);
        expect(needs).toHaveLength(1);
        expect(assessCompileLearningEligibility({ diagnostic: diagnostics[0], mcVersion: "1.21", dependencies, generatedFiles: files }).decision).toBe("LEARN");
        const cache = await loadKnowledgeContext({ env, needs, maxCharacters: 6_000 });
        expect(cache.used).toEqual([]);
        const request = await createDiagnosticLearningRequest({ originKey: `fix:${diagnosticsFingerprint(diagnostics)}:preflight:test`, needs });
        const state = { repairAttempts: 0 };
        putModelLearningRequest(state, request);
        setModelLearningRequestResult(state, request.requestId, { status: "deferred", reasonCode: "verification_timeout" });
        const resolution = await resolveModelLearningRequest({ env, state, uid: "user-regression", taskId: "task-regression", requestId: request.requestId });
        expect(resolution.status).toBe("resolved");
        if (resolution.status !== "resolved") throw new Error("Expected a terminal Learning result");
        expect(resolution.result).toMatchObject({ status: "deferred", reasonCode: "verification_timeout", knowledgeContext: "" });
        expect(state.repairAttempts).toBe(0);
        const prompt = buildFixPrompt(path, files[1].content, formatDiagnostics(diagnostics), {
            projectName: "MaceShieldBreak", packageName: "com.tahai.maceshieldbreak", coreType: "paper", version: "1.21", javaVersion: "21",
        }, [], "listener", "", negativeApiFactsContext(facts));
        expect(prompt.system).toContain(symbol);
        expect(prompt.system).toContain("不得再次引用上述符号");
        expect(validateNegativeApiCandidate({ files, facts, environment, taskId: "task-regression" }).map((item) => item.symbol)).toEqual([symbol]);
        // A same-named project type is outside this exact public dependency identity.
        const internalCandidate = [{ path, content: "package com.tahai.maceshieldbreak; import example.PlayerShieldBlockEvent; class ShieldBlockListener { PlayerShieldBlockEvent event; }" }];
        expect(validateNegativeApiCandidate({ files: internalCandidate, facts, environment, taskId: "task-regression" })).toEqual([]);
        expect(mergeTaskNegativeApiFacts(facts, facts, "task-regression", environment)).toHaveLength(1);
    });

    it("uses an exact positive cache hit and suspends conflicting conclusions before context construction", async () => {
        const { environment, needs, facts } = await regressionContext();
        const positive = makeKnowledgeItem({ lookupKey: knowledgeLookupKey(needs[0]), scope: needs[0].scope, payload: { assertion: "available", classpathFingerprint: environment.classpathFingerprint }, confidence: 1 });
        findActiveKnowledgeMock.mockResolvedValue([positive]);
        const cached = await loadKnowledgeContext({ env, needs, maxCharacters: 6_000 });
        expect(cached.lookupKeys).toEqual([positive.lookupKey]);
        expect(cached.used).toEqual([positive]);
        const reconciled = reconcileNegativeApiFacts({ facts, positiveFacts: positiveApiFactsFromKnowledge(cached.used), environment, taskId: "task-regression" });
        expect(reconciled.active).toEqual([]);
        expect(reconciled.suspendedKnowledgeIds).toEqual([positive.knowledgeId]);
        const safeKnowledge = cached.used.filter((item) => !reconciled.suspendedKnowledgeIds.includes(item.knowledgeId));
        expect(buildKnowledgeContext(safeKnowledge, 6_000).context).toBe("");
        expect(negativeApiFactsContext(reconciled.conflicts)).toBe("");
        expect(positive.status).toBe("active");
    });

    it("invalidates compiler observations when a new build or dependency version changes the environment", async () => {
        const { environment, facts } = await regressionContext();
        expect(validateNegativeApiCandidate({ files, facts, environment: { ...environment, compileRunId: 453 }, taskId: "task-regression" })).toEqual([]);
        const changed = await buildNegativeApiEnvironment({ coreType: "paper", mcVersion: "1.21.1", dependencies: [{ ...dependencies[0], version: "1.21.1-R0.1-SNAPSHOT" }], compileRunId: 452 });
        expect(validateNegativeApiCandidate({ files, facts, environment: changed, taskId: "task-regression" })).toEqual([]);
    });

    it("evaluates real diagnostic identities after a moved line or replacement package", () => {
        const moved = parseBuildDiagnostics(log.replace(/java:3:/g, "java:30:").replace(/java:22:/g, "java:40:"));
        expect(diagnosticsFingerprint(moved)).toBe(diagnosticsFingerprint(diagnostics));
        expect(compareDiagnostics(diagnostics, moved).status).toBe("stagnant");
        const replacement = parseBuildDiagnostics(log.replace(/io\.papermc\.paper\.event\.player/g, "com.destroystokyo.paper.event.player"));
        expect(compareDiagnostics(diagnostics, replacement).status).toBe("mixed");
    });
});
