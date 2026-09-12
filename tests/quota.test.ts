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
    it("uses the official CNY prices for V4.1 Flash and legacy V4 Pro", () => {
        expect(MODEL_PRICING).toMatchObject({
            "deepseek-flash": {
                offPeak: {cacheHit: 0.02, input: 1.0, output: 4.0},
                peak: {cacheHit: 0.04, input: 2.0, output: 8.0},
            },
            "deepseek-v4-pro": {
                offPeak: {cacheHit: 0.15, input: 4.5, output: 13.5},
                peak: {cacheHit: 0.30, input: 9.0, output: 27.0},
            },
        });
        expect(MODEL_PRICING["deepseek-v4-flash"]).toEqual(MODEL_PRICING["deepseek-flash"]);
        expect(MODEL_PRICING["deepseek-v4-flash-vision-exp"]).toEqual(MODEL_PRICING["deepseek-flash"]);
    });

    it.each([
        ["2026-09-11T00:59:59Z", false],
        ["2026-09-11T01:00:00Z", true],
        ["2026-09-11T03:59:59Z", true],
        ["2026-09-11T04:00:00Z", false],
        ["2026-09-11T05:59:59Z", false],
        ["2026-09-11T06:00:00Z", true],
        ["2026-09-11T09:59:59Z", true],
        ["2026-09-11T10:00:00Z", false],
        ["2026-09-12T01:00:00Z", false],
        ["2026-09-12T06:00:00Z", false],
        ["2026-09-13T01:00:00Z", false],
        ["2026-09-13T06:00:00Z", false],
        ["2026-09-14T01:00:00Z", true],
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
            "deepseek-flash",
            usage,
            new Date("2026-09-11T00:00:00Z"),
        )).toBeCloseTo(5.02);
        expect(usageCost(
            "deepseek-flash",
            usage,
            new Date("2026-09-11T01:00:00Z"),
        )).toBeCloseTo(10.04);
        expect(usageCost(
            "deepseek-v4-pro",
            usage,
            new Date("2026-09-11T00:00:00Z"),
        )).toBeCloseTo(18.15);
        expect(usageCost(
            "deepseek-v4-pro",
            usage,
            new Date("2026-09-11T06:00:00Z"),
        )).toBeCloseTo(36.3);
    });

    it("derives cache misses from prompt tokens when the provider omits them", () => {
        expect(usageCost("deepseek-flash", {
            prompt_tokens: 1_000_000,
            prompt_cache_hit_tokens: 250_000,
            completion_tokens: 0,
        }, new Date("2026-09-11T00:00:00Z"))).toBeCloseTo(0.755);
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

        vi.setSystemTime(new Date("2026-09-11T00:00:00Z"));
        const offPeakKv = createQuotaKv();
        const offPeak = await accumulateCosts(
            {TASKS: offPeakKv.namespace},
            "user-1",
            "task-off-peak",
            [{model: "deepseek-flash", usage}],
        );
        expect(offPeak).toMatchObject({delta: 1, total: 1, consumed: 1, outOfQuota: false});
        expect(JSON.parse(offPeakKv.store.get("user:user-1") || "{}").paidBalance).toBe(4);

        vi.setSystemTime(new Date("2026-09-11T01:00:00Z"));
        const peakKv = createQuotaKv();
        const peak = await accumulateCosts(
            {TASKS: peakKv.namespace},
            "user-1",
            "task-peak",
            [{model: "deepseek-flash", usage}],
        );
        expect(peak).toMatchObject({delta: 2, total: 2, consumed: 2, outOfQuota: false});
        expect(JSON.parse(peakKv.store.get("user:user-1") || "{}").paidBalance).toBe(3);
    });
});
