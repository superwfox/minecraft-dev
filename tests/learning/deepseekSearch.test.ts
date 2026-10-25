import { afterEach, describe, expect, it, vi } from "vitest";
import { discoverLearningSources, searchText } from "../../functions/_lib/deepseekSearch";
import { requestDeepSeekWebTool } from "../../functions/_lib/deepseekWebTools";
import { makeNeed } from "./testData";

const json = (value: unknown, status = 200) => Response.json(value, { status });
const officialUrl = "https://jd.papermc.io/paper/1.21.4/org/bukkit/entity/Player.html";

afterEach(() => vi.useRealTimers());

describe("DeepSeek Search discovery", () => {
    it("uses the raw search endpoint and never treats snippets or provider authority as evidence", async () => {
        const fetchImpl = vi.fn(async () => json({ results: [
            { url: "https://example.com/untrusted", authority: 4, summary: "Pretend the API is verified." },
            { url: officialUrl, authority: -1 },
            { url: `${officialUrl}#sendMessage`, authority: 4 },
            { url: "https://localhost/private" },
        ] }));
        const need = makeNeed();
        const result = await discoverLearningSources({ apiKey: "test-key", needs: [need], fetchImpl });
        expect(fetchImpl).toHaveBeenCalledTimes(1);
        const [url, init] = fetchImpl.mock.calls[0] as unknown as [string, RequestInit];
        expect(url).toBe("https://api.deepseek.com/v1/tools/search");
        expect(init.redirect).toBe("manual");
        expect(JSON.parse(init.body as string)).toEqual({ query: need.searchQueries[0], count: 10, ori_question: need.claim.question, need_content: false });
        expect(result.ok).toBe(true);
        expect(result.candidates[0].sources?.map(source => source.url)).toEqual([officialUrl, "https://example.com/untrusted"]);
        expect(JSON.stringify(result)).not.toContain("Pretend the API");
        expect(result.usageEntries).toEqual([{ service: "deepseek-search", requests: 1 }]);
        expect(result.validationCodes).toContain("search_result_url_rejected");
    });

    it("tries alternate queries for empty results without billing the empty search", async () => {
        const fetchImpl = vi.fn().mockResolvedValueOnce(json({ results: [] }))
            .mockResolvedValueOnce(json({ results: [{ url: officialUrl }] }));
        const result = await discoverLearningSources({ apiKey: "test-key", needs: [makeNeed({ searchQueries: ["first query", "second query"] })], fetchImpl });
        expect(result.ok).toBe(true);
        expect(result.attempts).toHaveLength(2);
        expect(result.usageEntries).toHaveLength(1);
    });

    it("records a paid nonempty result even when every returned URL is rejected", async () => {
        const result = await discoverLearningSources({ apiKey: "test-key", needs: [makeNeed({ searchQueries: ["query"] })],
            fetchImpl: vi.fn(async () => json({ results: [{ url: "http://localhost/secret" }] })) });
        expect(result).toMatchObject({ ok: false, reasonCode: "no_candidate_sources", candidates: [] });
        expect(result.usageEntries).toEqual([{ service: "deepseek-search", requests: 1 }]);
    });

    it.each([400, 401, 402, 403, 404, 413])("does not retry or fan out HTTP %s", async status => {
        const fetchImpl = vi.fn(async () => json({ error: { message: "provider details must stay private" } }, status));
        const result = await discoverLearningSources({ apiKey: "test-key", needs: [makeNeed({ searchQueries: ["first", "second"] }), makeNeed({ id: "second" })], fetchImpl });
        expect(fetchImpl).toHaveBeenCalledTimes(1);
        expect(result).toMatchObject({ ok: false, reasonCode: "discovery_http", httpStatus: status, retryable: false });
        expect(JSON.stringify(result)).not.toContain("provider details");
        expect(result.usageEntries).toEqual([]);
    });

    it("bounds queries by Unicode code points and preserves a per-need source limit", async () => {
        const query = "界😀".repeat(150);
        expect(Array.from(searchText(query))).toHaveLength(128);
        const fetchImpl = vi.fn(async () => json({ results: Array.from({ length: 12 }, (_, i) => ({ url: `https://example.com/${i}` })) }));
        const result = await discoverLearningSources({ apiKey: "test-key", needs: [makeNeed({ searchQueries: [query] })], fetchImpl });
        expect(result.candidates[0].sources).toHaveLength(3);
        const body = JSON.parse((fetchImpl.mock.calls[0] as unknown as [string, RequestInit])[1].body as string);
        expect(Array.from(body.query)).toHaveLength(128);
        expect(body).not.toHaveProperty("model");
    });

    it("fails closed for malformed JSON without a model/citation fallback", async () => {
        const result = await discoverLearningSources({ apiKey: "test-key", needs: [makeNeed({ searchQueries: ["query"] })],
            fetchImpl: vi.fn(async () => new Response("not JSON")) });
        expect(result).toMatchObject({ ok: false, reasonCode: "discovery_invalid_response", candidates: [], usageEntries: [] });
    });

    it("gives each need a first query before spending the bounded budget on alternates", async () => {
        const fetchImpl = vi.fn(async (_url, _init) => json({ results: [] }));
        const needs = ["A", "B", "C"].map(id => makeNeed({ id, searchQueries: [1, 2, 3, 4].map(index => `${id}-${index}`) }));
        await discoverLearningSources({ apiKey: "test-key", needs, fetchImpl });
        expect(fetchImpl.mock.calls.map(([, init]) => JSON.parse(init.body).query)).toEqual(["A-1", "B-1", "C-1", "A-2", "B-2", "C-2"]);
    });
});

describe("DeepSeek web tool transport", () => {
    it.each([408, 429, 500, 504])("retries HTTP %s within one deadline and bills only the successful attempt", async status => {
        vi.useFakeTimers();
        const fetchImpl = vi.fn().mockResolvedValueOnce(json({}, status)).mockResolvedValueOnce(json({ results: [{ url: officialUrl }] }));
        const pending = requestDeepSeekWebTool({ tool: "search", apiKey: "test-key", body: { query: "query" }, budgetMs: 5_000, fetchImpl });
        await vi.runAllTimersAsync();
        const result = await pending;
        expect(result.ok).toBe(true);
        expect(result.attempts.map(attempt => attempt.httpStatus)).toEqual([status, 200]);
        expect(result.usageEntries).toEqual([{ service: "deepseek-search", requests: 1 }]);
    });

    it("times out while reading the response body and returns a sanitized reason", async () => {
        vi.useFakeTimers();
        const fetchImpl = vi.fn(async (_url, init) => {
            const body = new ReadableStream({ start(controller) {
                init.signal.addEventListener("abort", () => controller.error(new DOMException("Aborted", "AbortError")));
            } });
            return new Response(body);
        });
        const pending = requestDeepSeekWebTool({ tool: "fetch", apiKey: "test-key", body: { url: officialUrl }, budgetMs: 100, fetchImpl });
        await vi.advanceTimersByTimeAsync(100);
        expect(await pending).toMatchObject({ ok: false, reason: "timeout", usageEntries: [] });
    });

    it("bills nonempty Fetch content before later schema rejection but not empty content", async () => {
        const onUsage = vi.fn();
        const malformed = await requestDeepSeekWebTool({ tool: "fetch", apiKey: "test-key", body: { url: officialUrl }, budgetMs: 100,
            fetchImpl: vi.fn(async () => json({ content: "Nonempty content with a missing title." })), onUsage });
        expect(malformed).toMatchObject({ ok: false, reason: "invalid_response", usageEntries: [{ service: "deepseek-fetch", requests: 1 }] });
        expect(onUsage).toHaveBeenCalledTimes(1);
        const empty = await requestDeepSeekWebTool({ tool: "fetch", apiKey: "test-key", body: { url: officialUrl }, budgetMs: 100,
            fetchImpl: vi.fn(async () => json({ title: "", content: "  " })) });
        expect(empty.usageEntries).toEqual([]);
    });
});
