const REPO = "superwfox/minecraft-dev-workflow";
const BASE = `https://api.github.com/repos/${REPO}`;

function headers(token: string) {
    return {
        Authorization: `Bearer ${token}`,
        Accept: "application/vnd.github+json",
        "Content-Type": "application/json",
    };
}

async function ghFetch(token: string, path: string, init?: RequestInit) {
    const resp = await fetch(`${BASE}${path}`, { ...init, headers: { ...headers(token), ...init?.headers } });
    if (!resp.ok) {
        const text = await resp.text();
        throw new Error(`GitHub ${resp.status}: ${text}`);
    }
    return resp;
}

export async function getDefaultBranchSha(token: string): Promise<{ branch: string; sha: string }> {
    const repo = await (await ghFetch(token, "")).json() as any;
    const branch = repo.default_branch;
    const ref = await (await ghFetch(token, `/git/ref/heads/${branch}`)).json() as any;
    return { branch, sha: ref.object.sha };
}

export async function createBranch(token: string, sha: string, name: string) {
    await ghFetch(token, "/git/refs", {
        method: "POST",
        body: JSON.stringify({ ref: `refs/heads/${name}`, sha }),
    });
}

export async function uploadFile(token: string, branch: string, path: string, content: string) {
    const encoded = btoa(unescape(encodeURIComponent(content)));
    await ghFetch(token, `/contents/${path}`, {
        method: "PUT",
        body: JSON.stringify({ message: `add ${path}`, content: encoded, branch }),
    });
}

export async function triggerWorkflow(token: string, branch: string, javaVersion: string) {
    await ghFetch(token, "/actions/workflows/maven.yml/dispatches", {
        method: "POST",
        body: JSON.stringify({ ref: branch, inputs: { branch, java_version: javaVersion } }),
    });
}

export async function findRunByBranch(token: string, branch: string, afterTime: string): Promise<number | null> {
    const resp = await ghFetch(token, `/actions/workflows/maven.yml/runs?branch=${branch}&created=>${afterTime}&per_page=1`);
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
        headers: { Authorization: `Bearer ${token}`, Accept: "application/vnd.github+json" },
        redirect: "follow",
    });
    if (!resp.ok) throw new Error(`Download failed: ${resp.status}`);
    return resp;
}

export async function deleteBranch(token: string, name: string) {
    try {
        await ghFetch(token, `/git/refs/heads/${name}`, { method: "DELETE" });
    } catch { /* branch may already be deleted */ }
}
