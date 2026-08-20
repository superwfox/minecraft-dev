import type { Ref } from "vue";
import type { ChatBlock } from "./chatState";
import {
    chatBlocks,
    streamTick,
    createDraftBlock,
    appendToDraft,
    combineUserMessages,
} from "./chatState";
import { streamGetInfo, consistChat, precheckPrompt } from "../api/deepseek";
import type { ChatMsg, StreamCallbacks, StreamHandle } from "../api/deepseek";
import type { PrecheckGuidance } from "./promptFormatting";
import { authState, fetchMe } from "./auth";
import { startGenerate } from "./generateHandler";
import { MINECRAFT_VERSIONS } from "./minecraftVersions";
import {actionMessageMetaForError} from "./actionMessages";
import type {ActionMessageKind} from "./actionMessages";

const CORE_TYPES = ["PAPER", "BUKKIT", "SPIGOT", "FORGE", "FABRIC"];
const VERSIONS = MINECRAFT_VERSIONS;

export { CORE_TYPES, VERSIONS };

const fallbackHistory: ChatMsg[] = [];

export type RebuildInfo = { prompt: string; coreType: string; version: string } | null;
let _rebuildInfo: RebuildInfo = null;
export function getRebuildInfo(): RebuildInfo { return _rebuildInfo; }
export function clearRebuildInfo() { _rebuildInfo = null; }

type NeedSelectHandler = (block: ChatBlock, missing: ("coreType" | "version")[]) => void;
type IncompleteHandler = (original: string, guidance: PrecheckGuidance) => void;

function setDraftError(
    draft: ChatBlock,
    message: string,
    error?: unknown,
    kind?: ActionMessageKind,
) {
    draft.phase = "error";
    draft.error = message;
    draft.errorMeta = actionMessageMetaForError(error, kind);
}

// analyze(需求分析)阶段的 abort controller；运行版本阻止取消后的陈旧响应回写。
let analyzeAbort: AbortController | null = null;
let fallbackHandle: StreamHandle | null = null;
let fallbackBlock: ChatBlock | null = null;
let analyzeRunRevision = 0;
type AnalyzeRun = {controller: AbortController; revision: number};

function markDraftInterrupted(block: ChatBlock | null | undefined) {
    if (!block?.draft || !["analyzing", "fetching", "rendering", "streaming"].includes(block.phase)) return;
    block.phase = "interrupted";
    block.error = undefined;
    block.errorMeta = undefined;
    block.streamText = "";
    block.rawMsg = "";
    block.thinkingText = "";
    block.outputText = "";
    block.streamStage = "";
    streamTick.value++;
}

export function interruptAnalyze(centerText?: Ref<string>) {
    const block = fallbackBlock
        || [...chatBlocks].reverse().find(item =>
            item.draft && ["analyzing", "fetching", "rendering", "streaming"].includes(item.phase));
    analyzeRunRevision++;
    analyzeAbort?.abort(new DOMException("User interrupted", "AbortError"));
    analyzeAbort = null;
    const handle = fallbackHandle;
    fallbackHandle = null;
    fallbackBlock = null;
    handle?.stop();
    markDraftInterrupted(block);
    if (centerText) centerText.value = "已中断";
}

function beginAnalyzeRun(): AnalyzeRun {
    analyzeAbort?.abort(new DOMException("Superseded", "AbortError"));
    fallbackHandle?.stop();
    fallbackHandle = null;
    fallbackBlock = null;
    const controller = new AbortController();
    analyzeAbort = controller;
    return {controller, revision: ++analyzeRunRevision};
}

function isAnalyzeRunCurrent(revision: number): boolean {
    return revision === analyzeRunRevision;
}

function assertAnalyzeRun(revision: number, controller: AbortController) {
    if (isAnalyzeRunCurrent(revision) && !controller.signal.aborted) return;
    throw new DOMException("Analysis interrupted", "AbortError");
}

function releaseAnalyzeController(controller: AbortController) {
    if (analyzeAbort === controller) analyzeAbort = null;
}

function beginDraftStream(block: ChatBlock, stage: ChatBlock["streamStage"]) {
    block.streamStage = stage;
    block.thinkingText = "";
    block.outputText = "";
    block.rawMsg = "";
}

function draftStreamCallbacks(block: ChatBlock, revision: number): StreamCallbacks {
    return {
        onThinking(chunk) {
            if (!isAnalyzeRunCurrent(revision) || block.phase === "interrupted") return;
            block.thinkingText += chunk;
            streamTick.value++;
        },
        onOutput(chunk) {
            if (!isAnalyzeRunCurrent(revision) || block.phase === "interrupted") return;
            block.outputText += chunk;
            block.rawMsg += chunk;
            streamTick.value++;
        },
    };
}

function handleAnalyzeAbort(block: ChatBlock, centerText: Ref<string>, revision: number) {
    if (!isAnalyzeRunCurrent(revision)) return;
    markDraftInterrupted(block);
    centerText.value = "已中断";
}

async function analyzeDraft(
    draft: ChatBlock,
    centerText: Ref<string>,
    onNeedSelect: NeedSelectHandler,
    onIncomplete?: IncompleteHandler,
    existingRun?: AnalyzeRun,
) {
    const combined = combineUserMessages(draft.userMessages);
    const original = draft.userMessages.join("\n\n");
    const {controller: analyzeController, revision} = existingRun ?? beginAnalyzeRun();
    draft.incompleteGuidance = undefined;
    draft.error = undefined;
    draft.errorMeta = undefined;

    // 阶段0: 需求完整性预检查
    if (onIncomplete) {
        centerText.value = "正在检查需求完整性...";
        draft.phase = "analyzing";
        beginDraftStream(draft, "precheck");
        try {
            const pre = await precheckPrompt(
                combined,
                draftStreamCallbacks(draft, revision),
                analyzeController.signal,
            );
            assertAnalyzeRun(revision, analyzeController);
            if (!pre.complete) {
                const guidance = pre.guidance || {
                    heading: "还需要补充",
                    items: [
                        {topic: "核心功能", detail: "插件最主要要实现什么玩法或系统行为？"},
                        {topic: "玩家交互", detail: "玩家通过什么操作、命令或事件使用它？"},
                        {topic: "触发条件", detail: "功能在什么条件下开始、结束或重置？"},
                    ],
                };
                draft.phase = "needs_input";
                draft.streamText = "";
                draft.rawMsg = "";
                draft.thinkingText = "";
                draft.outputText = "";
                draft.streamStage = "";
                draft.incompleteGuidance = guidance;
                releaseAnalyzeController(analyzeController);
                centerText.value = "请补充需求";
                onIncomplete(original, guidance);
                return;
            }
        } catch (e: any) {
            if (e?.name === "AbortError") {
                handleAnalyzeAbort(draft, centerText, revision);
                return;
            }
            if (!isAnalyzeRunCurrent(revision)) return;
            releaseAnalyzeController(analyzeController);
            setDraftError(draft, "需求完整性检查失败: " + (e?.message || e), e);
            centerText.value = "请求失败";
            return;
        }
    }

    // 阶段1: 需求分析
    assertAnalyzeRun(revision, analyzeController);
    centerText.value = "正在分析需求...";
    draft.phase = "analyzing";

    let info: any;
    try {
        beginDraftStream(draft, "analysis");
        const raw = await streamGetInfo(
            combined,
            draftStreamCallbacks(draft, revision),
            analyzeController.signal,
        );
        assertAnalyzeRun(revision, analyzeController);
        info = tryParseJson(raw);
    } catch (e: any) {
        if (e?.name === "AbortError") {
            handleAnalyzeAbort(draft, centerText, revision);
            return;
        }
        if (!isAnalyzeRunCurrent(revision)) return;
        releaseAnalyzeController(analyzeController);
        setDraftError(draft, "需求分析失败: " + (e?.message || e), e);
        centerText.value = "请求失败";
        return;
    }

    if (!info || typeof info !== "object") {
        releaseAnalyzeController(analyzeController);
        draft.phase = "streaming";
        centerText.value = "对话中";
        fallbackStream(draft, combined, centerText, revision);
        return;
    }

    draft.coreType = info.coreType ?? null;
    draft.version = info.version ?? null;
    draft.title = info.title ?? "";

    const missing: ("coreType" | "version")[] = [];
    if (!draft.coreType || draft.coreType === "null") missing.push("coreType");
    if (!draft.version || draft.version === "null") missing.push("version");

    releaseAnalyzeController(analyzeController);
    if (missing.length > 0) {
        draft.rawMsg = "";
        onNeedSelect(draft, missing);
        return;
    }

    assertAnalyzeRun(revision, analyzeController);
    await continueAfterSelect(draft, centerText);
}

export async function handleUserInput(
    input: string,
    centerText: Ref<string>,
    onNeedSelect: NeedSelectHandler,
    onIncomplete?: IncompleteHandler,
) {
    // 在鉴权等待前建立运行域，确保离页或 Esc 后不会晚启动模型请求。
    const run = beginAnalyzeRun();
    let draft = appendToDraft(input);
    if (!draft) draft = createDraftBlock(input);
    draft.phase = "analyzing";
    // 强制登录：未登录则提示，不发起任何 AI 调用
    if (!authState.loaded) await fetchMe();
    if (!isAnalyzeRunCurrent(run.revision) || run.controller.signal.aborted) return;
    if (!authState.user) {
        releaseAnalyzeController(run.controller);
        draft.draft = false;
        setDraftError(
            draft,
            "请先登录后再使用",
            {code: "AUTH_REQUIRED", status: 401, noRetry: true},
            "auth_required",
        );
        centerText.value = "请先登录";
        return;
    }

    // 重新生成快捷：基于上一轮已确认（非草稿且已定型核心/版本）的 block
    if (input.includes("重新生成")) {
        const prev = [...chatBlocks].reverse().find(b => b.coreType && b.version && !b.draft);
        if (prev) {
            releaseAnalyzeController(run.controller);
            const prevCombined = combineUserMessages(prev.userMessages);
            const combined = prevCombined + "\n\n追加需求：" + input.replace("重新生成", "").trim();
            _rebuildInfo = { prompt: combined, coreType: prev.coreType!, version: prev.version! };
            draft.draft = false;
            draft.phase = "done";
            draft.streamText = "正在基于追加需求重新生成...";
            centerText.value = "重新生成中";
            return;
        }
    }

    await analyzeDraft(draft, centerText, onNeedSelect, onIncomplete, run);
}

export async function resumeInterruptedAnalysis(
    draft: ChatBlock,
    centerText: Ref<string>,
    onNeedSelect: NeedSelectHandler,
    onIncomplete?: IncompleteHandler,
) {
    if (draft.phase !== "interrupted" || !chatBlocks.includes(draft)) return;
    const run = beginAnalyzeRun();
    if (!authState.loaded) await fetchMe();
    if (!isAnalyzeRunCurrent(run.revision) || run.controller.signal.aborted) return;
    if (!authState.user) {
        releaseAnalyzeController(run.controller);
        setDraftError(
            draft,
            "请先登录后再使用",
            {code: "AUTH_REQUIRED", status: 401, noRetry: true},
            "auth_required",
        );
        centerText.value = "请先登录";
        return;
    }
    await analyzeDraft(draft, centerText, onNeedSelect, onIncomplete, run);
}

export async function continueAfterSelect(block: ChatBlock, centerText: Ref<string>) {
    // 平台新方向：不再生成「开发步骤」预览，确认核心/版本后直接进入需求确认(clarify)+生成。
    block.rawMsg = "";
    block.thinkingText = "";
    block.outputText = "";
    block.streamStage = "";
    block.phase = "done";
    block.draft = false;
    centerText.value = "正在进入需求确认...";

    const combined = combineUserMessages(block.userMessages);
    // 不 await：后续由 genTask 阶段驱动 UI；startGenerate 内部自行处理错误。
    startGenerate(combined, block.coreType!, block.version!).catch(() => { /* guard 抛错忽略 */ });
}

function fallbackStream(block: ChatBlock, input: string, centerText: Ref<string>, revision: number) {
    block.streamText = "";
    block.thinkingText = "";
    block.outputText = "";
    block.streamStage = "chat";
    analyzeAbort = null;
    const complete = (commitHistory = true) => {
        if (!isAnalyzeRunCurrent(revision) || block.phase !== "streaming") return;
        if (commitHistory) {
            fallbackHistory.push({ role: "user", content: input });
            fallbackHistory.push({ role: "assistant", content: block.streamText || "" });
        }
        block.phase = "done";
        block.error = undefined;
        block.errorMeta = undefined;
        block.thinkingText = "";
        block.outputText = "";
        block.streamStage = "";
        centerText.value = commitHistory ? "就绪" : "已保留当前回复";
    };
    const handle = consistChat(fallbackHistory, input, (chunk) => {
        if (!isAnalyzeRunCurrent(revision) || block.phase !== "streaming") return;
        block.streamText = block.streamText + chunk;
        streamTick.value++;
    }, complete, (chunk) => {
        if (!isAnalyzeRunCurrent(revision) || block.phase !== "streaming") return;
        block.thinkingText += chunk;
        streamTick.value++;
    });
    fallbackHandle = handle;
    fallbackBlock = block;
    void handle.done.catch((error: any) => {
        if (error?.name === "AbortError") return;
        if (isAnalyzeRunCurrent(revision) && block.phase === "streaming") {
            if (error?.code === "STREAM_TRUNCATED" && block.streamText.trim()) {
                complete(false);
                return;
            }
            setDraftError(block, "回复中断: " + (error?.message || error), error);
            block.thinkingText = "";
            block.outputText = "";
            block.streamStage = "";
            centerText.value = "请求失败";
        }
    }).finally(() => {
        if (fallbackHandle === handle) fallbackHandle = null;
        if (fallbackBlock === block) fallbackBlock = null;
    });
}

function tryParseJson(raw: string): any {
    const trimmed = raw.trim();
    const start = trimmed.indexOf("[") !== -1 && (trimmed.indexOf("{") === -1 || trimmed.indexOf("[") < trimmed.indexOf("{"))
        ? trimmed.indexOf("[")
        : trimmed.indexOf("{");
    if (start === -1) return null;
    const end = trimmed.lastIndexOf(start === trimmed.indexOf("[") ? "]" : "}");
    if (end === -1) return null;
    try {
        return JSON.parse(trimmed.slice(start, end + 1));
    } catch {
        return null;
    }
}
