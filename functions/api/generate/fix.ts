import { buildFixPrompt } from "../../_lib/prompts";
import type { FileSummary } from "../../_lib/prompts";
import { getRunJobs, getJobLogs } from "../../_lib/github";
import { accumulateCosts, type UsageBreakdown, type UsageCostEntry } from "../../_lib/quota";
import { resolveLLM, type LLMProvider } from "../../_lib/llm";
import { buildDiagnosticKnowledgeNeeds } from "../../_lib/learning/assessment";
import { loadKnowledgeContext, mergeKnowledgeUsed, recordKnowledgeContextUsage } from "../../_lib/learning/context";
import { evaluateKnowledgeUsage } from "../../_lib/learning/store";
import type { KnowledgeNeed } from "../../_lib/learning/types";
import {
    acquireTaskOperationLease,
    getOwnedTask,
    markTaskQuotaExhausted,
    putTaskState,
    putTaskWithOperationLease,
    releaseTaskOperationLease,
    renewTaskOperationLease,
    type TaskOperationLeaseMode,
} from "../../_lib/taskStore";
import { normalizePomRepositories } from "../../_lib/pomGuard";
import {
    buildApiContractContext,
    findKnownApiIssues,
    partitionKnowledgeNeedsByApiContracts,
} from "../../_lib/apiContracts";
import {
    compareDiagnostics,
    diagnosticsFingerprint,
    errorLogExcerpt,
    formatDiagnostics,
    parseBuildDiagnostics,
    rollbackCandidates,
    type BuildDiagnostic,
    type DiagnosticProgress,
} from "../../_lib/buildDiagnostics";
import {
    REPAIR_LEASE_RENEW_INTERVAL_MS,
    REPAIR_RECOVERY_LEASE_MS,
} from "../../_lib/buildRepairRecovery";

interface Env {
    DB?: D1Database;
    DEEPSEEK_API_KEY: string;
    GITHUB_PAT: string;
    TASKS: KVNamespace;
}

interface AICallResult { content: string; model: string; usage?: UsageBreakdown; }

interface PendingKnowledgeUsage {
    knowledgeId: string;
    stage: string;
    path: string;
    diagnosticBefore: string;
}

const FIX_IDLE_MS = 120000; // 空闲超时:连续这么久没字节才 abort（推理在持续吐 delta，慢但活着不误杀）
const MAX_REPAIR_ATTEMPTS = 3;
const REPAIR_LEASE_RENEW_TIMEOUT_MS = 10_000;
const REPAIR_LEASE_LOCAL_SAFETY_MS = 2_000;

class RepairLeaseLostError extends Error {
    constructor() {
        super("Repair lease lost");
        this.name = "RepairLeaseLostError";
    }
}

async function callAIStream(
    llm: LLMProvider, system: string, user: string,
    writer: WritableStreamDefaultWriter<Uint8Array>, encoder: TextEncoder,
    parentSignal?: AbortSignal,
): Promise<AICallResult> {
    const model = llm.modelFor("pro");
    const body = {
        model,
        stream: true,
        stream_options: { include_usage: true },
        reasoning_effort: "high",
        thinking: { type: "enabled" },
        messages: [{ role: "system", content: system }, { role: "user", content: user }],
    };

    // 空闲超时:每收到一块数据就续命(arm),只掐真正断死的连接，不误杀慢而活着的长思考。
    const ctrl = new AbortController();
    const abortFromParent = () => ctrl.abort();
    if (parentSignal?.aborted) abortFromParent();
    else parentSignal?.addEventListener("abort", abortFromParent, { once: true });
    let idle: any;
    const arm = () => { clearTimeout(idle); idle = setTimeout(() => ctrl.abort(), FIX_IDLE_MS); };
    arm();
    try {
        const resp = await fetch(llm.url, {
            method: "POST",
            headers: { "Content-Type": "application/json", Authorization: `Bearer ${llm.apiKey}` },
            body: JSON.stringify(body),
            signal: ctrl.signal,
        });
        if (!resp.ok) throw new Error(await resp.text());

        const reader = resp.body!.getReader();
        const decoder = new TextDecoder();
        let full = "";
        let buffer = "";
        let usage: UsageBreakdown | undefined;

        while (true) {
            const { done, value } = await reader.read();
            if (done) break;
            arm();
            buffer += decoder.decode(value, { stream: true });
            const lines = buffer.split("\n");
            buffer = lines.pop()!;

            for (const line of lines) {
                const trimmed = line.trim();
                if (!trimmed.startsWith("data:")) continue;
                const payload = trimmed.slice(5).trim();
                if (payload === "[DONE]") continue;
                try {
                    const chunk = JSON.parse(payload);
                    const delta = chunk.choices?.[0]?.delta?.content;
                    if (delta) {
                        full += delta;
                        await writer.write(encoder.encode(`data: ${JSON.stringify({ type: "delta", content: delta })}\n\n`));
                    }
                    if (chunk.usage) usage = chunk.usage;
                } catch { /* skip */ }
            }
        }
        return { content: full, model, usage };
    } finally {
        clearTimeout(idle);
        parentSignal?.removeEventListener("abort", abortFromParent);
    }
}

function stripFences(raw: string): string {
    return raw.replace(/^```[\w]*\n?/, "").replace(/\n?```$/, "");
}

function sseEvent(encoder: TextEncoder, data: any): Uint8Array {
    return encoder.encode(`data: ${JSON.stringify(data)}\n\n`);
}

function extractSummaries(generatedFiles: any[]): FileSummary[] {
    return generatedFiles.map((f: any) => {
        const s: FileSummary = { path: f.path };
        if (f.apiSummary) Object.assign(s, f.apiSummary);
        return s;
    });
}

function sameContent(a: string, b: string): boolean {
    const normalize = (value: string) => value.replace(/\r\n/g, "\n").trim();
    return normalize(a) === normalize(b);
}

function matchesPath(filePath: string, diagnosticPath: string): boolean {
    return filePath === diagnosticPath || filePath.endsWith(diagnosticPath) || diagnosticPath.endsWith(filePath);
}

function knowledgeOutcomeForPath(
    previous: BuildDiagnostic[],
    current: BuildDiagnostic[],
    filePath: string,
): "resolved" | "persisted" | "introduced" {
    const before = previous.filter((item) => matchesPath(filePath, item.path));
    const after = current.filter((item) => matchesPath(filePath, item.path));
    const beforeKeys = new Set(before.map((item) => item.key));
    if (after.some((item) => !beforeKeys.has(item.key))) return "introduced";
    if (after.some((item) => beforeKeys.has(item.key))) return "persisted";
    return "resolved";
}

async function evaluatePendingKnowledgeUsage(
    env: Env,
    taskId: string,
    snapshot: { diagnostics: BuildDiagnostic[]; knowledgeUsage?: PendingKnowledgeUsage[] },
    diagnostics: BuildDiagnostic[],
    diagnosticAfter: string,
): Promise<void> {
    if (!env.DB || !snapshot.knowledgeUsage?.length) return;
    try {
        await Promise.all(snapshot.knowledgeUsage.map((usage) => evaluateKnowledgeUsage(env, {
            knowledgeId: usage.knowledgeId,
            generationTaskId: taskId,
            stage: usage.stage,
            diagnosticBefore: usage.diagnosticBefore,
            diagnosticAfter,
            outcome: knowledgeOutcomeForPath(snapshot.diagnostics, diagnostics, usage.path),
        })));
    } catch (error) {
        console.warn("knowledge usage evaluation failed", error);
    }
}

function progressSummary(progress: DiagnosticProgress | null, rolledBackFiles: string[]): string {
    if (!progress) return "首次修复：逐条处理当前诊断。";
    const parts = [
        `上轮已解决 ${progress.resolved.length} 条`,
        `仍存在 ${progress.persisted.length} 条`,
        `新增 ${progress.introduced.length} 条`,
    ];
    if (rolledBackFiles.length) parts.push(`已回滚无收益文件：${rolledBackFiles.join(", ")}`);
    return parts.join("；") + "。仍存在的诊断必须优先消除，不得重新引入已解决问题。";
}

export const onRequestPost: PagesFunction<Env> = async (context) => {
    const body = await context.request.json() as any;
    const taskId = body.taskId as string;
    const mode: "diagnose" | "repair" | "inspect" = body.mode === "diagnose"
        ? "diagnose"
        : body.mode === "inspect" ? "inspect" : "repair";
    const token = context.env.GITHUB_PAT;
    const uid: string = (context.data as any)?.uid || "";

    const raw = await getOwnedTask(context.env, taskId, uid);
    if (!raw) return new Response("Task not found", { status: 404 });
    let state = JSON.parse(raw);

    if (mode === "repair" && state.quotaExhausted) {
        return new Response(JSON.stringify({ error: "本月额度已用尽", code: "QUOTA_EXHAUSTED" }), {
            status: 402, headers: { "Content-Type": "application/json" },
        });
    }

    if (!state.runId) {
        return new Response(JSON.stringify({ error: "No build run to fix" }), {
            status: 400, headers: { "Content-Type": "application/json" },
        });
    }

    // diagnose/inspect 只抓取并结构化构建日志，不应依赖模型配置或剩余额度。
    const llm: LLMProvider | null = mode === "repair" ? await resolveLLM(context) : null;
    const repairLeaseToken = mode === "repair" ? `repair:${crypto.randomUUID()}` : "";
    let repairLeaseMode: TaskOperationLeaseMode | null = null;
    let repairLeaseReleased = false;
    let repairLeaseLost = false;
    let repairLeaseValidUntil = 0;
    let repairLeaseExpiryTimer: ReturnType<typeof setTimeout> | undefined;
    const repairAbort = new AbortController();
    const clearRepairLeaseExpiryTimer = () => {
        if (repairLeaseExpiryTimer === undefined) return;
        clearTimeout(repairLeaseExpiryTimer);
        repairLeaseExpiryTimer = undefined;
    };
    const markRepairLeaseLost = () => {
        if (repairLeaseLost) return;
        repairLeaseLost = true;
        clearRepairLeaseExpiryTimer();
        repairAbort.abort();
    };
    const armRepairLeaseExpiry = (leaseStartedAt: number) => {
        repairLeaseValidUntil = leaseStartedAt
            + REPAIR_RECOVERY_LEASE_MS
            - REPAIR_LEASE_LOCAL_SAFETY_MS;
        clearRepairLeaseExpiryTimer();
        const remainingMs = repairLeaseValidUntil - Date.now();
        if (remainingMs <= 0) {
            markRepairLeaseLost();
            return;
        }
        repairLeaseExpiryTimer = setTimeout(markRepairLeaseLost, remainingMs);
    };
    const releaseRepairLease = async () => {
        if (!repairLeaseMode || repairLeaseReleased) return;
        const released = await releaseTaskOperationLease(
            context.env,
            taskId,
            uid,
            repairLeaseToken,
            repairLeaseMode,
        );
        if (released) {
            repairLeaseReleased = true;
            clearRepairLeaseExpiryTimer();
        } else {
            markRepairLeaseLost();
        }
    };

    if (mode === "repair") {
        const leaseStartedAt = Date.now();
        try {
            repairLeaseMode = await acquireTaskOperationLease(
                context.env,
                taskId,
                uid,
                repairLeaseToken,
                REPAIR_RECOVERY_LEASE_MS,
            );
        } catch (error) {
            console.warn("repair lease acquisition failed", error);
            return new Response(JSON.stringify({
                error: "自动修复状态存储暂不可用，请稍后重试",
                code: "REPAIR_STORE_UNAVAILABLE",
            }), {
                status: 503,
                headers: { "Content-Type": "application/json", "Retry-After": "2" },
            });
        }
        if (!repairLeaseMode) {
            return new Response(JSON.stringify({
                error: "Repair is already in progress",
                code: "REPAIR_IN_PROGRESS",
            }), {
                status: 409,
                headers: { "Content-Type": "application/json", "Retry-After": "2" },
            });
        }
        armRepairLeaseExpiry(leaseStartedAt);

        let latestRaw: string | null = null;
        try {
            latestRaw = await getOwnedTask(context.env, taskId, uid);
        } catch (error) {
            console.warn("repair state reload failed", error);
        }
        if (!latestRaw) {
            await releaseRepairLease().catch((error) => console.warn("repair lease release failed", error));
            return new Response("Task state unavailable", { status: 503 });
        }
        try {
            state = JSON.parse(latestRaw);
        } catch (error) {
            console.warn("repair state parse failed", error);
            await releaseRepairLease().catch((releaseError) => console.warn("repair lease release failed", releaseError));
            return new Response("Task state unavailable", { status: 503 });
        }
        if (state.quotaExhausted) {
            await releaseRepairLease().catch((error) => console.warn("repair lease release failed", error));
            return new Response(JSON.stringify({ error: "本月额度已用尽", code: "QUOTA_EXHAUSTED" }), {
                status: 402, headers: { "Content-Type": "application/json" },
            });
        }
        if (!state.runId) {
            await releaseRepairLease().catch((error) => console.warn("repair lease release failed", error));
            return new Response(JSON.stringify({ error: "No build run to fix" }), {
                status: 400, headers: { "Content-Type": "application/json" },
            });
        }

        state.status = "repairing";
        state.repairStartedAt = Date.now();
        state.error = null;
        let committed = false;
        try {
            committed = await putTaskWithOperationLease(
                context.env,
                taskId,
                JSON.stringify(state),
                repairLeaseToken,
                repairLeaseMode,
                3600,
                uid,
            );
        } catch (error) {
            console.warn("repair state initialization failed", error);
        }
        if (!committed) {
            markRepairLeaseLost();
            await releaseRepairLease().catch((error) => console.warn("repair lease release failed", error));
            return new Response(JSON.stringify({
                error: "自动修复执行权已失效，请恢复任务状态",
                code: "REPAIR_LEASE_LOST",
            }), {
                status: 409,
                headers: { "Content-Type": "application/json", "Retry-After": "2" },
            });
        }
    }

    let repairLeaseRenewTimer: ReturnType<typeof setInterval> | undefined;
    let repairLeaseRenewal: Promise<void> | null = null;
    let repairLeaseRenewalStopped = false;
    const assertRepairLease = () => {
        if (mode !== "repair") return;
        if (repairLeaseValidUntil > 0 && Date.now() >= repairLeaseValidUntil) {
            markRepairLeaseLost();
        }
        if (!repairLeaseMode
            || repairLeaseLost
            || repairLeaseReleased
            || repairAbort.signal.aborted) {
            throw new RepairLeaseLostError();
        }
    };
    const renewRepairLease = () => {
        if (repairLeaseRenewalStopped
            || !repairLeaseMode
            || repairLeaseReleased
            || repairLeaseLost
            || repairLeaseRenewal) return;
        const renewalStartedAt = Date.now();
        let renewalTimedOut = false;
        let timeoutId: ReturnType<typeof setTimeout> | undefined;
        const renewalRequest = renewTaskOperationLease(
            context.env,
            taskId,
            uid,
            repairLeaseToken,
            REPAIR_RECOVERY_LEASE_MS,
        );
        const lateRenewalCleanup = renewalRequest.then(async (renewed) => {
            if (!renewalTimedOut || !renewed) return;
            await releaseRepairLease();
        }).catch((error) => {
            if (renewalTimedOut) console.warn("late repair lease renewal cleanup failed", error);
        });
        context.waitUntil(lateRenewalCleanup);
        const timeout = new Promise<boolean>((resolve) => {
            timeoutId = setTimeout(() => {
                renewalTimedOut = true;
                resolve(false);
            }, REPAIR_LEASE_RENEW_TIMEOUT_MS);
        });
        repairLeaseRenewal = Promise.race([renewalRequest, timeout]).then((renewed) => {
            if (!renewed) {
                markRepairLeaseLost();
                return;
            }
            armRepairLeaseExpiry(renewalStartedAt);
        }).catch((error) => {
            console.warn("repair lease renewal failed", error);
            markRepairLeaseLost();
        }).finally(() => {
            if (timeoutId !== undefined) clearTimeout(timeoutId);
            repairLeaseRenewal = null;
        });
    };
    const stopRepairLeaseRenewal = async () => {
        repairLeaseRenewalStopped = true;
        if (repairLeaseRenewTimer !== undefined) {
            clearInterval(repairLeaseRenewTimer);
            repairLeaseRenewTimer = undefined;
        }
        const pendingRenewal = repairLeaseRenewal;
        if (pendingRenewal) await pendingRenewal;
    };
    const persistState = async (releaseLease = false) => {
        if (mode !== "repair") {
            await putTaskState(context.env, taskId, state, 3600, uid);
            return;
        }
        assertRepairLease();
        if (releaseLease) {
            await stopRepairLeaseRenewal();
            assertRepairLease();
        }
        let committed = false;
        try {
            committed = await putTaskWithOperationLease(
                context.env,
                taskId,
                JSON.stringify(state),
                repairLeaseToken,
                repairLeaseMode!,
                3600,
                uid,
                releaseLease,
            );
        } catch (error) {
            console.warn("repair state commit failed", error);
        }
        if (!committed) {
            markRepairLeaseLost();
            throw new RepairLeaseLostError();
        }
        if (releaseLease) {
            repairLeaseReleased = true;
            clearRepairLeaseExpiryTimer();
        }
    };

    const pendingUsage: UsageCostEntry[] = [];
    let chargeFlushed = false;
    const charge = async (r: AICallResult) => {
        assertRepairLease();
        if (!llm || llm.byok || !uid || !r.usage) return; // BYOK 自带 key：跳过计费
        pendingUsage.push({ model: r.model, usage: r.usage });
    };
    const flushCharge = async () => {
        if (chargeFlushed || !llm || llm.byok || !uid || pendingUsage.length === 0) return;
        assertRepairLease();
        chargeFlushed = true;
        const cost = await accumulateCosts(context.env, uid, taskId, pendingUsage.splice(0));
        assertRepairLease();
        state.totalCost = cost.total;
        state.consumedQuota = cost.consumed;
        if (cost.outOfQuota) {
            state.quotaExhausted = true;
            await markTaskQuotaExhausted(context.env, taskId, uid);
            assertRepairLease();
        }
    };

    let stream: TransformStream<Uint8Array>;
    try {
        stream = new TransformStream<Uint8Array>();
    } catch (error) {
        await releaseRepairLease().catch((releaseError) => console.warn("repair lease release failed", releaseError));
        throw error;
    }
    const { readable, writable } = stream;
    const encoder = new TextEncoder();
    const writer = writable.getWriter();
    if (mode === "repair") {
        repairLeaseRenewTimer = setInterval(renewRepairLease, REPAIR_LEASE_RENEW_INTERVAL_MS);
    }

    const process = (async () => {
        // 心跳:拉日志 + 推理首 token 前那段静默期每 12s 写一个,避免被 CF 因长静默切断连接。
        const heartbeat = setInterval(() => {
            writer.write(sseEvent(encoder, { type: "heartbeat", t: Date.now() })).catch(() => { });
        }, 12000);
        try {
            // Fetch build log
            await writer.write(sseEvent(encoder, { type: "log", msg: "▸ 正在获取构建错误日志..." }));
            state.logs.push("▸ 正在获取构建错误日志...");

            const jobs = await getRunJobs(token, state.runId);
            assertRepairLease();
            const failedJob = jobs.find(j => j.conclusion === "failure") ?? jobs[0];
            if (!failedJob) throw new Error("未找到构建 Job");

            const fullLog = await getJobLogs(token, failedJob.id);
            assertRepairLease();
            const errorSection = errorLogExcerpt(fullLog);
            const diagnostics = parseBuildDiagnostics(fullLog);
            const fingerprint = diagnosticsFingerprint(diagnostics);

            if (!diagnostics.length) {
                const reason = "未能从构建日志提取可处理的编译或依赖诊断";
                state.status = "error";
                state.error = reason;
                state.logs.push(`! ${reason}`);
                await persistState(true);
                await writer.write(sseEvent(encoder, { type: "log", msg: `! ${reason}` }));
                await writer.write(sseEvent(encoder, { type: "result", fixed: 0, changed: 0, reason }));
                await writer.write(encoder.encode("data: [DONE]\n\n"));
                return;
            }

            await writer.write(sseEvent(encoder, { type: "log", msg: `▸ 已提取 ${diagnostics.length} 条构建诊断` }));

            const pendingSnapshot = state.pendingFixSnapshot as {
                attempt: number;
                runId: number;
                diagnostics: BuildDiagnostic[];
                changedFiles: string[];
                files: { path: string; content: string; apiSummary?: any }[];
                knowledgeUsage?: PendingKnowledgeUsage[];
            } | undefined;
            state.fixKnowledgeNeeds = buildDiagnosticKnowledgeNeeds({
                diagnostics,
                previousDiagnostics: pendingSnapshot?.diagnostics,
                coreType: state.coreType,
                mcVersion: state.version,
                projectPackage: state.packageName,
                externalDeps: state.grade?.vector?.external_deps ?? [],
            });
            state.fixDiagnosticsFingerprint = fingerprint;

            if (mode === "diagnose") {
                state.lastBuildDiagnostics = diagnostics;
                const msg = state.fixKnowledgeNeeds.length
                    ? `▸ 已识别 ${state.fixKnowledgeNeeds.length} 个可查证的公开技术缺口`
                    : "▸ 当前诊断没有可安全联网查证的公开知识缺口";
                state.logs.push(msg);
                await persistState(true);
                await writer.write(sseEvent(encoder, { type: "log", msg }));
                await writer.write(sseEvent(encoder, {
                    type: "result",
                    diagnosed: true,
                    fingerprint,
                    diagnostics,
                    knowledgeNeeds: state.fixKnowledgeNeeds.length,
                }));
                await writer.write(encoder.encode("data: [DONE]\n\n"));
                return;
            }

            const progress = pendingSnapshot
                ? compareDiagnostics(pendingSnapshot.diagnostics, diagnostics)
                : null;
            const rolledBackFiles = pendingSnapshot
                ? rollbackCandidates(pendingSnapshot.diagnostics, diagnostics, pendingSnapshot.changedFiles)
                : [];

            if (rolledBackFiles.length && pendingSnapshot) {
                for (const snapshot of pendingSnapshot.files) {
                    if (!rolledBackFiles.includes(snapshot.path)) continue;
                    const fileEntry = state.generatedFiles.find((file: any) => file.path === snapshot.path);
                    if (fileEntry) {
                        fileEntry.content = snapshot.content;
                        fileEntry.apiSummary = snapshot.apiSummary ?? null;
                    }
                }
                const msg = `↶ 已回滚 ${rolledBackFiles.length} 个未解决旧错误的改动: ${rolledBackFiles.map((path: string) => path.split("/").pop()).join(", ")}`;
                state.logs.push(msg);
                await writer.write(sseEvent(encoder, { type: "log", msg }));
            }

            if (pendingSnapshot && progress) {
                assertRepairLease();
                context.waitUntil(evaluatePendingKnowledgeUsage(
                    context.env,
                    taskId,
                    pendingSnapshot,
                    diagnostics,
                    fingerprint,
                ));
                state.fixStagnation = progress.resolved.length > 0 ? 0 : (Number(state.fixStagnation) || 0) + 1;
                const history = Array.isArray(state.buildFixHistory) ? state.buildFixHistory : [];
                for (let i = history.length - 1; i >= 0; i--) {
                    if (history[i]?.attempt === pendingSnapshot.attempt && !history[i]?.evaluatedRunId) {
                        history[i] = {
                            ...history[i],
                            evaluatedRunId: state.runId,
                            progress,
                            rolledBackFiles,
                            status: progress.status,
                        };
                        break;
                    }
                }
                state.buildFixHistory = history.slice(-6);
                const msg = `▸ 上轮结果：已解决 ${progress.resolved.length} 条，仍存在 ${progress.persisted.length} 条，新增 ${progress.introduced.length} 条`;
                state.logs.push(msg);
                await writer.write(sseEvent(encoder, { type: "log", msg }));
                delete state.pendingFixSnapshot;
            }

            const effectiveDiagnostics = diagnostics.filter((item) => !rolledBackFiles.includes(item.path));
            if (pendingSnapshot && rolledBackFiles.length) {
                for (const item of pendingSnapshot.diagnostics) {
                    if (rolledBackFiles.includes(item.path) && !effectiveDiagnostics.some((existing) => existing.key === item.key)) {
                        effectiveDiagnostics.push(item);
                    }
                }
            }

            state.lastBuildDiagnostics = diagnostics;
            state.lastBuildProgress = progress;
            await writer.write(sseEvent(encoder, {
                type: "debug",
                scope: "build-fix",
                msg: "fix:diagnostics",
                mode,
                runId: state.runId,
                fingerprint,
                diagnostics,
                progress,
                rolledBackFiles,
                errorSection: errorSection.slice(0, 8000),
            }));

            if (mode === "inspect") {
                const reason = `最终构建仍有 ${diagnostics.length} 条诊断，已停止自动修复`;
                state.status = "error";
                state.error = reason;
                state.logs.push(`× ${reason}`);
                await persistState(true);
                await writer.write(sseEvent(encoder, { type: "log", msg: `× ${reason}` }));
                await writer.write(sseEvent(encoder, {
                    type: "result", fixed: 0, changed: 0, inspected: true, reason,
                    fingerprint, diagnostics, progress, rolledBackFiles,
                }));
                await writer.write(encoder.encode("data: [DONE]\n\n"));
                return;
            }

            if (!llm) throw new Error("自动修复模型未配置");

            if ((Number(state.repairAttempts) || 0) >= MAX_REPAIR_ATTEMPTS) {
                const reason = `已达到 ${MAX_REPAIR_ATTEMPTS} 轮自动修复上限`;
                state.status = "error";
                state.error = reason;
                state.logs.push(`! ${reason}`);
                await persistState(true);
                await writer.write(sseEvent(encoder, { type: "result", fixed: 0, changed: 0, reason, diagnostics, progress, rolledBackFiles }));
                await writer.write(encoder.encode("data: [DONE]\n\n"));
                return;
            }

            if ((Number(state.fixStagnation) || 0) >= 2) {
                const reason = "连续两轮未解决任何旧诊断，已提前停止重复返工";
                state.status = "error";
                state.error = reason;
                state.logs.push(`! ${reason}`);
                await persistState(true);
                await writer.write(sseEvent(encoder, { type: "result", fixed: 0, changed: 0, reason, diagnostics, progress, rolledBackFiles }));
                await writer.write(encoder.encode("data: [DONE]\n\n"));
                return;
            }

            const filesToFix = state.generatedFiles
                .filter((file: any) => effectiveDiagnostics.some((item) => matchesPath(file.path, item.path)))
                .map((file: any) => file.path as string);

            if (filesToFix.length === 0) {
                const reason = "无法从构建诊断定位可安全修改的文件，已停止自动修复；不会重写全部 Java 文件";
                state.status = "error";
                state.error = reason;
                state.logs.push(`! ${reason}`);
                await persistState(true);
                await writer.write(sseEvent(encoder, {
                    type: "debug", scope: "build-fix", msg: "fix:no-target", fingerprint,
                    parsedPaths: effectiveDiagnostics.map((item) => item.path),
                }));
                await writer.write(sseEvent(encoder, { type: "result", fixed: 0, changed: 0, reason, fingerprint, diagnostics, progress }));
                await writer.write(encoder.encode("data: [DONE]\n\n"));
                return;
            }

            await writer.write(sseEvent(encoder, { type: "log", msg: `▸ 需要修改 ${filesToFix.length} 个文件: ${filesToFix.map((file) => file.split("/").pop()).join(", ")}` }));
            const summaries = extractSummaries(state.generatedFiles);
            const ctx = {
                projectName: state.projectName,
                packageName: state.packageName,
                coreType: state.coreType,
                version: state.version,
                javaVersion: state.javaVersion,
            };
            const apiContractInput = {
                coreType: state.coreType,
                version: state.version,
                externalDeps: state.grade?.vector?.external_deps ?? [],
                generatedFiles: state.generatedFiles,
            };
            const apiContractCtx = buildApiContractContext(apiContractInput);
            const rawFixNeeds = (Array.isArray(state.fixKnowledgeNeeds) ? state.fixKnowledgeNeeds : []) as KnowledgeNeed[];
            const fixNeeds = partitionKnowledgeNeedsByApiContracts(apiContractInput, rawFixNeeds).uncovered;
            const knowledge = await loadKnowledgeContext({
                env: context.env,
                needs: fixNeeds,
                maxCharacters: 6_000,
                title: "构建修复已验证公共技术知识",
            });
            assertRepairLease();
            state.knowledgeUsed = mergeKnowledgeUsed(state.knowledgeUsed, knowledge.used);
            const appliedKnowledgeUsage: PendingKnowledgeUsage[] = [];
            const markKnowledgeApplied = (filePath: string) => {
                assertRepairLease();
                const stage = `fix:${filePath}`;
                context.waitUntil(recordKnowledgeContextUsage({
                    env: context.env,
                    items: knowledge.used,
                    generationTaskId: taskId,
                    stage,
                    diagnosticBefore: fingerprint,
                }));
                for (const item of knowledge.used) {
                    if (appliedKnowledgeUsage.some((usage) => usage.knowledgeId === item.knowledgeId && usage.stage === stage)) continue;
                    appliedKnowledgeUsage.push({
                        knowledgeId: item.knowledgeId,
                        stage,
                        path: filePath,
                        diagnosticBefore: fingerprint,
                    });
                }
            };

            const repairAttempt = (Number(state.repairAttempts) || 0) + 1;
            state.repairAttempts = repairAttempt;
            let changedCount = 0;
            const changedFiles: string[] = [];
            const skippedFiles: string[] = [];
            const beforeContents = new Map<string, string>();
            const beforeSummaries = new Map<string, any>();
            for (const filePath of filesToFix) {
                assertRepairLease();
                const fileEntry = state.generatedFiles.find((f: any) => f.path === filePath);
                if (!fileEntry) continue;

                const fileDiagnostics = effectiveDiagnostics.filter((item) => matchesPath(filePath, item.path));
                const fileErrors = formatDiagnostics(fileDiagnostics.length ? fileDiagnostics : effectiveDiagnostics);

                await writer.write(sseEvent(encoder, { type: "phase", phase: "fixing", file: filePath }));
                await writer.write(sseEvent(encoder, { type: "log", msg: `↻ 生成 ${filePath} 的修正候选...` }));
                state.logs.push(`↻ 生成 ${filePath} 的修正候选...`);

                // The common legacy Paper repository failure is deterministic and
                // should not spend an LLM call or risk rewriting unrelated XML.
                if (filePath.endsWith("pom.xml")) {
                    const normalized = normalizePomRepositories(fileEntry.content);
                    if (normalized.changes.length > 0) {
                        beforeContents.set(filePath, fileEntry.content);
                        beforeSummaries.set(filePath, fileEntry.apiSummary ?? null);
                        fileEntry.content = normalized.content;
                        fileEntry.apiSummary = null;
                        changedCount++;
                        changedFiles.push(filePath);
                        const msg = `● pom.xml 已确定性修正：${normalized.changes.join("；")}`;
                        await writer.write(sseEvent(encoder, { type: "log", msg }));
                        state.logs.push(msg);
                        continue;
                    }
                }

                const fileRole = state.plan?.find((f: any) => f.path === filePath)?.role
                    ?? fileEntry.role
                    ?? "";
                const prompt = buildFixPrompt(
                    filePath,
                    fileEntry.content,
                    fileErrors,
                    ctx,
                    summaries,
                    fileRole,
                    apiContractCtx,
                    knowledge.context,
                    progressSummary(progress, rolledBackFiles),
                );
                let fixRes = await callAIStream(
                    llm,
                    prompt.system,
                    prompt.user,
                    writer,
                    encoder,
                    repairAbort.signal,
                );
                markKnowledgeApplied(filePath);
                await charge(fixRes);
                let fixedContent = stripFences(fixRes.content).trim();
                let knownApiIssues = findKnownApiIssues(apiContractInput, fixedContent);
                if (knownApiIssues.length) {
                    const retryMsg = `! 修正候选仍违反 API 契约，正在重新生成：${knownApiIssues.join("；")}`;
                    state.logs.push(retryMsg);
                    await writer.write(sseEvent(encoder, { type: "log", msg: retryMsg }));
                    const retryPrompt = buildFixPrompt(
                        filePath,
                        fixedContent,
                        fileErrors,
                        ctx,
                        summaries,
                        fileRole,
                        apiContractCtx,
                        knowledge.context,
                        `${progressSummary(progress, rolledBackFiles)}\n上一候选仍有确定性问题：${knownApiIssues.join("；")}`,
                    );
                    fixRes = await callAIStream(
                        llm,
                        retryPrompt.system,
                        retryPrompt.user,
                        writer,
                        encoder,
                        repairAbort.signal,
                    );
                    markKnowledgeApplied(filePath);
                    await charge(fixRes);
                    fixedContent = stripFences(fixRes.content).trim();
                    knownApiIssues = findKnownApiIssues(apiContractInput, fixedContent);
                }

                if (knownApiIssues.length) {
                    skippedFiles.push(filePath);
                    const reason = `候选仍违反 API 契约：${knownApiIssues.join("；")}`;
                    await writer.write(sseEvent(encoder, { type: "log", msg: `! ${filePath.split("/").pop()} 未应用：${reason}` }));
                    await writer.write(sseEvent(encoder, {
                        type: "debug", scope: "build-fix", msg: "fix:contract-rejected",
                        path: filePath, reason, responseLength: fixRes.content.length,
                    }));
                    continue;
                }

                if (!fixedContent || sameContent(fixedContent, fileEntry.content)) {
                    skippedFiles.push(filePath);
                    const reason = !fixedContent ? "模型返回空内容" : "返回内容与原文件相同";
                    await writer.write(sseEvent(encoder, { type: "log", msg: `! ${filePath.split("/").pop()} 未产生修改：${reason}` }));
                    await writer.write(sseEvent(encoder, {
                        type: "debug", scope: "build-fix", msg: "fix:unchanged",
                        path: filePath, reason, responseLength: fixRes.content.length,
                    }));
                    continue;
                }

                beforeContents.set(filePath, fileEntry.content);
                beforeSummaries.set(filePath, fileEntry.apiSummary ?? null);
                fileEntry.content = fixedContent;
                fileEntry.apiSummary = null;
                changedCount++;
                changedFiles.push(filePath);

                const msg = `● ${filePath.split("/").pop()} 已生成修正候选，等待重新构建验证`;
                await writer.write(sseEvent(encoder, { type: "log", msg }));
                state.logs.push(msg);
            }

            const failedRunId = state.runId;
            const history = Array.isArray(state.buildFixHistory) ? state.buildFixHistory : [];
            history.push({
                attempt: repairAttempt,
                runId: failedRunId,
                fingerprint: diagnosticsFingerprint(effectiveDiagnostics),
                diagnostics: effectiveDiagnostics,
                targets: filesToFix,
                changedFiles,
                skippedFiles,
                status: changedCount > 0 ? "pending" : "no-change",
                at: Date.now(),
            });
            state.buildFixHistory = history.slice(-6);

            await writer.write(sseEvent(encoder, {
                type: "debug", scope: "build-fix", msg: "fix:result",
                repairAttempt, fingerprint, targets: filesToFix, changedFiles, skippedFiles,
                changedCount, diagnostics, progress, rolledBackFiles,
            }));

            if (changedCount === 0) {
                const reason = "自动修复未产生任何有效文件变更，已停止重新构建";
                state.status = "error";
                state.error = reason;
                state.logs.push(`! ${reason}`);
                await flushCharge();
                await persistState(true);
                await writer.write(sseEvent(encoder, { type: "log", msg: `! ${reason}` }));
                await writer.write(sseEvent(encoder, {
                    type: "result", fixed: 0, changed: 0, reason, repairAttempt,
                    fingerprint, skippedFiles, diagnostics, progress, rolledBackFiles,
                }));
                await writer.write(encoder.encode("data: [DONE]\n\n"));
                return;
            }

            state.pendingFixSnapshot = {
                attempt: repairAttempt,
                runId: failedRunId,
                diagnostics: effectiveDiagnostics,
                changedFiles,
                files: changedFiles.map((path) => ({
                    path,
                    content: beforeContents.get(path) ?? "",
                    apiSummary: beforeSummaries.get(path) ?? null,
                })),
                knowledgeUsage: appliedKnowledgeUsage.filter((usage) => changedFiles.includes(usage.path)),
                at: Date.now(),
            };

            // Clear error state so rebuild can proceed
            state.status = "fixed";
            state.error = null;
            delete state.runId;
            delete state.buildBranch;
            const changedMsg = `● 已修改 ${changedCount} 个文件，等待重新构建验证`;
            state.logs.push(changedMsg);
            await flushCharge();
            await persistState(true);

            await writer.write(sseEvent(encoder, { type: "log", msg: changedMsg }));
            await writer.write(sseEvent(encoder, {
                type: "result",
                fixed: changedCount,
                changed: changedCount,
                verified: false,
                repairAttempt,
                fingerprint,
                changedFiles,
                skippedFiles,
                diagnostics,
                progress,
                rolledBackFiles,
            }));
            await writer.write(encoder.encode("data: [DONE]\n\n"));
        } catch (e: any) {
            let leaseFailure = e instanceof RepairLeaseLostError || repairLeaseLost;
            if (!leaseFailure) {
                const message = e?.message || "自动修复失败";
                state.status = "error";
                state.error = message;
                state.logs.push(`× 修复失败: ${message}`);
                try { await flushCharge(); } catch { /* 计费失败不覆盖原始修复异常 */ }
                try {
                    await persistState(true);
                } catch (persistError) {
                    leaseFailure = persistError instanceof RepairLeaseLostError || repairLeaseLost;
                }
            }

            const message = leaseFailure
                ? "自动修复执行权已失效，正在恢复最新任务状态"
                : e?.message || "自动修复失败";
            await writer.write(sseEvent(encoder, { type: "log", msg: `× ${message}` }));
            await writer.write(sseEvent(encoder, {
                type: "result",
                fixed: 0,
                changed: 0,
                error: message,
                ...(leaseFailure ? { code: "REPAIR_LEASE_LOST" } : {}),
            }));
            await writer.write(encoder.encode("data: [DONE]\n\n"));
        } finally {
            clearInterval(heartbeat);
            await stopRepairLeaseRenewal().catch(() => { });
            if (!repairLeaseLost && !repairLeaseReleased) {
                try { await flushCharge(); } catch { /* 计费失败不覆盖修复结果 */ }
            }
            await releaseRepairLease().catch((error) => console.warn("repair lease release failed", error));
            clearRepairLeaseExpiryTimer();
            try { await writer.close(); } catch { /* 客户端可能已断开 */ }
        }
    })();

    context.waitUntil(process);

    return new Response(readable, {
        headers: {
            "Content-Type": "text/event-stream",
            "Cache-Control": "no-cache",
            "Connection": "keep-alive",
        },
    });
};
