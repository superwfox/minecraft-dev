import { currentFixLearningAuthorization, sameFixLearningAuthorization } from "./fixAuthorization";
import {
    assessPlannerLearningAuthorization,
    samePlannerLearningAuthorization,
} from "./plannerAuthorization";
import type { LearningJobRecord, LearningReasonCode } from "./types";
import { taskOperationLeaseFromState } from "../taskStore";
import {
    currentModelLearningAuthorization,
    sameModelLearningAuthorization,
} from "./tool";

async function sha256Hex(value: string): Promise<string> {
    const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(value));
    return [...new Uint8Array(digest)]
        .map((byte) => byte.toString(16).padStart(2, "0"))
        .join("");
}

export async function bindLearningJobLookupHashToTaskFence(
    lookupHash: string,
    taskStateFence: string,
): Promise<string> {
    if (!lookupHash || !taskStateFence) throw new Error("invalid_learning_job_authorization");
    return sha256Hex(["learning-job.v2", lookupHash, taskStateFence].join("\n"));
}

export async function learningJobAuthorizationFailure(
    state: any,
    job: Pick<LearningJobRecord, "stage" | "work">,
): Promise<LearningReasonCode | undefined> {
    const currentTaskFence = taskOperationLeaseFromState(state)?.token || "";
    const expectedTaskFence = typeof job.work.taskStateFence === "string"
        ? job.work.taskStateFence
        : "";
    const reasonCode: LearningReasonCode = job.stage === "fix"
        ? "fix_authorization_expired"
        : job.stage === "tool"
            ? "tool_authorization_expired"
            : "planner_authorization_expired";
    if (!currentTaskFence || !expectedTaskFence || currentTaskFence !== expectedTaskFence) {
        return reasonCode;
    }

    if (job.stage === "fix") {
        return sameFixLearningAuthorization(
            currentFixLearningAuthorization(state),
            job.work.fixAuthorization,
        ) ? undefined : reasonCode;
    }

    if (job.stage === "tool") {
        const requestId = job.work.toolAuthorization?.requestId ?? "";
        return sameModelLearningAuthorization(
            currentModelLearningAuthorization(state, requestId),
            job.work.toolAuthorization,
        ) ? undefined : reasonCode;
    }

    const assessment = await assessPlannerLearningAuthorization(state);
    return assessment && samePlannerLearningAuthorization(
        assessment.authorization,
        job.work.plannerAuthorization,
    ) ? undefined : reasonCode;
}
