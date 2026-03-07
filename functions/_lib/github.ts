const REPO = "superwfox/minecraft-dev-workflow";
const BASE = `https://api.github.com/repos/${REPO}`;

function gh(token: string) {
    return {
        Authorization: `Bearer ${token}`,
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
    const q = afterTime ? `&created=>${afterTime}` : "";
    const resp = await ghFetch(token, `/actions/workflows/maven.yml/runs?branch=${branch}${q}&per_page=1`);
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

export async function deleteBranch(token: string, name: string) {
    try {
        await ghFetch(token, `/git/refs/heads/${name}`, { method: "DELETE" });
    } catch { /* branch may already be deleted */ }
}
