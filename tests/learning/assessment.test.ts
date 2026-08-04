import { describe, expect, it } from "vitest";
import {
    assessKnowledgeNeeds,
    buildDiagnosticKnowledgeNeeds,
    deduplicateKnowledgeNeeds,
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

    it("derives fix needs only from public dependency or API symbols", () => {
        const publicNeeds = buildDiagnosticKnowledgeNeeds({
            diagnostics: [{
                key: "pom.xml:worldguard",
                path: "pom.xml",
                message: "package com.sk89q.worldguard.protection.regions does not exist",
                details: [],
                category: "dependency",
            }],
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
            coreType: "paper",
            mcVersion: "1.21.4",
            projectPackage: "com.example.plugin",
        });

        expect(publicNeeds).toHaveLength(1);
        expect(publicNeeds[0].claim.answerType).toBe("coordinate");
        expect(publicNeeds[0].scope.dependency).toBe("WorldGuard");
        expect(privateNeeds).toEqual([]);
    });
});
