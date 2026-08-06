import { describe, expect, it } from "vitest";
import {
    isBuildInfrastructureDiagnostic,
    parseBuildDiagnostics,
} from "../../functions/_lib/buildDiagnostics";

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
});
