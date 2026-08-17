import { describe, expect, it } from "vitest";
import type { LLMProvider } from "../../functions/_lib/llm";
import {
    createModelLearningRequest,
    currentModelLearningAuthorization,
    getModelLearningRequest,
    learningToolDefinition,
    modelLearningContinuation,
    putModelLearningRequest,
    removeModelLearningRequest,
    sameModelLearningAuthorization,
} from "../../functions/_lib/learning/tool";

function provider(overrides: Partial<LLMProvider> = {}): LLMProvider {
    return {
        providerId: "deepseek",
        url: "https://api.deepseek.com/v1/chat/completions",
        apiKey: "test",
        byok: false,
        credentialId: "",
        learningCacheRead: true,
        canAutoLearn: true,
        modelFor: () => "deepseek-v4-pro",
        ...overrides,
    };
}

function toolCall(overrides: Record<string, unknown> = {}): Record<string, unknown> {
    return {
        id: "call_particle_slime",
        type: "function",
        function: {
            name: "learn_public_api",
            arguments: JSON.stringify({
                subject: "org.bukkit.Particle.SLIME",
                question: "Does org.bukkit.Particle.SLIME exist in Paper 1.21.8, and what is the exact replacement?",
                answerType: "migration",
                sourcePolicy: "api_signature",
                integrationKind: "public_api",
                dependency: "Paper API",
                packageName: "org.bukkit",
                symbol: "org.bukkit.Particle.SLIME",
                searchQueries: ["Paper 1.21.8 org.bukkit Particle Javadoc SLIME"],
                acceptanceCriteria: ["The versioned Paper Javadoc states the exact enum constants."],
                ...overrides,
            }),
        },
    };
}

describe("model-owned Learning tool", () => {
    it("only exposes the native function tool to an enabled DeepSeek provider", () => {
        expect(learningToolDefinition(provider())).toHaveLength(1);
        expect(learningToolDefinition(provider({ canAutoLearn: false }))).toEqual([]);
        expect(learningToolDefinition(provider({
            providerId: "glm",
            canAutoLearn: true,
        }))).toEqual([]);
    });

    it("turns a native tool call into a version-scoped request and preserves thinking context", async () => {
        const baseMessages = [
            { role: "system" as const, content: "Generate a Paper plugin." },
            { role: "user" as const, content: "Use a slime particle." },
        ];
        const request = await createModelLearningRequest({
            message: {
                role: "assistant",
                content: null,
                reasoning_content: "I need the exact enum contract.",
                tool_calls: [toolCall()],
            },
            messages: baseMessages,
            origin: "generate",
            originKey: "bucket:Main.java:generate:0",
            targetPath: "src/main/java/example/Main.java",
            coreType: "Paper",
            mcVersion: "1.21.8",
        });

        expect(request).not.toBeNull();
        expect(request).toMatchObject({
            schemaVersion: "model_learning_tool.v1",
            origin: "generate",
            round: 1,
        });
        expect(request!.lookupHash).toMatch(/^[a-f0-9]{64}$/);
        expect(request!.needs[0]).toMatchObject({
            integrationKind: "public_api",
            scope: {
                coreType: "Paper",
                mcVersion: "1.21.8",
                symbol: "org.bukkit.Particle.SLIME",
            },
        });
        expect(request!.messages.at(-1)).toMatchObject({
            role: "assistant",
            content: "",
            reasoning_content: "I need the exact enum contract.",
            tool_calls: [{ id: "call_particle_slime" }],
        });

        const continuation = modelLearningContinuation(request!, {
            status: "ready",
            knowledgeContext: "Paper 1.21.8 exposes ITEM_SLIME instead.",
        });
        expect(continuation.at(-1)).toMatchObject({
            role: "tool",
            tool_call_id: "call_particle_slime",
        });
        expect(continuation.at(-1)?.content).toContain("ITEM_SLIME");
    });

    it("rejects private-looking targets and undeclared external plugins", async () => {
        const base = {
            messages: [{ role: "user" as const, content: "Implement it." }],
            origin: "fix" as const,
            originKey: "fix:abc:Main.java",
            coreType: "Paper",
            mcVersion: "1.21.8",
        };
        await expect(createModelLearningRequest({
            ...base,
            message: {
                tool_calls: [toolCall({
                    subject: "com.example.private.SecretManager",
                    packageName: "com.example.private",
                    symbol: "com.example.private.SecretManager#load",
                })],
            },
        })).rejects.toThrow("learning_tool_arguments_invalid");

        await expect(createModelLearningRequest({
            ...base,
            message: {
                tool_calls: [toolCall({
                    subject: "me.clip.placeholderapi.PlaceholderAPI",
                    question: "What is the exact PlaceholderAPI expansion registration contract for the current version?",
                    integrationKind: "external_plugin",
                    dependency: "PlaceholderAPI",
                    packageName: "me.clip.placeholderapi",
                    symbol: "me.clip.placeholderapi.PlaceholderAPI",
                })],
            },
            allowedDependencies: ["Vault"],
        })).rejects.toThrow("learning_tool_arguments_invalid");
    });

    it("allows a declared external API and binds stored requests to a fingerprint", async () => {
        const request = await createModelLearningRequest({
            message: {
                tool_calls: [toolCall({
                    subject: "me.clip.placeholderapi.PlaceholderAPI",
                    question: "What is the exact PlaceholderAPI expansion registration contract for the current version?",
                    integrationKind: "external_plugin",
                    dependency: "me.clip:placeholderapi",
                    packageName: "me.clip.placeholderapi",
                    symbol: "me.clip.placeholderapi.PlaceholderAPI",
                })],
            },
            messages: [{ role: "user", content: "Implement PlaceholderAPI support." }],
            origin: "planner",
            originKey: "planner:plan_1234567890abcdef",
            coreType: "Paper",
            mcVersion: "1.21.8",
            allowedDependencies: ["PlaceholderAPI"],
        });
        expect(request).not.toBeNull();

        const state: Record<string, unknown> = {};
        putModelLearningRequest(state, request!);
        expect(getModelLearningRequest(state, request!.requestId)).toEqual(request);
        const authorization = currentModelLearningAuthorization(state, request!.requestId);
        expect(sameModelLearningAuthorization(authorization, {
            requestId: request!.requestId,
            needsFingerprint: request!.lookupHash,
        })).toBe(true);

        removeModelLearningRequest(state, request!.requestId);
        expect(getModelLearningRequest(state, request!.requestId)).toBeNull();
    });

    it("enforces the two-round tool-call safety limit", async () => {
        await expect(createModelLearningRequest({
            message: { tool_calls: [toolCall()] },
            messages: [{ role: "user", content: "Implement it." }],
            origin: "review",
            originKey: "bucket:Main.java:review:0",
            round: 3,
            coreType: "Paper",
            mcVersion: "1.21.8",
        })).rejects.toThrow("learning_tool_round_limit");
    });
});
