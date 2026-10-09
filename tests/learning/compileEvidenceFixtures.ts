import { compileDependencyContextHash } from "../../functions/_lib/learning/assessment";
import { COMPILE_EVIDENCE_MARKER, COMPILE_EVIDENCE_SCANNER_BLOB, COMPILE_EVIDENCE_WORKFLOW_BLOB, parseCompileApiEvidence, type CompileApiClass } from "../../functions/_lib/learning/compileApiEvidence";

export const POM = "<project><dependencies><dependency><groupId>io.papermc.paper</groupId><artifactId>paper-api</artifactId><version>1.21-R0.1-SNAPSHOT</version><scope>provided</scope></dependency></dependencies></project>";
export const FILES = [{ path: "pom.xml", content: POM }];
export const MISSING = "io.papermc.paper.event.player.PlayerShieldBlockEvent";
export const COORDINATE = "io.papermc.paper:paper-api:1.21-R0.1-SNAPSHOT";
export const FINGERPRINT = "sha256:" + "a".repeat(64);

export function definition(name: string, overrides: Partial<CompileApiClass> = {}): CompileApiClass {
    return { name, superName: "", interfaces: [], fields: [], enumConstants: [], isEnum: false, ...overrides };
}

export async function fixtureReport(overrides: Record<string, any> = {}) {
    return { schemaVersion: "compile_api_evidence.v1", repository: "superwfox/minecraft-dev-workflow", headSha: "b".repeat(40),
        runId: 452, runAttempt: 1, javaRelease: 21, pomHash: await compileDependencyContextHash(FILES), complete: true,
        dependencies: [{ groupId: "io.papermc.paper", artifactId: "paper-api", version: "1.21-R0.1-SNAPSHOT", type: "jar", classifier: "",
            resolvedVersion: "1.21-R0.1-20240810.100446-132", fingerprint: FINGERPRINT, complete: true, publicVerified: true,
            sourceUrl: "https://repo.papermc.io/repository/maven-public/io/papermc/paper/paper-api/1.21-R0.1-SNAPSHOT/paper-api-1.21-R0.1-20240810.100446-132.jar",
            classes: [definition("org.bukkit.Particle", { superName: "java.lang.Enum", isEnum: true, fields: ["FLAME"], enumConstants: ["FLAME"] })] }],
        jdkClasses: [definition("java.lang.Enum", { superName: "java.lang.Object" }), definition("java.lang.Object")], ...overrides };
}

export async function attestedReport(report?: Awaited<ReturnType<typeof fixtureReport>>) {
    report = report ?? await fixtureReport();
    const evidence = await parseCompileApiEvidence(COMPILE_EVIDENCE_MARKER + JSON.stringify(report), { ...report,
        attestation: { workflowBlob: COMPILE_EVIDENCE_WORKFLOW_BLOB, scannerBlob: COMPILE_EVIDENCE_SCANNER_BLOB, jobId: 777, stepIndex: 6 } });
    if (!evidence) throw new Error("Fixture rejected");
    return evidence;
}
