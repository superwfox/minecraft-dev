
import {
    assessPlannerLearningAuthorization,
    type PlannerLearningAuthorization,
} from "../../_lib/learning/plannerAuthorization";


    let pathSelectionChanged = false;
    if (stage === "planner") {
        const paths = Array.isArray(state.grade?.paths) ? state.grade.paths : [];
        const validChosenPath = !!chosenPathId && paths.some((path: any) => path?.id === chosenPathId);
        if (state.grade?.gateRequired && !chosenPathId) {
            return json({ error: "Missing chosenPathId", code: "PATH_NOT_CONFIRMED" }, 400);
        }
        if (chosenPathId && !validChosenPath) return json({ error: "Invalid chosenPathId" }, 400);
        if (chosenPathId && state.grade?.chosenPathId !== chosenPathId) {
            state.grade.chosenPathId = chosenPathId;
            pathSelectionChanged = true;
        }
    }



    if (pathSelectionChanged) {
        try {
            await putTaskState(context.env, taskId, state, 3600, uid);
        } catch (error) {
            console.warn("learning path selection persistence failed", error);
            return storageUnavailable();
        }
    }

    const externalDeps = Array.isArray(state.grade?.vector?.external_deps)
        ? state.grade.vector.external_deps
        : [];


    if (stage === "planner") {
        const plannerAssessment = await assessPlannerLearningAuthorization(state);
        if (!plannerAssessment) {
            return json({
                error: "Planner learning authorization is no longer current",
                reasonCode: "planner_authorization_expired",
            }, 409);
        }
        needs = plannerAssessment.needs;
        contractCoveredCount = plannerAssessment.coveredCount;
        plannerAuthorization = plannerAssessment.authorization;
    } else if (stage === "fix") {

