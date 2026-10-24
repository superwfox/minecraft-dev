import { partitionKnowledgeNeedsByApiContracts } from "../apiContracts";
import {
    assessKnowledgeNeeds,
    deduplicateKnowledgeNeeds,
    filterPlannerKnowledgeNeeds,
    filterSelectedPathKnowledgeNeeds,
    learningLookupHash,
} from "./assessment";
import type { KnowledgeNeed } from "./types";

export interface PlannerLearningAuthorization {
    chosenPathId: string;
    needsFingerprint: string;
}

export interface PlannerLearningAuthorizationAssessment {
    authorization: PlannerLearningAuthorization;
    needs: KnowledgeNeed[];
    coveredCount: number;
}

export interface PlannerResultAuthorization {
    chosenPathId: string;
    selectedNeedsFingerprint: string;
}

interface PlannerNeedSelection {
    chosenPathId: string;
    externalDeps: string[];
    needs: KnowledgeNeed[];
}

function acceptedPathIds(value: unknown): string[] | null {
    if (value === undefined) return [];
    if (!Array.isArray(value) || value.length > 3) return null;
    const seen = new Set<string>();
    const pathIds: string[] = [];
    for (const path of value) {
        const id = path && typeof path === "object" && typeof (path as any).id === "string"
            ? (path as any).id.trim()
            : "";
        if (!/^[A-Za-z0-9_-]{1,80}$/.test(id) || seen.has(id)) return null;
        seen.add(id);
        pathIds.push(id);
    }
    return pathIds;
}

function selectedPathId(state: any, pathIds: string[]): string | null {
    const raw = state?.grade?.chosenPathId;
    const chosenPathId = raw === null || raw === undefined
        ? ""
        : typeof raw === "string" ? raw.trim() : "";
    if ((raw !== null && raw !== undefined && !chosenPathId)
        || (chosenPathId && !/^[A-Za-z0-9_-]{1,80}$/.test(chosenPathId))
        || (chosenPathId && !pathIds.includes(chosenPathId))
        || (state?.grade?.gateRequired === true && !chosenPathId)) {
        return null;
    }
    return chosenPathId;
}

function plannerNeedSelection(state: any): PlannerNeedSelection | null {
    const pathIds = acceptedPathIds(state?.grade?.paths);
    if (!pathIds) return null;
    const chosenPathId = selectedPathId(state, pathIds);
    if (chosenPathId === null) return null;

    const externalDeps = Array.isArray(state?.grade?.vector?.external_deps)
        ? state.grade.vector.external_deps.filter((value: unknown) => typeof value === "string")
        : [];
    const assessment = assessKnowledgeNeeds(
        state?.grade?.knowledgeNeeds ?? state?.knowledgeNeeds,
        {
            coreType: state?.coreType,
            mcVersion: state?.version,
            allowedPathIds: pathIds,
        },
    );
    const needs = deduplicateKnowledgeNeeds(filterSelectedPathKnowledgeNeeds(
        filterPlannerKnowledgeNeeds(assessment.accepted, {
            userPrompt: state?.userPrompt,
            externalDeps,
        }).accepted,
        chosenPathId,
    ).accepted);
    return { chosenPathId, externalDeps, needs };
}

async function sha256Hex(value: string): Promise<string> {
    const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(value));
    return [...new Uint8Array(digest)]
        .map((byte) => byte.toString(16).padStart(2, "0"))
        .join("");
}

function canonicalPlannerNeed(need: KnowledgeNeed): string {
    return JSON.stringify({
        kind: need.kind,
        trigger: need.trigger,
        specificity: need.specificity,
        integrationKind: need.integrationKind ?? "",
        triggerReason: need.triggerReason ?? "",
        pathIds: [...(need.pathIds ?? [])].sort(),
        claim: need.claim,
        scope: Object.entries(need.scope)
            .filter(([, value]) => !!value)
            .sort(([left], [right]) => left.localeCompare(right)),
        risk: need.risk,
        sourcePolicy: need.sourcePolicy,
        searchQueries: [...need.searchQueries].sort(),
        acceptanceCriteria: [...need.acceptanceCriteria].sort(),
    });
}

// Planner 结果绑定完整的选中 need 集合；后续 generatedFiles 改变静态契约覆盖时不能让计划自失效。
export async function assessPlannerResultAuthorization(
    state: any,
): Promise<PlannerResultAuthorization | null> {
    const selection = plannerNeedSelection(state);
    if (!selection) return null;
    const selectedNeedsFingerprint = await sha256Hex(
        selection.needs.map(canonicalPlannerNeed).sort().join("\n"),
    );
    return {
        chosenPathId: selection.chosenPathId,
        selectedNeedsFingerprint,
    };
}

export async function assessPlannerLearningAuthorization(
    state: any,
): Promise<PlannerLearningAuthorizationAssessment | null> {
    const selection = plannerNeedSelection(state);
    if (!selection) return null;
    const coverage = partitionKnowledgeNeedsByApiContracts({
        coreType: state?.coreType,
        version: state?.version,
        externalDeps: selection.externalDeps,
        generatedFiles: Array.isArray(state?.generatedFiles)
            ? state.generatedFiles
                .filter((file: any) => file && typeof file.path === "string")
                .map((file: any) => ({
                    path: file.path,
                    content: typeof file.content === "string" ? file.content : undefined,
                }))
            : [],
    }, selection.needs);
    const needs = deduplicateKnowledgeNeeds(coverage.uncovered);
    return {
        authorization: {
            chosenPathId: selection.chosenPathId,
            needsFingerprint: await learningLookupHash(needs),
        },
        needs,
        coveredCount: coverage.covered.length,
    };
}

export function samePlannerLearningAuthorization(
    left: PlannerLearningAuthorization | null | undefined,
    right: PlannerLearningAuthorization | null | undefined,
): boolean {
    return !!left && !!right
        && left.chosenPathId === right.chosenPathId
        && left.needsFingerprint === right.needsFingerprint
        && /^[a-f0-9]{64}$/.test(left.needsFingerprint)
        && /^[a-f0-9]{64}$/.test(right.needsFingerprint);
}

export function samePlannerResultAuthorization(
    left: PlannerResultAuthorization | null | undefined,
    right: PlannerResultAuthorization | null | undefined,
): boolean {
    return !!left && !!right
        && left.chosenPathId === right.chosenPathId
        && left.selectedNeedsFingerprint === right.selectedNeedsFingerprint
        && /^[a-f0-9]{64}$/.test(left.selectedNeedsFingerprint)
        && /^[a-f0-9]{64}$/.test(right.selectedNeedsFingerprint);
}
