import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { parseBuildDiagnostics } from "../../functions/_lib/buildDiagnostics";
import { buildDiagnosticKnowledgeNeeds, publicSymbolFromDiagnostic } from "../../functions/_lib/learning/assessment";

describe("public symbols from raw compiler diagnostics", () => {
    it("combines the missing class and package from the real #452 log", () => {
        const diagnostics = parseBuildDiagnostics(readFileSync(new URL("../fixtures/build-failures/javac-missing-class.log", import.meta.url), "utf8"));
        expect(publicSymbolFromDiagnostic([diagnostics[0].message, ...diagnostics[0].details].join(" ")))
            .toBe("io.papermc.paper.event.player.PlayerShieldBlockEvent");
        expect(publicSymbolFromDiagnostic([diagnostics[1].message, ...diagnostics[1].details].join(" "))).toBe("");
    });

    it("resolves a missing enum member with the existing public-type map", () => {
        const [diagnostic] = parseBuildDiagnostics([
            "src/main/java/dev/example/Main.java:7: error: cannot find symbol",
            "    player.spawnParticle(Particle.SLIME, location, 1);",
            "                                 ^",
            "  symbol: variable SLIME",
            "  location: class Particle",
        ].join("\n"));
        expect(publicSymbolFromDiagnostic([diagnostic.message, ...diagnostic.details].join(" "))).toBe("org.bukkit.Particle.SLIME");
    });

    it("uses a qualified variable receiver for a missing method", () => {
        const [diagnostic] = parseBuildDiagnostics(readFileSync(new URL("../fixtures/build-failures/javac-missing-method.log", import.meta.url), "utf8"));
        expect(publicSymbolFromDiagnostic([diagnostic.message, ...diagnostic.details].join(" "))).toBe("org.bukkit.entity.Player.breakShield");
    });

    it("does not fabricate a namespace or learn an unrelated argument type", () => {
        expect(publicSymbolFromDiagnostic("cannot find symbol symbol: class UnknownEvent")).toBe("");
        expect(publicSymbolFromDiagnostic("cannot find symbol symbol: method missing(org.bukkit.entity.Player) location: class LocalListener")).toBe("");
        expect(publicSymbolFromDiagnostic("cannot find symbol symbol: class LocalEvent location: package com.example.plugin", "com.example.plugin")).toBe("");
    });

    it("deduplicates learning demands while retaining every raw compiler location", () => {
        const diagnostics = parseBuildDiagnostics(readFileSync(new URL("../fixtures/build-failures/javac-multiple-symbols.log", import.meta.url), "utf8"));
        const needs = buildDiagnosticKnowledgeNeeds({
            diagnostics,
            previousDiagnostics: diagnostics,
            coreType: "paper",
            mcVersion: "1.21.4",
        });
        expect(diagnostics.map((diagnostic) => diagnostic.line)).toEqual([3, 4, 18]);
        expect(needs.map((need) => need.scope.symbol).sort()).toEqual([
            "io.papermc.paper.event.player.ClassA",
            "io.papermc.paper.event.player.ClassB",
        ]);
    });
});
