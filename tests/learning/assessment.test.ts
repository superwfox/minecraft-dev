import { describe, expect, it } from "vitest";
import {
    assessKnowledgeNeeds,
    buildDiagnosticKnowledgeNeeds,
    deduplicateKnowledgeNeeds,
    filterFixKnowledgeNeeds,
    filterPlannerKnowledgeNeeds,
    filterSelectedPathKnowledgeNeeds,
    knowledgeLookupKey,
    learningLookupKeys,
} from "../../functions/_lib/learning/assessment";
import { makeNeed } from "./testData";

describe("knowledge need assessment", () => {
    it("normalizes a scoped atomic need and removes duplicate lists", () => {
        const raw = makeNeed({
            claim: {
                subject: "  org.bukkit.entity.Player#sendMessage  ",
                question: "What   is the exact Paper 1.21.4 signature for Player#sendMessage?",
            },
            searchQueries: ["Paper Player Javadoc", "paper player javadoc", ""],
            acceptanceCriteria: ["Official Javadoc states the signature.", "Official Javadoc states the signature."],
        });

        const result = assessKnowledgeNeeds([raw]);

        expect(result.rejected).toEqual([]);
        expect(result.accepted).toHaveLength(1);
        expect(result.accepted[0].claim.subject).toBe("org.bukkit.entity.Player#sendMessage");
        expect(result.accepted[0].claim.question).toBe(
            "What is the exact Paper 1.21.4 signature for Player#sendMessage?",
        );
        expect(result.accepted[0].searchQueries).toEqual(["Paper Player Javadoc"]);
        expect(result.accepted[0].acceptanceCriteria).toEqual(["Official Javadoc states the signature."]);
    });

    it("rejects ambiguous and generic learning topics", () => {
        const result = assessKnowledgeNeeds([
            makeNeed({ specificity: "ambiguous" }),
            makeNeed({
                id: "generic",
                claim: {
                    subject: "Paper API",
                    question: "Please research everything about Paper API for this plugin.",
                },
            }),
        ]);

        expect(result.accepted).toEqual([]);
        expect(result.rejected).toEqual([
            { index: 0, reason: "ambiguous" },
            { index: 1, reason: "generic_subject" },
        ]);
    });

    it("lets Planner learn only classified external integrations on the selected path", () => {
        const ordinaryBukkit = makeNeed({ id: "ordinary-bukkit" });
        const nms = makeNeed({
            id: "nms",
            integrationKind: "nms",
            triggerReason: "nms_version_sensitive",
            claim: {
                subject: "net.minecraft.server.level.ServerPlayer#connection",
                question: "What is the exact NMS connection member for Paper 1.21.4?",
            },
            scope: {
                packageName: "net.minecraft.server.level",
                symbol: "net.minecraft.server.level.ServerPlayer#connection",
            },
        });
        const craftBukkit = makeNeed({
            id: "craftbukkit",
            integrationKind: "craftbukkit",
            triggerReason: "reflection_contract",
            claim: {
                subject: "org.bukkit.craftbukkit.entity.CraftPlayer#getHandle",
                question: "What is the CraftBukkit getHandle contract for Paper 1.21.4?",
            },
            scope: {
                packageName: "org.bukkit.craftbukkit.entity",
                symbol: "org.bukkit.craftbukkit.entity.CraftPlayer#getHandle",
            },
        });
        const reflection = makeNeed({
            id: "reflection",
            integrationKind: "version_reflection",
            triggerReason: "reflection_contract",
            claim: {
                subject: "Class.forName org.bukkit.craftbukkit.CraftServer reflection",
                question: "Which reflected CraftBukkit server class is valid for Paper 1.21.4?",
            },
            scope: {
                packageName: "org.bukkit.craftbukkit",
                symbol: "Class.forName(org.bukkit.craftbukkit.CraftServer)",
            },
        });
        const placeholderApi = makeNeed({
            id: "placeholder-api",
            integrationKind: "external_plugin",
            triggerReason: "external_plugin_contract",
            pathIds: ["path-a"],
            claim: {
                subject: "PlaceholderAPI#setPlaceholders",
                question: "What is the supported PlaceholderAPI placeholder expansion call?",
            },
            scope: {
                dependency: "PlaceholderAPI",
                packageName: "me.clip.placeholderapi",
                symbol: "me.clip.placeholderapi.PlaceholderAPI#setPlaceholders",
            },
        });

        const accepted = filterPlannerKnowledgeNeeds([
            ordinaryBukkit,
            nms,
            craftBukkit,
            reflection,
            placeholderApi,
        ], {
            userPrompt: "使用 PlaceholderAPI 解析玩家变量",
            externalDeps: ["PlaceholderAPI"],
            chosenPathId: "path-a",
        });

        expect(accepted.accepted.map((need) => need.id)).toEqual([
            "nms",
            "craftbukkit",
            "reflection",
            "placeholder-api",
        ]);
        expect(accepted.rejected).toEqual([{
            index: 0,
            reason: "missing_integration_classification",
        }]);
        expect(filterPlannerKnowledgeNeeds([placeholderApi], {
            userPrompt: "使用 PlaceholderAPI 解析玩家变量",
            externalDeps: ["PlaceholderAPI"],
            chosenPathId: "path-b",
        }).rejected).toEqual([{ index: 0, reason: "unselected_path" }]);
        expect(filterPlannerKnowledgeNeeds([placeholderApi], {
            userPrompt: "普通计分板",
            externalDeps: ["PlaceholderAPI"],
            chosenPathId: "path-a",
        }).rejected).toEqual([{ index: 0, reason: "external_plugin_not_declared" }]);
    });

    it("requires a matching selected path for path-scoped needs", () => {
        const globalNeed = makeNeed({ id: "global" });
        const pathNeed = makeNeed({ id: "path-only", pathIds: ["path-a"] });

        expect(filterSelectedPathKnowledgeNeeds([globalNeed, pathNeed])).toEqual({
            accepted: [globalNeed],
            rejected: [{ index: 1, reason: "path_not_selected" }],
        });
        expect(filterSelectedPathKnowledgeNeeds([globalNeed, pathNeed], "path-b")).toEqual({
            accepted: [globalNeed],
            rejected: [{ index: 1, reason: "unselected_path" }],
        });
        expect(filterSelectedPathKnowledgeNeeds([globalNeed, pathNeed], "path-a").accepted)
            .toEqual([globalNeed, pathNeed]);
    });

    it("rejects malformed or unknown path constraints instead of widening them", () => {
        const invalidType = { ...makeNeed({ id: "invalid-type" }), pathIds: "path-a" };
        const tooMany = makeNeed({
            id: "too-many",
            pathIds: ["path-a", "path-b", "path-c", "path-d"],
        });
        const unknown = makeNeed({ id: "unknown", pathIds: ["path-z"] });

        const result = assessKnowledgeNeeds([invalidType, tooMany, unknown], {
            allowedPathIds: ["path-a", "path-b", "path-c"],
        });

        expect(result.accepted).toEqual([]);
        expect(result.rejected).toEqual([
            { index: 0, reason: "invalid_path_ids" },
            { index: 1, reason: "invalid_path_ids" },
            { index: 2, reason: "unknown_path_id" },
        ]);
    });

    it("allows Fix learning only after one repair and only for persistent external API facts", () => {
        const eligible = makeNeed({
            id: "eligible-fix",
            trigger: "diagnostic_repeat",
            integrationKind: "external_plugin",
            triggerReason: "persistent_diagnostic_gap",
        });
        const strategy = makeNeed({
            ...eligible,
            id: "strategy-fix",
            kind: "strategy",
        });
        const wrongTrigger = makeNeed({
            ...eligible,
            id: "wrong-trigger",
            trigger: "version_gap",
        });
        const missingIntegration = makeNeed({
            ...eligible,
            id: "missing-integration",
            integrationKind: undefined,
        });
        const plannerReason = makeNeed({
            ...eligible,
            id: "planner-reason",
            triggerReason: "external_plugin_contract",
        });

        expect(filterFixKnowledgeNeeds([eligible], { repairAttempts: 0 })).toEqual({
            accepted: [],
            rejected: [{ index: 0, reason: "repair_not_attempted" }],
        });

        const result = filterFixKnowledgeNeeds([
            eligible,
            strategy,
            wrongTrigger,
            missingIntegration,
            plannerReason,
        ], { repairAttempts: 1 });

        expect(result.accepted.map((need) => need.id)).toEqual(["eligible-fix"]);
        expect(result.rejected).toEqual([
            { index: 1, reason: "fix_strategy_not_allowed" },
            { index: 2, reason: "fix_trigger_not_diagnostic_repeat" },
            { index: 3, reason: "missing_integration_classification" },
            { index: 4, reason: "fix_not_persistent_diagnostic_gap" },
        ]);
    });

    it("builds a stable lookup key regardless of scope property order", () => {
        const first = makeNeed({
            scope: {
                dependency: "WorldGuard",
                symbol: "WorldGuard#getInstance",
            },
        });
        const second = {
            ...first,
            scope: {
                symbol: first.scope.symbol,
                dependency: first.scope.dependency,
                mcVersion: first.scope.mcVersion,
                coreType: first.scope.coreType,
                packageName: first.scope.packageName,
            },
        };

        expect(knowledgeLookupKey(first)).toBe(knowledgeLookupKey(second));
        expect(learningLookupKeys([second, first])).toEqual([knowledgeLookupKey(first)]);
    });

    it("keeps stricter risk and evidence policies out of weaker cache identities", () => {
        const base = makeNeed({
            acceptanceCriteria: ["Official Javadoc confirms the symbol.", "Version matches 1.21.4."],
        });
        const reordered = makeNeed({
            acceptanceCriteria: ["Version matches 1.21.4.", "Official Javadoc confirms the symbol."],
        });
        const highRisk = makeNeed({
            risk: "high",
            acceptanceCriteria: base.acceptanceCriteria,
        });
        const releasePolicy = makeNeed({
            sourcePolicy: "release",
            acceptanceCriteria: base.acceptanceCriteria,
        });
        const stricterCriteria = makeNeed({
            acceptanceCriteria: [...base.acceptanceCriteria, "A ground-truth source is required."],
        });

        expect(knowledgeLookupKey(reordered)).toBe(knowledgeLookupKey(base));
        expect(knowledgeLookupKey(highRisk)).not.toBe(knowledgeLookupKey(base));
        expect(knowledgeLookupKey(releasePolicy)).not.toBe(knowledgeLookupKey(base));
        expect(knowledgeLookupKey(stricterCriteria)).not.toBe(knowledgeLookupKey(base));
    });

    it("deduplicates semantically identical needs by lookup key", () => {
        const first = makeNeed({ id: "need-first" });
        const duplicate = makeNeed({ id: "need-duplicate" });
        const distinct = makeNeed({
            id: "need-distinct",
            claim: {
                subject: "org.bukkit.entity.Player#isOnline",
                question: "What does Player#isOnline return on Paper 1.21.4?",
            },
            scope: { symbol: "org.bukkit.entity.Player#isOnline" },
        });

        expect(deduplicateKnowledgeNeeds([first, duplicate, distinct])).toEqual([first, distinct]);
    });

    it("derives Fixer needs only after a prior repair and only for external API gaps", () => {
        const worldGuardDiagnostic = {
            key: "pom.xml:worldguard",
            path: "pom.xml",
            message: "package com.sk89q.worldguard.protection.regions does not exist",
            details: [],
            category: "dependency" as const,
        };
        const previousDiagnostics = [{
            key: "src/main/java/Test.java:previous",
            path: "src/main/java/Test.java",
            message: "cannot find symbol com.sk89q.worldguard.WorldGuard",
            details: [],
            category: "compile" as const,
        }];
        const unrelatedPreviousDiagnostics = [{
            key: "src/main/java/Test.java:placeholder",
            path: "src/main/java/Test.java",
            message: "cannot find symbol me.clip.placeholderapi.PlaceholderAPI",
            details: [],
            category: "compile" as const,
        }];
        const input = {
            diagnostics: [worldGuardDiagnostic],
            coreType: "paper",
            mcVersion: "1.21.4",
            projectPackage: "com.example.plugin",
            externalDeps: ["WorldGuard"],
        };

        expect(buildDiagnosticKnowledgeNeeds(input)).toEqual([]);

        const publicNeeds = buildDiagnosticKnowledgeNeeds({
            ...input,
            previousDiagnostics,
        });
        const unrelatedNeeds = buildDiagnosticKnowledgeNeeds({
            ...input,
            previousDiagnostics: unrelatedPreviousDiagnostics,
        });
        const genericDependencyNeeds = buildDiagnosticKnowledgeNeeds({
            diagnostics: [{
                key: "pom.xml:network",
                path: "pom.xml",
                message: "Could not transfer artifact org.apache.maven.plugins:maven-compiler-plugin from central",
                details: ["Connection timed out"],
                category: "dependency",
            }],
            previousDiagnostics,
            coreType: "paper",
            mcVersion: "1.21.4",
            projectPackage: "com.example.plugin",
            externalDeps: ["WorldGuard"],
        });
        const externalArtifactNetworkNeeds = buildDiagnosticKnowledgeNeeds({
            diagnostics: [worldGuardDiagnostic, {
                key: "pom.xml:worldguard-transfer",
                path: "pom.xml",
                message: "Could not transfer artifact com.sk89q.worldguard:worldguard-bukkit:jar:7.0.9 from/to paper-repo",
                details: ["UnknownHostException: repo.papermc.io"],
                category: "dependency",
            }],
            previousDiagnostics,
            coreType: "paper",
            mcVersion: "1.21.4",
            projectPackage: "com.example.plugin",
            externalDeps: ["WorldGuard"],
        });
        const privateNeeds = buildDiagnosticKnowledgeNeeds({
            diagnostics: [{
                key: "src/main/java/Test.java:private",
                path: "src/main/java/Test.java",
                message: "package com.example.plugin.internal does not exist",
                details: [],
                category: "compile",
            }],
            previousDiagnostics,
            coreType: "paper",
            mcVersion: "1.21.4",
            projectPackage: "com.example.plugin",
        });
        const ordinaryBukkitNeeds = buildDiagnosticKnowledgeNeeds({
            diagnostics: [{
                key: "src/main/java/Test.java:bukkit",
                path: "src/main/java/Test.java",
                message: "package org.bukkit.entity does not exist",
                details: [],
                category: "compile",
            }],
            previousDiagnostics,
            coreType: "paper",
            mcVersion: "1.21.4",
            projectPackage: "com.example.plugin",
        });

        expect(publicNeeds).toHaveLength(1);
        expect(publicNeeds[0]).toMatchObject({
            integrationKind: "external_plugin",
            triggerReason: "persistent_diagnostic_gap",
            claim: { answerType: "coordinate" },
            scope: { dependency: "WorldGuard" },
        });
        expect(unrelatedNeeds).toEqual([]);
        expect(genericDependencyNeeds).toEqual([]);
        expect(externalArtifactNetworkNeeds).toEqual([]);
        expect(privateNeeds).toEqual([]);
        expect(ordinaryBukkitNeeds).toEqual([]);
    });
});
