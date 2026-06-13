import { reactive, ref } from "vue";

export type GenPhase = "idle" | "planning" | "clarifying" | "awaiting_input" | "generating" | "verifying" | "uploading" | "building" | "polling" | "fixing" | "done" | "error";

export type GeneratorType =
    | "CommandGen" | "ListenerGen" | "TaskGen" | "ManagerGen"
    | "ConfigGen" | "ConfigClassGen" | "ModelGen" | "EnumGen"
    | "UtilGen" | "FileRelatedGen" | "MainGen";

export type GenFile = {
    path: string;
    role: string;
    content?: string;
    status: "pending" | "generating" | "done" | "error";
    generatorType?: GeneratorType;
    tag?: "gui" | null;
    pairPath?: string;
    bucket?: number;
    streamingContent?: string;
    streamingPhase?: string;
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
    clarifyWaiting.value = false;
}

// 中断标记：ESC 撤回时抛出，startGenerate 的 catch 据此安静复位
export class InterruptError extends Error {
    interrupted = true;
    constructor() { super("interrupted"); this.name = "InterruptError"; }
}

// 本轮澄清是否已就绪可作答（流式问题全部到达、resolver 已建立）。
// 卡片 UI 只在此为 true 时才允许提交，避免流未结束时提交丢失答案。
export const clarifyWaiting = ref(false);

// 等待用户确认的 Promise 解析器（作答完成时调用）
let clarifyResolver: ((answers: Record<string, string | string[]>) => void) | null = null;
let clarifyRejecter: ((e: any) => void) | null = null;

export function waitForClarifyAnswers(): Promise<Record<string, string | string[]>> {
    clarifyWaiting.value = true;
    return new Promise((resolve, reject) => {
        clarifyResolver = resolve;
        clarifyRejecter = reject;
    });
}

export function submitClarifyAnswers(answers: Record<string, string | string[]>) {
    if (clarifyResolver) {
        const r = clarifyResolver;
        clarifyResolver = null;
        clarifyRejecter = null;
        clarifyWaiting.value = false;
        r(answers);
    }
}

// 等待用户补充需求描述（awaiting_input 阶段）
let extraPromptResolver: ((extra: string) => void) | null = null;
let extraPromptRejecter: ((e: any) => void) | null = null;

export function waitForExtraPrompt(): Promise<string> {
    return new Promise((resolve, reject) => {
        extraPromptResolver = resolve;
        extraPromptRejecter = reject;
    });
}

export function submitExtraPrompt(extra: string) {
    if (extraPromptResolver) {
        const r = extraPromptResolver;
        extraPromptResolver = null;
        extraPromptRejecter = null;
        r(extra);
    }
}

/** ESC 中断：拒绝任何正在等待用户输入的 Promise（澄清答题 / 补充描述） */
export function cancelPendingInput() {
    clarifyWaiting.value = false;
    if (clarifyRejecter) {
        const r = clarifyRejecter;
        clarifyResolver = null;
        clarifyRejecter = null;
        r(new InterruptError());
    }
    if (extraPromptRejecter) {
        const r = extraPromptRejecter;
        extraPromptResolver = null;
        extraPromptRejecter = null;
        r(new InterruptError());
    }
}
