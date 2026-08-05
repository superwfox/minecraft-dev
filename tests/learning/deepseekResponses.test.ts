import { describe, expect, it, vi } from "vitest";
import completedFixture from "../fixtures/deepseek-responses/completed.json";
import failedFixture from "../fixtures/deepseek-responses/failed.json";
import incompleteFixture from "../fixtures/deepseek-responses/incomplete.json";
import {
    discoverLearningSources,
    normalizeResponsesUsage,
    parseLearningCandidates,
    parseResponsesResult,
} from "../../functions/_lib/deepseekResponses";
import { makeNeed } from "./testData";

describe("DeepSeek Responses adapter", () => {
    it("parses completed, incomplete, and failed fixtures", () => {
        const completed = parseResponsesResult(completedFixture);

        expect(completed.status).toBe("completed");
        expect(completed.model).toBe("deepseek-v4-flash");
        expect(completed.content).toContain("need-api");
        expect(completed.usage).toEqual({
            prompt_tokens: 120,
            completion_tokens: 30,
            prompt_cache_hit_tokens: 20,
            prompt_cache_miss_tokens: 100,
        });
        expect(parseResponsesResult(incompleteFixture).status).toBe("incomplete");
        expect(parseResponsesResult(failedFixture).status).toBe("failed");
    });

    it("fails closed for an unknown response envelope", () => {
        expect(parseResponsesResult({ output_text: "{}" }).status).toBe("failed");
        expect(parseResponsesResult({ status: "cancelled" }).status).toBe("failed");
    });

    it("accepts only known need IDs and deduplicates candidate URLs", () => {
        const candidates = parseLearningCandidates(`\n\`\`\`json
            {"candidates":[
                {"needId":"need-api","urls":["https://example.com/a","https://example.com/a"," https://example.com/b "]},
                {"needId":"unknown","urls":["https://example.com/c"]},
                {"needId":"need-api","urls":["https://example.com/d"]}
            ]}
        \`\`\``, [makeNeed()]);

        expect(candidates).toEqual([{
            needId: "need-api",
            urls: ["https://example.com/a", "https://example.com/b"],
        }]);
    });

    it("normalizes usage without allowing cached tokens to exceed input", () => {
        expect(normalizeResponsesUsage({
            input_tokens: 10,
            output_tokens: 2,
            input_tokens_details: { cached_tokens: 40 },
        })).toEqual({
            prompt_tokens: 10,
            completion_tokens: 2,
            prompt_cache_hit_tokens: 10,
            prompt_cache_miss_tokens: 0,
        });
    });

    it("uses the Responses endpoint and server-side web_search tool", async () => {
        const fetchImpl = vi.fn(async () => new Response(JSON.stringify(completedFixture), {
            status: 200,
            headers: { "Content-Type": "application/json" },
        })) as unknown as typeof fetch;

        const result = await discoverLearningSources({
            apiKey: "test-key",
            needs: [makeNeed()],
            fetchImpl,
        });

        expect(result.candidates).toHaveLength(1);
        expect(fetchImpl).toHaveBeenCalledOnce();
        const [url, init] = vi.mocked(fetchImpl).mock.calls[0];
        const body = JSON.parse(String(init?.body));
        expect(url).toBe("https://api.deepseek.com/responses");
        expect(init?.headers).toMatchObject({ Authorization: "Bearer test-key" });
        expect(body.model).toBe("deepseek-v4-flash");
        expect(body.tools).toEqual([{ type: "web_search" }]);
        expect(body.tool_choice).toEqual({ type: "web_search" });
        expect(body.text?.format).toMatchObject({
            type: "json_schema",
            name: "learning_source_candidates",
            schema: {
                type: "object",
                required: ["candidates"],
                properties: {
                    candidates: {
                        maxItems: 1,
                        items: {
                            properties: {
                                needId: { enum: ["need-api"] },
                            },
                        },
                    },
                },
            },
        });
    });

    it("retries one quick transient HTTP failure without exposing its body", async () => {
        const fetchImpl = vi.fn()
            .mockResolvedValueOnce(new Response("provider-secret-body", { status: 503 }))
            .mockResolvedValueOnce(new Response(JSON.stringify(completedFixture), {
                status: 200,
                headers: { "Content-Type": "application/json" },
            })) as unknown as typeof fetch;

        const result = await discoverLearningSources({
            apiKey: "test-key",
            needs: [makeNeed()],
            fetchImpl,
            budgetMs: 8_000,
        });

        expect(result.ok).toBe(true);
        expect(result.attempts).toHaveLength(2);
        expect(result.attempts[0]).toMatchObject({
            reasonCode: "discovery_http",
            httpStatus: 503,
            retryable: true,
        });
        expect(JSON.stringify(result)).not.toContain("provider-secret-body");
    });

    it("retries a slow completed response whose text is not valid JSON", async () => {
        let now = 1_800_000_000_000;
        const nowSpy = vi.spyOn(Date, "now").mockImplementation(() => now);
        const invalidCompleted = {
            type: "response.completed",
            response: {
                status: "completed",
                model: "deepseek-v4-flash",
                output: [{
                    type: "message",
                    content: [{ type: "output_text", text: "Sources were found, but this is not JSON." }],
                }],
            },
        };
        const fetchImpl = vi.fn()
            .mockImplementationOnce(async () => {
                now += 6_000;
                return new Response(JSON.stringify(invalidCompleted), { status: 200 });
            })
            .mockResolvedValueOnce(new Response(JSON.stringify(completedFixture), {
                status: 200,
            })) as unknown as typeof fetch;

        try {
            const result = await discoverLearningSources({
                apiKey: "test-key",
                needs: [makeNeed()],
                fetchImpl,
                budgetMs: 30_000,
            });

            expect(result.ok).toBe(true);
            expect(result.attempts).toHaveLength(2);
            expect(result.attempts[0]).toMatchObject({
                reasonCode: "discovery_invalid_response",
                providerStatus: "completed",
                retryable: true,
            });
            expect(fetchImpl).toHaveBeenCalledTimes(2);
        } finally {
            nowSpy.mockRestore();
        }
    });

    it("does not retry a non-transient authentication response", async () => {
        const fetchImpl = vi.fn(async () => new Response("credential-error-body", {
            status: 401,
        })) as unknown as typeof fetch;

        const result = await discoverLearningSources({
            apiKey: "test-key",
            needs: [makeNeed()],
            fetchImpl,
            budgetMs: 8_000,
        });

        expect(result).toMatchObject({
            ok: false,
            reasonCode: "discovery_http",
            httpStatus: 401,
            retryable: false,
        });
        expect(result.attempts).toHaveLength(1);
        expect(fetchImpl).toHaveBeenCalledOnce();
        expect(JSON.stringify(result)).not.toContain("credential-error-body");
    });

    it("accounts for usage from an incomplete attempt before retrying", async () => {
        const incompleteWithUsage = {
            type: "response.incomplete",
            response: {
                status: "incomplete",
                model: "deepseek-v4-flash",
                output_text: "",
                usage: { input_tokens: 10, output_tokens: 2 },
            },
        };
        const fetchImpl = vi.fn()
            .mockResolvedValueOnce(new Response(JSON.stringify(incompleteWithUsage), { status: 200 }))
            .mockResolvedValueOnce(new Response(JSON.stringify(completedFixture), { status: 200 })) as unknown as typeof fetch;

        const result = await discoverLearningSources({
            apiKey: "test-key",
            needs: [makeNeed()],
            fetchImpl,
            budgetMs: 8_000,
        });

        expect(result.ok).toBe(true);
        expect(result.attempts[0]).toMatchObject({
            reasonCode: "discovery_provider_incomplete",
            providerStatus: "incomplete",
            retryable: true,
        });
        expect(result.usageEntries).toHaveLength(2);
        expect(result.usageEntries[0].usage).toMatchObject({
            prompt_tokens: 10,
            completion_tokens: 2,
        });
    });

    it("returns a bounded timeout reason when the provider does not respond", async () => {
        const fetchImpl = vi.fn((_url: RequestInfo | URL, init?: RequestInit) =>
            new Promise<Response>((_, reject) => {
                const signal = init?.signal;
                const abort = () => reject(new DOMException("Aborted", "AbortError"));
                if (signal?.aborted) abort();
                else signal?.addEventListener("abort", abort, { once: true });
            })) as unknown as typeof fetch;

        const result = await discoverLearningSources({
            apiKey: "test-key",
            needs: [makeNeed()],
            fetchImpl,
            budgetMs: 1_000,
        });

        expect(result).toMatchObject({
            ok: false,
            reasonCode: "discovery_timeout",
            retryable: false,
        });
        expect(result.attempts).toHaveLength(1);
        expect(fetchImpl).toHaveBeenCalledOnce();
    });
});
