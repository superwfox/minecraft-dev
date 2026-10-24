
import {
    assessPlannerLearningAuthorization,
    samePlannerLearningAuthorization,
} from "./plannerAuthorization";


    const assessment = await assessPlannerLearningAuthorization(state);
    return assessment && samePlannerLearningAuthorization(
        assessment.authorization,
        job.work.plannerAuthorization,
    ) ? undefined : reasonCode;
