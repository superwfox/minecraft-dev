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
    });
});
