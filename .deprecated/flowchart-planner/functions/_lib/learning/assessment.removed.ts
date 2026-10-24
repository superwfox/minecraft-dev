function normalizedIdentifier(value: string): string { return value.toLowerCase().replace(/[^a-z0-9]/g, ""); }
function needIntegrationText(need: KnowledgeNeed): string { return [need.claim.subject, need.claim.question, need.scope.dependency, need.scope.packageName, need.scope.symbol].filter(Boolean).join(" ").toLowerCase(); }

function plannerIntegrationReason(need: KnowledgeNeed, input: { userPrompt?: string; externalDeps?: string[]; chosenPathId?: string }): string {
    if (!need.integrationKind || !need.triggerReason) return "missing_integration_classification";
    if (need.kind !== "fact") return "planner_strategy_not_allowed";
    if (input.chosenPathId && need.pathIds?.length && !need.pathIds.includes(input.chosenPathId)) return "unselected_path";
    const text = needIntegrationText(need);
    if (need.integrationKind === "public_api") return "planner_public_api_not_allowed";
    if (need.integrationKind === "nms") {
        if (need.triggerReason !== "nms_version_sensitive" && need.triggerReason !== "reflection_contract") return "invalid_nms_reason";
        return /(?:\bnet\.minecraft\b|\bnms\b)/i.test(text) ? "" : "nms_scope_missing";
    }
    if (need.integrationKind === "craftbukkit") {
        if (need.triggerReason !== "nms_version_sensitive" && need.triggerReason !== "reflection_contract") return "invalid_craftbukkit_reason";
        return /(?:org\.bukkit\.craftbukkit|craftbukkit)/i.test(text) ? "" : "craftbukkit_scope_missing";
    }
    if (need.integrationKind === "version_reflection") {
        if (need.triggerReason !== "reflection_contract") return "invalid_reflection_reason";
        return /(?:reflect|class\.forname|getdeclared|getmethod|getfield|反射)/i.test(text) && /(?:net\.minecraft|org\.bukkit\.craftbukkit|craftbukkit|\bnms\b)/i.test(text) ? "" : "reflection_scope_missing";
    }
    if (need.triggerReason !== "external_plugin_contract") return "invalid_external_plugin_reason";
    const promptKey = normalizedIdentifier(input.userPrompt ?? "");
    const explicitDependencies = cleanList(input.externalDeps, 8, 120).filter((dependency) => { const key = normalizedIdentifier(dependency); return key.length >= 3 && promptKey.includes(key); });
    const needKey = normalizedIdentifier(text);
    return explicitDependencies.some((dependency) => { const key = normalizedIdentifier(dependency); return key.length >= 3 && needKey.includes(key); }) ? "" : "external_plugin_not_declared";
}

export function filterPlannerKnowledgeNeeds(needs: KnowledgeNeed[], input: { userPrompt?: string; externalDeps?: string[]; chosenPathId?: string } = {}): KnowledgeNeedAssessment {
    const accepted: KnowledgeNeed[] = [], rejected: KnowledgeNeedRejection[] = [];
    needs.forEach((need, index) => { const reason = plannerIntegrationReason(need, input); reason ? rejected.push({ index, reason }) : accepted.push(need); });
    return { accepted, rejected };
}

export function filterSelectedPathKnowledgeNeeds(needs: KnowledgeNeed[], chosenPathId?: string): KnowledgeNeedAssessment {
    const selectedPathId = clean(chosenPathId, 80); const accepted: KnowledgeNeed[] = [], rejected: KnowledgeNeedRejection[] = [];
    needs.forEach((need, index) => need.pathIds?.length && (!selectedPathId || !need.pathIds.includes(selectedPathId)) ? rejected.push({ index, reason: selectedPathId ? "unselected_path" : "path_not_selected" }) : accepted.push(need));
    return { accepted, rejected };
}
