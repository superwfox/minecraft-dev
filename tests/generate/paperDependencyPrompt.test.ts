import { describe, expect, it } from "vitest";
import { buildFixPrompt, dispatchGen, type PlanFileItem } from "../../functions/_lib/prompts";

const pomFile: PlanFileItem = {
    path: "pom.xml",
    role: "Configure the Paper API dependency.",
    order: 0,
    generatorType: "FileRelatedGen",
};

function paperPomPrompt(version: string): string {
    return dispatchGen(pomFile, {
        projectName: "ExamplePlugin",
        packageName: "com.example.plugin",
        coreType: "Paper",
        version,
        javaVersion: version.startsWith("26.") ? "25" : "21",
    }, [], {}).gen.system;
}

function spigotPomPrompt(version: string): string {
    return dispatchGen(pomFile, {
        projectName: "ExamplePlugin",
        packageName: "com.example.plugin",
        coreType: "Spigot",
        version,
        javaVersion: version.startsWith("26.") ? "25" : "21",
    }, [], {}).gen.system;
}

function otherCorePomPrompt(coreType: string, version: string): string {
    return dispatchGen(pomFile, {
        projectName: "ExamplePlugin",
        packageName: "com.example.plugin",
        coreType,
        version,
        javaVersion: "21",
    }, [], {}).gen.system;
}

describe("Paper dependency prompt", () => {
    it("uses the verified build-qualified stable coordinate for Paper 26.2", () => {
        const prompt = paperPomPrompt("26.2");

        expect(prompt).toContain("io.papermc.paper:paper-api:26.2.build.112-stable");
        expect(prompt).toContain("禁止拼接 -R0.1-SNAPSHOT");
        expect(prompt).not.toContain("paper-api:26.2-R0.1-SNAPSHOT");
    });

    it("retains legacy snapshot guidance for Paper 1.x", () => {
        expect(paperPomPrompt("1.21.4"))
            .toContain("io.papermc.paper:paper-api:1.21.4-R0.1-SNAPSHOT");
    });

    it("does not inject Paper coordinates into a Spigot prompt", () => {
        const prompt = spigotPomPrompt("26.2");

        expect(prompt).toContain("org.spigotmc:spigot-api 与 MC 26.2 匹配的官方版本");
        expect(prompt).toContain("https://hub.spigotmc.org/nexus/content/repositories/snapshots/");
        expect(prompt).not.toContain("io.papermc.paper:paper-api");
    });

    it("does not turn Bukkit, Forge, or Fabric projects into Spigot projects", () => {
        for (const coreType of ["Bukkit", "Forge", "Fabric"]) {
            const prompt = otherCorePomPrompt(coreType, "1.21.4");
            expect(prompt).toContain(`${coreType} 使用其官方构建体系`);
            expect(prompt).not.toContain("org.spigotmc:spigot-api");
            expect(prompt).not.toContain("io.papermc.paper:paper-api");
        }
    });

    it("keeps build-fix repository guidance aligned with the selected core", () => {
        const spigotFix = buildFixPrompt("pom.xml", "<project/>", "dependency failed", {
            projectName: "ExamplePlugin",
            packageName: "com.example.plugin",
            coreType: "Spigot",
            version: "1.21.4",
            javaVersion: "21",
        }).system;
        const paperFix = buildFixPrompt("pom.xml", "<project/>", "dependency failed", {
            projectName: "ExamplePlugin",
            packageName: "com.example.plugin",
            coreType: "Paper",
            version: "26.2",
            javaVersion: "25",
        }).system;

        expect(spigotFix).toContain("https://hub.spigotmc.org/nexus/content/repositories/snapshots/");
        expect(spigotFix).not.toContain("repo.papermc.io");
        expect(paperFix).toContain("io.papermc.paper:paper-api:26.2.build.112-stable");
        expect(paperFix).toContain("https://repo.papermc.io/repository/maven-public/");
    });
});
