import { compileDependencyContextHash } from "./assessment";
import { compileEvidenceFactApplies, currentCompileApiEvidence, resolvedCompileDependencies } from "./compileApiEvidence";
import { buildNegativeApiEnvironment, canonicalNegativeApiSymbol, findActiveNegativeApiFacts,
    getNegativeApiFactsByIds, negativeApiFactApplies, positiveApiFactsFromKnowledge, reconcileNegativeApiFacts,
    type NegativeApiFact } from "./negativeApiFacts";
import type { LearningStoreEnv } from "./store";
import type { KnowledgeItemRecord, KnowledgeNeed, LearningJobRecord, NegativeFactUsed } from "./types";

export function learningNegativeFactIds(job: Pick<LearningJobRecord, "work"> | null): string[] {
    return [...new Set([...Object.values(job?.work.negativeResultIds ?? {}), ...(job?.work.cachedNegativeFactIds ?? [])])];
}

export function negativeFactsUsed(facts: NegativeApiFact[], cachedIds: string[] = []): NegativeFactUsed[] {
    return facts.filter(fact => fact.status === "active" && fact.expiresAt > Date.now()).map(fact => ({
        factId: fact.factId, symbol: fact.symbol, dependencyIdentity: fact.dependencyIdentity,
        dependencyFingerprint: fact.dependencyFingerprint || "", sourceUrl: fact.evidenceSourceUrl || "",
        source: cachedIds.includes(fact.factId) ? "cache" : "verified",
    }));
}

export function negativeFactAnswersNeed(fact: NegativeApiFact, need: KnowledgeNeed): boolean {
    return need.kind === "fact" && need.claim.answerType === "signature"
        && fact.symbol === canonicalNegativeApiSymbol(need.scope.symbol)
        && fact.dependencyIdentity === need.scope.dependency && fact.coreType === need.scope.coreType?.toLowerCase()
        && fact.mcVersion === need.scope.mcVersion;
}

async function validFacts(state: any, facts: NegativeApiFact[], positives: KnowledgeItemRecord[] = []) {
    const evidence = await currentCompileApiEvidence(state);
    if (!evidence) return [];
    const environment = await buildNegativeApiEnvironment({ coreType: state.coreType || "", mcVersion: state.version || "",
        dependencies: await resolvedCompileDependencies(state),
        pomContent: (state.generatedFiles ?? []).find((file: any) => file.path === "pom.xml")?.content || "", compileRunId: state.runId });
    return reconcileNegativeApiFacts({ environment,
        facts: facts.filter(fact => negativeApiFactApplies(fact, environment) && compileEvidenceFactApplies(evidence, fact)),
        positiveFacts: positiveApiFactsFromKnowledge(positives) }).active;
}

export async function loadNegativeNeedCache(env: LearningStoreEnv, state: any, needs: KnowledgeNeed[], positives: KnowledgeItemRecord[] = []) {
    if (!await currentCompileApiEvidence(state)) return [];
    const environment = await buildNegativeApiEnvironment({ coreType: state.coreType || "", mcVersion: state.version || "",
        dependencies: await resolvedCompileDependencies(state), compileRunId: state.runId });
    const facts = await findActiveNegativeApiFacts(env, { symbols: needs.map(need => need.scope.symbol || ""), environment });
    return (await validFacts(state, facts, positives)).filter(fact => needs.some(need => negativeFactAnswersNeed(fact, need)));
}

export async function loadLearningNegativeFacts(env: LearningStoreEnv, job: LearningJobRecord | null, state: any, positives: KnowledgeItemRecord[] = []) {
    if (!job || !learningNegativeFactIds(job).length) return [];
    const expected = job.work.compileEvidenceContext;
    const evidence = await currentCompileApiEvidence(state);
    if (!evidence || !expected || expected.contextHash !== evidence.contextHash
        || expected.pomHash !== await compileDependencyContextHash(state.generatedFiles ?? [])) return [];
    const facts = await getNegativeApiFactsByIds(env, learningNegativeFactIds(job));
    return (await validFacts(state, facts, positives)).filter(fact => job.needs.some(need =>
        job.work.negativeResultIds?.[need.id] === fact.factId && negativeFactAnswersNeed(fact, need))
        || job.work.cachedNegativeFactIds?.includes(fact.factId));
}

export function resolvedNegativeNeedCount(job: LearningJobRecord, facts: NegativeApiFact[]): number {
    return job.needs.filter(need => facts.some(fact => job.work.negativeResultIds?.[need.id] === fact.factId && negativeFactAnswersNeed(fact, need))).length;
}
