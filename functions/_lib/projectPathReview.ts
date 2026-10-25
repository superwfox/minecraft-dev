import { nodePath, planItemForNode, type ProjectTree, type TreePath } from "./projectTree";
import { checkNodeContract } from "./projectTreeContract";
import type { PlanFileItem } from "./prompts";

export interface PathReview {
    pathId: string; fingerprint: string; passed: boolean; summary: string;
    steps: { id: string; passed: boolean; detail: string }[];
}
export interface PathCheck {
    pathId: string; status: "pending" | "failed" | "passed";
    staticStatus: "pending" | "failed" | "passed"; compileStatus: "pending" | "failed" | "passed";
    summary: string; steps: PathReview["steps"];
}
export interface PathReviewState {
    tree?: ProjectTree; generatedFiles?: { path: string; content: string }[];
    pathReviews?: Record<string, PathReview>; sourceFingerprint?: string;
    clarifyRounds?: unknown[];
    compileCheck?: { fingerprint: string; status: "pending" | "passed" | "failed"; headSha: string; runId?: number };
}
export async function sourceFingerprint(state: PathReviewState): Promise<string> {
    const files = [...(state.generatedFiles ?? [])].sort((a, b) => a.path.localeCompare(b.path));
    const input = JSON.stringify([state.tree?.lockedRevision, state.tree?.paths ?? [], files.map(file => [file.path, file.content])]);
    const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(input));
    return [...new Uint8Array(digest)].map(byte => byte.toString(16).padStart(2, "0")).join("");
}
export function publicPathChecks(state: PathReviewState): Record<string, PathCheck> {
    return Object.fromEntries((state.tree?.paths ?? []).map(path => {
        const review = state.pathReviews?.[path.id];
        const current = !!state.sourceFingerprint && review?.fingerprint === state.sourceFingerprint;
        const staticStatus = current ? review.passed ? "passed" : "failed" : "pending";
        const compileStatus = state.sourceFingerprint && state.compileCheck?.fingerprint === state.sourceFingerprint ? state.compileCheck.status : "pending";
        const status = staticStatus === "failed" || compileStatus === "failed" ? "failed" : staticStatus === "passed" && compileStatus === "passed" ? "passed" : "pending";
        return [path.id, { pathId: path.id, status, staticStatus, compileStatus, summary: current ? review.summary : "等待按需求路径静态审查", steps: current ? review.steps : [] } satisfies PathCheck];
    }));
}
export function pathReviewFiles(tree: ProjectTree, path: TreePath) {
    const ids = new Set(path.nodes.flatMap(step => step.fileIds));
    const visit = (id: string) => {
        const node = tree.nodes.find(node => node.id === id);
        for (const dependency of node?.depends ?? []) if (!ids.has(dependency)) { ids.add(dependency); visit(dependency); }
    };
    for (const id of [...ids]) visit(id);
    // Inspect Main registration and resources without pulling unrelated Main dependencies into this route.
    for (const node of tree.nodes) if (node.origin === "system" || node.moduleId === "_resources") ids.add(node.id);
    return tree.nodes.filter(node => ids.has(node.id));
}
export function pathReviewPrompt(state: PathReviewState, path: TreePath, userPrompt: string) {
    const tree = state.tree!;
    const nodes = pathReviewFiles(tree, path);
    const files = nodes.map(node => ({ id: node.id, path: nodePath(tree, node), content: state.generatedFiles?.find(file => file.path === nodePath(tree, node))?.content ?? "" }));
    if (files.some(file => !file.content.trim())) throw new Error("路径审查所需文件尚未生成");
    return {
        system: "你是 Minecraft 插件的静态代码审查员。仅检查给定需求路径，不模拟玩家、不声称运行游戏或编译。沿步骤检查 Main/事件/命令注册、触发条件、调用参数与返回值、条件分支、共享状态、资源配置、调度与生命周期清理、最终结果。必须阅读实现，不能只凭类名或方法存在判定通过。仅输出 JSON：{\"passed\":boolean,\"summary\":\"简短结论和具体问题\",\"steps\":[{\"id\":\"步骤id\",\"passed\":boolean,\"detail\":\"实现证据或具体问题，含文件/方法\"}]}。steps 必须恰好覆盖此路径的所有步骤；发现断链或缺失证据时 passed=false，不编造运行证据。",
        user: `原始需求：${userPrompt}\n用户已确认的澄清决策：${JSON.stringify(state.clarifyRounds ?? [])}\n\n路径与顺序：${JSON.stringify(path)}\n\n全树职责与契约：${JSON.stringify(tree.nodes.map(node => ({ id: node.id, responsibility: node.responsibility, contract: node.contract })))}\n\n关联文件完整源码：\n${files.map(file => `--- ${file.id}: ${file.path}\n${file.content}`).join("\n\n")}`,
    };
}
export function parsePathReview(raw: string, state: PathReviewState, path: TreePath): PathReview {
    const value = JSON.parse(raw.replace(/^```[\w]*\s*/, "").replace(/\s*```$/, ""));
    if (typeof value.passed !== "boolean" || typeof value.summary !== "string" || !Array.isArray(value.steps) || value.steps.length !== path.nodes.length) throw new Error("路径审查返回了不完整的检查结果");
    const ids = new Set<string>();
    const steps = value.steps.map((step: unknown) => {
        const item = step as { id?: string; passed?: boolean; detail?: string };
        if (!path.nodes.some(node => node.id === item.id) || ids.has(item.id!) || typeof item.passed !== "boolean" || typeof item.detail !== "string" || !item.detail.trim()) throw new Error("路径审查步骤与当前路径不一致");
        ids.add(item.id!);
        return { id: item.id!, passed: item.passed, detail: item.detail.slice(0, 1200) };
    });
    const contractFailures = pathReviewFiles(state.tree!, path).flatMap(node => {
        const content = state.generatedFiles?.find(file => file.path === nodePath(state.tree!, node))?.content ?? "";
        return checkNodeContract(state.tree!, node, content).items.filter(item => !item.ok).map(item => `${node.id}: ${item.label}`);
    });
    return { pathId: path.id, fingerprint: state.sourceFingerprint!, passed: value.passed && steps.every(step => step.passed) && !contractFailures.length, summary: (contractFailures.length ? `契约未满足：${contractFailures.join("；")}` : value.summary).slice(0, 2000), steps };
}
export const MAX_PATH_REPAIR_ATTEMPTS = 1;
type QueueState = PathReviewState & {
    buckets: PlanFileItem[][]; fileStatuses: Record<string, string>; generationCheckpoints: Record<string, unknown>; currentBucket: number;
    pathRepair?: { bucketIndex: number; files: string[] } | null; pathRepairAttempts?: number;
};
export function activePathRepair(state: QueueState): number | undefined {
    const repair = state.pathRepair;
    return repair && repair.files.some(file => state.fileStatuses?.[file] !== "done") ? repair.bucketIndex : undefined;
}
/** Queues one bounded rework round for files implicated by failed static path reviews of the current source. */
export function queuePathRepair(state: QueueState): number | undefined {
    const active = activePathRepair(state);
    if (active !== undefined) return active;
    if ((state.pathRepairAttempts ?? 0) >= MAX_PATH_REPAIR_ATTEMPTS) return;
    const tree = state.tree!;
    const contentOf = (id: string) => {
        const node = tree.nodes.find(node => node.id === id);
        return node ? state.generatedFiles?.find(file => file.path === nodePath(tree, node))?.content ?? "" : "";
    };
    const reasons = new Map<string, string[]>();
    for (const path of tree.paths ?? []) {
        const review = state.pathReviews?.[path.id];
        if (!review || review.fingerprint !== state.sourceFingerprint || review.passed) continue;
        const stepFiles = (stepId: string) => path.nodes.find(step => step.id === stepId)?.fileIds ?? [];
        const failedSteps = review.steps.filter(step => !step.passed);
        const contractNodes = pathReviewFiles(tree, path).filter(node => checkNodeContract(tree, node, contentOf(node.id)).items.some(item => !item.ok)).map(node => node.id);
        const implicated = [...failedSteps.flatMap(step => stepFiles(step.id)), ...contractNodes];
        for (const id of new Set(implicated.length ? implicated : path.nodes.flatMap(step => step.fileIds))) {
            const details = failedSteps.filter(step => stepFiles(step.id).includes(id)).map(step => `- ${path.nodes.find(node => node.id === step.id)?.title ?? step.id}：${step.detail}`);
            reasons.set(id, [...(reasons.get(id) ?? []), [`需求路径「${path.title}」静态审查未通过：${review.summary}`, ...details].join("\n")]);
        }
    }
    const nodes = tree.nodes.filter(node => reasons.has(node.id) && contentOf(node.id).trim())
        .sort((a, b) => Number(a.id === "Main") - Number(b.id === "Main"));
    if (!nodes.length) return;
    const index = state.buckets.length;
    const bucket = nodes.map((node, order) => planItemForNode(tree, node, index, order + 1));
    bucket.forEach((file, order) => {
        const node = nodes[order];
        state.fileStatuses[file.path] = "pending";
        state.generationCheckpoints[file.path] = { version: 1, path: file.path, stage: "rework", content: contentOf(node.id), reworkCount: 0, dynamicGenDone: true, dynamicFiles: [], dynamicIndex: 0, lastReason: reasons.get(node.id)!.join("\n\n").slice(0, 2000) };
    });
    state.buckets.push(bucket);
    state.currentBucket = index;
    state.pathRepair = { bucketIndex: index, files: bucket.map(file => file.path) };
    state.pathRepairAttempts = (state.pathRepairAttempts ?? 0) + 1;
    return index;
}
export function queuePathReview(state: PathReviewState & { buckets: PlanFileItem[][]; fileStatuses: Record<string, string>; generationCheckpoints: Record<string, unknown>; currentBucket: number }): number | undefined {
    const pending = (state.tree?.paths ?? []).some(path => state.pathReviews?.[path.id]?.fingerprint !== state.sourceFingerprint);
    if (!pending) return;
    const main = state.tree!.nodes.find(node => node.id === "Main")!;
    const path = nodePath(state.tree!, main);
    const checkpoint = state.generationCheckpoints[path] as { stage?: string } | undefined;
    if (checkpoint?.stage === "path_review") return state.currentBucket;
    const index = state.buckets.length;
    state.buckets.push([planItemForNode(state.tree!, main, index, 1)]);
    state.currentBucket = index;
    state.fileStatuses[path] = "generating";
    state.generationCheckpoints[path] = { version: 1, path, stage: "path_review", content: state.generatedFiles!.find(file => file.path === path)!.content, reworkCount: 0, dynamicGenDone: false, dynamicFiles: [], dynamicIndex: 0, lastReason: "" };
    return index;
}
