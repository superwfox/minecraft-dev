// 用写权限 token 在社区 skill 仓库（superwfox/TAHAI-Skills）自动开 PR（skill 上传入口用）。
// 与 _lib/github.ts（构建流水线，操作 minecraft-dev-workflow 仓库）互不相干：本文件只动 skill 库。
//
// 流程：取 main → 建 tree(inline content) → commit → 新分支 → 开 PR。
// PR 正文 @mention 贡献者，使其收到通知并订阅该 PR（合并/关闭/评论都会邮件提醒）。

import { REPO } from "./skills";

interface PrEnv {
    GITHUB_PR_TOKEN?: string;
}

export interface SubmitFile {
    path: string;       // skill 内相对路径（如 brief.json / api/OneBotApi.md）
    content: string;
}
export interface PrAuthor {
    uid: string;
    login: string;      // GitHub 用户名，用于 @mention
}

const BASE_BRANCH = "main";

async function ghJson(env: PrEnv, path: string, method: string, body?: any): Promise<any> {
    const r = await fetch(`https://api.github.com/repos/${REPO}${path}`, {
        method,
        headers: {
            "User-Agent": "tahai-skills",
            "Accept": "application/vnd.github+json",
            "Authorization": `Bearer ${env.GITHUB_PR_TOKEN}`,
            "Content-Type": "application/json",
        },
        body: body ? JSON.stringify(body) : undefined,
    });
    const text = await r.text();
    if (!r.ok) throw new Error(`GitHub ${method} ${path} → ${r.status}: ${text.slice(0, 300)}`);
    return text ? JSON.parse(text) : {};
}

/**
 * 把一个 skill 的文件以新分支 + PR 形式提交到仓库（不碰 main）。
 * 文件落到仓库的 `<skillId>/<相对路径>`。
 */
export async function createSkillPR(
    env: PrEnv,
    opts: { skillId: string; files: SubmitFile[]; author: PrAuthor; note?: string },
): Promise<{ prUrl: string; branch: string }> {
    if (!env.GITHUB_PR_TOKEN) throw new Error("未配置 GITHUB_PR_TOKEN（仓库写权限 token）");
    const { skillId, files, author, note } = opts;

    // 1) base 分支最新 commit
    const ref = await ghJson(env, `/git/ref/heads/${BASE_BRANCH}`, "GET");
    const baseSha = ref?.object?.sha;
    if (!baseSha) throw new Error("无法获取 main 分支 sha");

    // 2) tree（inline content，path 前缀加 skillId/）
    const tree = files.map((f) => ({
        path: `${skillId}/${f.path}`,
        mode: "100644",
        type: "blob",
        content: f.content,
    }));
    const newTree = await ghJson(env, `/git/trees`, "POST", { base_tree: baseSha, tree });

    // 3) commit
    const commit = await ghJson(env, `/git/commits`, "POST", {
        message: `skill: ${skillId} (via TAHAI upload by @${author.login})`,
        tree: newTree.sha,
        parents: [baseSha],
    });

    // 4) 新分支
    const branch = `skill-submit-${skillId}-${Date.now()}`;
    await ghJson(env, `/git/refs`, "POST", { ref: `refs/heads/${branch}`, sha: commit.sha });

    // 5) PR（@mention 贡献者）
    const body = [
        `经 TAHAI 上传入口自动生成的 skill 提交。`,
        ``,
        `提交者：@${author.login}（uid: ${author.uid}）`,
        note ? `\n备注：${note}\n` : ``,
        `> @${author.login} 此 PR 合并 / 关闭 / 评论时你都会收到 GitHub 通知。`,
    ].join("\n");
    const pr = await ghJson(env, `/pulls`, "POST", {
        title: `skill: ${skillId} by @${author.login}`,
        head: branch,
        base: BASE_BRANCH,
        body,
    });

    return { prUrl: pr.html_url, branch };
}
