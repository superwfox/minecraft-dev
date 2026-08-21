import {afterEach, describe, expect, it, vi} from "vitest";
import {
    accumulateCosts,
    isDeepSeekPeakTime,
    MODEL_PRICING,
    usageCost,
} from "../functions/_lib/quota";

function createQuotaKv(paidBalance = 5): {
    namespace: KVNamespace;
    store: Map<string, string>;
} {
    const store = new Map<string, string>([
        ["user:user-1", JSON.stringify({paidBalance, totalRecharged: paidBalance})],
    ]);
    const namespace = {
        get: async (key: string) => store.get(key) ?? null,
        put: async (key: string, value: string) => {
            store.set(key, value);
        },
    } as unknown as KVNamespace;
    return {namespace, store};
}

afterEach(() => {
    vi.useRealTimers();
});

describe("DeepSeek official pricing", () => {
    it("uses the official CNY prices for Flash and Pro", () => {
        expect(MODEL_PRICING).toEqual({
            "deepseek-v4-flash": {
                offPeak: {cacheHit: 0.05, input: 1.5, output: 4.5},
                peak: {cacheHit: 0.10, input: 3.0, output: 9.0},
            },
            "deepseek-v4-pro": {
                offPeak: {cacheHit: 0.15, input: 4.5, output: 13.5},
                peak: {cacheHit: 0.30, input: 9.0, output: 27.0},
            },
        });
    });

    it.each([
        ["2026-08-22T00:59:59Z", false],
        ["2026-08-22T01:00:00Z", true],
        ["2026-08-22T03:59:59Z", true],
        ["2026-08-22T04:00:00Z", false],
        ["2026-08-22T05:59:59Z", false],
        ["2026-08-22T06:00:00Z", true],
        ["2026-08-22T09:59:59Z", true],
        ["2026-08-22T10:00:00Z", false],
    ])("classifies %s against the official peak windows", (timestamp, expected) => {
        expect(isDeepSeekPeakTime(new Date(timestamp))).toBe(expected);
    });

    it("prices cache hits, cache misses, and output at the selected window", () => {
        const usage = {
            prompt_tokens: 2_000_000,
            prompt_cache_hit_tokens: 1_000_000,
            prompt_cache_miss_tokens: 1_000_000,
            completion_tokens: 1_000_000,
        };

        expect(usageCost(
            "deepseek-v4-flash",
            usage,
            new Date("2026-08-22T00:00:00Z"),
        )).toBeCloseTo(6.05);
        expect(usageCost(
            "deepseek-v4-flash",
            usage,
            new Date("2026-08-22T01:00:00Z"),
        )).toBeCloseTo(12.1);
        expect(usageCost(
            "deepseek-v4-pro",
            usage,
            new Date("2026-08-22T00:00:00Z"),
        )).toBeCloseTo(18.15);
        expect(usageCost(
            "deepseek-v4-pro",
            usage,
            new Date("2026-08-22T06:00:00Z"),
        )).toBeCloseTo(36.3);
    });

    it("derives cache misses from prompt tokens when the provider omits them", () => {
        expect(usageCost("deepseek-v4-flash", {
            prompt_tokens: 1_000_000,
            prompt_cache_hit_tokens: 250_000,
            completion_tokens: 0,
        }, new Date("2026-08-22T00:00:00Z"))).toBeCloseTo(1.1375);
    });

    it("returns zero for an unknown model", () => {
        expect(usageCost("unknown-model", {
            prompt_tokens: 1_000_000,
            completion_tokens: 1_000_000,
        }, new Date("2026-08-22T01:00:00Z"))).toBe(0);
    });

    it("applies the current pricing window during accumulated quota settlement", async () => {
        vi.useFakeTimers();
        const usage = {
            prompt_tokens: 1_000_000,
            prompt_cache_miss_tokens: 1_000_000,
            completion_tokens: 0,
        };

        vi.setSystemTime(new Date("2026-08-22T00:00:00Z"));
        const offPeakKv = createQuotaKv();
        const offPeak = await accumulateCosts(
            {TASKS: offPeakKv.namespace},
            "user-1",
            "task-off-peak",
            [{model: "deepseek-v4-flash", usage}],
        );
        expect(offPeak).toMatchObject({delta: 1.5, total: 1.5, consumed: 1, outOfQuota: false});
        expect(JSON.parse(offPeakKv.store.get("user:user-1") || "{}").paidBalance).toBe(4);

        vi.setSystemTime(new Date("2026-08-22T01:00:00Z"));
        const peakKv = createQuotaKv();
        const peak = await accumulateCosts(
            {TASKS: peakKv.namespace},
            "user-1",
            "task-peak",
            [{model: "deepseek-v4-flash", usage}],
        );
        expect(peak).toMatchObject({delta: 3, total: 3, consumed: 3, outOfQuota: false});
        expect(JSON.parse(peakKv.store.get("user:user-1") || "{}").paidBalance).toBe(2);
    });
});
