import { PRODUCT_REPO, projectGit } from "../../_lib/projectGithub";
import { submission, saveSubmission, lockSubmission, unlockSubmission } from "../../_lib/projectSubmission";
import { digest, redact, safeProjectPath } from "../../../shared/projectArchive";
import { feedbackBundle } from "../../../shared/feedbackBundle";
interface Env { DB: D1Database; GITHUB_FEEDBACK_TOKEN?: string; GITHUB_PR_TOKEN?: string; DEEPSEEK_API_KEY?: string; GITHUB_PAT?: string; FEEDBACK_DATA_BRANCH_READY?: string }
const json = (data: unknown, status = 200) => new Response(JSON.stringify(data), { status, headers: { "Content-Type": "application/json", "Cache-Control": "no-store" } });
const publicBranch = "feedback-data";
export const onRequestGet: PagesFunction<Env> = async context => {
    const id = new URL(context.request.url).searchParams.get("submissionId");
    if (!id) return json({ repository: PRODUCT_REPO, public: true, configured: !!(context.env.DB && (context.env.GITHUB_FEEDBACK_TOKEN || context.env.GITHUB_PR_TOKEN) && context.env.FEEDBACK_DATA_BRANCH_READY === "true") });
    if (!context.env.DB) return json({ error: "反馈服务尚未配置工程存储" }, 503);
    const row: any = await context.env.DB.prepare("SELECT state_json FROM project_submissions WHERE submission_id=? AND owner_uid=? AND kind='feedback'").bind(id, String(context.data.uid)).first();
    return row ? json(JSON.parse(row.state_json)) : json({ error: "反馈不存在" }, 404);
};
export const onRequestPost: PagesFunction<Env> = async context => {
    const uid = String(context.data.uid), token = context.env.GITHUB_FEEDBACK_TOKEN || context.env.GITHUB_PR_TOKEN || "";
    if (!context.env.DB || !token || context.env.FEEDBACK_DATA_BRANCH_READY !== "true") return json({ error: "反馈服务尚未配置：需要 D1 迁移、仓库权限，并确认 feedback-data 不触发 Pages/Actions 后设置 FEEDBACK_DATA_BRANCH_READY=true" }, 503);
    if (Number(context.request.headers.get("Content-Length")) > 32 * 1024 * 1024) return json({ error: "反馈资料超过 32 MiB" }, 413);
    let lock = "", id = "";
    try {
        const body: any = await context.request.json(); id = String(body.submissionId || "");
        if (!/^[a-zA-Z0-9_-]{16,100}$/.test(id) || body.publicConsent !== true || typeof body.description !== "string" || !body.description.trim() || body.description.length > 30000 || !Array.isArray(body.files) || body.files.length > 2500) return json({ error: "请检查反馈内容并确认公开范围" }, 400);
        const secrets = [context.request.headers.get("X-LLM-Key") || "", context.env.DEEPSEEK_API_KEY || "", token, context.env.GITHUB_PAT || ""];
        const files: any[] = []; const paths = new Set<string>(); let bytes = 0, images = 0;
        for (const file of body.files) {
            if (!safeProjectPath(file.path) || paths.has(file.path) || typeof file.content !== "string") throw new Error("附件路径或内容无效");
            paths.add(file.path); bytes += new TextEncoder().encode(file.content).byteLength;
            if (bytes > 30 * 1024 * 1024) throw new Error("反馈资料过大，请删减附件");
            if (file.encoding === "base64") {
                if (!/^images\/[a-zA-Z0-9_-]+\.(png|jpg|webp)$/.test(file.path) || ++images > 5 || file.content.length > 7 * 1024 * 1024) throw new Error("图片数量或大小超限");
                const binary = atob(file.content);
                if (!(binary.startsWith("\x89PNG\r\n\x1a\n") || binary.startsWith("\xff\xd8\xff") || binary.startsWith("RIFF") && binary.slice(8, 12) === "WEBP")) throw new Error("图片格式不支持");
                files.push(file);
            } else files.push({ path: file.path, content: redact(file.content, secrets) });
        }
        if (body.bundleVersion !== undefined && body.bundleVersion !== 2) throw new Error("反馈打包版本不支持");
        const description = redact(body.description, secrets), hash = await digest({ description, files, ...(body.bundleVersion === 2 ? { bundleVersion: 2 } : {}) });
        let item = await submission(context.env.DB, id, uid, "feedback", hash);
        if (item.state.issueUrl) return json(item.state);
        lock = await lockSubmission(context.env.DB, id, uid);
        if (!lock) return json({ error: "反馈正在提交，请稍后查询结果", code: "FEEDBACK_PENDING" }, 409);
        item = await submission(context.env.DB, id, uid, "feedback", hash);
        item.leaseToken = lock;
        item.state.blobs ??= [];
        // Existing frozen submissions keep their original protocol and attachment commit.
        const published = item.state.commit ? item.state.publishedFiles || files : body.bundleVersion === 2 ? (await feedbackBundle(files, secrets)).files : files;
        for (const file of (item.state.commit ? [] : published).filter((file: any) => file.encoding === "base64")) {
            if (item.state.blobs.some((blob: any) => blob.path === file.path)) continue;
            const blob = await projectGit(token, PRODUCT_REPO, "/git/blobs", "POST", { content: file.content, encoding: "base64" });
            item.state.blobs.push({ path: file.path, sha: blob.sha }); await saveSubmission(context.env.DB, item, uid);
        }
        if (!item.state.commit) {
            // Append-only data branch; retry a compare-and-swap race without force-pushing.
            for (let attempt = 0; attempt < 4; attempt++) {
                let parent: any = null;
                try { parent = await projectGit(token, PRODUCT_REPO, `/git/ref/heads/${publicBranch}`); } catch (error) { if ((error as any).status !== 404) throw error; }
                let baseTree: string | undefined;
                if (parent) {
                    baseTree = (await projectGit(token, PRODUCT_REPO, `/git/commits/${parent.object.sha}`)).tree.sha;
                    const prior = await projectGit(token, PRODUCT_REPO, `/git/trees/${baseTree}?recursive=1`);
                    if (prior.truncated || prior.tree?.some((file: any) => String(file.path).split("/").some((part: string) => part.toLowerCase() === ".github"))) throw new Error("feedback-data 包含工作流或无法完整核对，请先修正数据分支配置");
                }
                const tree = await projectGit(token, PRODUCT_REPO, "/git/trees", "POST", { ...(baseTree ? { base_tree: baseTree } : {}), tree: published.map((file: any) => ({ path: `${id}/${file.path}`, ...(file.encoding === "base64" ? { sha: item.state.blobs.find((blob: any) => blob.path === file.path).sha } : { content: file.content }), type: "blob", mode: "100644" })) });
                const commit = await projectGit(token, PRODUCT_REPO, "/git/commits", "POST", { message: `feedback ${id}`, tree: tree.sha, parents: parent ? [parent.object.sha] : [] });
                try {
                    await projectGit(token, PRODUCT_REPO, parent ? `/git/refs/heads/${publicBranch}` : "/git/refs", parent ? "PATCH" : "POST", parent ? { sha: commit.sha, force: false } : { ref: `refs/heads/${publicBranch}`, sha: commit.sha });
                    item.state.commit = commit.sha;
                    item.state.publishedFiles = published.map((file: any) => ({ path: file.path, ...(file.encoding ? { encoding: file.encoding } : {}) }));
                    await saveSubmission(context.env.DB, item, uid); break;
                } catch (error) { if (![409, 422].includes((error as any).status) || attempt === 3) throw error; }
            }
        }
        const marker = `tahai-feedback:${id}`;
        // Find a prior creation after a network failure before creating another Issue.
        let issue: any;
        for (let page = 1; page <= 10; page++) {
            const recent = await projectGit(token, PRODUCT_REPO, `/issues?state=all&per_page=100&page=${page}`);
            issue = recent.find((issue: any) => issue.body?.includes(`<!-- ${marker} -->`));
            if (issue || recent.length < 100) break;
        }
        if (!issue) {
            if (item.state.issueRequestedAt) return json({ error: "上次 Issue 创建结果尚未确认。请稍后重试查询，系统不会重复创建。", code: "FEEDBACK_RECONCILIATION_PENDING" }, 409);
            const base = `https://github.com/${PRODUCT_REPO}/blob/${item.state.commit}/${id}`;
            const directory = `https://github.com/${PRODUCT_REPO}/tree/${item.state.commit}/${id}`;
            const pathUrl = (path: string) => path.split("/").map(encodeURIComponent).join("/");
            const images = published.filter((file: any) => file.path.startsWith("images/")).map((file: any) => `![用户附件](${base}/${pathUrl(file.path)}?raw=true)`);
            const links = published.filter((file: any) => !file.path.startsWith("images/")).slice(0, 20).map((file: any) => `- [${file.path === "source.zip" ? "源码 ZIP" : file.path === "diagnostics.zip" ? "完整诊断 ZIP" : file.path.replace(/[\\[\]]/g, "\\$&")}](${base}/${pathUrl(file.path)}${file.path.endsWith(".zip") ? "?raw=true" : ""})`);
            links.push(`- [附件目录](${directory})`);
            const login = String(context.data.login || "");
            const author = /^[a-zA-Z0-9][a-zA-Z0-9-]{0,38}$/.test(login) ? `@${login}` : "已登录用户";
            item.state.issueRequestedAt = Date.now(); await saveSubmission(context.env.DB, item, uid);
            try { issue = await projectGit(token, PRODUCT_REPO, "/issues", "POST", { title: `[用户反馈] ${description.trim().split("\n")[0].slice(0, 90)}`, body: `<!-- ${marker} -->\n${description}\n\n公开诊断资料：\n${links.join("\n")}\n\n${images.join("\n")}\n\n反馈用户：${author}；资料长期公开保存。` }); }
            catch (error) { if ((error as any).status) { delete item.state.issueRequestedAt; await saveSubmission(context.env.DB, item, uid); } throw error; }
        }
        item.state.issueUrl = issue.html_url; item.state.issueNumber = issue.number;
        await saveSubmission(context.env.DB, item, uid); return json(item.state);
    } catch (error) { return json({ error: error instanceof Error ? error.message : "反馈提交失败，草稿已保留" }, 400); }
    finally { if (lock) await unlockSubmission(context.env.DB, id, uid, lock).catch(() => {}); }
};
