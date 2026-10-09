import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { afterEach, describe, expect, it, vi } from "vitest";
import { COMPILE_EVIDENCE_MARKER, COMPILE_EVIDENCE_SCANNER_BLOB, COMPILE_EVIDENCE_STEP, COMPILE_EVIDENCE_WORKFLOW_BLOB,
    compileEvidenceSymbolAbsent, compileEvidenceFactApplies, compileNegativeEvidence, currentCompileApiEvidence, parseCompileApiEvidence,
    protectedBuildPath, resolvedCompileDependencies } from "../../functions/_lib/learning/compileApiEvidence";
import { getCompileApiEvidence } from "../../functions/_lib/github";
import { makeNeed } from "./testData";

import { attestedReport, fixtureReport, definition, FILES, POM, COORDINATE, MISSING, FINGERPRINT } from "./compileEvidenceFixtures";

describe("attested compile inventory", () => {
    it("pins exactly the bundled reviewed workflow and scanner", () => {
        for (const [path, expected] of [["maven.yml", COMPILE_EVIDENCE_WORKFLOW_BLOB], ["compile_api_evidence.py", COMPILE_EVIDENCE_SCANNER_BLOB]]) {
            const bytes = readFileSync(new URL(`../../public/${path}`, import.meta.url));
            expect(createHash("sha1").update(`blob ${bytes.length}\0`).update(bytes).digest("hex")).toBe(expected);
        }
    });
    it("proves class and enum absence but preserves existing and inherited fields", async () => {
        const evidence = await attestedReport();
        expect(compileEvidenceSymbolAbsent(evidence, MISSING, COORDINATE)).toBe(true);
        expect(compileEvidenceSymbolAbsent(evidence, "org.bukkit.Particle#SLIME", COORDINATE)).toBe(true);
        expect(compileEvidenceSymbolAbsent(evidence, "org.bukkit.Particle#FLAME", COORDINATE)).toBe(false);
        const particle = evidence.dependencies[0].classes[0];
        particle.interfaces = ["org.bukkit.Flags"];
        expect(compileEvidenceSymbolAbsent(evidence, "org.bukkit.Particle#SLIME", COORDINATE)).toBe(false);
        evidence.dependencies[0].classes.push(definition("org.bukkit.Flags", { fields: ["SLIME"] }));
        expect(compileEvidenceSymbolAbsent(evidence, "org.bukkit.Particle#SLIME", COORDINATE)).toBe(false);
    });
    it("rejects classpath shadows, unknown owners and non-enum fields", async () => {
        const evidence = await attestedReport();
        evidence.dependencies.push({ fingerprint: "c".repeat(64), complete: true, publicVerified: false, classes: [definition(MISSING)] });
        expect(compileEvidenceSymbolAbsent(evidence, MISSING, COORDINATE)).toBe(false);
        expect(compileEvidenceSymbolAbsent(evidence, MISSING, "net.kyori:adventure-api:4.17.0")).toBe(false);
        expect(compileEvidenceSymbolAbsent(evidence, "org.bukkit.Particle#fakeMethod", COORDINATE)).toBe(false);
        evidence.dependencies[0].classes[0].isEnum = false;
        expect(compileEvidenceSymbolAbsent(evidence, "org.bukkit.Particle#SLIME", COORDINATE)).toBe(false);
    });
    it("rejects incomplete, forged, duplicated, oversized and mismatched reports", async () => {
        const report = await fixtureReport();
        const expected = { ...report, attestation: (await attestedReport()).attestation };
        const anonymous = structuredClone(report);
        anonymous.dependencies[0].classes.push(definition("org.bukkit.ChatColor.1"));
        anonymous.dependencies[0].classes.push(definition("org.bukkit.damage.package-info"));
        expect(await parseCompileApiEvidence(COMPILE_EVIDENCE_MARKER + JSON.stringify(anonymous), expected)).not.toBeNull();
        for (const change of [{ complete: false }, { runAttempt: 2 }, { headSha: "c".repeat(40) }, { pomHash: "d".repeat(64) }, { javaRelease: 17 }]) {
            expect(await parseCompileApiEvidence(COMPILE_EVIDENCE_MARKER + JSON.stringify({ ...report, ...change }), expected)).toBeNull();
        }
        expect(await parseCompileApiEvidence((COMPILE_EVIDENCE_MARKER + JSON.stringify(report) + "\n").repeat(2), expected)).toBeNull();
        expect(await parseCompileApiEvidence("x".repeat(2_200_000), expected)).toBeNull();
        const unsafe = structuredClone(report);
        unsafe.dependencies[0].sourceUrl = "https://evil.example/paper.jar";
        expect(await parseCompileApiEvidence(COMPILE_EVIDENCE_MARKER + JSON.stringify(unsafe), expected)).toBeNull();
        expect(await parseCompileApiEvidence(COMPILE_EVIDENCE_MARKER + JSON.stringify(report), { ...expected, attestation: { ...expected.attestation, scannerBlob: "c".repeat(40) } })).toBeNull();
    });
    it("enriches only the attested current POM and drops stale build fingerprints", async () => {
        const evidence = await attestedReport();
        const state = { generatedFiles: FILES, runId: 452, buildHeadSha: evidence.headSha, javaVersion: "21", compileApiEvidence: evidence };
        expect((await resolvedCompileDependencies(state))[0].fingerprint).toBe(FINGERPRINT);
        expect(await currentCompileApiEvidence({ ...state, runId: 453 })).toBeNull();
        expect(await currentCompileApiEvidence(state, [{ path: "pom.xml", content: POM + " " }])).toBeNull();
        expect((await resolvedCompileDependencies(state, [{ path: "pom.xml", content: POM + " " }]))[0].fingerprint).toBeUndefined();
    });
    it("only produces public facts for scoped signature questions", async () => {
        const evidence = await attestedReport();
        const need = makeNeed({ scope: { dependency: COORDINATE, symbol: MISSING, mcVersion: "1.21" } });
        expect(compileNegativeEvidence(need, evidence)?.fact).toMatchObject({ symbol: MISSING, evidenceKind: "artifact", assertionScope: "versioned_api" });
        const fact = compileNegativeEvidence(need, evidence)!.fact;
        expect(compileEvidenceFactApplies(evidence, fact)).toBe(true);
        expect(compileEvidenceFactApplies(evidence, { ...fact, dependencyFingerprint: "sha256:" + "c".repeat(64) })).toBe(false);
        expect(compileEvidenceFactApplies(evidence, { ...fact, dependencyFingerprint: "" })).toBe(false);
        expect(compileNegativeEvidence({ ...need, claim: { ...need.claim, answerType: "migration" } }, evidence)).toBeNull();
    });
    it("protects producer paths before build uploads", () => {
        for (const path of [".github/workflows/maven.yml", "TOOLS/compile_api_evidence.py", "src/../.github/workflows/maven.yml", "/pom.xml", ".git/config", "src\\main\\x.java"]) expect(protectedBuildPath(path)).toBe(true);
        expect(protectedBuildPath("src/main/java/example/Plugin.java")).toBe(false);
    });
});

afterEach(() => vi.unstubAllGlobals());
describe("dedicated GitHub step evidence", () => {
    it("binds the exact attempt, uses a zero-based step index and strips download credentials", async () => {
        const report = await fixtureReport();
        const fetchMock = vi.fn(async (input: any, init: any = {}) => {
            const url = String(input);
            if (url.endsWith("/actions/runs/452")) return Response.json({ head_sha: report.headSha, head_branch: "build-task-12345", event: "workflow_dispatch", path: ".github/workflows/maven.yml", status: "completed", run_attempt: 1 });
            if (url.includes("/contents/")) return Response.json({ sha: url.includes("maven.yml") ? COMPILE_EVIDENCE_WORKFLOW_BLOB : COMPILE_EVIDENCE_SCANNER_BLOB });
            if (url.endsWith("/attempts/1/jobs?per_page=100")) return Response.json({ jobs: [{ id: 777, name: "verify", head_sha: report.headSha, steps: [{ name: "Maven", number: 1 }, { name: COMPILE_EVIDENCE_STEP, number: 2, status: "completed", conclusion: "success" }] }] });
            if (url.endsWith("/jobs/777/steps/1/logs")) return new Response(null, { status: 302, headers: { Location: "https://logs.example/report" } });
            if (url === "https://logs.example/report") { expect(init.headers).toBeUndefined(); return new Response("2026-10-09T00:00:00Z " + COMPILE_EVIDENCE_MARKER + JSON.stringify(report)); }
            throw new Error(`Unexpected ${url}`);
        });
        vi.stubGlobal("fetch", fetchMock);
        expect(await getCompileApiEvidence("test-only-credential", { runId: 452, headSha: report.headSha, branch: "build-task-12345", pomHash: report.pomHash, javaRelease: 21 })).not.toBeNull();
        expect(fetchMock.mock.calls.some(([url]) => String(url).includes("/attempts/1/jobs"))).toBe(true);
    });
    it("fails closed for legacy build state", async () => {
        const fetchMock = vi.fn(); vi.stubGlobal("fetch", fetchMock);
        expect(await getCompileApiEvidence("", { runId: 452, branch: "build-task-12345", headSha: "", pomHash: "a".repeat(64), javaRelease: 21 })).toBeNull();
        expect(fetchMock).not.toHaveBeenCalled();
    });
});
