import { describe, expect, it } from "vitest";
import {
    buildSafeDebugExport,
    SAFE_DEBUG_BYTE_LIMIT,
    SAFE_DEBUG_EVENT_LIMIT,
} from "../../src/logic/safeDebug";
import type { LearningDebugEvent, LearningProgress } from "../../src/logic/generateState";
import type { SafeDebugSource } from "../../src/logic/safeDebug";

function makeProgress(overrides: Partial<LearningProgress> = {}): LearningProgress {
    return {
        jobId: "learn-safe",
        status: "deferred",
        revision: 3,
        totalNeeds: 1,
        completedNeeds: 0,
        sourceCount: 0,
        searchedSourceCount: 0,
        message: "redacted-message-sentinel",
        reasonCode: "discovery_timeout",
        ...overrides,
    };
}

function makeSource(overrides: Partial<SafeDebugSource> = {}): SafeDebugSource {
    return {
        taskId: "task-safe",
        phase: "error",
        files: [],
        currentIndex: 0,
        plannerAttempt: 1,
        plannerReplan: false,
        debugLog: [],
        buildDiagnostics: [],
        learningProgress: makeProgress(),
        learningDebugEvents: [],
        learningDebugDroppedEvents: 0,
        ...overrides,
    };
}

function telemetry() {
    return {
        version: 1 as const,
        discoveryAttempts: 1,
        discoveryElapsedMs: 29_250,
        discoveryTimeouts: 1,
        discoveryRetryableFailures: 0,
        discoveryLastHttpStatus: 0,
        discoveryLastProviderStatus: "unknown" as const,
        candidateNeedCount: 0,
        candidateUrlCount: 0,
        sourceAttempts: 0,
        sourceAccepted: 0,
        sourceRejected: 0,
        sourceInvalid: 0,
        sourceDeduplicated: 0,
        sourceTimeouts: 0,
        sourceHttp4xx: 0,
        sourceHttp5xx: 0,
        sourceTooLarge: 0,
        sourceUnsupportedContentType: 0,
        sourceTooThin: 0,
        sourceElapsedMs: 0,
        sourceBudgetExhausted: 0,
        verificationAttempts: 0,
        verificationCompleted: 0,
        verificationSupported: 0,
        verificationContradicted: 0,
        verificationInsufficient: 0,
        verificationFailures: 0,
        verificationTimeouts: 0,
        verificationHttp4xx: 0,
        verificationHttp5xx: 0,
        verificationInvalidResponses: 0,
        verificationElapsedMs: 0,
    };
}

describe("safe Debug export", () => {
    it("exports only allowlisted diagnostic fields", () => {
        const source = makeSource({
            files: [{
                path: "src/main/java/private/Secret.java",
                role: "private-role-sentinel",
                content: "source-code-sentinel",
                status: "error",
            }],
            debugLog: [
                {
                    type: "debug",
                    bucket: 0,
                    msg: "task:throw",
                    path: "private-path-sentinel",
                    body: "provider-body-sentinel",
                    stack: "stack-trace-sentinel",
                },
                {
                    type: "debug",
                    scope: "build-fix",
                    msg: "fix:diagnostics",
                    diagnostics: [{ message: "diagnostic-message-sentinel" }],
                    fingerprint: "fingerprint-sentinel",
                },
                {
                    type: "debug",
                    bucket: 0,
                    msg: "unknown-sensitive-event",
                    apiKey: "api-key-sentinel",
                },
            ],
            buildDiagnostics: [
                {
                    category: "compile",
                    path: "compile-path-sentinel",
                    message: "compile-message-sentinel",
                    details: ["compile-details-sentinel"],
                },
                { category: "unexpected", message: "unknown-diagnostic-sentinel" },
            ],
            learningProgress: {
                ...makeProgress(),
                currentNeed: "current-need-sentinel",
            },
            learningDebugEvents: [{
                at: 1_700_000_000_000,
                kind: "http",
                stage: "planner",
                endpoint: "step",
                attempt: 1,
                httpStatus: 200,
                elapsedMs: 30_000,
                jobId: "learn-safe",
                requestRevision: 1,
                responseRevision: 2,
                fromStatus: "discovering",
                toStatus: "deferred",
                reasonCode: "discovery_timeout",
                telemetry: telemetry(),
                body: "responses-content-sentinel",
                headers: "authorization-header-sentinel",
                url: "https://private-url-sentinel.example/path",
                searchReason: "search-reason-sentinel",
                recipe: "recipe-code-sentinel",
                excerpt: "evidence-excerpt-sentinel",
            } as LearningDebugEvent],
        });
        const unsafeSource = source as SafeDebugSource & Record<string, unknown>;
        unsafeSource.userPrompt = "user-prompt-sentinel";
        unsafeSource.projectName = "project-name-sentinel";
        unsafeSource.packageName = "package-name-sentinel";
        unsafeSource.logs = ["full-log-sentinel"];
        unsafeSource.buildHistory = [{ content: "history-content-sentinel" }];
        unsafeSource.knowledgeUsed = [{ summary: "knowledge-summary-sentinel" }];
        unsafeSource.searchedSources = [{ url: "https://audit-url-sentinel.example" }];
        unsafeSource.learningEvidence = [{ excerpt: "stored-excerpt-sentinel" }];
        unsafeSource.implementationRecipe = { code: "stored-recipe-sentinel" };

        const payload = buildSafeDebugExport(source, 1_700_000_000_000);
        const json = JSON.stringify(payload, null, 2);

        expect(payload.schemaVersion).toBe("tahai.safe-debug.v1");
        expect(payload.generation.debug).toMatchObject({
            rawEvents: 3,
            acceptedEvents: 2,
            rejectedEvents: 1,
            droppedEvents: 0,
        });
        expect(payload.generation.debug.events).toEqual([
            { scope: "bucket", msg: "task:throw", bucket: 0 },
            { scope: "build-fix", msg: "fix:diagnostics" },
        ]);
        expect(payload.generation.debug.summaries).toEqual([
            { scope: "bucket", msg: "task:throw", count: 1 },
            { scope: "build-fix", msg: "fix:diagnostics", count: 1 },
        ]);
        expect(payload.generation.files).toMatchObject({ total: 1, error: 1 });
        expect(payload.build.diagnostics).toEqual({
            total: 2,
            compile: 1,
            dependency: 0,
            build: 0,
            unknown: 1,
        });
        expect(payload.learning.stages[0]).toMatchObject({
            stage: "planner",
            jobId: "learn-safe",
            status: "deferred",
            revision: 2,
            reasonCode: "discovery_timeout",
            telemetry: {
                discoveryAttempts: 1,
                discoveryTimeouts: 1,
                discoveryElapsedMs: 29_250,
            },
        });
        expect(payload.learning.events[0]).not.toHaveProperty("jobId");
        expect(payload.learning.events[0]).not.toHaveProperty("telemetry");

        for (const sentinel of [
            "source-code-sentinel", "private-path-sentinel", "provider-body-sentinel",
            "stack-trace-sentinel", "diagnostic-message-sentinel", "fingerprint-sentinel",
            "api-key-sentinel", "compile-path-sentinel", "compile-message-sentinel",
            "compile-details-sentinel", "unknown-diagnostic-sentinel", "current-need-sentinel",
            "responses-content-sentinel", "authorization-header-sentinel", "user-prompt-sentinel",
            "project-name-sentinel", "package-name-sentinel", "full-log-sentinel",
            "history-content-sentinel", "knowledge-summary-sentinel", "redacted-message-sentinel",
            "private-url-sentinel", "search-reason-sentinel", "recipe-code-sentinel",
            "evidence-excerpt-sentinel", "audit-url-sentinel", "stored-excerpt-sentinel",
            "stored-recipe-sentinel",
        ]) {
            expect(json).not.toContain(sentinel);
        }
    });

    it("keeps job deadline diagnostics without exporting timing anchors or the current need", () => {
        const startedAt = 7_777_777_777_777;
        const deadlineAt = startedAt + 240_000;
        const payload = buildSafeDebugExport(makeSource({
            learningProgress: makeProgress({
                stage: "fix",
                startedAt,
                deadlineAt,
                currentNeed: "private-current-need-sentinel",
                reasonCode: "job_deadline",
            }),
        }), 1_700_000_000_000);
        const json = JSON.stringify(payload);

        expect(payload.learning.current.reasonCode).toBe("job_deadline");
        expect(json).not.toContain(String(startedAt));
        expect(json).not.toContain(String(deadlineAt));
        expect(json).not.toContain("private-current-need-sentinel");
    });

    it("clears an earlier failure reason after a newer successful status", () => {
        const events: LearningDebugEvent[] = [
            {
                at: 1_700_000_000_000,
                kind: "http",
                stage: "planner",
                endpoint: "step",
                attempt: 1,
                httpStatus: 200,
                elapsedMs: 1_000,
                responseRevision: 1,
                toStatus: "deferred",
                reasonCode: "discovery_timeout",
            },
            {
                at: 1_700_000_001_000,
                kind: "http",
                stage: "planner",
                endpoint: "status",
                attempt: 2,
                httpStatus: 200,
                elapsedMs: 100,
                responseRevision: 2,
                toStatus: "ready",
            },
        ];

        const payload = buildSafeDebugExport(makeSource({
            learningProgress: makeProgress({
                status: "ready",
                revision: 2,
                reasonCode: undefined,
            }),
            learningDebugEvents: events,
        }), 1_700_000_002_000);

        expect(payload.learning.stages[0]).toMatchObject({
            stage: "planner",
            status: "ready",
            revision: 2,
        });
        expect(payload.learning.stages[0]).not.toHaveProperty("reasonCode");
    });

    it("reports events dropped by the runtime ring buffer before export", () => {
        const payload = buildSafeDebugExport(makeSource({
            learningDebugDroppedEvents: 44,
            learningDebugEvents: [{
                at: 1_700_000_000_000,
                kind: "http",
                stage: "planner",
                endpoint: "step",
                attempt: 256,
                httpStatus: 200,
                elapsedMs: 10,
                toStatus: "verifying",
            }],
        }), 1_700_000_000_001);

        expect(payload.redaction.droppedEvents).toBe(44);
        expect(payload.redaction.truncated).toBe(true);
    });

    it("keeps the newest events within both export budgets", () => {
        const events = Array.from({ length: 300 }, (_, index): LearningDebugEvent => ({
            at: 1_700_000_000_000 + index,
            kind: "http",
            stage: index % 2 ? "fix" : "planner",
            endpoint: "step",
            attempt: index,
            httpStatus: 200,
            elapsedMs: index,
            jobId: index % 2 ? "learn-fix" : "learn-planner",
            requestRevision: index,
            responseRevision: index + 1,
            fromStatus: "discovering",
            toStatus: "discovering",
        }));

        const payload = buildSafeDebugExport(makeSource({ learningDebugEvents: events }), 1_700_000_000_000);
        const bytes = new TextEncoder().encode(JSON.stringify(payload, null, 2)).byteLength;

        expect(payload.learning.events.length).toBeLessThanOrEqual(SAFE_DEBUG_EVENT_LIMIT);
        expect(payload.learning.events.at(-1)?.attempt).toBe(299);
        expect(payload.redaction.droppedEvents).toBeGreaterThanOrEqual(44);
        expect(payload.redaction.truncated).toBe(true);
        expect(bytes).toBeLessThanOrEqual(SAFE_DEBUG_BYTE_LIMIT);
    });
});
