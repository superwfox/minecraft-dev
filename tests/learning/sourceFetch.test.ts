import { describe, expect, it, vi } from "vitest";
import {
    fetchLearningSource,
    fetchLearningSources,
    learningNoSourcesReason,
    publicLearningCandidateUrl,
    validatePublicSourceUrl,
} from "../../functions/_lib/learning/sourceFetch";
import { makeNeed } from "./testData";

const LONG_TEXT = "Versioned public technical evidence ".repeat(8);

function responseFetch(body = LONG_TEXT, contentType = "text/plain"): typeof fetch {
    return vi.fn(async () => new Response(body, {
        status: 200,
        headers: { "Content-Type": contentType },
    })) as unknown as typeof fetch;
}

async function fetchAt(url: string, need = makeNeed()) {
    const contentType = url.endsWith(".pom") || url.endsWith(".xml") ? "application/xml" : "text/plain";
    return fetchLearningSource({
        jobId: "learn-test",
        need,
        url,
        fetchImpl: responseFetch(LONG_TEXT, contentType),
        now: 1_700_000_000_000,
    });
}

describe("learning source fetch safety", () => {
    it("rejects non-public URL forms before fetching", () => {
        const cases = [
            ["http://example.com/docs", "https_required"],
            ["https://user:secret@example.com/docs", "credentials_forbidden"],
            ["https://example.com:8443/docs", "port_forbidden"],
            ["https://localhost/docs", "localhost_forbidden"],
            ["https://service.internal/docs", "private_hostname_forbidden"],
            ["https://metadata.google.internal/docs", "metadata_forbidden"],
            ["https://127.0.0.1/docs", "ip_literal_forbidden"],
            ["https://2130706433/docs", "ip_literal_forbidden"],
            ["https://8.8.8.8/docs", "ip_literal_forbidden"],
            ["https://[::ffff:127.0.0.1]/docs", "ip_literal_forbidden"],
            ["https://[2001:4860:4860::8888]/docs", "ip_literal_forbidden"],
        ] as const;

        for (const [url, error] of cases) {
            expect(() => validatePublicSourceUrl(url), url).toThrow(error);
        }
        expect(validatePublicSourceUrl("https://example.com/docs#section").href).toBe("https://example.com/docs");
    });

    it("projects candidate URLs without credentials, fragments, or sensitive query values", () => {
        expect(publicLearningCandidateUrl(
            "https://user:secret@example.com/docs?token=private&lang=en#section",
        )).toBe("https://example.com/docs?lang=en");
        expect(publicLearningCandidateUrl("not a url")).toBe("");
    });

    it("rejects redirects to an IP literal without issuing the second request", async () => {
        const fetchImpl = vi.fn(async () => new Response(null, {
            status: 302,
            headers: { Location: "https://127.0.0.1/metadata" },
        })) as unknown as typeof fetch;

        await expect(fetchLearningSource({
            jobId: "learn-test",
            need: makeNeed(),
            url: "https://example.com/start",
            fetchImpl,
        })).rejects.toThrow("ip_literal_forbidden");
        expect(fetchImpl).toHaveBeenCalledOnce();
    });

    it("uses one timeout budget across the full redirect chain", async () => {
        const signals: AbortSignal[] = [];
        const fetchImpl = vi.fn(async (_url: RequestInfo | URL, init?: RequestInit) => {
            const signal = init?.signal as AbortSignal;
            signals.push(signal);
            if (signals.length === 1) {
                return new Response(null, {
                    status: 302,
                    headers: { Location: "https://example.com/final" },
                });
            }
            return new Promise<Response>((_, reject) => {
                const abort = () => reject(new DOMException("Aborted", "AbortError"));
                if (signal.aborted) abort();
                else signal.addEventListener("abort", abort, { once: true });
            });
        }) as unknown as typeof fetch;

        await expect(fetchLearningSource({
            jobId: "learn-test",
            need: makeNeed(),
            url: "https://example.com/start",
            fetchImpl,
            timeoutMs: 5,
        })).rejects.toMatchObject({ name: "AbortError" });
        expect(fetchImpl).toHaveBeenCalledTimes(2);
        expect(signals[1]).toBe(signals[0]);
    });

    it("requires an exact dependency-scoped version POM for artifact ground truth", async () => {
        const dependencyNeed = makeNeed({
            claim: {
                subject: "example:library:1.0",
                question: "Which exact Maven coordinate provides example library 1.0?",
                answerType: "coordinate",
            },
            scope: {
                dependency: "example:library:1.0",
                packageName: undefined,
                symbol: undefined,
            },
            sourcePolicy: "dependency",
        });
        const exactPom = await fetchAt(
            "https://repo.maven.apache.org/maven2/example/library/1.0/library-1.0.pom",
            dependencyNeed,
        );
        const wrongCoordinatePom = await fetchAt(
            "https://repo.maven.apache.org/maven2/example/other/1.0/other-1.0.pom",
            dependencyNeed,
        );
        const implicitScopePom = await fetchAt(
            "https://repo.maven.apache.org/maven2/example/library/1.0/library-1.0.pom",
            makeNeed({ scope: { dependency: "example:library", symbol: undefined } }),
        );
        const metadata = await fetchAt(
            "https://repo.maven.apache.org/maven2/example/library/maven-metadata.xml",
            dependencyNeed,
        );
        const jitpackPom = await fetchAt(
            "https://jitpack.io/example/library/1.0/library-1.0.pom",
            dependencyNeed,
        );
        const mirroredPom = await fetchAt(
            "https://example.com/example/library/1.0/library-1.0.pom",
            dependencyNeed,
        );

        expect(exactPom).toMatchObject({ sourceType: "artifact", authority: "ground_truth" });
        expect(wrongCoordinatePom.authority).toBe("official");
        expect(implicitScopePom.authority).toBe("official");
        expect(metadata).toMatchObject({ sourceType: "artifact", authority: "official" });
        expect(jitpackPom).toMatchObject({ sourceType: "artifact", authority: "secondary" });
        expect(mirroredPom).toMatchObject({ sourceType: "artifact", authority: "secondary" });
    });

    it("does not promote SHA-shaped GitHub objects without trusted ref ancestry", async () => {
        const commit = "a".repeat(40);
        const officialCommit = await fetchAt(`https://github.com/PaperMC/Paper/blob/${commit}/README.md`);
        const officialRawCommit = await fetchAt(
            `https://raw.githubusercontent.com/PaperMC/Paper/${commit}/README.md`,
        );
        const officialRelease = await fetchAt(
            "https://github.com/PaperMC/Paper/releases/tag/ver/1.21.4-123",
        );
        const unlistedRelease = await fetchAt(
            "https://github.com/PaperMC/Website/releases/tag/example",
        );

        expect(officialCommit).toMatchObject({ sourceType: "repository", authority: "secondary" });
        expect(officialRawCommit).toMatchObject({ sourceType: "repository", authority: "secondary" });
        expect(officialRelease).toMatchObject({ sourceType: "release", authority: "official" });
        expect(unlistedRelease).toMatchObject({ sourceType: "release", authority: "secondary" });
    });

    it("does not treat user-published or nested subdomains as official sources", async () => {
        const paperForum = await fetchAt(
            "https://forums.papermc.io/threads/user-posted-implementation",
        );
        const spigotResource = await fetchAt(
            "https://www.spigotmc.org/resources/user-published-library.12345/",
        );
        const nestedDocsHost = await fetchAt(
            "https://community.docs.papermc.io/paper/reference",
        );
        const officialDocs = await fetchAt(
            "https://docs.papermc.io/paper/reference/overview",
        );

        expect(paperForum).toMatchObject({ sourceType: "community", authority: "untrusted" });
        expect(spigotResource).toMatchObject({ sourceType: "community", authority: "untrusted" });
        expect(nestedDocsHost).toMatchObject({ sourceType: "community", authority: "untrusted" });
        expect(officialDocs).toMatchObject({ sourceType: "documentation", authority: "official" });
    });

    it("requires official Javadoc to match both the need version and symbol", async () => {
        const matching = await fetchAt(
            "https://jd.papermc.io/paper/1.21.4/org/bukkit/entity/Player.html",
        );
        const wrongVersion = await fetchAt(
            "https://jd.papermc.io/paper/1.21.3/org/bukkit/entity/Player.html",
        );
        const versionPrefixOnly = await fetchAt(
            "https://jd.papermc.io/paper/1.21.4/org/bukkit/entity/Player.html",
            makeNeed({ scope: { mcVersion: "1.21" } }),
        );
        const wrongSymbol = await fetchAt(
            "https://jd.papermc.io/paper/1.21.4/org/bukkit/entity/Entity.html",
        );
        const unversioned = await fetchAt(
            "https://jd.papermc.io/paper/org/bukkit/entity/Player.html",
        );
        const missingSymbol = await fetchAt(
            "https://jd.papermc.io/paper/1.21.4/org/bukkit/entity/Player.html",
            makeNeed({ scope: { symbol: undefined } }),
        );
        const mirrored = await fetchAt(
            "https://example.com/javadoc/1.21.4/org/bukkit/entity/Player.html",
        );

        expect(matching.authority).toBe("ground_truth");
        expect(wrongVersion.authority).toBe("official");
        expect(versionPrefixOnly.authority).toBe("official");
        expect(wrongSymbol.authority).toBe("official");
        expect(unversioned.authority).toBe("official");
        expect(missingSymbol.authority).toBe("official");
        expect(mirrored.authority).toBe("secondary");
    });

    it("derives stable source IDs from the job, need, and canonical URL", async () => {
        const need = makeNeed();
        const first = await fetchLearningSource({
            jobId: "learn-test",
            need,
            url: "https://example.com/docs#first",
            fetchImpl: responseFetch(),
            now: 1_700_000_000_000,
        });
        const retried = await fetchLearningSource({
            jobId: "learn-test",
            need,
            url: "https://example.com/docs#second",
            fetchImpl: responseFetch(),
            now: 1_800_000_000_000,
        });
        const otherNeed = await fetchLearningSource({
            jobId: "learn-test",
            need: makeNeed({ id: "need-other" }),
            url: "https://example.com/docs",
            fetchImpl: responseFetch(),
        });
        const otherJob = await fetchLearningSource({
            jobId: "learn-other",
            need,
            url: "https://example.com/docs",
            fetchImpl: responseFetch(),
        });

        expect(first.sourceId).toMatch(/^src_[a-f0-9]{64}$/);
        expect(retried.sourceId).toBe(first.sourceId);
        expect(otherNeed.sourceId).not.toBe(first.sourceId);
        expect(otherJob.sourceId).not.toBe(first.sourceId);
    });

    it("allocates the source budget round-robin and fills unsourced needs first", async () => {
        const firstNeed = makeNeed({ id: "need-first" });
        const secondNeed = makeNeed({ id: "need-second" });
        const requested: string[] = [];
        const fetchImpl = vi.fn(async (rawUrl: RequestInfo | URL) => {
            const url = String(rawUrl);
            requested.push(url);
            if (url.endsWith("/second-1")) return new Response("not found", { status: 404 });
            return new Response(LONG_TEXT, {
                status: 200,
                headers: { "Content-Type": "text/plain" },
            });
        }) as unknown as typeof fetch;

        const result = await fetchLearningSources({
            jobId: "learn-test",
            needs: [firstNeed, secondNeed],
            candidates: [
                {
                    needId: firstNeed.id,
                    urls: ["https://example.com/first-1", "https://example.com/first-2"],
                },
                {
                    needId: secondNeed.id,
                    urls: ["https://example.com/second-1", "https://example.com/second-2"],
                },
            ],
            fetchImpl,
            maxSources: 3,
        });

        expect(result.sources.map((source) => source.needId)).toEqual([
            firstNeed.id,
            secondNeed.id,
            firstNeed.id,
        ]);
        expect(requested).toEqual([
            "https://example.com/first-1",
            "https://example.com/second-1",
            "https://example.com/second-2",
            "https://example.com/first-2",
        ]);
        expect(result.telemetry).toMatchObject({
            sourceAttempts: 4,
            sourceAccepted: 3,
            sourceRejected: 1,
            sourceInvalid: 0,
            sourceDeduplicated: 0,
            sourceTimeouts: 0,
            sourceHttp4xx: 1,
            sourceHttp5xx: 0,
        });
    });

    it("continues to the next candidate after one source timeout while stage budget remains", async () => {
        const fetchImpl = vi.fn((rawUrl: RequestInfo | URL, init?: RequestInit) => {
            if (String(rawUrl).endsWith("/slow")) {
                return new Promise<Response>((_, reject) => {
                    const signal = init?.signal;
                    const abort = () => reject(new DOMException("Aborted", "AbortError"));
                    if (signal?.aborted) abort();
                    else signal?.addEventListener("abort", abort, { once: true });
                });
            }
            return Promise.resolve(new Response(LONG_TEXT, {
                status: 200,
                headers: { "Content-Type": "text/plain" },
            }));
        }) as unknown as typeof fetch;

        const result = await fetchLearningSources({
            jobId: "learn-test",
            needs: [makeNeed()],
            candidates: [{
                needId: "need-api",
                urls: ["https://example.com/slow", "https://example.com/usable"],
            }],
            fetchImpl,
            timeoutMs: 5,
            budgetMs: 250,
            maxSources: 1,
        });

        expect(fetchImpl).toHaveBeenCalledTimes(2);
        expect(result.sources).toHaveLength(1);
        expect(result.sources[0].canonicalUrl).toBe("https://example.com/usable");
        expect(result.telemetry).toMatchObject({
            sourceAttempts: 2,
            sourceAccepted: 1,
            sourceTimeouts: 1,
            sourceBudgetExhausted: 0,
        });
    });

    it("stops the candidate queue when the total fetch budget expires", async () => {
        const fetchImpl = vi.fn((_url: RequestInfo | URL, init?: RequestInit) =>
            new Promise<Response>((_, reject) => {
                const signal = init?.signal;
                const abort = () => reject(new DOMException("Aborted", "AbortError"));
                if (signal?.aborted) abort();
                else signal?.addEventListener("abort", abort, { once: true });
            })) as unknown as typeof fetch;

        const result = await fetchLearningSources({
            jobId: "learn-test",
            needs: [makeNeed()],
            candidates: [{
                needId: "need-api",
                urls: ["https://example.com/slow-1", "https://example.com/slow-2"],
            }],
            fetchImpl,
            timeoutMs: 1_000,
            budgetMs: 5,
        });

        expect(fetchImpl).toHaveBeenCalledOnce();
        expect(result.sources).toEqual([]);
        expect(result.telemetry).toMatchObject({
            sourceAttempts: 1,
            sourceTimeouts: 1,
            sourceBudgetExhausted: 1,
        });
        expect(result.outcomes).toMatchObject([
            { status: "rejected", rejectionCode: "timeout" },
            { status: "skipped", rejectionCode: "budget_exhausted" },
        ]);
    });

    it("marks unattempted candidates as skipped after reaching the source limit", async () => {
        const fetchImpl = responseFetch();
        const result = await fetchLearningSources({
            jobId: "learn-test",
            needs: [makeNeed()],
            candidates: [{
                needId: "need-api",
                sources: [
                    {
                        url: "https://example.com/first",
                        reason: "Check the first versioned source for the target contract.",
                    },
                    {
                        url: "https://example.com/second",
                        reason: "Check a backup source if the first source is insufficient.",
                    },
                ],
            }],
            fetchImpl,
            maxSources: 1,
        });

        expect(fetchImpl).toHaveBeenCalledOnce();
        expect(result.outcomes).toMatchObject([
            { status: "fetched" },
            { status: "skipped", rejectionCode: "source_limit" },
        ]);
    });

    it("rejects malformed recovered candidate payloads before issuing requests", async () => {
        const fetchImpl = responseFetch();
        const sources = ["a", "b", "c", "d"].map((suffix) => ({
            url: `https://example.com/${suffix}`,
            reason: `Check versioned source ${suffix} for the exact API contract.`,
        }));

        await expect(fetchLearningSources({
            jobId: "learn-test",
            needs: [makeNeed()],
            candidates: [{ needId: "need-api", sources }],
            fetchImpl,
        })).rejects.toThrow("learning_candidate_bounds");
        await expect(fetchLearningSources({
            jobId: "learn-test",
            needs: [makeNeed()],
            candidates: [{
                needId: "need-unknown",
                sources: sources.slice(0, 1),
            }],
            fetchImpl,
        })).rejects.toThrow("learning_candidate_bounds");
        expect(fetchImpl).not.toHaveBeenCalled();
    });

    it("classifies an empty source result without hiding timeout causes", () => {
        expect(learningNoSourcesReason({
            sourceTimeouts: 0,
            sourceBudgetExhausted: 1,
        }, true)).toBe("job_deadline");
        expect(learningNoSourcesReason({
            sourceTimeouts: 1,
            sourceBudgetExhausted: 0,
        }, false)).toBe("source_fetch_timeout");
        expect(learningNoSourcesReason({
            sourceTimeouts: 0,
            sourceBudgetExhausted: 1,
        }, false)).toBe("source_fetch_timeout");
        expect(learningNoSourcesReason({
            sourceTimeouts: 0,
            sourceBudgetExhausted: 0,
        }, false)).toBe("no_fetchable_sources");
    });

    it("applies the timeout while waiting for the response body", async () => {
        const fetchImpl = vi.fn(async (_url: RequestInfo | URL, init?: RequestInit) => {
            const signal = init?.signal;
            const body = new ReadableStream<Uint8Array>({
                start(controller) {
                    const abort = () => controller.error(new DOMException("Aborted", "AbortError"));
                    if (signal?.aborted) abort();
                    else signal?.addEventListener("abort", abort, { once: true });
                },
            });
            return new Response(body, {
                status: 200,
                headers: { "Content-Type": "text/plain" },
            });
        }) as unknown as typeof fetch;

        await expect(fetchLearningSource({
            jobId: "learn-test",
            need: makeNeed(),
            url: "https://example.com/slow",
            fetchImpl,
            timeoutMs: 5,
        })).rejects.toMatchObject({ name: "AbortError" });
        expect(fetchImpl).toHaveBeenCalledOnce();
    });

    it("stops reading a body that exceeds the byte budget without a Content-Length header", async () => {
        const fetchImpl = responseFetch("x".repeat(256 * 1024 + 1));

        await expect(fetchLearningSource({
            jobId: "learn-test",
            need: makeNeed(),
            url: "https://example.com/large",
            fetchImpl,
        })).rejects.toThrow("source_too_large");
    });

    it("deduplicates canonical URLs and reports invalid candidates", async () => {
        const fetchImpl = responseFetch();
        const result = await fetchLearningSources({
            jobId: "learn-test",
            needs: [makeNeed()],
            candidates: [{
                needId: "need-api",
                sources: [
                    {
                        url: "https://example.com/docs#first",
                        reason: "Check the versioned documentation for the exact method.",
                    },
                    {
                        url: "https://example.com/docs#second",
                        reason: "Check whether the second anchor contains a distinct contract.",
                    },
                    {
                        url: "http://example.com/not-https?token=private",
                        reason: "Audit a candidate that does not satisfy the HTTPS policy.",
                    },
                ],
            }],
            fetchImpl,
        });

        expect(result.sources).toHaveLength(1);
        expect(result.telemetry).toMatchObject({
            sourceAttempts: 3,
            sourceAccepted: 1,
            sourceRejected: 2,
            sourceInvalid: 1,
            sourceDeduplicated: 1,
        });
        expect(fetchImpl).toHaveBeenCalledOnce();
        expect(result.outcomes).toEqual([
            expect.objectContaining({
                reason: "Check the versioned documentation for the exact method.",
                status: "fetched",
                url: "https://example.com/docs",
                canonicalUrl: "https://example.com/docs",
            }),
            expect.objectContaining({
                reason: "Check whether the second anchor contains a distinct contract.",
                status: "rejected",
                rejectionCode: "duplicate",
                url: "https://example.com/docs",
            }),
            expect.objectContaining({
                reason: "Audit a candidate that does not satisfy the HTTPS policy.",
                status: "rejected",
                rejectionCode: "invalid_url",
                url: "http://example.com/not-https",
            }),
        ]);
    });
});
