import { describe, expect, it } from "vitest";
import {
    isKnowledgeNeedCoveredByApiContracts,
    partitionKnowledgeNeedsByApiContracts,
} from "../../functions/_lib/apiContracts";
import { makeNeed } from "./testData";

describe("static API contract coverage", () => {
    it("covers an exact known dependency coordinate", () => {
        const need = makeNeed({
            claim: {
                subject: "me.clip:placeholderapi",
                question: "What Maven coordinate and repository provide PlaceholderAPI 2.x?",
                answerType: "coordinate",
            },
            scope: {
                dependency: "me.clip:placeholderapi",
                symbol: undefined,
            },
            sourcePolicy: "dependency",
        });

        expect(isKnowledgeNeedCoveredByApiContracts({
            coreType: "paper",
            version: "1.21.4",
            externalDeps: ["PlaceholderAPI"],
        }, need)).toBe(true);
    });

    it.each([
        {
            externalDep: "WorldGuard 6",
            subject: "WorldGuard.getInstance",
            question: "What does WorldGuard.getInstance return?",
            dependency: "WorldGuard",
            symbol: "WorldGuard.getInstance",
        },
        {
            externalDep: "WorldGuard 8",
            subject: "WorldGuard.getInstance",
            question: "What does WorldGuard.getInstance return?",
            dependency: "WorldGuard",
            symbol: "WorldGuard.getInstance",
        },
        {
            externalDep: "Vault 2",
            subject: "Economy#getBalance",
            question: "What does Economy#getBalance return?",
            dependency: "Vault",
            symbol: "Economy#getBalance",
        },
        {
            externalDep: "PlaceholderAPI 3",
            subject: "PlaceholderAPI.setPlaceholders",
            question: "What does PlaceholderAPI.setPlaceholders return?",
            dependency: "PlaceholderAPI",
            symbol: "PlaceholderAPI.setPlaceholders",
        },
    ])("does not activate a contract for unsupported external dependency $externalDep", ({
        externalDep,
        subject,
        question,
        dependency,
        symbol,
    }) => {
        const need = makeNeed({
            claim: { subject, question },
            scope: { dependency, symbol },
        });

        expect(isKnowledgeNeedCoveredByApiContracts({
            coreType: "paper",
            version: "1.21.4",
            externalDeps: [externalDep],
        }, need)).toBe(false);
    });

    it("does not cover a need with an unsupported major in its dependency scope", () => {
        const need = makeNeed({
            claim: {
                subject: "Economy#getBalance",
                question: "What does Economy#getBalance return?",
            },
            scope: {
                dependency: "Vault 2",
                symbol: "Economy#getBalance",
            },
        });

        expect(isKnowledgeNeedCoveredByApiContracts({
            coreType: "paper",
            version: "1.21.4",
            externalDeps: ["Vault"],
        }, need)).toBe(false);
    });

    it("does not cover a coordinate need with an unsupported major in its question", () => {
        const need = makeNeed({
            claim: {
                subject: "me.clip:placeholderapi",
                question: "What Maven coordinate and repository provide PlaceholderAPI 3.x?",
                answerType: "coordinate",
            },
            scope: {
                dependency: "me.clip:placeholderapi",
                symbol: undefined,
            },
            sourcePolicy: "dependency",
        });

        expect(isKnowledgeNeedCoveredByApiContracts({
            coreType: "paper",
            version: "1.21.4",
            externalDeps: ["PlaceholderAPI"],
        }, need)).toBe(false);
    });

    it("does not treat an artifact name suffix as an explicit major", () => {
        const need = makeNeed({
            claim: {
                subject: "WorldGuard.getInstance",
                question: "What does WorldGuard.getInstance return?",
            },
            scope: {
                dependency: "com.example:worldguard-bridge8",
                symbol: "WorldGuard.getInstance",
            },
        });

        expect(isKnowledgeNeedCoveredByApiContracts({
            coreType: "paper",
            version: "1.21.4",
            externalDeps: ["com.example:worldguard-bridge8"],
        }, need)).toBe(true);
    });

    it("does not treat Paper registerNewObjective as a universal contract", () => {
        const need = makeNeed({
            claim: {
                subject: "Scoreboard#registerNewObjective",
                question: "Which registerNewObjective overload exists in Paper 1.21.4?",
            },
            scope: { symbol: "Scoreboard#registerNewObjective" },
        });

        expect(isKnowledgeNeedCoveredByApiContracts({
            coreType: "paper",
            version: "1.21.4",
        }, need)).toBe(false);
        expect(isKnowledgeNeedCoveredByApiContracts({
            coreType: "spigot",
            version: "1.21.4",
        }, need)).toBe(true);
    });

    it("partitions exact WorldGuard methods from unknown API questions", () => {
        const covered = makeNeed({
            id: "worldguard",
            claim: {
                subject: "WorldGuard.getInstance",
                question: "What does WorldGuard.getInstance return in WorldGuard 7?",
            },
            scope: {
                dependency: "WorldGuard",
                symbol: "WorldGuard.getInstance",
            },
        });
        const uncovered = makeNeed({
            id: "unknown",
            claim: {
                subject: "CustomEconomy#openAccount",
                question: "What is the exact CustomEconomy 3 openAccount signature?",
            },
            scope: {
                dependency: "CustomEconomy 3",
                symbol: "CustomEconomy#openAccount",
            },
        });

        expect(partitionKnowledgeNeedsByApiContracts({
            coreType: "paper",
            version: "1.21.4",
            externalDeps: ["WorldGuard", "CustomEconomy"],
        }, [covered, uncovered])).toEqual({ covered: [covered], uncovered: [uncovered] });
    });
});
