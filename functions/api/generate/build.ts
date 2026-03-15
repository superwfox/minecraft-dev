import { getDefaultBranchSha, createBranch, createBlob, createTree, createCommitAndUpdateRef, triggerWorkflow, findRunByBranch } from "../../_lib/github";

interface Env {
    GITHUB_PAT: string;
    TASKS: KVNamespace;
}

export const onRequestPost: PagesFunction<Env> = async (context) => {
    const { taskId } = await context.request.json() as any;
    const token = context.env.GITHUB_PAT;
    if (!token) return new Response("GITHUB_PAT not configured", { status: 500 });

    const raw = await context.env.TASKS.get(taskId);
    if (!raw) return new Response("Task not found", { status: 404 });
    const state = JSON.parse(raw);

    state.status = "uploading";
    state.logs.push("正在上传文件到 GitHub...");

    try {
        const { sha } = await getDefaultBranchSha(token);
        const branch = `build-${taskId}`;
        await createBranch(token, sha, branch);
        state.buildBranch = branch;
        state.logs.push(`已创建临时分支 ${branch}`);

        const treeFiles: { path: string; blobSha: string }[] = [];
        for (const file of state.generatedFiles) {
            const blobSha = await createBlob(token, file.content);
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

        return new Response(JSON.stringify({ buildBranch: branch, runId }), {
            headers: { "Content-Type": "application/json" },
        });
    } catch (e: any) {
        state.status = "error";
        state.error = e.message;
        state.logs.push("❌ 构建启动失败: " + e.message);
        await context.env.TASKS.put(taskId, JSON.stringify(state), { expirationTtl: 3600 });
        return new Response(JSON.stringify({ error: e.message }), { status: 500 });
    }
};
