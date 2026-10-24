
export type GradePath = {
    id: string;
    title: string;
    summary: string;
    mermaid: string;
    axes?: string[];
};
export type GradeInfo = { level: string; paths: GradePath[] };


export type PlannerResumeState = {
    plannerRequestId: string;
    plannerReplan: boolean;
    plannerAttempt: number;
};

export function normalizeGradeRequestId(value: unknown): string {
    return normalizeStageRequestId(value, "grade");
}


export function normalizePlannerResumeState(value: unknown): PlannerResumeState {
    const raw = value && typeof value === "object" ? value as Record<string, unknown> : {};
    const plannerRequestId = typeof raw.plannerRequestId === "string"
        && /^plan_[a-z0-9]{16,64}$/i.test(raw.plannerRequestId)
        ? raw.plannerRequestId
        : "";
    const plannerReplan = !!plannerRequestId && raw.plannerReplan === true;
    const rawAttempt = Number(raw.plannerAttempt);
    const plannerAttempt = plannerRequestId && plannerReplan && Number.isInteger(rawAttempt)
        ? Math.max(1, Math.min(10, rawAttempt))
        : 0;
    return { plannerRequestId, plannerReplan, plannerAttempt };
}


    grade: GradeInfo | null;
    chosenPathId: string;
    gradeRequestId: string;
    gradeRequestCorrection: string;
    plannerRequestId: string;
    plannerReplan: boolean;
    plannerAttempt: number;
    plannerLearningRequired: boolean;
    plannerLearningNeedCount: number;
    grade: null,
    chosenPathId: "",
    gradeRequestId: "",
    gradeRequestCorrection: "",
    plannerRequestId: "",
    plannerReplan: false,
    plannerAttempt: 0,
    plannerLearningRequired: false,
    plannerLearningNeedCount: 0,
    genTask.grade = null;
    genTask.chosenPathId = "";
    genTask.gradeRequestId = "";
    genTask.gradeRequestCorrection = "";
    genTask.plannerRequestId = "";
    genTask.plannerReplan = false;
    genTask.plannerAttempt = 0;
    genTask.plannerLearningRequired = false;
    genTask.plannerLearningNeedCount = 0;
            grade: genTask.grade,
            chosenPathId: genTask.chosenPathId,
            gradeRequestId: genTask.gradeRequestId,
            gradeRequestCorrection: genTask.gradeRequestCorrection,
            plannerRequestId: genTask.plannerRequestId,
            plannerReplan: genTask.plannerReplan,
            plannerAttempt: genTask.plannerAttempt,
            plannerLearningRequired: genTask.plannerLearningRequired,
            plannerLearningNeedCount: genTask.plannerLearningNeedCount,
        genTask.grade = s.grade || null;
        genTask.chosenPathId = s.chosenPathId || "";
        genTask.gradeRequestId = normalizeGradeRequestId(s.gradeRequestId);
        genTask.gradeRequestCorrection = typeof s.gradeRequestCorrection === "string"
            ? s.gradeRequestCorrection
            : "";
        const plannerResume = normalizePlannerResumeState(s);
        genTask.plannerRequestId = plannerResume.plannerRequestId;
        genTask.plannerReplan = plannerResume.plannerReplan;
        genTask.plannerAttempt = plannerResume.plannerAttempt;
        genTask.plannerLearningRequired = s.plannerLearningRequired === true;
        genTask.plannerLearningNeedCount = safeCount(s.plannerLearningNeedCount);
        genTask.plannerRequestId, genTask.plannerReplan, genTask.plannerAttempt,
        genTask.plannerLearningRequired, genTask.plannerLearningNeedCount,
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

