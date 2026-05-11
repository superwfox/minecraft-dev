import {reactive, ref} from "vue";

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
    phase: "analyzing" | "fetching" | "rendering" | "streaming" | "done" | "error";
    coreType?: string;
    version?: string;
    title?: string;
    steps?: TodoStep[];
    streamText: string;
    rawMsg: string;
    error?: string;
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
    };
    chatBlocks.push(block);
    return chatBlocks[chatBlocks.length - 1];
}

export function appendToDraft(input: string): ChatBlock | null {
    const d = getActiveDraft();
    if (!d) return null;
    d.userMessages.push(input);
    d.streamText = "";
    d.rawMsg = "";
    d.error = undefined;
    return d;
}

export function freezeDraft() {
    const d = getActiveDraft();
    if (d) d.draft = false;
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
    chatBlocks.splice(0, chatBlocks.length, ...blocks);
    let maxId = -1;
    for (const b of chatBlocks) if (b.id > maxId) maxId = b.id;
    nextId = maxId + 1;
}
