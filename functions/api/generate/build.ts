import { getDefaultBranchSha, createBranch, createBlob, createTree, createCommitAndUpdateRef, triggerWorkflow, findRunByBranch, deleteBranch } from "../../_lib/github";
import { MAX_BUILDS_PER_USER_DAY, userBuildCheck, userBuildIncrement } from "../../_lib/quota";
import { checkPom } from "../../_lib/pomGuard";

interface Env {
    GITHUB_PAT: string;
    TASKS: KVNamespace;
}

const TAHAI_TAG = "§eTAHAI§r";

/**
 * 在 plugin.yml 的 author 字段后追加 TAHAI 水印。幂等：已含 TAHAI 直接返回。
 * 注意：只改上传到 GitHub 的内容，不改 KV state.generatedFiles[*].content，
 * 这样用户在 IDE 文件树里看到的还是干净版本。
 */
function injectTahaiAuthor(content: string): string {
    if (content.includes("TAHAI")) return content;

    // 单值 author: <name>
    if (/^author\s*:/m.test(content)) {
        return content.replace(/^author\s*:\s*(.*)$/m, (_, val) => {
            const inner = String(val).trim().replace(/^["']|["']$/g, "");
            return inner ? `author: "${inner} ${TAHAI_TAG}"` : `author: "${TAHAI_TAG}"`;
        });
    }
    // 数组 authors: [a, b]
    if (/^authors\s*:\s*\[/m.test(content)) {
        return content.replace(/^authors\s*:\s*\[(.*?)\]/m, (_, list) => {
            const trimmed = String(list).trim();
            return `authors: [${trimmed}${trimmed ? ", " : ""}"${TAHAI_TAG}"]`;
        });
    }
    // block 风格 authors: 然后下方列表
    if (/^authors\s*:\s*$/m.test(content)) {
        return content.replace(/^authors\s*:\s*$/m, `authors:\n  - "${TAHAI_TAG}"`);
    }
    // 完全没有
    return content.trimEnd() + `\nauthor: "${TAHAI_TAG}"\n`;
}

function json(obj: any, status: number): Response {
    return new Response(JSON.stringify(obj), { status, headers: { "Content-Type": "application/json" } });
}

export const onRequestPost: PagesFunction<Env> = async (context) => {
    const { taskId, files: incomingFiles, meta } = await context.request.json() as any;
    const token = context.env.GITHUB_PAT;
    if (!token) return json({ error: "GITHUB_PAT not configured" }, 500);

    const uid: string | undefined = (context.data as any)?.uid;

    const hasIncoming = Array.isArray(incomingFiles) && incomingFiles.length > 0;

    const raw = await context.env.TASKS.get(taskId);
    let state: any;
    if (raw) {
        state = JSON.parse(raw);
    } else if (hasIncoming) {
        // KV 任务已过期（TTL 1h），但 IDE 本地仍有文件：凭 IDE 传来的内容 + 元数据重建任务。
        // javaVersion 是触发 workflow 的必需项，缺失时默认 21（现代 Paper）。
        state = {
            taskId,
            status: "uploading",
            javaVersion: meta?.javaVersion || "21",
            projectName: meta?.projectName || "",
            packageName: meta?.packageName || "",
            coreType: meta?.coreType || "Paper",
            version: meta?.version || "",
            generatedFiles: [],
            logs: ["▸ 服务端任务已过期，使用 IDE 本地内容重建构建"],
        };
    } else {
        return json({ error: "Task not found", code: "TASK_NOT_FOUND" }, 404);
    }

    // 从 IDE 触发的构建：用浏览器侧最新内容完整覆盖 KV 里的 generatedFiles
    // （chat 阶段定型后，用户在 IDE 改动 / 新增 / 删除 不会回写后端；
    // 这里走 build 才回写一次，保证产物 == IDE 内容）
    if (hasIncoming) {
        const prevByPath = new Map<string, any>(
            (state.generatedFiles || []).map((f: any) => [f.path, f]),
        );
        state.generatedFiles = incomingFiles.map((f: any) => {
            const prev = prevByPath.get(f.path);
            return {
                path: f.path,
                content: String(f.content ?? ""),
                apiSummary: prev?.apiSummary ?? null,
            };
        });
        // 元数据兜底：KV 存在但缺 javaVersion 时也用 meta 补
        if (meta?.javaVersion && !state.javaVersion) state.javaVersion = meta.javaVersion;
        if (meta?.projectName && !state.projectName) state.projectName = meta.projectName;
        if (meta?.packageName && !state.packageName) state.packageName = meta.packageName;
        state.logs.push(`▸ 已从 IDE 同步 ${state.generatedFiles.length} 个文件到构建仓`);
    }

    // ── (a) 单用户每日构建上限：粗粒度防刷 ──
    let userBuildUsed = 0;
    if (uid) {
        const r = await userBuildCheck(context.env.TASKS, uid);
        if (!r.ok) {
            return json({ error: `今日构建次数已达上限 ${MAX_BUILDS_PER_USER_DAY}`, code: "BUILD_DAY_LIMIT" }, 429);
        }
        userBuildUsed = r.used;
    }

    // ── (b) pom.xml 安全 scrub：阻断恶意 pom 在 CI 内执行任意代码 ──
    const pomFile = state.generatedFiles.find((f: any) => f.path.endsWith("pom.xml"));
    if (pomFile) {
        const r = checkPom(pomFile.content);
        if (!r.ok) {
            state.status = "error";
            state.error = r.reason;
            state.logs.push(`× 安全校验拦截：${r.reason}`);
            await context.env.TASKS.put(taskId, JSON.stringify(state), { expirationTtl: 3600 });
            return json({ error: r.reason, code: "POM_BLOCKED" }, 400);
        }
    }

    state.status = "uploading";
    state.logs.push("正在上传文件到 GitHub...");

    try {
        const { sha } = await getDefaultBranchSha(token);
        const branch = `build-${taskId}`;
        // 删除可能残留的同名分支（上次构建失败未清理 + KV 过期重建），让创建幂等
        await deleteBranch(token, branch);
        await createBranch(token, sha, branch);
        state.buildBranch = branch;
        state.logs.push(`已创建临时分支 ${branch}`);

        const treeFiles: { path: string; blobSha: string }[] = [];
        for (const file of state.generatedFiles) {
            // 上传给 GitHub 时按需修补 plugin.yml 水印；不污染 KV state
            const content = file.path.endsWith("plugin.yml")
                ? injectTahaiAuthor(file.content)
                : file.content;
            const blobSha = await createBlob(token, content);
            treeFiles.push({ path: file.path, blobSha });
            state.logs.push(`已创建 blob: ${file.path}`);
        }

        const treeSha = await createTree(token, sha, treeFiles);
        await createCommitAndUpdateRef(token, treeSha, sha, branch, `build ${taskId}: ${treeFiles.length} files`);
        state.logs.push(`已一次性提交 ${treeFiles.length} 个文件`);

        const beforeTrigger = new Date().toISOString();
        await triggerWorkflow(token, branch, state.javaVersion);
        state.logs.push("已触发 GitHub Actions 构建");

        await new Promise(r => setTimeout(r, 2000));

        const runId = await findRunByBranch(token, branch, beforeTrigger);
        if (runId) {
            state.runId = runId;
            state.logs.push(`构建 run #${runId} 已启动`);
        } else {
            state.logs.push("构建已触发，等待 run 创建...");
        }

        state.status = "building";
        await context.env.TASKS.put(taskId, JSON.stringify(state), { expirationTtl: 3600 });

        // 通过所有校验且 GitHub 提交成功后再 increment daily 计数
        if (uid) await userBuildIncrement(context.env.TASKS, uid, userBuildUsed);

        return new Response(JSON.stringify({
            buildBranch: branch,
            runId,
            projectName: state.projectName,
            packageName: state.packageName,
            javaVersion: state.javaVersion,
        }), {
            headers: { "Content-Type": "application/json" },
        });
    } catch (e: any) {
        state.status = "error";
        state.error = e.message;
        state.logs.push("× 构建启动失败: " + e.message);
        await context.env.TASKS.put(taskId, JSON.stringify(state), { expirationTtl: 3600 });
        return new Response(JSON.stringify({ error: e.message }), { status: 500 });
    }
};
