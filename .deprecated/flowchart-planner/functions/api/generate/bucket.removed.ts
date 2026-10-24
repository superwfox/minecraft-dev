
import {
    assessPlannerLearningAuthorization,
    assessPlannerResultAuthorization,
    samePlannerResultAuthorization,
} from "../../_lib/learning/plannerAuthorization";


    if (state.plannerBillingSettled === false || state.plannerAttemptBillingPending) {
        return new Response(JSON.stringify({
            error: "Planner 额度结算尚未完成，请先重试 Planner",
            code: "PLANNER_SETTLEMENT_PENDING",
        }), {
            status: 503,
            headers: { "Content-Type": "application/json", "Retry-After": "2" },
        });
    }



    const [plannerAssessment, plannerResultAuthorization] = await Promise.all([
        assessPlannerLearningAuthorization(state),
        assessPlannerResultAuthorization(state),
    ]);
    if (!plannerAssessment || !plannerResultAuthorization || !samePlannerResultAuthorization(
        state.plannerResultAuthorization,
        plannerResultAuthorization,
    )) {
        return new Response(JSON.stringify({
            error: "Planner 路径授权已失效，请重新规划",
            code: "PLANNER_AUTHORIZATION_EXPIRED",
        }), {
            status: 409,
            headers: { "Content-Type": "application/json" },
        });
    }



        const alreadyGenerated = new Set([
            ...summaries.map(summary => summary.className).filter((name): name is string => !!name),
            ...(state.generatedFiles ?? [])
                .map((file: any) => String(file.path || "").split("/").pop()?.replace(/\.java$/i, ""))
                .filter((name: unknown): name is string => typeof name === "string" && !!name),
            ...(state.plan ?? [])
                .map((file: any) => String(file.path || "").split("/").pop()?.replace(/\.java$/i, ""))
                .filter((name: unknown): name is string => typeof name === "string" && !!name),
        ]);
        const dynamicFiles = missingClasses
            .filter(className => !alreadyGenerated.has(className))
            .map(className => ({
                className,
                path: `src/main/java/${ctx.packageName.replace(/\./g, "/")}/${className}.java`,
                role: `${className} — 被 ${filePath.split("/").pop()} 引用`,
            }));

