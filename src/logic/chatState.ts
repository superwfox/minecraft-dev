import {reactive} from "vue";

export type TodoStep = {
    step: number;
    content?: string;
    function?: string | null;
    params?: string[] | null;
    event?: string | null;
};

export type ChatBlock = {
    id: number;
    userInput: string;
    phase: "analyzing" | "fetching" | "rendering" | "streaming" | "done" | "error";
    coreType?: string;
    version?: string;
    title?: string;
    steps?: TodoStep[];
    streamText?: string;
    error?: string;
};

let nextId = 0;

export const chatBlocks = reactive<ChatBlock[]>([]);

export function addBlock(userInput: string): ChatBlock {
    const block: ChatBlock = {
        id: nextId++,
        userInput,
        phase: "analyzing",
        streamText: "",
    };
    chatBlocks.push(block);
    return block;
}

export function resetChat() {
    chatBlocks.splice(0);
    nextId = 0;
}
