import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import {
    cleanBuildLogLine,
    compareDiagnostics,
    diagnosticsFingerprint,
    errorLogExcerpt,
    isBuildInfrastructureDiagnostic,
    parseBuildDiagnostics,
    rollbackCandidates,
} from "../../functions/_lib/buildDiagnostics";

const fixture = (name: string) => readFileSync(new URL(`../fixtures/build-failures/${name}`, import.meta.url), "utf8");
const missingClassLog = (symbol: string, line = 3, packageName = "io.papermc.paper.event.player") => [
    `src/main/java/dev/example/Listener.java:${line}: error: cannot find symbol`,
    `import ${packageName}.${symbol};`,
    "                                    ^",
    `  symbol:   class ${symbol}`,
    `  location: package ${packageName}`,
].join("\n");

describe("build diagnostics", () => {
    it("retains Maven infrastructure failures alongside compiler diagnostics", () => {
        const diagnostics = parseBuildDiagnostics([
            "[ERROR] /workspace/src/main/java/dev/example/Main.java:[12,8] package com.sk89q.worldguard does not exist",
            "[ERROR] Could not transfer artifact com.sk89q.worldguard:worldguard-bukkit:jar:7.0.9 from/to paper-repo",
            "[ERROR] UnknownHostException: repo.papermc.io",
        ].join("\n"));

        expect(diagnostics.map((diagnostic) => diagnostic.category)).toEqual([
            "compile",
            "dependency",
        ]);
        expect(diagnostics.some(isBuildInfrastructureDiagnostic)).toBe(true);
    });

    it("parses the real #452 source and caret blocks without losing original locations", () => {
        const diagnostics = parseBuildDiagnostics(fixture("javac-missing-class.log"));
        expect(diagnostics).toHaveLength(2);
        expect(diagnostics[0]).toMatchObject({
            path: "src/main/java/com/tahai/maceshieldbreak/ShieldBlockListener.java",
            line: 3,
            category: "compile",
            errorKind: "missing_symbol",
            symbol: "PlayerShieldBlockEvent",
            packageName: "io.papermc.paper.event.player",
            qualifiedSymbol: "io.papermc.paper.event.player.PlayerShieldBlockEvent",
            symbolResolution: "resolved",
        });
        expect(diagnostics[0].details).toEqual([
            "symbol:   class PlayerShieldBlockEvent",
            "location: package io.papermc.paper.event.player",
        ]);
        expect(diagnostics[1]).toMatchObject({ line: 22, symbol: "PlayerShieldBlockEvent", location: "class ShieldBlockListener", symbolResolution: "unresolved" });
        expect(diagnostics[1].details).not.toContain(diagnostics[0].details[1]);
    });

    it("accepts javac bare file paths and source text containing colons", () => {
        const diagnostics = parseBuildDiagnostics([
            "Listener.java:7: error: cannot find symbol",
            '    String text = "Other.java:8: error: cannot find symbol";',
            "                     ^",
            "  symbol: class ClassA",
            "  location: package org.bukkit.event",
        ].join("\n"));
        expect(diagnostics).toHaveLength(1);
        expect(diagnostics[0]).toMatchObject({ path: "Listener.java", line: 7, qualifiedSymbol: "org.bukkit.event.ClassA" });
    });

    it("handles timestamp-free Maven blocks and different missing symbols in one file", () => {
        const diagnostics = parseBuildDiagnostics(fixture("javac-multiple-symbols.log"));
        expect(diagnostics).toHaveLength(3);
        expect(diagnostics.map((diagnostic) => diagnostic.symbol)).toEqual(["ClassA", "ClassB", "ClassA"]);
        expect(diagnostics.map((diagnostic) => diagnostic.line)).toEqual([3, 4, 18]);
        expect(diagnostics[0].column).toBe(37);
        expect(diagnostics[0].key).not.toBe(diagnostics[1].key);
        expect(diagnostics[0].key).toBe(diagnostics[2].key);
    });

    it("marks incomplete missing-symbol diagnostics unresolved without inventing a package", () => {
        const [diagnostic] = parseBuildDiagnostics([
            "src/main/java/dev/example/Listener.java:3: error: cannot find symbol",
            "  symbol: class UnknownEvent",
            "[INFO] BUILD FAILURE",
            "  location: package org.bukkit.event",
        ].join("\n"));
        expect(diagnostic).toMatchObject({ symbol: "UnknownEvent", symbolResolution: "unresolved" });
        expect(diagnostic.qualifiedSymbol).toBeUndefined();
        expect(diagnostic.packageName).toBeUndefined();
    });

    it("stops at the next diagnostic so its fields do not leak backwards", () => {
        const diagnostics = parseBuildDiagnostics([
            "src/main/java/dev/example/Listener.java:3: error: cannot find symbol",
            "  symbol: class FirstEvent",
            missingClassLog("SecondEvent", 9),
        ].join("\n"));
        expect(diagnostics).toHaveLength(2);
        expect(diagnostics[0].details).toEqual(["symbol: class FirstEvent"]);
        expect(diagnostics[0].symbolResolution).toBe("unresolved");
        expect(diagnostics[1].symbol).toBe("SecondEvent");
    });

    it("bounds the diagnostic block lookahead", () => {
        const [diagnostic] = parseBuildDiagnostics([
            "src/main/java/dev/example/Listener.java:3: error: cannot find symbol",
            ...Array.from({ length: 70 }, () => "source excerpt"),
            "symbol: class UnrelatedEvent",
            "location: package org.bukkit.event",
        ].join("\n"));
        expect(diagnostic.details).toEqual([]);
        expect(diagnostic.symbol).toBeUndefined();
    });

    it("ends semantic collection at GitHub, javac note, and Maven summary boundaries", () => {
        for (const boundary of ["##[error]Process completed with exit code 1.", "Note: Some files use a deprecated API.", "[ERROR] COMPILATION ERROR :"]) {
            const [diagnostic] = parseBuildDiagnostics([
                "src/main/java/dev/example/Listener.java:3: error: cannot find symbol",
                "  symbol: class UnknownEvent",
                boundary,
                "  location: package org.bukkit.event",
            ].join("\n"));
            expect(diagnostic.details).toEqual(["symbol: class UnknownEvent"]);
            expect(diagnostic.symbolResolution).toBe("unresolved");
        }
    });

    it("retains missing-method and constructor semantic fields", () => {
        const [method] = parseBuildDiagnostics(fixture("javac-missing-method.log"));
        expect(method).toMatchObject({ symbol: "breakShield(int)", qualifiedSymbol: "org.bukkit.entity.Player.breakShield", symbolResolution: "resolved" });
        const [constructor] = parseBuildDiagnostics(fixture("javac-constructor-mismatch.log"));
        expect(constructor.errorKind).toBe("signature_mismatch");
        expect(constructor.details).toEqual(["required: Plugin,String", "found:    String", "reason: actual and formal argument lists differ in length"]);
    });

    it("includes missing method argument signatures in semantic identity", () => {
        const log = fixture("javac-missing-method.log");
        const before = parseBuildDiagnostics(log);
        const after = parseBuildDiagnostics(log.replace("symbol:   method breakShield(int)", "symbol:   method breakShield(java.lang.String)"));
        expect(compareDiagnostics(before, after).status).toBe("mixed");
        expect(diagnosticsFingerprint(before)).not.toBe(diagnosticsFingerprint(after));
    });

    it("preserves ordinary dependency failure classification", () => {
        const diagnostics = parseBuildDiagnostics(fixture("maven-dependency-failure.log"));
        expect(diagnostics).toHaveLength(1);
        expect(diagnostics[0]).toMatchObject({ category: "dependency", path: "pom.xml" });
        expect(isBuildInfrastructureDiagnostic(diagnostics[0])).toBe(false);
    });

    it("ignores changed lines and duplicate occurrences when comparing semantic progress", () => {
        const before = parseBuildDiagnostics(missingClassLog("ClassA", 3));
        const after = parseBuildDiagnostics([missingClassLog("ClassA", 9), missingClassLog("ClassA", 17)].join("\n"));
        expect(after).toHaveLength(2);
        expect(diagnosticsFingerprint(after)).toBe(diagnosticsFingerprint(before));
        expect(compareDiagnostics(before, after)).toEqual({ resolved: [], introduced: [], persisted: [before[0].key], status: "stagnant" });
        expect(rollbackCandidates(before, after, [before[0].path])).toEqual([before[0].path]);
    });

    it("recognizes replacing the missing class or its package as a changed candidate", () => {
        const before = parseBuildDiagnostics(missingClassLog("ClassA"));
        for (const after of [parseBuildDiagnostics(missingClassLog("ClassB")), parseBuildDiagnostics(missingClassLog("ClassA", 3, "org.bukkit.event.player"))]) {
            expect(compareDiagnostics(before, after).status).toBe("mixed");
            expect(diagnosticsFingerprint(after)).not.toBe(diagnosticsFingerprint(before));
            expect(rollbackCandidates(before, after, [before[0].path])).toEqual([]);
        }
    });

    it("recomputes identity for historical diagnostics with symbol-blind stored keys", () => {
        const parsed = parseBuildDiagnostics(missingClassLog("ClassA"));
        const previous = parsed.map(({ errorKind, symbol, symbolKind, location, packageName, qualifiedSymbol, symbolResolution, ...diagnostic }) => ({ ...diagnostic, key: "src/main/java/dev/example/Listener.java:legacy-message-hash" }));
        expect(compareDiagnostics(previous, parsed).status).toBe("stagnant");
        expect(diagnosticsFingerprint(previous)).toBe(diagnosticsFingerprint(parsed));
        expect(rollbackCandidates(previous, parsed, [parsed[0].path])).toEqual([parsed[0].path]);
        const different = parseBuildDiagnostics(missingClassLog("ClassB"));
        expect(compareDiagnostics(previous, different).status).toBe("mixed");
        expect(rollbackCandidates(previous, different, [parsed[0].path])).toEqual([]);
    });

    it("cleans GitHub timestamps and ANSI Maven error prefixes", () => {
        expect(cleanBuildLogLine("2026-10-08T17:31:57.0453551Z [ERROR] symbol: class Example")).toBe("symbol: class Example");
        expect(cleanBuildLogLine("2026-10-09T01:31:57+08:00 \u001b[31m[ERROR]\u001b[0m location: package org.bukkit")).toBe("location: package org.bukkit");
    });

    it("includes raw javac headers in the user-facing error excerpt", () => {
        const log = fixture("javac-missing-class.log");
        expect(errorLogExcerpt(log)).toContain("ShieldBlockListener.java:3: error: cannot find symbol");
        expect(errorLogExcerpt(log)).toContain("symbol:   class PlayerShieldBlockEvent");
    });
});
