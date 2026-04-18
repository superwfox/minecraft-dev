import { reactive } from "vue";

export type GenPhase = "idle" | "planning" | "clarifying" | "awaiting_input" | "generating" | "verifying" | "uploading" | "building" | "polling" | "fixing" | "done" | "error";

export type GenFile = {
    path: string;
    role: string;
    content?: string;
    status: "pending" | "generating" | "done";
};

export type TodoItem = {
    id: string;
    question: string;
    options: string[];
    allowCustom: boolean;
    multiSelect: boolean;
    chart?: "linear" | "power2" | "power0.5" | "log" | "exp" | "multi" | null;
};

export type ClarifyRound = {
    todos: TodoItem[];
    answers: Record<string, string | string[]>;
};

export type GenTask = {
    taskId: string;
    phase: GenPhase;
    projectName: string;
    packageName: string;
    javaVersion: string;
    files: GenFile[];
    currentIndex: number;
    logs: string[];
    error: string;
    streamingContent: string;
    streamingPhase: string;
    streamingFile: string;
    clarifyTodos: TodoItem[];
    clarifyRound: number;
    clarifyHistory: ClarifyRound[];
    reasoningContent: string;
    reasoningVisible: boolean;
    moreInputHint: string;
};

export const genTask = reactive<GenTask>({
    taskId: "",
    phase: "idle",
    projectName: "",
    packageName: "",
    javaVersion: "",
    files: [],
    currentIndex: 0,
    logs: [],
    error: "",
    streamingContent: "",
    streamingPhase: "",
    streamingFile: "",
    clarifyTodos: [],
    clarifyRound: 0,
    clarifyHistory: [],
    reasoningContent: "",
    reasoningVisible: true,
    moreInputHint: "",
});

export function resetGenTask() {
    genTask.taskId = "";
    genTask.phase = "idle";
    genTask.projectName = "";
    genTask.packageName = "";
    genTask.javaVersion = "";
    genTask.files = [];
    genTask.currentIndex = 0;
    genTask.logs = [];
    genTask.error = "";
    genTask.streamingContent = "";
    genTask.streamingPhase = "";
    genTask.streamingFile = "";
    genTask.clarifyTodos = [];
    genTask.clarifyRound = 0;
    genTask.clarifyHistory = [];
    genTask.reasoningContent = "";
    genTask.reasoningVisible = true;
    genTask.moreInputHint = "";
}

// 等待用户确认的 Promise 解析器（ClarifyPanel 点击确认时调用）
let clarifyResolver: ((answers: Record<string, string | string[]>) => void) | null = null;

export function waitForClarifyAnswers(): Promise<Record<string, string | string[]>> {
    return new Promise((resolve) => {
        clarifyResolver = resolve;
    });
}

export function submitClarifyAnswers(answers: Record<string, string | string[]>) {
    if (clarifyResolver) {
        const r = clarifyResolver;
        clarifyResolver = null;
        r(answers);
    }
}

// 等待用户补充需求描述（awaiting_input 阶段）
let extraPromptResolver: ((extra: string) => void) | null = null;

export function waitForExtraPrompt(): Promise<string> {
    return new Promise((resolve) => {
        extraPromptResolver = resolve;
    });
}

export function submitExtraPrompt(extra: string) {
    if (extraPromptResolver) {
        const r = extraPromptResolver;
        extraPromptResolver = null;
        r(extra);
    }
}
