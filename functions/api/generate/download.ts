import { downloadArtifact, deleteBranch } from "../../_lib/github";
import { getOwnedTask } from "../../_lib/taskStore";

interface Env {
    GITHUB_PAT: string;
    TASKS: KVNamespace;
}

export const onRequestGet: PagesFunction<Env> = async (context) => {
    const uid: string = (context.data as any)?.uid || "";
    const url = new URL(context.request.url);
    const taskId = url.searchParams.get("taskId");
    if (!taskId) return new Response("Missing taskId", { status: 400 });

    const token = context.env.GITHUB_PAT;
    const raw = await getOwnedTask(context.env, taskId, uid);
    if (!raw) return new Response("Task not found", { status: 404 });
    const state = JSON.parse(raw);

    const revisionId = url.searchParams.get("revisionId");
    if (revisionId && revisionId !== (state.revisionId || "initial")) return new Response("工程版本已更新，请从本地历史下载原版本产物", { status: 409 });
    if (state.status !== "done") return new Response("当前版本尚未构建成功", { status: 409 });

    if (!state.artifactId) return new Response("Artifact not ready", { status: 409 });

    try {
        const resp = await downloadArtifact(token, state.artifactId);

        if (state.buildBranch) {
            deleteBranch(token, state.buildBranch).catch(() => { });
        }

        return new Response(resp.body, {
            headers: {
                "Content-Type": "application/zip",
                "Content-Disposition": `attachment; filename="${state.projectName || "plugin"}.zip"`,
                "X-Project-Revision": state.revisionId || "initial",
            },
        });
    } catch (e: any) {
        return new Response(JSON.stringify({ error: e.message }), { status: 500 });
    }
};
