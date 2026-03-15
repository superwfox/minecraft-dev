import type { Ref } from "vue";
import type { ChatBlock } from "./chatState";
import { addBlock, chatBlocks, streamTick } from "./chatState";
import { getInfo, getTodoList, consistChat } from "../api/deepseek";
import type { ChatMsg } from "../api/deepseek";

const CORE_TYPES = ["PAPER", "BUKKIT", "SPIGOT", "FORGE", "FABRIC"];
const VERSIONS = [
    "1.21", "1.20", "1.19", "1.18", "1.17", "1.16", "1.15", "1.14", "1.13", "1.12", "1.11", "1.10", "1.9", "1.8", "1.7"
];

export { CORE_TYPES, VERSIONS };

let hasRendered = false;
const chatHistory: ChatMsg[] = [];

export type RebuildInfo = { prompt: string; coreType: string; version: string } | null;
let _rebuildInfo: RebuildInfo = null;
export function getRebuildInfo(): RebuildInfo { return _rebuildInfo; }
export function clearRebuildInfo() { _rebuildInfo = null; }

export async function handleUserInput(
    input: string,
    centerText: Ref<string>,
    onNeedSelect: (block: ChatBlock, missing: ("coreType" | "version")[]) => void,
) {
    const block = addBlock(input);

    if (hasRendered) {
        if (input.includes("重新生成")) {
            const prev = [...chatBlocks].reverse().find(b => b.coreType && b.version && b.steps?.length);
            if (prev) {
                const combined = prev.userInput + "；追加需求：" + input.replace("重新生成", "").trim();
                _rebuildInfo = { prompt: combined, coreType: prev.coreType!, version: prev.version! };
                block.phase = "done";
                block.streamText = "正在基于追加需求重新生成...";
                centerText.value = "重新生成中";
                return;
            }
        }
        block.phase = "streaming";
        centerText.value = "对话中";
        fallbackStream(block, input, centerText);
        return;
    }

    // 阶段1: 需求分析
    centerText.value = "正在分析需求...";
    block.phase = "analyzing";

    let info: any;
    try {
        const raw = await getInfo(input);
        info = tryParseJson(raw);
    } catch (e: any) {
        block.phase = "error";
        block.error = "需求分析失败: " + (e?.message || e);
        centerText.value = "请求失败";
        return;
    }

    if (!info || typeof info !== "object") {
        block.phase = "streaming";
        centerText.value = "对话中";
        fallbackStream(block, input, centerText);
        return;
    }

    block.coreType = info.coreType ?? null;
    block.version = info.version ?? null;
    block.title = info.title ?? "";

    const missing: ("coreType" | "version")[] = [];
    if (!block.coreType || block.coreType === "null") missing.push("coreType");
    if (!block.version || block.version === "null") missing.push("version");

    if (missing.length > 0) {
        onNeedSelect(block, missing);
        return;
    }

    await continueAfterSelect(block, centerText);
}

export async function continueAfterSelect(block: ChatBlock, centerText: Ref<string>) {
    // 阶段2: API调出
    centerText.value = "正在生成开发步骤...";
    block.phase = "fetching";

    const prompt = JSON.stringify({
        coreType: block.coreType,
        version: block.version,
        title: block.title,
        rawPrompt: block.userInput,
    });

    let steps: any;
    try {
        const raw = await getTodoList(prompt);
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
        fallbackStream(block, block.userInput, centerText);
        return;
    }

    // 阶段3: 渲染
    centerText.value = "渲染完成";
    block.phase = "rendering";
    block.steps = steps;
    hasRendered = true;

    setTimeout(() => {
        block.phase = "done";
    }, 300);
}

function fallbackStream(block: ChatBlock, input: string, centerText: Ref<string>) {
    block.streamText = "";
    consistChat(chatHistory, input, (chunk) => {
        block.streamText = block.streamText + chunk;
        streamTick.value++;
    }, () => {
        chatHistory.push({ role: "user", content: input });
        chatHistory.push({ role: "assistant", content: block.streamText || "" });
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
