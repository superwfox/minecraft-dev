import { reactive, ref } from "vue";

export type GenPhase = "idle" | "planning" | "clarifying" | "grading" | "confirming" | "awaiting_input" | "generating" | "verifying" | "uploading" | "building" | "polling" | "fixing" | "done" | "error";

export type GradePath = {
    id: string;
    title: string;
    summary: string;
    mermaid: string;
    axes?: string[];
};
export type GradeInfo = { level: string; paths: GradePath[] };

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
    grade: GradeInfo | null;
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
    grade: null,
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
    genTask.grade = null;
    clarifyWaiting.value = false;
    pathGateWaiting.value = false;
}

// 超级并发开关：默认 false（桶内串行，每个 CF 请求只做 1 文件，最稳）。
// 开启后桶内并发生成、更快，但更易撞 Cloudflare Worker 单请求 CPU/时长/子请求上限导致「零进度 → 重新规划 → 失败」——慎用。
// 用户偏好，持久化到 localStorage。
function loadSuperConcurrency(): boolean {
    try { return localStorage.getItem("tahai-super-concurrency") === "1"; } catch { return false; }
}
export const superConcurrency = ref(loadSuperConcurrency());
export function setSuperConcurrency(on: boolean) {
    superConcurrency.value = on;
    try { localStorage.setItem("tahai-super-concurrency", on ? "1" : "0"); } catch { /* ignore */ }
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

// ── 实现路径确认门（confirming 阶段）：选路径 或 打回修正 ──
export const pathGateWaiting = ref(false);
let pathResolver: ((r: { pathId?: string; correction?: string }) => void) | null = null;
let pathRejecter: ((e: any) => void) | null = null;

export function waitForPathChoice(): Promise<{ pathId?: string; correction?: string }> {
    pathGateWaiting.value = true;
    return new Promise((resolve, reject) => {
        pathResolver = resolve;
        pathRejecter = reject;
    });
}
function resolvePath(r: { pathId?: string; correction?: string }) {
    if (pathResolver) {
        const fn = pathResolver;
        pathResolver = null;
        pathRejecter = null;
        pathGateWaiting.value = false;
        fn(r);
    }
}
export function submitPathChoice(pathId: string) { resolvePath({ pathId }); }
export function submitPathReject(correction: string) { resolvePath({ correction }); }

/** ESC 中断：拒绝任何正在等待用户输入的 Promise（澄清答题 / 补充描述 / 路径确认） */
export function cancelPendingInput() {
    clarifyWaiting.value = false;
    pathGateWaiting.value = false;
    if (pathRejecter) {
        const r = pathRejecter;
        pathResolver = null;
        pathRejecter = null;
        r(new InterruptError());
    }
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
