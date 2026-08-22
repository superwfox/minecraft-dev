import { describe, expect, it } from "vitest";
import {
    containsSharedKnowledgeForbiddenTerm,
    sharedKnowledgeForbiddenTerms,
    unprovenSharedKnowledgeForbiddenTerms,
} from "../../functions/_lib/learning/privacy";
import { makeNeed } from "./testData";


describe("shared learning knowledge privacy", () => {
    it("detects task, project package, generated path, and private class markers", () => {
        const terms = sharedKnowledgeForbiddenTerms({
            taskId: "task-private-1234",
            projectName: "TeleportSuite",
            packageName: "com.example.teleport",
            generatedFilePaths: [
                "src/main/java/com/example/teleport/TeleportManager.java",
                "src/main/resources/plugin.yml",
            ],
        });

        expect(containsSharedKnowledgeForbiddenTerm({
            scope: { packageName: "com.example.teleport.internal" },
        }, terms)).toBe(true);
        expect(containsSharedKnowledgeForbiddenTerm(
            "Use TeleportManager after task-private-1234 completes.",
            terms,
        )).toBe(true);
        expect(containsSharedKnowledgeForbiddenTerm(
            "Use me.clip.placeholderapi.PlaceholderAPI on the server thread.",
            terms,
        )).toBe(false);
    });

    it("does not treat generic project and file names as private markers", () => {
        const terms = sharedKnowledgeForbiddenTerms({
            projectName: "Plugin",
            generatedFilePaths: ["pom.xml", "src/main/java/example/Main.java"],
        });

        expect(terms).not.toContain("plugin");
        expect(terms).not.toContain("main");
        expect(containsSharedKnowledgeForbiddenTerm("public static void main(String[] args) {}", terms))
            .toBe(false);
    });

    it("extracts pre-plan identifiers from user input, clarification answers, dependencies, and needs", () => {
        const need = makeNeed({
            claim: {
                subject: "dev.sudark.secretbridge.SecretBridgeAPI",
                question: "What is the public SecretBridgeAPI contract for PlaceholderAPI integration?",
            },
            scope: {
                dependency: "SecretBridge",
                packageName: "dev.sudark.secretbridge",
                symbol: "dev.sudark.secretbridge.SecretBridgeAPI#register",
            },
            searchQueries: ["SecretBridgeAPI PlaceholderAPI public contract"],
        });
        const terms = sharedKnowledgeForbiddenTerms({
            userPrompt: "项目名 TeleportSuite，需要接入 PlaceholderAPI。",
            clarifyRounds: [{
                todos: [{ id: "package", question: "插件包名是什么？" }],
                answers: { dependency: "SecretBridge", package: "dev.private" },
            }],
            externalDeps: ["PlaceholderAPI", "SecretBridge"],
            knowledgeNeeds: [need],
        });

        expect(terms).toContain("teleportsuite");
        expect(terms).toContain("placeholderapi");
        expect(terms).toContain("secretbridge");
        expect(terms).toContain("dev.sudark.secretbridge");
        expect(terms).toContain("dev.private");
        expect(terms).toContain("secretbridgeapi");
        expect(terms).not.toContain("org.bukkit.entity");
        expect(terms).not.toContain("player");
    });

    it("does not reclassify classes inside core public namespaces as private terms", () => {
        const need = makeNeed({
            claim: {
                subject: "net.minecraft.server.level.ServerPlayer#connection",
                question: "what is the exact target method contract?",
            },
            scope: {
                packageName: "net.minecraft.server.level",
                symbol: "net.minecraft.server.level.ServerPlayer#connection",
            },
            searchQueries: ["versioned method signature"],
            acceptanceCriteria: ["versioned source states the exact signature"],
        });

        const terms = sharedKnowledgeForbiddenTerms({ knowledgeNeeds: [need] });

        expect(terms).not.toContain("net.minecraft.server.level.serverplayer");
        expect(terms).not.toContain("serverplayer");
    });

    it("does not treat public Maven diagnostics and search criteria as task-private identifiers", () => {
        const need = makeNeed({
            claim: {
                subject: "io.papermc.paper:paper-api",
                question: "What is the correct Maven coordinate and version for io.papermc.paper:paper-api targeting Minecraft Paper 26.2? The current pom uses 26.2-R0.1-SNAPSHOT and fails with DependencyResolutionException.",
                answerType: "coordinate",
            },
            scope: {
                dependency: "io.papermc.paper:paper-api:26.2-R0.1-SNAPSHOT",
                packageName: undefined,
                symbol: undefined,
            },
            sourcePolicy: "dependency",
            searchQueries: ["official Paper 26.2 Maven metadata stable coordinate"],
            acceptanceCriteria: ["Official metadata proves the replacement for the invalid snapshot."],
        });

        const terms = sharedKnowledgeForbiddenTerms({ knowledgeNeeds: [need] });

        expect(terms).not.toContain("dependencyresolutionexception");
        expect(terms).not.toContain("official");
        expect(terms).not.toContain("snapshot");
        expect(containsSharedKnowledgeForbiddenTerm(need, terms)).toBe(false);
    });

    it("fails closed when recursive task metadata exceeds the extraction limit", () => {
        const terms = sharedKnowledgeForbiddenTerms({
            clarifyRounds: [{
                answers: {
                    bulk: Array.from({ length: 257 }, (_, index) => `answer-${index}`),
                },
            }],
        });

        expect(terms).toContain("__shared_knowledge_private_term_overflow__");
        expect(containsSharedKnowledgeForbiddenTerm("otherwise public recipe", terms)).toBe(true);
    });

    it("only removes identifiers explicitly present in fetched excerpts", () => {
        const terms = [
            "placeholderapi",
            "me.clip.placeholderapi",
            "me/clip/placeholderapi",
            "secretmanager",
        ];
        const unproven = unprovenSharedKnowledgeForbiddenTerms(terms, [{
            excerpt: "The public PlaceholderAPI package is me.clip.placeholderapi and exposes expansion APIs.",
        }]);

        expect(unproven).not.toContain("placeholderapi");
        expect(unproven).not.toContain("me.clip.placeholderapi");
        expect(unproven).not.toContain("me/clip/placeholderapi");
        expect(unproven).toContain("secretmanager");
        expect(unprovenSharedKnowledgeForbiddenTerms(["placeholderapi"], [{
            excerpt: "PlaceholderAPIFork is a different identifier.",
        }])).toEqual(["placeholderapi"]);
    });
});
