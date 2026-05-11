import type { Ref } from "vue";
import type { ChatBlock } from "./chatState";
import {
    chatBlocks,
    streamTick,
    createDraftBlock,
    appendToDraft,
    getActiveDraft,
    combineUserMessages,
} from "./chatState";
import { streamGetInfo, streamGetTodoList, consistChat, precheckPrompt } from "../api/deepseek";
import type { ChatMsg } from "../api/deepseek";

const CORE_TYPES = ["PAPER", "BUKKIT", "SPIGOT", "FORGE", "FABRIC"];
const VERSIONS = [
    "1.21", "1.20", "1.19", "1.18", "1.17", "1.16", "1.15", "1.14", "1.13", "1.12", "1.11", "1.10", "1.9", "1.8", "1.7"
];

export { CORE_TYPES, VERSIONS };

const fallbackHistory: ChatMsg[] = [];

export type RebuildInfo = { prompt: string; coreType: string; version: string } | null;
let _rebuildInfo: RebuildInfo = null;
export function getRebuildInfo(): RebuildInfo { return _rebuildInfo; }
export function clearRebuildInfo() { _rebuildInfo = null; }

export async function handleUserInput(
    input: string,
    centerText: Ref<string>,
    onNeedSelect: (block: ChatBlock, missing: ("coreType" | "version")[]) => void,
    onIncomplete?: (original: string, hint: string) => void,
) {
    // 重新生成快捷：基于上一轮已确认的 block
    if (input.includes("重新生成")) {
        const prev = [...chatBlocks].reverse().find(b => b.coreType && b.version && b.steps?.length);
        if (prev) {
            const prevCombined = combineUserMessages(prev.userMessages);
            const combined = prevCombined + "\n\n追加需求：" + input.replace("重新生成", "").trim();
            _rebuildInfo = { prompt: combined, coreType: prev.coreType!, version: prev.version! };
            const block = createDraftBlock(input);
            block.draft = false;
            block.phase = "done";
            block.streamText = "正在基于追加需求重新生成...";
            centerText.value = "重新生成中";
            return;
        }
    }

    // 找 active draft 追加，否则建新 draft
    let draft = appendToDraft(input);
    if (!draft) draft = createDraftBlock(input);

    const combined = combineUserMessages(draft.userMessages);

    // 阶段0: 需求完整性预检查
    if (onIncomplete) {
        centerText.value = "正在检查需求完整性...";
        draft.phase = "analyzing";
        try {
            const pre = await precheckPrompt(combined);
            if (!pre.complete) {
                draft.phase = "error";
                draft.error = pre.hint || "需求描述不完整，请补充";
                centerText.value = "请补充需求";
                onIncomplete(input, pre.hint || "请补充核心功能、玩家交互、触发方式");
                return;
            }
        } catch {
            // 预检查失败不阻塞，继续
        }
    }

    // 阶段1: 需求分析
    centerText.value = "正在分析需求...";
    draft.phase = "analyzing";

    let info: any;
    try {
        draft.rawMsg = "";
        const raw = await streamGetInfo(combined, (chunk) => {
            draft.rawMsg += chunk;
            streamTick.value++;
        });
        info = tryParseJson(raw);
    } catch (e: any) {
        draft.phase = "error";
        draft.error = "需求分析失败: " + (e?.message || e);
        centerText.value = "请求失败";
        return;
    }

    if (!info || typeof info !== "object") {
        draft.phase = "streaming";
        centerText.value = "对话中";
        fallbackStream(draft, combined, centerText);
        return;
    }

    draft.coreType = info.coreType ?? null;
    draft.version = info.version ?? null;
    draft.title = info.title ?? "";

    const missing: ("coreType" | "version")[] = [];
    if (!draft.coreType || draft.coreType === "null") missing.push("coreType");
    if (!draft.version || draft.version === "null") missing.push("version");

    if (missing.length > 0) {
        draft.rawMsg = "";
        onNeedSelect(draft, missing);
        return;
    }

    await continueAfterSelect(draft, centerText);
}

export async function continueAfterSelect(block: ChatBlock, centerText: Ref<string>) {
    centerText.value = "正在生成开发步骤...";
    block.phase = "fetching";

    const combined = combineUserMessages(block.userMessages);
    const prompt = JSON.stringify({
        coreType: block.coreType,
        version: block.version,
        title: block.title,
        rawPrompt: combined,
    });

    let steps: any;
    try {
        block.rawMsg = "";
        const raw = await streamGetTodoList(prompt, (chunk) => {
            block.rawMsg += chunk;
            streamTick.value++;
        });
        steps = tryParseJson(raw);
    } catch (e: any) {
        block.phase = "error";
        block.error = "步骤生成失败: " + (e?.message || e);
        centerText.value = "请求失败";
        return;
    }

    if (!Array.isArray(steps)) {
        block.phase = "streaming";
        centerText.value = "对话中";
        fallbackStream(block, combined, centerText);
        return;
    }

    centerText.value = "渲染完成";
    block.rawMsg = "";
    block.phase = "rendering";
    block.steps = steps;

    setTimeout(() => {
        block.phase = "done";
    }, 300);
}

function fallbackStream(block: ChatBlock, input: string, centerText: Ref<string>) {
    block.streamText = "";
    consistChat(fallbackHistory, input, (chunk) => {
        block.streamText = block.streamText + chunk;
        streamTick.value++;
    }, () => {
        fallbackHistory.push({ role: "user", content: input });
        fallbackHistory.push({ role: "assistant", content: block.streamText || "" });
        block.phase = "done";
        centerText.value = "就绪";
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
