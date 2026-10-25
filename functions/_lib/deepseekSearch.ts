import type { UsageCostEntry } from "./quota";
import { requestDeepSeekWebTool } from "./deepseekWebTools";
import { LEARNING_DISCOVERY_LIMIT_MS } from "./learning/deadline";
import { sourceClassification, validatePublicSourceUrl } from "./learning/sourceFetch";
import type { KnowledgeNeed, LearningCandidate, LearningProviderStatus, LearningReasonCode } from "./learning/types";

export interface DiscoveryAttemptTelemetry {
    reasonCode?: LearningReasonCode;
    detailCode?: string;
    needId?: string;
    query?: string;
    elapsedMs: number;
    httpStatus: number;
    providerStatus: LearningProviderStatus;
    retryable: boolean;
}

export type LearningDiscoveryResult = {
    attempts: DiscoveryAttemptTelemetry[];
    elapsedMs: number;
    usageEntries: UsageCostEntry[];
    validationCodes: string[];
} & ({ ok: true; candidates: LearningCandidate[] } | {
    ok: false;
    candidates: [];
    reasonCode: LearningReasonCode;
    httpStatus: number;
    providerStatus: LearningProviderStatus;
    retryable: boolean;
});

/** Search accepts at most 128 Unicode code points, rather than UTF-16 units. */
export function searchText(value: string): string {
    return Array.from(value.trim().replace(/\s+/g, " ")).slice(0, 128).join("").trim();
}

function candidateSources(results: unknown[], need: KnowledgeNeed, validationCodes: string[]) {
    const seen = new Set<string>();
    const candidates: Array<{ url: string; priority: number; index: number }> = [];
    for (const [index, item] of results.slice(0, 50).entries()) {
        try {
            if (!item || typeof item !== "object") throw new Error("invalid_result");
            const raw = (item as { url?: unknown }).url;
            if (typeof raw !== "string" || raw.length > 2_000) throw new Error("invalid_url");
            const url = validatePublicSourceUrl(raw);
            url.searchParams.sort();
            if (seen.has(url.href)) continue;
            seen.add(url.href);
            const { authority } = sourceClassification(url, need);
            candidates.push({ url: url.href, index, priority: authority === "ground_truth" ? 0 : authority === "official" ? 1 : 2 });
        } catch {
            validationCodes.push("search_result_url_rejected");
        }
    }
    // Provider scores and summaries are not evidence. Prefer our version/source checks.
    return candidates.sort((a, b) => a.priority - b.priority || a.index - b.index).slice(0, 3)
        .map(({ url }) => ({ url, reason: `核对公开技术问题：${need.claim.question}`.slice(0, 240) }));
}

export async function discoverLearningSources(input: {
    apiKey: string;
    needs: KnowledgeNeed[];
    fetchImpl?: typeof fetch;
    budgetMs?: number;
    timeoutMs?: number;
}): Promise<LearningDiscoveryResult> {
    const startedAt = Date.now();
    const attempts: DiscoveryAttemptTelemetry[] = [];
    const usageEntries: UsageCostEntry[] = [];
    const validationCodes: string[] = [];
    const finish = (candidates: LearningCandidate[], reasonCode: LearningReasonCode = "no_candidate_sources"): LearningDiscoveryResult => {
        const common = { attempts, elapsedMs: Math.max(0, Date.now() - startedAt), usageEntries, validationCodes: [...new Set(validationCodes)].slice(0, 20) };
        const last = attempts.at(-1);
        return candidates.length ? { ...common, ok: true, candidates } : {
            ...common, ok: false, candidates: [], reasonCode,
            httpStatus: last?.httpStatus ?? 0, providerStatus: last?.providerStatus ?? "unknown", retryable: last?.retryable ?? false,
        };
    };
    // Keep the persisted reason code compatible with existing tasks and safe Debug exports.
    if (!input.apiKey) return finish([], "responses_not_configured");
    if (!input.needs.length) return finish([], "no_learning_needed");
    const configured = Number(input.budgetMs ?? input.timeoutMs);
    const budgetMs = Number.isFinite(configured) && configured > 0 ? Math.min(configured, LEARNING_DISCOVERY_LIMIT_MS) : LEARNING_DISCOVERY_LIMIT_MS;
    const deadline = startedAt + Math.max(1, budgetMs - Math.min(750, budgetMs / 10));
    const candidates: LearningCandidate[] = [];
    let lastReason: LearningReasonCode = "no_candidate_sources";
    let queryCount = 0;
    const queues = input.needs.slice(0, 3).map(need => ({
        need, queries: [...new Set(need.searchQueries.slice(0, 4).map(searchText).filter(Boolean))],
    }));
    for (let round = 0; round < 4; round++) {
        for (const { need, queries } of queues) {
            const query = queries[round];
            if (!query || candidates.some(candidate => candidate.needId === need.id)) continue;
            if (queryCount >= 6 || deadline - Date.now() < 250) return finish(candidates, queryCount >= 6 ? lastReason : "discovery_timeout");
            queryCount++;
            const result = await requestDeepSeekWebTool({
                tool: "search", apiKey: input.apiKey,
                body: { query, count: 10, ori_question: searchText(need.claim.question) || query, need_content: false },
                budgetMs: Math.min(25_000, deadline - Date.now()), fetchImpl: input.fetchImpl,
            });
            usageEntries.push(...result.usageEntries);
            attempts.push(...result.attempts.map(attempt => ({
                ...attempt, needId: need.id, query,
                reasonCode: attempt.reason ? `discovery_${attempt.reason}` as LearningReasonCode : undefined,
                providerStatus: attempt.reason ? "failed" as const : "completed" as const,
            })));
            if (result.ok === false) {
                lastReason = `discovery_${result.reason}` as LearningReasonCode;
                // Retrying another query cannot fix authentication, balance or invalid API requests.
                if (result.httpStatus >= 400 && result.httpStatus < 500
                    && result.httpStatus !== 408 && result.httpStatus !== 429) return finish(candidates, lastReason);
                continue;
            }
            const sources = candidateSources(result.payload.results as unknown[], need, validationCodes);
            if (sources.length) {
                candidates.push({ needId: need.id, sources });
                continue;
            }
            lastReason = "no_candidate_sources";
        }
    }
    return finish(candidates, lastReason);
}
