import {reactive, ref} from "vue";
import {normalizePrecheckGuidance} from "./promptFormatting";
import type {PrecheckGuidance} from "./promptFormatting";
import {legacyActionMessageMeta, normalizeActionMessageMeta} from "./actionMessages";
import type {ActionMessageMeta} from "./actionMessages";

export type TodoStep = {
    step: number;
    content?: string;
    function?: string | null;
    params?: string[] | null;
    event?: string | null;
};

export type ChatBlock = {
    id: number;
    userMessages: string[];
    draft: boolean;
    phase: "analyzing" | "fetching" | "rendering" | "streaming" | "needs_input" | "interrupted" | "done" | "error";
    coreType?: string;
    version?: string;
    title?: string;
    steps?: TodoStep[];
    streamText: string;
    rawMsg: string;
    thinkingText: string;
    outputText: string;
    streamStage: "" | "precheck" | "analysis" | "chat";
    incompleteGuidance?: PrecheckGuidance;
    error?: string;
    errorMeta?: ActionMessageMeta;
};

let nextId = 0;

export const chatBlocks = reactive<ChatBlock[]>([]);
export const streamTick = ref(0);

export function getActiveDraft(): ChatBlock | null {
    for (let i = chatBlocks.length - 1; i >= 0; i--) {
        if (chatBlocks[i].draft) return chatBlocks[i];
    }
    return null;
}

export function createDraftBlock(input: string): ChatBlock {
    const block: ChatBlock = {
        id: nextId++,
        userMessages: [input],
        draft: true,
        phase: "analyzing",
        streamText: "",
        rawMsg: "",
        thinkingText: "",
        outputText: "",
        streamStage: "",
    };
    chatBlocks.push(block);
    return chatBlocks[chatBlocks.length - 1];
}

export function appendToDraft(input: string): ChatBlock | null {
    const d = getActiveDraft();
    if (!d) return null;
    if (d.phase === "needs_input" || d.phase === "interrupted") {
        d.userMessages.splice(0, d.userMessages.length, input);
    }
    else d.userMessages.push(input);
    d.streamText = "";
    d.rawMsg = "";
    d.thinkingText = "";
    d.outputText = "";
    d.streamStage = "";
    d.incompleteGuidance = undefined;
    d.error = undefined;
    d.errorMeta = undefined;
    return d;
}

export function freezeDraft() {
    const d = getActiveDraft();
    if (d) d.draft = false;
}

export function removeChatBlock(block: ChatBlock) {
    const index = chatBlocks.indexOf(block);
    if (index >= 0) chatBlocks.splice(index, 1);
}

export function removeDraftBlock(block: ChatBlock) {
    if (block.draft) removeChatBlock(block);
}

export function combineUserMessages(messages: string[]): string {
    if (messages.length === 1) return messages[0];
    return messages
        .map((m, i) => (i === 0 ? `初始需求：${m}` : `补充 ${i}：${m}`))
        .join("\n\n");
}

export function resetChat() {
    chatBlocks.splice(0);
    nextId = 0;
}

export function rehydrateBlocks(blocks: ChatBlock[]) {
    for (const block of blocks) {
        if (block.incompleteGuidance) {
            block.incompleteGuidance = normalizePrecheckGuidance(block.incompleteGuidance);
        }
        block.errorMeta = normalizeActionMessageMeta(block.errorMeta) || legacyActionMessageMeta(block.error);
    }
    chatBlocks.splice(0, chatBlocks.length, ...blocks);
    let maxId = -1;
    for (const b of chatBlocks) if (b.id > maxId) maxId = b.id;
    nextId = maxId + 1;
}
