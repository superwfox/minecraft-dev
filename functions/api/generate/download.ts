import { downloadArtifact, deleteBranch } from "../../_lib/github";
import { deleteTask, getOwnedTask } from "../../_lib/taskStore";

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

    if (!state.artifactId) return new Response("Artifact not ready", { status: 409 });

    try {
        const resp = await downloadArtifact(token, state.artifactId);

        if (state.buildBranch) {
            deleteBranch(token, state.buildBranch).catch(() => { });
        }
        context.waitUntil(deleteTask(context.env, taskId, uid).catch(() => { }));

        return new Response(resp.body, {
            headers: {
                "Content-Type": "application/zip",
                "Content-Disposition": `attachment; filename="${state.projectName || "plugin"}.zip"`,
            },
        });
    } catch (e: any) {
        return new Response(JSON.stringify({ error: e.message }), { status: 500 });
    }
};
