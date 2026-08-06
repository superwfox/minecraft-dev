import type {
    ImplementationRecipeV1,
    KnowledgeItemRecord,
    KnowledgeNeed,
    LearningSourceRecord,
    VerificationResult,
} from "../../functions/_lib/learning/types";

type NeedOverrides = Partial<Omit<KnowledgeNeed, "claim" | "scope">> & {
    claim?: Partial<KnowledgeNeed["claim"]>;
    scope?: Partial<KnowledgeNeed["scope"]>;
};

export function makeNeed(overrides: NeedOverrides = {}): KnowledgeNeed {
    const { claim, scope, ...rest } = overrides;
    return {
        id: "need-api",
        kind: "fact",
        trigger: "version_gap",
        specificity: "exact",
        claim: {
            subject: "org.bukkit.entity.Player#sendMessage",
            question: "What is the exact Paper 1.21.4 signature for Player#sendMessage?",
            answerType: "signature",
            ...claim,
        },
        scope: {
            coreType: "paper",
            mcVersion: "1.21.4",
            packageName: "org.bukkit.entity",
            symbol: "org.bukkit.entity.Player#sendMessage",
            ...scope,
        },
        risk: "medium",
        sourcePolicy: "api_signature",
        searchQueries: ["Paper 1.21.4 Player sendMessage Javadoc"],
        acceptanceCriteria: ["Versioned official Javadoc states the exact signature."],
        ...rest,
    };
}

export function makeSource(overrides: Partial<LearningSourceRecord> = {}): LearningSourceRecord {
    return {
        sourceId: "src-official",
        jobId: "learn-test",
        needId: "need-api",
        canonicalUrl: "https://jd.papermc.io/paper/1.21.4/org/bukkit/entity/Player.html",
        domain: "jd.papermc.io",
        sourceType: "javadoc",
        authority: "ground_truth",
        title: "Player Javadoc",
        fetchedAt: 1_700_000_000_000,
        contentHash: "abc123",
        excerpt: "The exact versioned API signature sendMessage(java.lang.String message) is documented in this fixture source.",
        verificationState: "pending",
        ...overrides,
    };
}

export function makeRecipe(overrides: Partial<ImplementationRecipeV1> = {}): ImplementationRecipeV1 {
    return {
        schemaVersion: "implementation_recipe.v1",
        language: "java",
        integrationKind: "external_plugin",
        title: "Send a verified player message",
        code: [
            "public static void sendMessage(Player player, String message) {",
            "    player.sendMessage(message);",
            "}",
        ].join("\n"),
        imports: ["import org.bukkit.entity.Player;"],
        versionScope: "Paper 1.21.4",
        prerequisites: ["The player and message arguments are non-null."],
        notes: ["Call this method from the server thread."],
        sourceIds: ["src-official"],
        ...overrides,
    };
}

export function makeVerification(overrides: Partial<VerificationResult> = {}): VerificationResult {
    const verdict = overrides.verdict ?? "supported";
    return {
        needId: "need-api",
        verdict,
        normalizedClaim: {
            symbol: "org.bukkit.entity.Player#sendMessage(java.lang.String)",
        },
        evidence: [{
            sourceId: "src-official",
            relation: "supports",
            locator: "method summary",
            excerpt: "sendMessage(java.lang.String message)",
        }],
        confidence: 0.96,
        runtimeSummary: "Paper 1.21.4 exposes Player#sendMessage(String).",
        expiresInDays: 90,
        ...(verdict === "supported" ? { recipe: makeRecipe() } : {}),
        ...overrides,
    };
}

export function makeKnowledgeItem(overrides: Partial<KnowledgeItemRecord> = {}): KnowledgeItemRecord {
    return {
        knowledgeId: "know-test",
        kind: "fact",
        lookupKey: "lookup-test",
        scope: { coreType: "paper", mcVersion: "1.21.4" },
        payload: { signature: "sendMessage(String)" },
        summary: "Paper 1.21.4 exposes Player#sendMessage(String).",
        risk: "medium",
        confidence: 0.96,
        status: "active",
        validFrom: 1_700_000_000_000,
        expiresAt: 0,
        revision: 1,
        reviewNote: "",
        createdAt: 1_700_000_000_000,
        updatedAt: 1_700_000_000_000,
        ...overrides,
    };
}
