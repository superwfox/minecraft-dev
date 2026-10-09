import { readFileSync } from "node:fs";
import { describe, expect, it, vi } from "vitest";
import { parseBuildDiagnostics } from "../../functions/_lib/buildDiagnostics";
import {
    buildNegativeApiEnvironment,
    canonicalNegativeApiSymbol,
    createCompilerNegativeApiFacts,
    findActiveNegativeApiFacts,
    invalidateNegativeApiFacts,
    mergeTaskNegativeApiFacts,
    negativeApiFactApplies,
    negativeApiFactsContext,
    persistVerifiedNegativeApiFact,
    positiveApiFactsFromKnowledge,
    reconcileNegativeApiFacts,
    validateNegativeApiCandidate,
    type NegativeApiEnvironment,
    type NegativeApiFact,
    type SharedNegativeApiEvidence,
} from "../../functions/_lib/learning/negativeApiFacts";
import { makeKnowledgeItem } from "./testData";
import type { KnowledgeItemRecord } from "../../functions/_lib/learning/types";

const now = 1_800_000_000_000;
const hash = "a".repeat(64);
const symbol = "io.papermc.paper.event.player.PlayerShieldBlockEvent";
const dependency = { groupId: "io.papermc.paper", artifactId: "paper-api", version: "1.21-R0.1-SNAPSHOT" };
const log = readFileSync(new URL("../fixtures/build-failures/javac-missing-class.log", import.meta.url), "utf8");

async function environment(overrides: Partial<Parameters<typeof buildNegativeApiEnvironment>[0]> = {}): Promise<NegativeApiEnvironment> {
    return buildNegativeApiEnvironment({ coreType: "paper", mcVersion: "1.21", dependencies: [dependency], compileRunId: 452, ...overrides });
}

async function compilerFacts(inputEnvironment?: NegativeApiEnvironment, run = 452): Promise<NegativeApiFact[]> {
    const env = inputEnvironment ?? await environment();
    return createCompilerNegativeApiFacts({
        taskId: "private-task", compileRunId: run, diagnostics: parseBuildDiagnostics(log),
        environment: env, dependencyForSymbol: () => env.dependencies[0], now,
    });
}

function publicFact(overrides: Partial<NegativeApiFact> = {}): NegativeApiFact {
    return {
        factId: "neg-old", symbol, coreType: "paper", mcVersion: "1.21",
        dependencyIdentity: "io.papermc.paper:paper-api:1.21-R0.1-SNAPSHOT", dependencyFingerprint: hash,
        assertion: "unavailable", assertionScope: "versioned_api", evidenceKind: "artifact", confidence: 1,
        createdAt: now, expiresAt: now + 100_000, status: "active", ...overrides,
    };
}

function evidence(overrides: Partial<SharedNegativeApiEvidence> = {}): SharedNegativeApiEvidence {
    return {
        source: {
            sourceId: "src-artifact", canonicalUrl: "https://repo.papermc.io/releases/paper-api-1.21.jar",
            sourceType: "artifact", authority: "ground_truth", contentHash: hash,
        },
        symbol, dependencyIdentity: publicFact().dependencyIdentity, dependencyFingerprint: hash,
        publicApiNamespace: "io.papermc.paper", assertion: "verified_absent", exhaustive: true, public: true,
        verificationMethod: "artifact_symbol_inventory", verifiedBy: "deterministic", ...overrides,
    };
}

function mockDb(rows: Record<string, unknown>[] = []) {
    const bound: unknown[][] = [];
    const queries: string[] = [];
    const rowStore = rows.slice();
    const db = {
        prepare: (query: string) => {
            queries.push(query);
            return { bind: (...values: unknown[]) => {
                bound.push(values);
                return {
                    all: vi.fn(async () => ({ results: rowStore })),
                    first: vi.fn(async () => rowStore[0] || null),
                    run: vi.fn(async () => {
                        if (query.includes("INSERT") && !rowStore.some((row) => row.fact_id === values[0])) rowStore.push({
                            fact_id: values[0], symbol: values[1], core_type: values[2], mc_version: values[3],
                            dependency_identity: values[4], dependency_fingerprint: values[5], evidence_kind: values[6],
                            evidence_source_id: values[7], evidence_content_hash: values[8], confidence: values[10],
                            created_at: values[11], expires_at: values[12], status: "active", updated_at: values[13],
                            evidence_source_url: values[14], verified_by: values[15], verification_method: values[9],
                        });
                        if (query.includes("SET evidence_kind")) {
                            const row = rowStore.find((item) => item.fact_id === values[0]);
                            if (row && ((row.status === "active" && Number(row.expires_at) <= Number(values[8]))
                                || (values[9] && ["suspended", "invalidated"].includes(String(row.status))
                                    && row.evidence_content_hash === values[9] && Number(row.updated_at) < Number(values[6])))) {
                                Object.assign(row, { evidence_kind: values[1], evidence_source_id: values[2], evidence_content_hash: values[3],
                                    verification_method: values[4], confidence: values[5], created_at: values[6], expires_at: values[7],
                                    updated_at: values[8], evidence_source_url: values[10], verified_by: values[11], status: "active" });
                            }
                        }
                        return { success: true };
                    }),
                };
            } };
        },
    } as unknown as D1Database;
    return { db, bound, queries, rows: rowStore };
}

describe("negative API fact scope", () => {
    it("records a real javac missing class only in the originating private task and run", async () => {
        const env = await environment(), facts = await compilerFacts(env);
        expect(facts).toHaveLength(1);
        expect(facts[0]).toMatchObject({ symbol, evidenceKind: "compiler", taskId: "private-task", compileRunId: 452 });
        expect(negativeApiFactApplies(facts[0], env, "private-task", now)).toBe(true);
        expect(negativeApiFactApplies(facts[0], env, "other-task", now)).toBe(false);
        expect(negativeApiFactApplies(facts[0], { ...env, compileRunId: 453 }, "private-task", now)).toBe(false);
        expect(negativeApiFactApplies(facts[0], { ...env, mcVersion: "1.21.1" }, "private-task", now)).toBe(false);
        expect(negativeApiFactApplies(facts[0], env, "private-task", facts[0].expiresAt)).toBe(false);
    });

    it("invalidates facts on the full POM/dependency set and does not generalize SNAPSHOT", async () => {
        const env = await environment(), facts = await compilerFacts(env);
        const changed = await environment({ dependencies: [dependency, { groupId: "example", artifactId: "api", version: "2.0" }] });
        const pomChanged = await environment({ pomContent: "<project><repositories>changed</repositories></project>" });
        expect(negativeApiFactApplies(facts[0], changed, "private-task", now)).toBe(false);
        expect(negativeApiFactApplies(facts[0], pomChanged, "private-task", now)).toBe(false);
        expect(negativeApiFactApplies(publicFact(), env, undefined, now)).toBe(false);
        expect(negativeApiFactApplies(publicFact(), await environment({ dependencies: [{ ...dependency, fingerprint: hash }] }), undefined, now)).toBe(true);
        expect(negativeApiFactApplies(publicFact(), await environment({ dependencies: [{ ...dependency, fingerprint: "b".repeat(64) }] }), undefined, now)).toBe(false);
    });

    it("deduplicates equivalent facts and skips overload/package failures", async () => {
        const env = await environment(), facts = await compilerFacts(env);
        expect(mergeTaskNegativeApiFacts(facts, facts, "private-task", env, now)).toHaveLength(1);
        const invalid = parseBuildDiagnostics(log).map((diagnostic) => ({ ...diagnostic, symbolKind: "method", qualifiedSymbol: "org.bukkit.Player.fakeMethod" }));
        expect(await createCompilerNegativeApiFacts({ taskId: "private-task", compileRunId: 452, diagnostics: invalid, environment: env, dependencyForSymbol: () => dependency, now })).toEqual([]);
        expect(await createCompilerNegativeApiFacts({ taskId: "private-task", compileRunId: 452, diagnostics: invalid.map((item) => ({ ...item, message: "package fake does not exist", symbolKind: "class" })), environment: env, dependencyForSymbol: () => dependency, now })).toEqual([]);
    });

    it("uses one member identity for dependency ownership and variable fact creation", async () => {
        const env = await environment();
        const diagnostics = parseBuildDiagnostics([
            "src/main/java/example/Listener.java:10: error: cannot find symbol",
            "    Object value = org.bukkit.Particle.SLIME;",
            "                                     ^",
            "  symbol: variable SLIME",
            "  location: class org.bukkit.Particle",
            "src/main/java/example/Listener.java:11: error: cannot find symbol",
            "    Object value = org.bukkit.Particle.slime;",
            "                                     ^",
            "  symbol: variable slime",
            "  location: class org.bukkit.Particle",
        ].join("\n"));
        const owner = new Map([
            [canonicalNegativeApiSymbol("org.bukkit.Particle.SLIME"), dependency],
            [canonicalNegativeApiSymbol("org.bukkit.Particle.slime", "variable"), dependency],
        ]);
        const facts = await createCompilerNegativeApiFacts({ taskId: "private-task", compileRunId: 452, diagnostics, environment: env,
            dependencyForSymbol: (symbol) => owner.get(symbol), now });
        expect(facts.map((fact) => fact.symbol).sort()).toEqual(["org.bukkit.Particle#SLIME", "org.bukkit.Particle#slime"]);
        expect(canonicalNegativeApiSymbol("org.bukkit.Particle")).toBe("org.bukkit.Particle");
        expect(canonicalNegativeApiSymbol("example.Outer.API", "class")).toBe("example.Outer.API");
    });

    it("suspends both exact-scope conclusions irrespective of positive confidence", async () => {
        const env = await environment(), facts = await compilerFacts(env);
        const positives = positiveApiFactsFromKnowledge([makeKnowledgeItem({
            scope: { symbol, coreType: "paper", mcVersion: "1.21", dependency: facts[0].dependencyIdentity },
            confidence: 1, payload: { assertion: "available", classpathFingerprint: env.classpathFingerprint },
        })]);
        const result = reconcileNegativeApiFacts({ facts, positiveFacts: positives, environment: env, taskId: "private-task", now });
        expect(result.active).toEqual([]);
        expect(result.conflicts[0].status).toBe("suspended");
        expect(result.suspendedKnowledgeIds).toEqual(["know-test"]);
        expect(reconcileNegativeApiFacts({ facts, positiveFacts: positives.map((item) => ({ ...item, mcVersion: "1.22" })), environment: env, taskId: "private-task", now }).active).toHaveLength(1);
        expect(reconcileNegativeApiFacts({ facts, positiveFacts: positives.map((item) => ({ ...item, classpathFingerprint: undefined })), environment: env, taskId: "private-task", now }).active).toHaveLength(1);
        expect(negativeApiFactsContext(result.conflicts)).toBe("");
    });

    it("tolerates legacy or partial positive cache rows without inventing scope", () => {
        expect(positiveApiFactsFromKnowledge([
            { knowledgeId: "legacy", lookupKey: "partial", revision: 1 } as KnowledgeItemRecord,
            makeKnowledgeItem({ scope: undefined, payload: undefined }),
        ])).toEqual([]);
    });

    it("requires an explicit matching availability or signature claim before suspending compiler evidence", async () => {
        const env = await environment(), facts = await compilerFacts(env);
        const item = (payload: Record<string, unknown>) => makeKnowledgeItem({
            scope: { symbol, coreType: "paper", mcVersion: "1.21", dependency: facts[0].dependencyIdentity },
            payload: { classpathFingerprint: env.classpathFingerprint, ...payload },
            summary: "A summary that mentions the unavailable event exists is not structured proof.",
        });
        const mentions = [
            item({}),
            item({ answerType: "migration", claim: { symbol, alternative: "org.bukkit.event.entity.EntityDamageByEntityEvent" } }),
            item({ answerType: "behavior", claim: { symbol, detail: "Use an available damage event instead." } }),
            item({ answerType: "signature", claim: { symbol } }),
            item({ signature: "sendMessage(String)" }),
            item({ assertion: "unavailable", signature: `public class ${symbol.split(".").pop()} {}` }),
            item({ claim: { symbol: "org.bukkit.event.entity.EntityDamageByEntityEvent", exists: true } }),
        ];
        expect(positiveApiFactsFromKnowledge(mentions)).toEqual([]);
        expect(reconcileNegativeApiFacts({ facts, positiveFacts: positiveApiFactsFromKnowledge(mentions), environment: env, taskId: "private-task", now }).active).toHaveLength(1);
        const assertions = [
            item({ assertion: "available" }),
            item({ exists: true }),
            item({ claim: { symbol, available: true } }),
            item({ answerType: "signature", claim: { symbol, signature: "public class PlayerShieldBlockEvent {}" } }),
        ];
        expect(positiveApiFactsFromKnowledge(assertions)).toHaveLength(assertions.length);
        const method = makeKnowledgeItem({ scope: { coreType: "paper", mcVersion: "1.21", symbol: "org.bukkit.entity.Player#sendMessage", dependency: facts[0].dependencyIdentity },
            payload: { answerType: "signature", claim: { symbol: "org.bukkit.entity.Player#sendMessage(java.lang.String)" } } });
        expect(positiveApiFactsFromKnowledge([method])[0].symbol).toBe("org.bukkit.entity.Player#sendMessage");
        const field = (signature: string, unavailable = false) => makeKnowledgeItem({ scope: { coreType: "paper", mcVersion: "1.21", symbol: "org.bukkit.Particle.SLIME", dependency: facts[0].dependencyIdentity },
            payload: { answerType: "signature", claim: { symbol: "org.bukkit.Particle.SLIME", signature, ...(unavailable ? { exists: false } : {}) } } });
        expect(positiveApiFactsFromKnowledge([field("public static final Particle SLIME"), field("SLIME")]).map((item) => item.symbol)).toEqual(["org.bukkit.Particle#SLIME", "org.bukkit.Particle#SLIME"]);
        expect(positiveApiFactsFromKnowledge([field("return SLIME;"), field("public static final Particle SLIME", true)])).toEqual([]);
    });
});

describe("negative API candidate checks", () => {
    async function validate(content: string, additional: { path: string; content: string }[] = []) {
        const env = await environment();
        return validateNegativeApiCandidate({ files: [{ path: "src/main/java/test/Listener.java", content }, ...additional], facts: await compilerFacts(env), environment: env, taskId: "private-task", now });
    }

    it("rejects exact FQN, explicit imports and unambiguous wildcard references", async () => {
        expect(await validate(`class Listener { ${symbol} value; }`)).toHaveLength(1);
        expect(await validate(`import ${symbol};\nclass Listener { PlayerShieldBlockEvent value; }`)).toHaveLength(1);
        expect(await validate("import io.papermc.paper.event.player.*; class Listener { PlayerShieldBlockEvent value; }")).toHaveLength(1);
    });

    it("ignores comments, strings, text blocks and unrelated simple-name classes", async () => {
        expect(await validate(`// import ${symbol};\nclass Listener { String text = "${symbol}"; String block = """\n${symbol}\n"""; }`)).toEqual([]);
        expect(await validate("import example.PlayerShieldBlockEvent; class Listener { PlayerShieldBlockEvent value; }")).toEqual([]);
        expect(await validate("package test; import io.papermc.paper.event.player.*; class Listener { PlayerShieldBlockEvent value; }", [{ path: "src/main/java/test/PlayerShieldBlockEvent.java", content: "package test; public class PlayerShieldBlockEvent {}" }])).toEqual([]);
        expect(await validate("class PlayerShieldBlockEvent {} class Listener { PlayerShieldBlockEvent value; }")).toEqual([]);
        expect(await validate(`class Listener { ${symbol}Extra value; }`)).toEqual([]);
        expect(await validate(`class Listener { example.${symbol} value; }`)).toEqual([]);
        expect(await validate("import io.papermc.paper.event.player.*; class Listener { String PlayerShieldBlockEvent = null; }")).toEqual([]);
    });

    it("resolves member references and static imports without banning other owner types", async () => {
        const env = await environment();
        const [fact] = await compilerFacts(env);
        fact.symbol = "org.bukkit.Particle#SLIME";
        const check = (content: string) => validateNegativeApiCandidate({ files: [{ path: "Particle.java", content }], facts: [fact], environment: env, taskId: "private-task", now });
        expect(check("import org.bukkit.Particle; class Test { Object p = Particle.SLIME; }")).toHaveLength(1);
        expect(check("import static org.bukkit.Particle.SLIME; class Test { Object p = SLIME; }")).toHaveLength(1);
        expect(check("import example.Particle; class Test { Object p = Particle.SLIME; }")).toEqual([]);
        expect(check("import org.bukkit.Particle; class Test { Object p = Particle.FLAME; }")).toEqual([]);
        expect(check("import static org.bukkit.Particle.*; class Test { String SLIME = null; }")).toEqual([]);
        expect(check("import org.bukkit.Particle; class Test { Particle p; void f(Other p) { Object v = p.SLIME; } }")).toEqual([]);
    });
});

describe("public negative API storage", () => {
    it("persists only verified exhaustive public absence with deterministic identity", async () => {
        const mock = mockDb();
        const first = await persistVerifiedNegativeApiFact({ DB: mock.db }, { fact: publicFact(), evidence: evidence(), now });
        const second = await persistVerifiedNegativeApiFact({ DB: mock.db }, { fact: publicFact(), evidence: evidence(), now });
        expect(first.factId).toBe(second.factId);
        expect(mock.queries[0]).toContain("INSERT OR IGNORE");
        expect(JSON.stringify(mock.bound)).not.toContain("private-task");
        expect(first).toMatchObject({ evidenceSourceId: "src-artifact", assertionScope: "versioned_api" });
        expect(first.evidenceSourceUrl).toBe(evidence().source.canonicalUrl);
        expect(mock.rows).toHaveLength(1);
        expect(first).not.toHaveProperty("taskId");
        expect(first).not.toHaveProperty("sourceCode");
    });

    it("deduplicates dotted/hash enum facts and canonicalizes dotted cache queries", async () => {
        const mock = mockDb();
        const dot = "org.bukkit.Particle.SLIME", member = "org.bukkit.Particle#SLIME";
        const publicEvidence = evidence({ symbol: dot, publicApiNamespace: "org.bukkit" });
        const first = await persistVerifiedNegativeApiFact({ DB: mock.db }, { fact: publicFact({ symbol: dot }), evidence: publicEvidence, now });
        const second = await persistVerifiedNegativeApiFact({ DB: mock.db }, { fact: publicFact({ symbol: member }), evidence: { ...publicEvidence, symbol: member }, now });
        expect(first.symbol).toBe(member);
        expect(first.factId).toBe(second.factId);
        expect(mock.rows).toHaveLength(1);
        const env = await environment({ dependencies: [{ ...dependency, fingerprint: hash }] });
        const found = await findActiveNegativeApiFacts({ DB: mock.db }, { symbols: [dot], environment: env, now });
        expect(found[0].symbol).toBe(member);
        expect(mock.bound.at(-1)).toContain(member);
        expect(mock.bound.at(-1)).not.toContain(dot);
    });

    it("renews expired active facts and requires explicit fresh revalidation for suspended facts", async () => {
        const mock = mockDb();
        const stored = await persistVerifiedNegativeApiFact({ DB: mock.db }, { fact: publicFact(), evidence: evidence(), now });
        mock.rows[0].expires_at = now;
        const renewed = await persistVerifiedNegativeApiFact({ DB: mock.db }, { fact: publicFact({ createdAt: now + 1 }), evidence: evidence(), now: now + 1 });
        expect(renewed.createdAt).toBe(now + 1);
        mock.rows[0].status = "suspended";
        const ordinary = await persistVerifiedNegativeApiFact({ DB: mock.db }, { fact: publicFact({ createdAt: now + 2 }), evidence: evidence(), now: now + 2 });
        expect(ordinary.status).toBe("suspended");
        await expect(persistVerifiedNegativeApiFact({ DB: mock.db }, { fact: publicFact({ createdAt: now + 2 }), evidence: evidence(), now: now + 2,
            revalidation: { factId: stored.factId, evidenceContentHash: "b".repeat(64) } })).rejects.toThrow("negative_api_fact_revision_conflict");
        const revalidated = await persistVerifiedNegativeApiFact({ DB: mock.db }, { fact: publicFact({ createdAt: now + 2 }), evidence: evidence(), now: now + 2,
            revalidation: { factId: stored.factId, evidenceContentHash: hash } });
        expect(revalidated.status).toBe("active");
    });

    it("bounds lookup parameters without losing a large dependency context", async () => {
        const mock = mockDb();
        const env = await environment({ dependencies: Array.from({ length: 130 }, (_, i) => ({ groupId: "example", artifactId: `api${i}`, version: "1.0" })) });
        await findActiveNegativeApiFacts({ DB: mock.db }, { symbols: Array.from({ length: 64 }, (_, i) => `example.api.Class${i}`), environment: env, now });
        expect(mock.bound).toHaveLength(9);
        expect(Math.max(...mock.bound.map((values) => values.length))).toBeLessThanOrEqual(91);
        expect(mock.bound.flat()).toContain("example:api129:1.0");
    });

    it("never promotes compiler/model/search/contradicted/private or unresolved SNAPSHOT results", async () => {
        const mock = mockDb(), fact = publicFact();
        for (const untrusted of [
            { ...evidence(), verifiedBy: "model" },
            { ...evidence(), assertion: "contradicted" },
            { ...evidence(), exhaustive: false },
            { ...evidence(), public: false },
            { ...evidence(), source: { ...evidence().source, authority: "secondary" } },
        ]) {
            await expect(persistVerifiedNegativeApiFact({ DB: mock.db }, { fact, evidence: untrusted as SharedNegativeApiEvidence, now })).rejects.toThrow("negative_api_fact_unverified");
        }
        await expect(persistVerifiedNegativeApiFact({ DB: mock.db }, { fact: (await compilerFacts())[0], evidence: evidence(), now })).rejects.toThrow("negative_api_fact_unverified");
        await expect(persistVerifiedNegativeApiFact({ DB: mock.db }, { fact: { ...fact, dependencyFingerprint: undefined }, evidence: { ...evidence(), dependencyFingerprint: undefined }, now })).rejects.toThrow("negative_api_fact_unverified");
        await expect(persistVerifiedNegativeApiFact({ DB: mock.db }, { fact, evidence: evidence(), forbiddenTerms: ["PlayerShieldBlockEvent"], now })).rejects.toThrow("negative_api_fact_private_content");
        expect(mock.queries).toEqual([]);
    });

    it("rejects malformed supplied fingerprints even for immutable official releases", async () => {
        const mock = mockDb();
        const identity = "io.papermc.paper:paper-api:1.21.4-R0.1";
        const officialFact = publicFact({ evidenceKind: "official", dependencyIdentity: identity, dependencyFingerprint: undefined });
        const officialEvidence = evidence({ dependencyIdentity: identity, dependencyFingerprint: undefined,
            verificationMethod: "official_versioned_inventory", verifiedBy: "human_review",
            source: { ...evidence().source, sourceType: "javadoc", canonicalUrl: "https://jd.papermc.io/paper/1.21.4/index-all.html" } });
        for (const [factFingerprint, evidenceFingerprint] of [["invalid", "invalid"], ["invalid", undefined], [undefined, "invalid"]]) {
            await expect(persistVerifiedNegativeApiFact({ DB: mock.db }, {
                fact: { ...officialFact, dependencyFingerprint: factFingerprint }, evidence: { ...officialEvidence, dependencyFingerprint: evidenceFingerprint }, now,
            })).rejects.toThrow("negative_api_fact_unverified");
        }
        expect(mock.queries).toEqual([]);
        const valid = await persistVerifiedNegativeApiFact({ DB: mock.db }, { fact: officialFact, evidence: officialEvidence, now });
        expect(valid).not.toHaveProperty("dependencyFingerprint");
    });

    it("normalizes targeted invalidation and rejects malformed selectors before SQL", async () => {
        const mock = mockDb();
        await invalidateNegativeApiFacts({ DB: mock.db }, { dependencyIdentity: publicFact().dependencyIdentity,
            symbol: "org.bukkit.Particle.SLIME", dependencyFingerprint: hash.toUpperCase(), now });
        expect(mock.bound[0]).toEqual(["invalidated", now, publicFact().dependencyIdentity, "org.bukkit.Particle#SLIME", `sha256:${hash}`]);
        await invalidateNegativeApiFacts({ DB: mock.db }, { dependencyIdentity: publicFact().dependencyIdentity,
            symbol: "org.bukkit.Particle#SLIME", dependencyFingerprint: `SHA256:${hash.toUpperCase()}`, now });
        expect(mock.bound[1]).toEqual(mock.bound[0]);
        await expect(invalidateNegativeApiFacts({ DB: mock.db }, { dependencyIdentity: publicFact().dependencyIdentity, dependencyFingerprint: "bad" })).rejects.toThrow("negative_api_fact_invalid_fingerprint");
        await expect(invalidateNegativeApiFacts({ DB: mock.db }, { dependencyIdentity: publicFact().dependencyIdentity, symbol: "not a symbol" })).rejects.toThrow("negative_api_fact_invalid_scope");
        expect(mock.queries).toHaveLength(2);
    });

    it("queries indexed exact symbols/identities and filters mismatched artifact fingerprints", async () => {
        const persisted = mockDb();
        await persistVerifiedNegativeApiFact({ DB: persisted.db }, { fact: publicFact(), evidence: evidence(), now });
        const env = await environment({ dependencies: [{ ...dependency, fingerprint: hash }] });
        expect(await findActiveNegativeApiFacts({ DB: persisted.db }, { symbols: [symbol, symbol], environment: env, now })).toHaveLength(1);
        expect(await findActiveNegativeApiFacts({ DB: persisted.db }, { symbols: [symbol], environment: { ...env, dependencies: [{ ...dependency, fingerprint: "b".repeat(64) }] }, now })).toEqual([]);
        expect(persisted.queries.at(-1)).toContain("dependency_identity IN");
        await invalidateNegativeApiFacts({ DB: persisted.db }, { dependencyIdentity: publicFact().dependencyIdentity, symbol, status: "suspended", now });
        expect(persisted.bound.at(-1)).toEqual(["suspended", now, publicFact().dependencyIdentity, symbol, ""]);
    });
});
