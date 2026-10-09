import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { parseBuildDiagnostics } from "../../functions/_lib/buildDiagnostics";
import { assessCompileLearningEligibility, buildDiagnosticKnowledgeNeeds, compileDependencyContextHash,
    filterFixKnowledgeNeeds, resolveCompileDependencyContext } from "../../functions/_lib/learning/assessment";
import { isAllowedModelLearningNeed } from "../../functions/_lib/learning/tool";

const raw = readFileSync(new URL("../fixtures/build-failures/javac-missing-class.log", import.meta.url), "utf8");
const pom = `<project><properties><api.version>1.21-R0.1-SNAPSHOT</api.version></properties><dependencies><dependency><groupId>io.papermc.paper</groupId><artifactId>paper-api</artifactId><version>\${api.version}</version><scope>provided</scope></dependency></dependencies></project>`;
const files = [{ path: "pom.xml", content: pom }];
const dependencies = resolveCompileDependencyContext(files);
const diagnostic = parseBuildDiagnostics(raw)[0];

describe("first compile learning eligibility from compiler logs", () => {
    it("learns the first exact public class miss using the actual declared coordinate", () => {
        expect(assessCompileLearningEligibility({ diagnostic, dependencies, mcVersion: "1.21" }))
            .toMatchObject({ decision: "LEARN", symbol: "io.papermc.paper.event.player.PlayerShieldBlockEvent",
                dependency: "io.papermc.paper:paper-api:1.21-R0.1-SNAPSHOT" });
        const needs = buildDiagnosticKnowledgeNeeds({ diagnostics: parseBuildDiagnostics(raw), dependencies,
            coreType: "paper", mcVersion: "1.21", generatedFiles: files });
        expect(needs).toHaveLength(1);
        expect(filterFixKnowledgeNeeds(needs, { repairAttempts: 0 }).accepted).toHaveLength(1);
        expect(needs[0].claim.question).toContain("1.21-R0.1-SNAPSHOT");
    });

    it("requires a dependency identity and matching target version", () => {
        expect(assessCompileLearningEligibility({ diagnostic, dependencies: [], mcVersion: "1.21" }).decision).toBe("INSUFFICIENT_CONTEXT");
        expect(assessCompileLearningEligibility({ diagnostic, dependencies, mcVersion: "1.21.4" }).reason).toBe("target_dependency_version_mismatch");
        expect(resolveCompileDependencyContext([{ path: "pom.xml", content: pom.replace("1.21-R0.1-SNAPSHOT", "\${unknown}") }])).toEqual([]);
        expect(resolveCompileDependencyContext([{ path: "pom.xml", content: pom.replace("<dependencies>", "<dependencyManagement><dependencies>").replace("</dependencies>", "</dependencies></dependencyManagement>") }])).toEqual([]);
        const pluginOnly = pom.replace("<dependencies>", "<build><plugins><plugin><dependencies>")
            .replace("</dependencies>", "</dependencies></plugin></plugins></build>");
        expect(resolveCompileDependencyContext([{ path: "pom.xml", content: pluginOnly }])).toEqual([]);
        for (const artifactTag of ["<type>pom</type>", "<classifier>sources</classifier>", "<classifier>javadoc</classifier>"]) {
            expect(resolveCompileDependencyContext([{ path: "pom.xml", content: pom.replace("<scope>", `${artifactTag}<scope>`) }])).toEqual([]);
        }
    });

    it("repairs internal constructors and methods without network learning", () => {
        const constructor = parseBuildDiagnostics("src/main/java/dev/example/Test.java:9: error: constructor MaceCommand cannot be applied to given types;\nrequired: Main\nfound: no arguments")[0];
        expect(assessCompileLearningEligibility({ diagnostic: constructor, dependencies, mcVersion: "1.21" }).decision).toBe("REPAIR_DIRECTLY");
        const internal = parseBuildDiagnostics("src/main/java/dev/example/Test.java:4: error: cannot find symbol\n symbol: method start()\n location: class dev.example.Test")[0];
        expect(assessCompileLearningEligibility({ diagnostic: internal, dependencies, mcVersion: "1.21", projectPackage: "dev.example" }).decision).toBe("REPAIR_DIRECTLY");
        const simpleInternal = parseBuildDiagnostics("src/main/java/Listener.java:4: error: cannot find symbol\n symbol: method start()\n location: class Listener")[0];
        expect(assessCompileLearningEligibility({ diagnostic: simpleInternal, dependencies, mcVersion: "1.21",
            generatedFiles: [{ path: "src/main/java/Listener.java", content: "class Listener {}" }] }).decision).toBe("REPAIR_DIRECTLY");
    });

    it("does not assume a mapped public simple type when the project shadows it", () => {
        const particle = parseBuildDiagnostics("src/main/java/Test.java:4: error: cannot find symbol\n symbol: variable SLIME\n location: class Particle")[0];
        const source = { path: "src/main/java/Test.java", content: "import org.bukkit.Particle; class Test { Object value = Particle.SLIME; }" };
        expect(assessCompileLearningEligibility({ diagnostic: particle, dependencies, mcVersion: "1.21", generatedFiles: [...files, source] }).decision).toBe("LEARN");
        expect(assessCompileLearningEligibility({ diagnostic: particle, dependencies, mcVersion: "1.21", generatedFiles: [...files, source, { path: "src/main/java/Particle.java", content: "class Particle {}" }] }).decision).toBe("REPAIR_DIRECTLY");
        expect(assessCompileLearningEligibility({ diagnostic: particle, dependencies, mcVersion: "1.21" }).reason).toBe("public_type_context_unresolved");
    });

    it("invalidates the preflight identity when any declared dependency context changes", async () => {
        expect(await compileDependencyContextHash(files)).not.toBe(await compileDependencyContextHash([{ path: "pom.xml", content: pom.replace("provided", "compile") }]));
    });

    it("keeps exact external coordinates authorized by the existing declared plugin name", () => {
        const external = parseBuildDiagnostics("src/main/java/Test.java:3: error: cannot find symbol\n symbol: class WorldGuard\n location: package com.sk89q.worldguard");
        const needs = buildDiagnosticKnowledgeNeeds({ diagnostics: external, mcVersion: "1.21", dependencies: [
            { groupId: "com.sk89q.worldguard", artifactId: "worldguard-bukkit", version: "7.0.9" },
        ] });
        expect(needs).toHaveLength(1);
        expect(isAllowedModelLearningNeed(needs[0], ["WorldGuard"])).toBe(true);
        expect(isAllowedModelLearningNeed(needs[0], ["Vault"])).toBe(false);
    });
});
