import { COMPILE_EVIDENCE_MAX_BYTES, COMPILE_EVIDENCE_SCANNER_BLOB, COMPILE_EVIDENCE_STEP,
    COMPILE_EVIDENCE_WORKFLOW_BLOB, parseCompileApiEvidence, type CompileApiEvidence } from "./learning/compileApiEvidence";

const REPO = "superwfox/minecraft-dev-workflow";
const BASE = `https://api.github.com/repos/${REPO}`;

function gh(token: string) {
    return {
        ...(token ? { Authorization: `Bearer ${token}` } : {}),
        Accept: "application/vnd.github+json",
        "Content-Type": "application/json",
        "User-Agent": "mc-devtool",
    };
}

async function ghFetch(token: string, path: string, init?: RequestInit) {
    const url = `${BASE}${path}`;
    const resp = await fetch(url, {
        ...init,
        headers: { ...gh(token), ...init?.headers },
    });
    if (!resp.ok) {
        const body = await resp.text();
        throw new Error(`GitHub ${init?.method || "GET"} ${path} → ${resp.status}: ${body}`);
    }
    return resp;
}

function toBase64(text: string): string {
    const bytes = new TextEncoder().encode(text);
    let binary = "";
    for (const b of bytes) binary += String.fromCharCode(b);
    return btoa(binary);
}

export async function getDefaultBranchSha(token: string): Promise<{ branch: string; sha: string }> {
    const repo = await (await ghFetch(token, "")).json() as any;
    const branch = repo.default_branch || "main";

    try {
        const ref = await (await ghFetch(token, `/git/ref/heads/${branch}`)).json() as any;
        return { branch, sha: ref.object.sha };
    } catch {
        // 空仓库，创建初始 commit
        await ghFetch(token, "/contents/README.md", {
            method: "PUT",
            body: JSON.stringify({
                message: "init",
                content: toBase64("# minecraft-dev-workflow\nBuild repository for MC DevTool\n"),
            }),
        });
        const ref = await (await ghFetch(token, `/git/ref/heads/${branch}`)).json() as any;
        return { branch, sha: ref.object.sha };
    }
}

export async function createBranch(token: string, sha: string, name: string) {
    await ghFetch(token, "/git/refs", {
        method: "POST",
        body: JSON.stringify({ ref: `refs/heads/${name}`, sha }),
    });
}

export async function uploadFile(token: string, branch: string, path: string, content: string) {
    await ghFetch(token, `/contents/${path}`, {
        method: "PUT",
        body: JSON.stringify({ message: `add ${path}`, content: toBase64(content), branch }),
    });
}

export async function triggerWorkflow(token: string, branch: string, javaVersion: string) {
    await ghFetch(token, "/actions/workflows/maven.yml/dispatches", {
        method: "POST",
        body: JSON.stringify({ ref: branch, inputs: { branch, java_version: javaVersion } }),
    });
}

export async function findRunByBranch(token: string, branch: string, afterTime: string): Promise<number | null> {
    const params = new URLSearchParams({ branch, per_page: "1" });
    if (afterTime) params.set("created", `>${afterTime}`);
    const resp = await ghFetch(token, `/actions/workflows/maven.yml/runs?${params.toString()}`);
    const data = await resp.json() as any;
    return data.workflow_runs?.[0]?.id ?? null;
}

export async function getRunStatus(token: string, runId: number): Promise<{ status: string; conclusion: string | null }> {
    const data = await (await ghFetch(token, `/actions/runs/${runId}`)).json() as any;
    return { status: data.status, conclusion: data.conclusion };
}

export async function getArtifactInfo(token: string, runId: number): Promise<{ id: number; name: string } | null> {
    const data = await (await ghFetch(token, `/actions/runs/${runId}/artifacts`)).json() as any;
    const a = data.artifacts?.[0];
    return a ? { id: a.id, name: a.name } : null;
}

export async function downloadArtifact(token: string, artifactId: number): Promise<Response> {
    const resp = await fetch(`${BASE}/actions/artifacts/${artifactId}/zip`, {
        headers: { Authorization: `Bearer ${token}`, Accept: "application/vnd.github+json", "User-Agent": "mc-devtool" },
        redirect: "manual",
    });
    if (resp.status === 302) {
        const location = resp.headers.get("Location");
        if (!location) throw new Error("No redirect URL");
        const dl = await fetch(location);
        if (!dl.ok) throw new Error(`Download failed: ${dl.status}`);
        return dl;
    }
    if (!resp.ok) throw new Error(`Download failed: ${resp.status}`);
    return resp;
}

export async function createBlob(token: string, content: string): Promise<string> {
    const resp = await ghFetch(token, "/git/blobs", {
        method: "POST",
        body: JSON.stringify({ content: toBase64(content), encoding: "base64" }),
    });
    const data = await resp.json() as any;
    return data.sha;
}

export async function createTree(
    token: string, baseSha: string,
    files: { path: string; blobSha: string }[],
): Promise<string> {
    const tree = files.map(f => ({
        path: f.path, mode: "100644" as const, type: "blob" as const, sha: f.blobSha,
    }));
    const resp = await ghFetch(token, "/git/trees", {
        method: "POST",
        body: JSON.stringify({ base_tree: baseSha, tree }),
    });
    const data = await resp.json() as any;
    return data.sha;
}

export async function createCommitAndUpdateRef(
    token: string, treeSha: string, parentSha: string,
    branch: string, message: string,
): Promise<string> {
    const commitResp = await ghFetch(token, "/git/commits", {
        method: "POST",
        body: JSON.stringify({ message, tree: treeSha, parents: [parentSha] }),
    });
    const commit = await commitResp.json() as any;
    await ghFetch(token, `/git/refs/heads/${branch}`, {
        method: "PATCH",
        body: JSON.stringify({ sha: commit.sha }),
    });
    return commit.sha;
}

export async function getRunJobs(token: string, runId: number): Promise<{ id: number; name: string; conclusion: string | null }[]> {
    const data = await (await ghFetch(token, `/actions/runs/${runId}/jobs`)).json() as any;
    return (data.jobs ?? []).map((j: any) => ({ id: j.id, name: j.name, conclusion: j.conclusion }));
}

export async function getJobLogs(token: string, jobId: number): Promise<string> {
    const resp = await fetch(`${BASE}/actions/jobs/${jobId}/logs`, {
        headers: { Authorization: `Bearer ${token}`, Accept: "application/vnd.github+json", "User-Agent": "mc-devtool" },
        redirect: "follow",
    });
    if (!resp.ok) throw new Error(`Failed to fetch job logs: ${resp.status}`);
    return await resp.text();
}

async function boundedLogText(response: Response): Promise<string> {
    const maximum = COMPILE_EVIDENCE_MAX_BYTES + 32_768;
    if (!response.ok || Number(response.headers.get("Content-Length")) > maximum || !response.body) throw new Error("compile_evidence_log_unavailable");
    const reader = response.body.getReader(), decoder = new TextDecoder();
    let size = 0, text = "";
    try {
        while (true) {
            const chunk = await reader.read();
            if (chunk.done) break;
            size += chunk.value.byteLength;
            if (size > maximum) throw new Error("compile_evidence_log_too_large");
            text += decoder.decode(chunk.value, { stream: true });
        }
        return text + decoder.decode();
    } finally { await reader.cancel(); }
}

export async function getCompileApiEvidence(token: string, input: {
    runId: number; branch: string; headSha: string; pomHash: string; javaRelease: number;
}): Promise<CompileApiEvidence | null> {
    // Historical builds and legacy dispatch state remain task-local.
    if (!Number.isSafeInteger(input.runId) || input.runId <= 0 || !/^[a-f0-9]{40}$/.test(input.headSha || "")
        || !/^build-[A-Za-z0-9_-]{8,80}$/.test(input.branch || "")) return null;
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), 15_000);
    const init = { signal: controller.signal };
    try {
        const run: any = await (await ghFetch(token, `/actions/runs/${input.runId}`, init)).json();
        if (run.head_sha !== input.headSha || run.head_branch !== input.branch || run.event !== "workflow_dispatch"
            || run.path !== ".github/workflows/maven.yml" || run.status !== "completed"
            || !Number.isSafeInteger(run.run_attempt) || run.run_attempt < 1) return null;
        const files = await Promise.all([
            ghFetch(token, `/contents/.github/workflows/maven.yml?ref=${input.headSha}`, init).then(response => response.json() as Promise<any>),
            ghFetch(token, `/contents/tools/compile_api_evidence.py?ref=${input.headSha}`, init).then(response => response.json() as Promise<any>),
        ]);
        if (files[0].sha !== COMPILE_EVIDENCE_WORKFLOW_BLOB || files[1].sha !== COMPILE_EVIDENCE_SCANNER_BLOB) return null;
        const data: any = await (await ghFetch(token, `/actions/runs/${input.runId}/attempts/${run.run_attempt}/jobs?per_page=100`, init)).json();
        const jobs = (data.jobs ?? []).filter((job: any) => job.name === "verify" && job.head_sha === input.headSha);
        if (jobs.length !== 1 || !Array.isArray(jobs[0].steps)) return null;
        const job = jobs[0];
        const indexes = job.steps.map((step: any, index: number) => step.name === COMPILE_EVIDENCE_STEP ? index : -1).filter((index: number) => index >= 0);
        if (indexes.length !== 1) return null;
        const stepIndex = indexes[0];
        if (job.steps[stepIndex].status !== "completed" || job.steps[stepIndex].conclusion !== "success") return null;
        // Step log API takes a zero-based position, unlike the steps[].number field.
        const endpoint = `${BASE}/actions/jobs/${job.id}/steps/${stepIndex}/logs`;
        let response = await fetch(endpoint, { headers: { ...gh(token), "X-GitHub-Api-Version": "2026-03-10" }, redirect: "manual", signal: controller.signal });
        if (response.status === 302) {
            const location = response.headers.get("Location");
            if (!location || new URL(location).protocol !== "https:") return null;
            // Do not forward the GitHub token to the signed log download host.
            response = await fetch(location, { signal: controller.signal });
        }
        const log = await boundedLogText(response);
        return await parseCompileApiEvidence(log, { ...input, runAttempt: run.run_attempt,
            attestation: { workflowBlob: files[0].sha, scannerBlob: files[1].sha, jobId: job.id, stepIndex } });
    } catch { return null; }
    finally { clearTimeout(timer); }
}

export async function deleteBranch(token: string, name: string) {
    try {
        await ghFetch(token, `/git/refs/heads/${name}`, { method: "DELETE" });
    } catch { /* branch may already be deleted */ }
}
