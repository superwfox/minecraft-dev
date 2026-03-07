import { reactive } from "vue";

export type GenPhase = "idle" | "planning" | "generating" | "verifying" | "uploading" | "building" | "polling" | "done" | "error";

export type GenFile = {
    path: string;
    role: string;
    content?: string;
    status: "pending" | "generating" | "done";
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
}
