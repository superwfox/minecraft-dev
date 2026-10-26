import JSZip from "jszip";
import { BUILD_REPO, projectGit, publishDataCommit } from "../../_lib/projectGithub";
import { submission, saveSubmission, lockSubmission, unlockSubmission } from "../../_lib/projectSubmission";
import { acquireTaskOperationLease, getOwnedTask, putTaskWithOperationLease, releaseTaskOperationLease } from "../../_lib/taskStore";
import { downloadArtifact } from "../../_lib/github";
import { seedJarProject } from "../../_lib/jarProject";
import { checkpointView } from "../../_lib/projectArchive";
import { inspectJar } from "../../../shared/jarArchive";
import { digest } from "../../../shared/projectArchive";
import { journalRecorder } from "../../_lib/projectJournal";
interface Env { DB: D1Database; TASKS: KVNamespace; GITHUB_PAT: string }
const json = (data: unknown, status = 200) => new Response(JSON.stringify(data), { status, headers: { "Content-Type": "application/json", "Cache-Control": "no-store" } });
const repoInfo = async (env: Env) => { const repo = await projectGit(env.GITHUB_PAT, BUILD_REPO, ""); if (typeof repo.private !== "boolean" || typeof repo.default_branch !== "string") throw new Error("无法确定执行仓库的可见性，尚未上传"); return { repository: BUILD_REPO, private: repo.private, defaultBranch: repo.default_branch }; };
export const onRequestPost: PagesFunction<Env> = async context => {
    if (!context.env.DB) return json({ error: "请先执行工程存储迁移" }, 503);
    const uid = String(context.data.uid); let lock = "", id = "", taskId = "";
    try {
        if (Number(context.request.headers.get("Content-Length")) > 21 * 1024 * 1024) return json({ error: "JAR 超过 20 MiB" }, 413);
        const form = await context.request.formData(), file = form.get("jar"); taskId = String(form.get("taskId") || ""); id = String(form.get("submissionId") || "");
        if (!file || typeof file === "string" || !file.name.toLowerCase().endsWith(".jar") || !/^[a-zA-Z0-9_-]{16,100}$/.test(id)) return json({ error: "请选择一个有效 JAR" }, 400);
        const raw = await getOwnedTask(context.env, taskId, uid); if (!raw) return json({ error: "任务不存在", code: "TASK_NOT_FOUND" }, 404);
        const state = JSON.parse(raw);
        if (!/^(paper|spigot)$/i.test(state.coreType) || !/^[0-9]+(?:\.[0-9]+){1,3}(?:-[A-Za-z0-9.-]+)?$/.test(state.version)) return json({ error: "首版仅支持 Java Paper/Spigot 插件，请检查目标版本" }, 400);
        if (state.importSubmissionId === id) return json({ status: "ready", taskId, state: checkpointView(state) });
        if (!["clarifying", "importing"].includes(state.status) || state.tree) return json({ error: "当前任务已开始，请先完成或切换任务" }, 409);
        const repo = await repoInfo(context.env);
        if (!repo.private && form.get("publicConsent") !== "true") return json({ error: "目标仓库公开，请先确认原始 JAR 与源码的公开上传", code: "PUBLIC_UPLOAD_CONSENT" }, 409);
        await projectGit(context.env.GITHUB_PAT, BUILD_REPO, "/actions/workflows/resolve-jar.yml");
        const bytes = new Uint8Array(await file.arrayBuffer()); inspectJar(bytes);
        const hash = await digest(Array.from(new Uint8Array(await crypto.subtle.digest("SHA-256", bytes)))), identity = await digest([hash, state.coreType, state.version]);
        let item = await submission(context.env.DB, id, uid, "jar", identity);
        lock = await lockSubmission(context.env.DB, id, uid); if (!lock) return json({ error: "JAR 正在上传，请稍后查询", code: "JAR_PENDING" }, 409);
        item = await submission(context.env.DB, id, uid, "jar", identity);
        item.leaseToken = lock;
        if (!item.state.commit) {
            let binary = ""; for (let i = 0; i < bytes.length; i += 8192) binary += String.fromCharCode(...bytes.subarray(i, i + 8192));
            const blob = await projectGit(context.env.GITHUB_PAT, BUILD_REPO, "/git/blobs", "POST", { content: btoa(binary), encoding: "base64" });
            item.state = { ...item.state, taskId, coreType: state.coreType, version: state.version, inputSha256: Array.from(new Uint8Array(await crypto.subtle.digest("SHA-256", bytes)), b => b.toString(16).padStart(2, "0")).join(""), uploadedAt: Date.now(), private: repo.private };
            item.state.commit = await publishDataCommit(context.env.GITHUB_PAT, BUILD_REPO, `resolve-input-${id}`, [{ path: "input.jar", sha: blob.sha }], `ResolveJAR input ${id}`);
            await saveSubmission(context.env.DB, item, uid);
        }
        item.state.taskId = taskId;
        if (!item.state.dispatchedAt) {
            if (item.state.dispatchRequestedAt) {
                const runs = await projectGit(context.env.GITHUB_PAT, BUILD_REPO, "/actions/workflows/resolve-jar.yml/runs?event=workflow_dispatch&per_page=100");
                if (!runs.workflow_runs?.some((run: any) => run.display_title === `ResolveJAR ${id}`)) return json({ error: "上次解析启动结果尚未确认，请稍后继续查询；系统不会重复调度", code: "JAR_RECONCILIATION_PENDING" }, 409);
            } else {
                item.state.dispatchRequestedAt = Date.now(); await saveSubmission(context.env.DB, item, uid);
                try { await projectGit(context.env.GITHUB_PAT, BUILD_REPO, "/actions/workflows/resolve-jar.yml/dispatches", "POST", { ref: repo.defaultBranch, inputs: { submission_id: id, input_ref: item.state.commit, input_sha256: item.state.inputSha256, core_type: state.coreType, mc_version: state.version } }); }
                catch (error) { if ((error as any).status) { delete item.state.dispatchRequestedAt; await saveSubmission(context.env.DB, item, uid); } throw error; }
            }
            item.state.dispatchedAt = Date.now(); await saveSubmission(context.env.DB, item, uid);
        }
        else await saveSubmission(context.env.DB, item, uid);
        return json({ submissionId: id, status: "queued", repository: repo.repository });
    } catch (error) { return json({ error: (error as any)?.status === 404 ? "执行仓库尚未安装 resolve-jar.yml 工作流，请按 ref/project-lifecycle.md 配置" : error instanceof Error ? error.message : "JAR 导入失败" }, 400); }
    finally { if (lock) await unlockSubmission(context.env.DB, id, uid, lock).catch(() => {}); }
};
export const onRequestGet: PagesFunction<Env> = async context => {
    const url = new URL(context.request.url), id = url.searchParams.get("submissionId"), uid = String(context.data.uid);
    try {
        if (!id) return json(await repoInfo(context.env));
        if (!context.env.DB) return json({ error: "请先执行工程存储迁移" }, 503);
        const row: any = await context.env.DB.prepare("SELECT * FROM project_submissions WHERE submission_id=? AND owner_uid=? AND kind='jar'").bind(id, uid).first();
        if (!row) return json({ error: "导入任务不存在" }, 404);
        const item = { id, kind: "jar", hash: row.payload_hash, state: JSON.parse(row.state_json) };
        const targetId = url.searchParams.get("taskId") || item.state.taskId;
        if (targetId !== item.state.taskId) {
            const targetRaw = await getOwnedTask(context.env, targetId, uid);
            const target = targetRaw && JSON.parse(targetRaw);
            if (!target || target.coreType !== item.state.coreType || target.version !== item.state.version || target.tree && target.importSubmissionId !== id) return json({ error: "恢复后的目标工程与本次导入不一致" }, 409);
            item.state.taskId = targetId; item.state.imported = false;
        }
        if (item.state.imported) {
            const raw = await getOwnedTask(context.env, item.state.taskId, uid);
            return raw ? json({ status: "ready", taskId: item.state.taskId, state: checkpointView(JSON.parse(raw)) }) : json({ error: "导入任务已过期，请恢复本地工程" }, 404);
        }
        if (!item.state.commit || !item.state.dispatchRequestedAt) return json({ status: "upload_required" });
        const runs = await projectGit(context.env.GITHUB_PAT, BUILD_REPO, "/actions/workflows/resolve-jar.yml/runs?event=workflow_dispatch&per_page=100");
        const run = runs.workflow_runs?.find((run: any) => run.display_title === `ResolveJAR ${id}`);
        if (!run || run.status !== "completed") return json({ status: run?.status || (item.state.dispatchedAt ? "queued" : "reconciling"), runId: run?.id });
        const artifacts = await projectGit(context.env.GITHUB_PAT, BUILD_REPO, `/actions/runs/${run.id}/artifacts`);
        const artifact = artifacts.artifacts?.find((a: any) => a.name === `resolved-${id}` && !a.expired);
        if (!artifact) return json({ error: "反编译工作流未产生工程，请检查工作流诊断", runId: run.id, status: "failed" }, 422);
        const response = await downloadArtifact(context.env.GITHUB_PAT, artifact.id), reader = response.body!.getReader();
        let size = 0; const chunks: Uint8Array[] = [];
        while (true) { const chunk = await reader.read(); if (chunk.done) break; size += chunk.value.length; if (size > 24 * 1024 * 1024) { await reader.cancel(); throw new Error("解析工程制品过大"); } chunks.push(chunk.value); }
        const bytes = new Uint8Array(size); let position = 0; for (const chunk of chunks) { bytes.set(chunk, position); position += chunk.length; }
        const zip = await JSZip.loadAsync(bytes), resultFile = zip.file("resolved-project.json");
        if (!resultFile || (resultFile as any)._data?.uncompressedSize > 18 * 1024 * 1024) throw new Error("解析工程制品不完整或过大");
        const result = JSON.parse(await resultFile.async("string"));
        if (result.inputSha256 !== item.state.inputSha256) throw new Error("解析结果与原始 JAR 指纹不一致");
        const taskId = item.state.taskId, lease = `jar:${id}:${crypto.randomUUID()}`, mode = await acquireTaskOperationLease(context.env, taskId, uid, lease, 120000);
        if (!mode) return json({ error: "任务忙，请稍后继续" }, 409);
        let released = false;
        try {
            const raw = await getOwnedTask(context.env, taskId, uid); if (!raw) return json({ error: "任务已过期" }, 404);
            const state = JSON.parse(raw);
            if (state.importSubmissionId !== id) {
                if (state.tree || !["clarifying", "importing"].includes(state.status)) return json({ error: "原任务已开始其他工作，解析结果仍保留；请切回对应导入工程后继续。", code: "JAR_TARGET_CHANGED" }, 409);
                result.report = { ...result.report, origin: { repository: BUILD_REPO, inputCommit: item.state.commit, inputSha256: item.state.inputSha256, runId: run.id, workflowHeadSha: run.head_sha, artifactId: artifact.id } };
                const project = seedJarProject(result, state.coreType, state.version);
                Object.assign(state, project, project.tree.project, { status: "tree_confirming", treeSession: null, clarifyDone: true, projectOrigin: "jar", importSubmissionId: id });
                state.logs.push(`JAR 已还原；基线编译：${result.report?.baseline?.status || "unknown"}；阻塞项：${(result.report?.blockers || []).join("；")}`);
                const committed = await putTaskWithOperationLease(context.env, taskId, JSON.stringify(state), lease, mode, 3600, uid, true);
                if (!committed) throw new Error("任务写入冲突，请稍后重试"); released = true;
                context.data.journalTaskId = taskId;
                await journalRecorder(context as any).record("jar.import", { submissionId: id, ...result.report.origin, report: result.report, files: result.files.map((file: any) => ({ path: file.path, encoding: file.encoding || "text" })) });
            }
            item.state.imported = true; item.state.runId = run.id; await saveSubmission(context.env.DB, item, uid);
            return json({ status: "ready", taskId, state: checkpointView(state) });
        } finally { if (!released) await releaseTaskOperationLease(context.env, taskId, uid, lease, mode).catch(() => {}); }
    } catch (error) { return json({ error: error instanceof Error ? error.message : "导入状态读取失败" }, 400); }
};
