export const PRODUCT_REPO = "superwfox/minecraft-dev";
export const BUILD_REPO = "superwfox/minecraft-dev-workflow";
export async function projectGit(token: string, repo: string, path: string, method = "GET", body?: unknown): Promise<any> {
    if (!token) throw new Error("尚未配置此操作所需的仓库凭据");
    const response = await fetch(`https://api.github.com/repos/${repo}${path}`, { method, signal: AbortSignal.timeout(30000), headers: { Authorization: `Bearer ${token}`, Accept: "application/vnd.github+json", "Content-Type": "application/json", "User-Agent": "tahai-projects" }, ...(body === undefined ? {} : { body: JSON.stringify(body) }) });
    if (!response.ok) { const error: any = new Error(`仓库操作失败（${response.status}）`); error.status = response.status; throw error; }
    return response.status === 204 ? null : response.json();
}
export function base64Text(text: string) {
    const bytes = new TextEncoder().encode(text); let binary = "";
    for (let index = 0; index < bytes.length; index += 8192) binary += String.fromCharCode(...bytes.subarray(index, index + 8192));
    return btoa(binary);
}
/** Orphan data commits contain no executable workflows and never inherit application code. */
export async function publishDataCommit(token: string, repo: string, branch: string, blobs: { path: string; sha: string }[], message: string) {
    const tree = await projectGit(token, repo, "/git/trees", "POST", { tree: blobs.map(file => ({ path: file.path, sha: file.sha, type: "blob", mode: "100644" })) });
    const commit = await projectGit(token, repo, "/git/commits", "POST", { message, tree: tree.sha, parents: [] });
    // One ref per submission avoids overwriting another user's files. Main is never touched.
    try { await projectGit(token, repo, "/git/refs", "POST", { ref: `refs/heads/${branch}`, sha: commit.sha }); }
    catch (error) {
        if ((error as any).status !== 422) throw error;
        const existing = await projectGit(token, repo, `/git/ref/heads/${branch}`);
        if (!existing.object?.sha) throw error;
        return existing.object.sha as string;
    }
    return commit.sha as string;
}
