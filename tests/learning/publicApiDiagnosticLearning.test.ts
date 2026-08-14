import { describe, expect, it } from "vitest";
import { buildDiagnosticKnowledgeNeeds, filterFixKnowledgeNeeds } from "../../functions/_lib/learning/assessment";

describe("public API diagnostic learning", () => {
    const particleDiagnostic = {
        key: "src/main/java/SlimeKingBoss.java:141:SLIME",
        path: "src/main/java/SlimeKingBoss.java",
        message: "cannot find symbol",
        details: ["symbol: variable SLIME", "location: class Particle"],
        category: "compile" as const,
    };

    it("does not learn a public API miss before a repair has repeated it", () => {
        expect(buildDiagnosticKnowledgeNeeds({
            diagnostics: [particleDiagnostic],
            coreType: "spigot",
            mcVersion: "1.21.11",
            projectPackage: "com.example.plugin",
        })).toEqual([]);
    });

    it("turns a repeated Particle enum miss into a public_api learning need", () => {
        const needs = buildDiagnosticKnowledgeNeeds({
            diagnostics: [particleDiagnostic],
            previousDiagnostics: [{ ...particleDiagnostic, key: "src/main/java/SlimeKingBoss.java:previous:SLIME" }],
            coreType: "spigot",
            mcVersion: "1.21.11",
            projectPackage: "com.example.plugin",
        });

        expect(needs).toHaveLength(1);
        expect(needs[0]).toMatchObject({
            trigger: "diagnostic_repeat",
            integrationKind: "public_api",
            triggerReason: "persistent_diagnostic_gap",
            claim: {
                subject: "org.bukkit.Particle.SLIME",
                answerType: "signature",
            },
            scope: {
                coreType: "spigot",
                mcVersion: "1.21.11",
                packageName: "org.bukkit",
                symbol: "org.bukkit.Particle.SLIME",
            },
        });
        expect(filterFixKnowledgeNeeds(needs, { repairAttempts: 1 }).accepted).toHaveLength(1);
    });

    it.each([
        ["Attribute", "ATTACK_DAMAGE", "org.bukkit.attribute.Attribute.ATTACK_DAMAGE"],
        ["Attribute", "MOVEMENT_SPEED", "org.bukkit.attribute.Attribute.MOVEMENT_SPEED"],
        ["PlayerProfile", "PlayerProfile", "org.bukkit.profile.PlayerProfile"],
    ])("recognizes repeated %s API contracts", (location, symbol, expected) => {
        const diagnostic = {
            key: `src/main/java/Test.java:${location}:${symbol}`,
            path: "src/main/java/Test.java",
            message: "cannot find symbol",
            details: [`symbol: variable ${symbol}`, `location: class ${location}`],
            category: "compile" as const,
        };
        const needs = buildDiagnosticKnowledgeNeeds({
            diagnostics: [diagnostic],
            previousDiagnostics: [{ ...diagnostic, key: `${diagnostic.key}:previous` }],
            coreType: "paper",
            mcVersion: "1.21.4",
        });
        expect(needs[0]?.integrationKind).toBe("public_api");
        expect(needs[0]?.scope.symbol).toBe(expected);
    });
});
