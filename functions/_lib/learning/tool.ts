import type { LLMProvider } from "../llm";
import {
    assessKnowledgeNeeds,
    learningLookupHash,
} from "./assessment";
import type {
    KnowledgeAnswerType,
    KnowledgeNeed,
    LearningIntegrationKind,
    LearningJobStatus,
    LearningReasonCode,
    SourcePolicy,
} from "./types";

export const LEARNING_TOOL_NAME = "learn_public_api";
export const MAX_LEARNING_TOOL_ROUNDS = 2;
const MAX_STORED_REQUESTS = 8;
const CORE_PUBLIC_PREFIXES = [
    "com.destroystokyo.paper",
    "com.mojang",
    "io.papermc",
    "java",
    "javax",
    "net.kyori",
    "org.bukkit",
    "org.spigotmc",
];
const CORE_DEPENDENCY_KEYS = new Set([
    "adventure", "bukkit", "minecraft", "paper", "paperapi", "spigot", "spigotapi",
]);

export type ModelLearningOrigin = "planner" | "generate" | "review" | "rework" | "fix";

export interface ModelToolCall {
    id: string;
    type: "function";
    function: {
        name: string;
        arguments: string;
    };
}

export interface ModelChatMessage {
    role: "system" | "user" | "assistant" | "tool";
    content: string;
    reasoning_content?: string;
    tool_calls?: ModelToolCall[];
    tool_call_id?: string;
}

export interface ModelLearningRequestResult {
    status: Extract<LearningJobStatus, "ready" | "deferred" | "needs_review" | "failed" | "cancelled">;
    reasonCode?: LearningReasonCode;
}

export interface ModelLearningRequest {
    schemaVersion: "model_learning_tool.v1";
    requestId: string;
    origin: ModelLearningOrigin;
    originKey: string;
    targetPath: string;
    round: number;
    createdAt: number;
    lookupHash: string;
    needs: KnowledgeNeed[];
    callNeedIds: Record<string, string>;
    messages: ModelChatMessage[];
    result?: ModelLearningRequestResult;
}

export interface ModelLearningToolResult {
    status: ModelLearningRequestResult["status"];
    reasonCode?: LearningReasonCode;
    knowledgeContext: string;
}

const ANSWER_TYPES = new Set<KnowledgeAnswerType>([
    "signature", "coordinate", "behavior", "migration", "rule",
]);
const SOURCE_POLICIES = new Set<SourcePolicy>([
    "api_signature", "dependency", "behavior", "release",
]);
const INTEGRATION_KINDS = new Set<LearningIntegrationKind>([
    "public_api", "nms", "craftbukkit", "version_reflection", "external_plugin",
]);

function clean(value: unknown, max: number): string {
    return typeof value === "string"
        ? value.trim().replace(/\s+/g, " ").slice(0, max)
        : "";
}

function cleanList(value: unknown, maxItems: number, maxLength: number): string[] {
    if (!Array.isArray(value)) return [];
    const seen = new Set<string>();
    const result: string[] = [];
    for (const item of value) {
        const normalized = clean(item, maxLength);
        const key = normalized.toLowerCase();
        if (!normalized || seen.has(key)) continue;
        seen.add(key);
        result.push(normalized);
        if (result.length >= maxItems) break;
    }
    return result;
}

function toolCall(value: unknown): ModelToolCall | null {
    if (!value || typeof value !== "object") return null;
    const raw = value as Record<string, any>;
    const id = clean(raw.id, 200);
    const name = clean(raw.function?.name, 100);
    const args = typeof raw.function?.arguments === "string"
        ? raw.function.arguments.slice(0, 16_000)
        : "";
    if (!id || raw.type !== "function" || name !== LEARNING_TOOL_NAME || !args) return null;
    return { id, type: "function", function: { name, arguments: args } };
}

export function learningToolCallsFromMessage(message: unknown): ModelToolCall[] {
    if (!message || typeof message !== "object") return [];
    const calls = Array.isArray((message as any).tool_calls)
        ? (message as any).tool_calls
        : [];
    return calls.map(toolCall).filter((call): call is ModelToolCall => !!call).slice(0, 3);
}

export function learningToolDefinition(llm: LLMProvider): Record<string, unknown>[] {
    if (llm.providerId !== "deepseek" || !llm.canAutoLearn) return [];
    return [{
        type: "function",
        function: {
            name: LEARNING_TOOL_NAME,
            description: [
                "查证一个当前实现确实缺少的、版本敏感的公开 Java API 事实，并返回经过来源验证的实现知识。",
                "仅在无法从当前 prompt 的静态契约或已验证知识确定精确签名、枚举常量、行为、迁移规则或 Maven 坐标时调用。",
                "不要用于项目内部类、普通 Java/Bukkit 常识、代码生成本身，也不要提交用户代码、项目名、私有包名或业务数据。",
                "Paper/Bukkit/Adventure 等核心公开命名空间使用 public_api；第三方插件 API 仅在任务已声明该依赖时使用 external_plugin。",
                "每次调用只描述一个原子事实；如果当前上下文已经给出答案，直接完成任务。",
            ].join(" "),
            parameters: {
                type: "object",
                additionalProperties: false,
                properties: {
                    subject: {
                        type: "string",
                        description: "需要查证的公开依赖、全限定类型、成员或枚举常量。",
                    },
                    question: {
                        type: "string",
                        description: "包含目标核心和版本的精确技术问题。",
                    },
                    answerType: {
                        type: "string",
                        enum: ["signature", "coordinate", "behavior", "migration", "rule"],
                    },
                    sourcePolicy: {
                        type: "string",
                        enum: ["api_signature", "dependency", "behavior", "release"],
                    },
                    integrationKind: {
                        type: "string",
                        enum: ["public_api", "nms", "craftbukkit", "version_reflection", "external_plugin"],
                        description: "目标集成类别；public_api 仅用于核心公开命名空间，第三方插件使用 external_plugin。",
                    },
                    dependency: {
                        type: "string",
                        description: "公开依赖名或 Maven 坐标；不适用时传空字符串。",
                    },
                    packageName: {
                        type: "string",
                        description: "被查证 API 的公开包名；不适用时传空字符串。",
                    },
                    symbol: {
                        type: "string",
                        description: "尽量使用全限定符号，如 org.bukkit.Particle.SLIME。",
                    },
                    searchQueries: {
                        type: "array",
                        items: { type: "string" },
                        description: "1 到 4 条面向官方文档、版本化 JavaDoc 或固定源码标签的查询。",
                    },
                    acceptanceCriteria: {
                        type: "array",
                        items: { type: "string" },
                        description: "1 到 4 条可由公开来源直接验证的验收条件。",
                    },
                },
                required: [
                    "subject", "question", "answerType", "sourcePolicy", "integrationKind",
                    "dependency", "packageName", "symbol", "searchQueries", "acceptanceCriteria",
                ],
            },
        },
    }];
}

function defaultQuery(subject: string, coreType: string, mcVersion: string): string {
    return `${subject} ${coreType || "Paper"} ${mcVersion} official Javadoc API`;
}

function defaultCriterion(answerType: KnowledgeAnswerType, coreType: string, mcVersion: string): string {
    if (answerType === "coordinate") {
        return `Official metadata states the Maven coordinate and repository for ${coreType || "Paper"} ${mcVersion}.`;
    }
    return `Versioned official documentation or immutable source states the exact ${answerType} for ${coreType || "Paper"} ${mcVersion}.`;
}

function identifierKey(value: unknown): string {
    return clean(value, 240).toLowerCase().replace(/[^a-z0-9]/g, "");
}

function hasNamespace(value: string, prefixes: string[]): boolean {
    const normalized = value.trim().toLowerCase().replace(/\//g, ".");
    return prefixes.some((prefix) => normalized === prefix || normalized.startsWith(`${prefix}.`));
}

function allowedExternalDependency(dependency: string, allowed: string[]): boolean {
    const keys = (value: string) => new Set([
        identifierKey(value),
        ...value.split(/[:/@\s]+/).map(identifierKey),
    ].filter((key) => key.length >= 3));
    const requested = keys(dependency);
    if (!requested.size) return false;
    return allowed.some((candidate) => {
        const candidateKeys = keys(String(candidate));
        return [...requested].some((key) => candidateKeys.has(key));
    });
}

export function isAllowedModelLearningNeed(
    need: KnowledgeNeed,
    allowedDependencies: string[] = [],
): boolean {
    const integrationKind = need.integrationKind;
    const targets = [need.claim.subject, need.scope.packageName, need.scope.symbol]
        .filter((value): value is string => !!value);
    const targetsNamespace = (prefixes: string[]) => targets.some((value) => hasNamespace(value, prefixes));
    if (integrationKind === "public_api") {
        const explicitTargets = [need.scope.packageName, need.scope.symbol]
            .filter((value): value is string => !!value);
        return explicitTargets.length
            ? explicitTargets.some((value) => hasNamespace(value, CORE_PUBLIC_PREFIXES))
            : targetsNamespace(CORE_PUBLIC_PREFIXES)
                || CORE_DEPENDENCY_KEYS.has(identifierKey(need.scope.dependency || need.claim.subject));
    }
    if (integrationKind === "nms") return targetsNamespace(["net.minecraft"]);
    if (integrationKind === "craftbukkit") return targetsNamespace(["org.bukkit.craftbukkit"]);
    if (integrationKind === "version_reflection") {
        return targetsNamespace(["net.minecraft", "org.bukkit.craftbukkit"])
            && /(?:reflect|class\.forname|getdeclared|getmethod|getfield|反射)/i.test(need.claim.question);
    }
    return integrationKind === "external_plugin"
        && allowedExternalDependency(need.scope.dependency || need.claim.subject, allowedDependencies);
}

export function modelLearningAllowedPublicTerms(needs: KnowledgeNeed[]): string[] {
    const terms = new Set<string>();
    for (const need of needs) {
        for (const raw of [
            need.claim.subject,
            need.scope.dependency,
            need.scope.packageName,
            need.scope.symbol,
        ]) {
            const normalized = clean(raw, 240).toLowerCase().replace(/\\/g, "/");
            if (!normalized) continue;
            terms.add(normalized);
            terms.add(normalized.replace(/\//g, "."));
            terms.add(normalized.replace(/\./g, "/"));
            for (const part of normalized.split(/[^a-z0-9_$]+/)) {
                if (part.length >= 4) terms.add(part);
            }
        }
    }
    return [...terms];
}

function needFromToolCall(
    call: ModelToolCall,
    defaults: { coreType?: string; mcVersion?: string },
): KnowledgeNeed | null {
    let args: Record<string, unknown>;
    try {
        const parsed = JSON.parse(call.function.arguments);
        if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return null;
        args = parsed as Record<string, unknown>;
    } catch {
        return null;
    }

    const subject = clean(args.subject, 240);
    const question = clean(args.question, 600);
    const answerType = ANSWER_TYPES.has(args.answerType as KnowledgeAnswerType)
        ? args.answerType as KnowledgeAnswerType
        : null;
    const sourcePolicy = SOURCE_POLICIES.has(args.sourcePolicy as SourcePolicy)
        ? args.sourcePolicy as SourcePolicy
        : null;
    const integrationKind = INTEGRATION_KINDS.has(args.integrationKind as LearningIntegrationKind)
        ? args.integrationKind as LearningIntegrationKind
        : null;
    if (!subject || !question || !answerType || !sourcePolicy || !integrationKind) return null;

    const dependency = clean(args.dependency, 180);
    const packageName = clean(args.packageName, 180);
    const symbol = clean(args.symbol, 240);
    const coreType = clean(defaults.coreType, 40);
    const mcVersion = clean(defaults.mcVersion, 80);
    const searchQueries = cleanList(args.searchQueries, 4, 300);
    const acceptanceCriteria = cleanList(args.acceptanceCriteria, 4, 300);
    const idKey = call.id.replace(/[^a-z0-9]/gi, "").slice(-40) || crypto.randomUUID().replace(/-/g, "");
    const trigger = integrationKind === "external_plugin"
        ? "dependency_gap" as const
        : integrationKind === "public_api"
            ? "contract_miss" as const
            : "version_gap" as const;
    const triggerReason = integrationKind === "external_plugin"
        ? "external_plugin_contract" as const
        : integrationKind === "version_reflection"
            ? "reflection_contract" as const
            : integrationKind === "nms" || integrationKind === "craftbukkit"
                ? "nms_version_sensitive" as const
                : undefined;
    const raw: KnowledgeNeed = {
        id: `tool-${idKey}`.slice(0, 80),
        kind: "fact",
        trigger,
        specificity: symbol ? "exact" : dependency || packageName ? "scoped" : "ambiguous",
        claim: { subject, question, answerType },
        scope: {
            ...(coreType ? { coreType } : {}),
            ...(mcVersion ? { mcVersion } : {}),
            ...(dependency ? { dependency } : {}),
            ...(packageName ? { packageName } : {}),
            ...(symbol ? { symbol } : {}),
        },
        risk: integrationKind === "public_api" ? "medium" : "high",
        sourcePolicy,
        integrationKind,
        ...(triggerReason ? { triggerReason } : {}),
        searchQueries: searchQueries.length
            ? searchQueries
            : [defaultQuery(subject, coreType, mcVersion)],
        acceptanceCriteria: acceptanceCriteria.length
            ? acceptanceCriteria
            : [defaultCriterion(answerType, coreType, mcVersion)],
    };
    return assessKnowledgeNeeds([raw], defaults, 1).accepted[0] ?? null;
}

function assistantMessage(value: unknown, calls: ModelToolCall[]): ModelChatMessage {
    const raw = value && typeof value === "object" ? value as Record<string, unknown> : {};
    return {
        role: "assistant",
        content: typeof raw.content === "string" ? raw.content.slice(0, 40_000) : "",
        ...(typeof raw.reasoning_content === "string" ? {
            reasoning_content: raw.reasoning_content.slice(0, 80_000),
        } : {}),
        tool_calls: calls,
    };
}

function safeMessages(value: ModelChatMessage[]): ModelChatMessage[] {
    return value.slice(-16).map((message) => ({
        ...message,
        content: typeof message.content === "string" ? message.content.slice(0, 80_000) : "",
        ...(message.reasoning_content === undefined ? {} : {
            reasoning_content: message.reasoning_content.slice(0, 80_000),
        }),
        ...(message.tool_calls === undefined ? {} : {
            tool_calls: message.tool_calls.slice(0, 3),
        }),
    }));
}

export async function createModelLearningRequest(input: {
    message: unknown;
    messages: ModelChatMessage[];
    origin: ModelLearningOrigin;
    originKey: string;
    targetPath?: string;
    round?: number;
    coreType?: string;
    mcVersion?: string;
    allowedDependencies?: string[];
}): Promise<ModelLearningRequest | null> {
    const calls = learningToolCallsFromMessage(input.message);
    if (!calls.length) return null;
    const round = Math.max(1, Math.floor(Number(input.round) || 1));
    if (round > MAX_LEARNING_TOOL_ROUNDS) throw new Error("learning_tool_round_limit");

    const needs: KnowledgeNeed[] = [];
    const callNeedIds: Record<string, string> = {};
    const seenCallIds = new Set<string>();
    for (const call of calls) {
        if (seenCallIds.has(call.id)) throw new Error("learning_tool_arguments_invalid");
        seenCallIds.add(call.id);
        const need = needFromToolCall(call, {
            coreType: input.coreType,
            mcVersion: input.mcVersion,
        });
        if (!need || !isAllowedModelLearningNeed(need, input.allowedDependencies ?? [])) {
            throw new Error("learning_tool_arguments_invalid");
        }
        needs.push(need);
        callNeedIds[call.id] = need.id;
    }

    const lookupHash = await learningLookupHash(needs);
    return {
        schemaVersion: "model_learning_tool.v1",
        requestId: `learnreq_${crypto.randomUUID().replace(/-/g, "")}`,
        origin: input.origin,
        originKey: clean(input.originKey, 500),
        targetPath: clean(input.targetPath, 500),
        round,
        createdAt: Date.now(),
        lookupHash,
        needs,
        callNeedIds,
        messages: safeMessages([
            ...input.messages,
            assistantMessage(input.message, calls),
        ]),
    };
}

function validRequest(value: unknown): value is ModelLearningRequest {
    if (!value || typeof value !== "object") return false;
    const request = value as ModelLearningRequest;
    return request.schemaVersion === "model_learning_tool.v1"
        && /^learnreq_[a-f0-9]{32}$/i.test(request.requestId)
        && ["planner", "generate", "review", "rework", "fix"].includes(request.origin)
        && !!request.originKey
        && Number.isInteger(request.round)
        && request.round >= 1
        && request.round <= MAX_LEARNING_TOOL_ROUNDS
        && /^[a-f0-9]{64}$/.test(request.lookupHash)
        && Array.isArray(request.needs)
        && request.needs.length > 0
        && request.needs.length <= 3
        && !!request.callNeedIds
        && Array.isArray(request.messages);
}

export function getModelLearningRequest(state: any, requestId: string): ModelLearningRequest | null {
    const value = state?.modelLearningRequests?.[requestId];
    return validRequest(value) ? value : null;
}

export function findModelLearningRequest(
    state: any,
    originKey: string,
): ModelLearningRequest | null {
    const values = state?.modelLearningRequests && typeof state.modelLearningRequests === "object"
        ? Object.values(state.modelLearningRequests)
        : [];
    const matches = values.filter((value): value is ModelLearningRequest =>
        validRequest(value) && value.originKey === originKey
    );
    return matches.sort((left, right) => right.createdAt - left.createdAt)[0] ?? null;
}

export function putModelLearningRequest(state: any, request: ModelLearningRequest): void {
    const current = state.modelLearningRequests && typeof state.modelLearningRequests === "object"
        ? state.modelLearningRequests as Record<string, unknown>
        : {};
    current[request.requestId] = request;
    const entries = Object.entries(current)
        .filter(([, value]) => validRequest(value))
        .sort(([, left], [, right]) => (right as ModelLearningRequest).createdAt - (left as ModelLearningRequest).createdAt)
        .slice(0, MAX_STORED_REQUESTS);
    state.modelLearningRequests = Object.fromEntries(entries);
}

export function removeModelLearningRequest(state: any, requestId: string): void {
    if (!state?.modelLearningRequests || typeof state.modelLearningRequests !== "object") return;
    delete state.modelLearningRequests[requestId];
    if (!Object.keys(state.modelLearningRequests).length) delete state.modelLearningRequests;
}

export function setModelLearningRequestResult(
    state: any,
    requestId: string,
    result: ModelLearningRequestResult,
): ModelLearningRequest | null {
    const request = getModelLearningRequest(state, requestId);
    if (!request) return null;
    request.result = result;
    putModelLearningRequest(state, request);
    return request;
}

export function sameModelLearningAuthorization(
    left: { requestId: string; needsFingerprint: string } | null | undefined,
    right: { requestId: string; needsFingerprint: string } | null | undefined,
): boolean {
    return !!left && !!right
        && left.requestId === right.requestId
        && left.needsFingerprint === right.needsFingerprint
        && /^[a-f0-9]{64}$/.test(left.needsFingerprint)
        && /^[a-f0-9]{64}$/.test(right.needsFingerprint);
}

export function currentModelLearningAuthorization(
    state: any,
    requestId: string,
): { requestId: string; needsFingerprint: string } | null {
    const request = getModelLearningRequest(state, requestId);
    return request ? { requestId, needsFingerprint: request.lookupHash } : null;
}

export function learningToolResultMessages(
    request: ModelLearningRequest,
    result: ModelLearningToolResult,
): ModelChatMessage[] {
    const calls = request.messages[request.messages.length - 1]?.tool_calls ?? [];
    return calls.map((call) => {
        const needId = request.callNeedIds[call.id];
        const need = request.needs.find((candidate) => candidate.id === needId);
        return {
            role: "tool" as const,
            tool_call_id: call.id,
            content: JSON.stringify({
                status: result.status,
                ...(result.reasonCode ? { reasonCode: result.reasonCode } : {}),
                subject: need?.claim.subject ?? "",
                question: need?.claim.question ?? "",
                verifiedKnowledge: result.knowledgeContext,
                instruction: result.knowledgeContext
                    ? "Use only the verified knowledge above for this external API fact."
                    : "No verified evidence became available. Continue conservatively without inventing an API contract.",
            }),
        };
    });
}

export function modelLearningContinuation(
    request: ModelLearningRequest,
    result: ModelLearningToolResult,
): ModelChatMessage[] {
    return safeMessages([
        ...request.messages,
        ...learningToolResultMessages(request, result),
    ]);
}
