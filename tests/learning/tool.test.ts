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
    type ModelChatMessage,
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

function toolCall(
    overrides: Record<string, unknown> = {},
    id = "call_particle_slime",
): Record<string, unknown> {
    return {
        id,
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

    it("allows continued tool calls beyond the former two-round limit", async () => {
        const request = await createModelLearningRequest({
            message: { tool_calls: [toolCall()] },
            messages: [{ role: "user", content: "Implement it." }],
            origin: "review",
            originKey: "bucket:Main.java:review:0",
            round: 12,
            coreType: "Paper",
            mcVersion: "1.21.8",
        });

        expect(request?.round).toBe(12);
        const state: Record<string, unknown> = {};
        putModelLearningRequest(state, request!);
        expect(getModelLearningRequest(state, request!.requestId)?.round).toBe(12);
    });

    it("retains the original system and user constraints across many continuations", async () => {
        const originalSystem = "Keep the generated plugin compatible with Paper 1.21.8.";
        const originalUser = "Implement the requested particle behavior without inventing APIs.";
        let messages: ModelChatMessage[] = [
            { role: "system", content: originalSystem },
            { role: "user", content: originalUser },
        ];

        for (let round = 1; round <= 12; round++) {
            const request = await createModelLearningRequest({
                message: {
                    role: "assistant",
                    content: `Learning request ${round}`,
                    tool_calls: [toolCall()],
                },
                messages,
                origin: "generate",
                originKey: "bucket:Main.java:generate:0",
                targetPath: "src/main/java/example/Main.java",
                round,
                coreType: "Paper",
                mcVersion: "1.21.8",
            });

            expect(request).not.toBeNull();
            messages = modelLearningContinuation(request!, {
                status: "ready",
                knowledgeContext: `Verified result ${round}`,
            });
        }

        expect(messages).toHaveLength(16);
        expect(messages[0]).toMatchObject({ role: "system", content: originalSystem });
        expect(messages[1]).toMatchObject({ role: "user", content: originalUser });
        expect(messages.at(-1)).toMatchObject({ role: "tool" });
        expect(messages.at(-1)?.content).toContain("Verified result 12");
        expect(messages.some((message) => message.content.includes("Verified result 11"))).toBe(true);
    });

    it("truncates only at complete multi-tool interaction boundaries", async () => {
        let messages: ModelChatMessage[] = [
            { role: "system", content: "Keep the original system contract." },
            { role: "user", content: "Keep the original user request." },
        ];

        for (let round = 1; round <= 7; round++) {
            const request = await createModelLearningRequest({
                message: {
                    role: "assistant",
                    content: `Single-call request ${round}`,
                    tool_calls: [toolCall({}, `call_single_${round}`)],
                },
                messages,
                origin: "generate",
                originKey: "bucket:Main.java:generate:0",
                round,
                coreType: "Paper",
                mcVersion: "1.21.8",
            });
            messages = modelLearningContinuation(request!, {
                status: "ready",
                knowledgeContext: `Single-call result ${round}`,
            });
        }

        const multiRequest = await createModelLearningRequest({
            message: {
                role: "assistant",
                content: "Two-call request",
                tool_calls: [
                    toolCall({}, "call_multi_particle"),
                    toolCall({
                        subject: "org.bukkit.Sound.ENTITY_SLIME_JUMP",
                        question: "Does org.bukkit.Sound.ENTITY_SLIME_JUMP exist in Paper 1.21.8?",
                        answerType: "signature",
                        symbol: "org.bukkit.Sound.ENTITY_SLIME_JUMP",
                        searchQueries: ["Paper 1.21.8 Sound ENTITY_SLIME_JUMP Javadoc"],
                        acceptanceCriteria: ["The versioned Paper Javadoc states the exact enum constant."],
                    }, "call_multi_sound"),
                ],
            },
            messages,
            origin: "generate",
            originKey: "bucket:Main.java:generate:0",
            round: 8,
            coreType: "Paper",
            mcVersion: "1.21.8",
        });
        messages = modelLearningContinuation(multiRequest!, {
            status: "ready",
            knowledgeContext: "Both facts are verified.",
        });

        expect(messages.length).toBeLessThanOrEqual(16);
        expect(messages[0]).toMatchObject({ role: "system", content: "Keep the original system contract." });
        expect(messages[1]).toMatchObject({ role: "user", content: "Keep the original user request." });
        expect(messages[2]?.role).toBe("assistant");

        let activeToolCallIds = new Set<string>();
        for (const message of messages.slice(2)) {
            if (message.role === "assistant") {
                activeToolCallIds = new Set(message.tool_calls?.map((call) => call.id) ?? []);
            } else if (message.role === "tool") {
                expect(activeToolCallIds.has(message.tool_call_id ?? "")).toBe(true);
            } else {
                activeToolCallIds.clear();
            }
        }

        const latestAssistantIndex = messages.findIndex((message) => message.content === "Two-call request");
        expect(latestAssistantIndex).toBeGreaterThan(1);
        expect(messages[latestAssistantIndex]?.tool_calls?.map((call) => call.id)).toEqual([
            "call_multi_particle",
            "call_multi_sound",
        ]);
        expect(messages.slice(latestAssistantIndex + 1).map((message) => message.tool_call_id)).toEqual([
            "call_multi_particle",
            "call_multi_sound",
        ]);
    });
});
