import type { KnowledgeNeed } from "./learning/types";

export type ApiContractId = "spigot" | "paper" | "placeholderapi" | "vault" | "worldguard";

export interface MavenDependency {
    groupId: string;
    artifactId: string;
    version: string;
    scope?: string;
}

export interface ApiContractInput {
    coreType?: string;
    version?: string;
    externalDeps?: string[];
    generatedFiles?: {
        path: string;
        content?: string;
        apiSummary?: {
            className?: string;
            constructors?: { params?: string }[];
        } | null;
    }[];
}

interface ApiContract {
    id: ApiContractId;
    title: string;
    majors?: number[];
    matches?: (dep: MavenDependency) => boolean;
    importPattern?: RegExp;
    rules: string[];
}

const CONTRACTS: ApiContract[] = [
    {
        id: "spigot",
        title: "Spigot / Bukkit",
        rules: [
            "Player#setPlayerListHeaderFooter(String, String) 接收字符串；不得把 Adventure Component 传给这个方法。",
            "Scoreboard#registerNewObjective 的展示名必须使用目标 Spigot API 实际声明的 String 重载，不得臆造 Component 重载。",
            "除非 pom.xml 明确加入 Adventure 且目标方法签名明确接收 Component，否则 Bukkit 消息与展示文本保持 String/ChatColor。",
        ],
    },
    {
        id: "paper",
        title: "Paper / Adventure",
        rules: [
            "继承自 Bukkit 的 setPlayerListHeaderFooter(String, String) 仍按字符串签名调用。",
            "目标为具备 Adventure API 的现代 Paper 时，页眉页脚应使用 Audience#sendPlayerListHeaderAndFooter(Component, Component)，不要给字符串方法硬塞 Component。",
            "现代 Paper 的 Scoreboard 提供 Component 展示名重载；旧版 Paper 是否可用必须服从目标版本签名，不得与 Spigot 签名混用。",
            "不要因为目标是 Paper 就假定所有 Bukkit 同名方法都存在 Component 重载；以目标版本真实签名为准。",
        ],
    },
    {
        id: "placeholderapi",
        title: "PlaceholderAPI 2.x",
        majors: [2],
        matches: (d) => d.groupId === "me.clip" && d.artifactId.toLowerCase() === "placeholderapi",
        importPattern: /\bme\.clip\.placeholderapi\./,
        rules: [
            "Maven 坐标使用 me.clip:placeholderapi:2.x，仓库使用 https://repo.extendedclip.com/content/repositories/placeholderapi/，scope=provided。",
            "PlaceholderAPI.setPlaceholders(OfflinePlayer, String) 返回 String，不返回 Adventure Component。",
            "PlaceholderAPI.setBracketPlaceholders(OfflinePlayer, String) 同样返回 String；List 输入重载返回 List<String>。",
            "不得把 setPlaceholders 的结果赋给 Component，也不得传给只接受 Component 的 serializer；需要 Component 时先取得 String，再显式 deserialize。",
            "运行时按 depend/softdepend 语义检查 PlaceholderAPI 是否启用；Maven 依赖使用 provided。",
        ],
    },
    {
        id: "vault",
        title: "VaultAPI 1.x",
        majors: [1],
        matches: (d) => d.groupId.toLowerCase() === "com.github.milkbowl" && d.artifactId.toLowerCase() === "vaultapi",
        importPattern: /\bnet\.milkbowl\.vault\./,
        rules: [
            "Maven 坐标使用 com.github.MilkBowl:VaultAPI:1.x，仓库使用 https://jitpack.io，scope=provided。",
            "通过 ServicesManager#getRegistration(Economy.class) 获取 RegisteredServiceProvider<Economy>，再调用 getProvider()。",
            "Economy#getBalance(OfflinePlayer) 返回 double，Economy#format(double) 返回 String。",
            "depositPlayer/withdrawPlayer 返回 EconomyResponse，不得当作 boolean、double 或 String 使用；应检查 transactionSuccess()。",
            "Vault 与经济实现插件缺失时必须有明确降级路径；Maven 依赖使用 provided。",
        ],
    },
    {
        id: "worldguard",
        title: "WorldGuard 7.x",
        majors: [7],
        matches: (d) => d.groupId === "com.sk89q.worldguard" && d.artifactId.toLowerCase().includes("worldguard"),
        importPattern: /\bcom\.sk89q\.worldguard\./,
        rules: [
            "Maven 坐标使用 com.sk89q.worldguard:worldguard-bukkit:7.x，仓库使用 https://maven.enginehub.org/repo/，scope=provided。",
            "WorldGuard 7 的区域 API 使用 WorldGuard.getInstance().getPlatform().getRegionContainer()。",
            "Bukkit World/Location/Player 与 WorldEdit/WorldGuard 类型不得直接互换；使用 BukkitAdapter.adapt(...) 或 WorldGuardPlugin#wrapPlayer(...)。",
            "RegionContainer#get 接收 WorldEdit World；RegionQuery 与 ApplicableRegionSet 的返回类型不得凭名称猜测。",
            "WorldGuard/WorldEdit 依赖使用 provided，并按 depend/softdepend 处理缺失插件。",
        ],
    },
];

function resolveProperty(value: string, properties: Map<string, string>): string {
    let result = value.trim();
    for (let i = 0; i < 6 && /\$\{[^}]+}/.test(result); i++) {
        result = result.replace(/\$\{([^}]+)}/g, (_, key) => properties.get(String(key)) ?? `\${${key}}`);
    }
    return result.trim();
}

function tagValue(xml: string, tag: string): string {
    const match = xml.match(new RegExp(`<${tag}\\s*>([\\s\\S]*?)<\\/${tag}>`, "i"));
    return match?.[1]?.trim() ?? "";
}

export function parsePomDependencies(content: string): MavenDependency[] {
    if (!content.trim()) return [];
    const properties = new Map<string, string>();
    const propsBody = content.match(/<properties\b[^>]*>([\s\S]*?)<\/properties>/i)?.[1] ?? "";
    for (const match of propsBody.matchAll(/<([A-Za-z0-9_.-]+)\s*>([\s\S]*?)<\/\1>/g)) {
        properties.set(match[1], match[2].trim());
    }

    const dependencies: MavenDependency[] = [];
    const seen = new Set<string>();
    for (const match of content.matchAll(/<dependency\b[^>]*>([\s\S]*?)<\/dependency>/gi)) {
        const block = match[1];
        const groupId = resolveProperty(tagValue(block, "groupId"), properties);
        const artifactId = resolveProperty(tagValue(block, "artifactId"), properties);
        const version = resolveProperty(tagValue(block, "version"), properties);
        const scope = resolveProperty(tagValue(block, "scope"), properties);
        if (!groupId || !artifactId) continue;
        const key = `${groupId}:${artifactId}:${version}`;
        if (seen.has(key)) continue;
        seen.add(key);
        dependencies.push({ groupId, artifactId, version, scope: scope || undefined });
    }
    return dependencies;
}

function dependencyMajor(version: string): number | null {
    const match = version.match(/(?:^|[^0-9])(\d+)(?:\.|$)/);
    return match ? Number(match[1]) : null;
}

function supportsPaperAdventure(version: string | undefined): boolean {
    const match = String(version ?? "").match(/^(\d+)\.(\d+)/);
    if (!match) return false;
    const major = Number(match[1]);
    const minor = Number(match[2]);
    return major > 1 || (major === 1 && minor >= 17);
}

function targetMinecraftVersion(input: ApiContractInput): string | undefined {
    if (/^\d+\.\d+/.test(String(input.version ?? ""))) return input.version;
    const pom = (input.generatedFiles ?? []).find((file) => /(^|\/)pom\.xml$/i.test(file.path));
    const coreDependency = parsePomDependencies(pom?.content ?? "").find((dependency) =>
        ["paper-api", "spigot-api"].includes(dependency.artifactId.toLowerCase()),
    );
    return coreDependency?.version.match(/\d+\.\d+/)?.[0];
}

function normalizeExternalName(value: string): ApiContractId | null {
    const normalized = value.toLowerCase().replace(/[^a-z0-9]/g, "");
    if (normalized.includes("placeholderapi") || normalized === "papi") return "placeholderapi";
    if (normalized.includes("vault")) return "vault";
    if (normalized.includes("worldguard")) return "worldguard";
    return null;
}

// major 必须与依赖名分隔，避免把 bridge8 这类 artifact 尾数当成版本。
const CONTRACT_MAJOR_PATTERNS: Partial<Record<ApiContractId, RegExp>> = {
    placeholderapi: /\bplaceholder\s*api\b(?:\s*[:@]\s*|\s+(?:(?:major|version|v)\s*)?)(\d+)(?=(?:\.\d+|\.x)*(?:[^a-z0-9_]|$))/gi,
    vault: /\bvault(?:\s*api)?\b(?:\s*[:@]\s*|\s+(?:(?:major|version|v)\s*)?)(\d+)(?=(?:\.\d+|\.x)*(?:[^a-z0-9_]|$))/gi,
    worldguard: /\bworld\s*guard(?:\s*(?:-\s*)?bukkit)?\b(?:\s*[:@]\s*|\s+(?:(?:major|version|v)\s*)?)(\d+)(?=(?:\.\d+|\.x)*(?:[^a-z0-9_]|$))/gi,
};

function explicitContractMajors(value: string, id: ApiContractId): number[] {
    const pattern = CONTRACT_MAJOR_PATTERNS[id];
    if (!pattern) return [];
    return [...value.matchAll(pattern)].map((match) => Number(match[1]));
}

function unsupportedContractMajor(contract: ApiContract, majors: number[]): number | null {
    const supported = contract.majors;
    if (!supported) return null;
    return majors.find((major) => !supported.includes(major)) ?? null;
}

const CONTRACT_KNOWLEDGE_PATTERNS: Record<ApiContractId, RegExp[]> = {
    spigot: [
        /\bsetplayerlistheaderfooter\b/,
        /\bregisternewobjective\b/,
    ],
    paper: [
        /\bsetplayerlistheaderfooter\b/,
        /\bsendplayerlistheaderandfooter\b/,
    ],
    placeholderapi: [
        /\bsetplaceholders\b/,
        /\bsetbracketplaceholders\b/,
    ],
    vault: [
        /\bgetregistration\b/,
        /\bregisteredserviceprovider\b/,
        /\bgetbalance\b/,
        /\bdepositplayer\b/,
        /\bwithdrawplayer\b/,
        /\beconomyresponse\b/,
        /\btransactionsuccess\b/,
    ],
    worldguard: [
        /\bworldguard\s*(?:#|\.)?\s*getinstance\b/,
        /\bregioncontainer\s*(?:#|\.)?\s*get\b/,
        /\bbukkitadapter\s*(?:#|\.)?\s*adapt\b/,
        /\bworldguardplugin\s*(?:#|\.)?\s*wrapplayer\b/,
    ],
};

export function resolveApiContractIds(input: ApiContractInput): { ids: ApiContractId[]; warnings: string[] } {
    const files = input.generatedFiles ?? [];
    const pom = files.find((file) => /(^|\/)pom\.xml$/i.test(file.path));
    const dependencies = parsePomDependencies(pom?.content ?? "");
    const source = files.filter((file) => file.path.endsWith(".java")).map((file) => file.content ?? "").join("\n");
    const requested = new Map<ApiContractId, string[]>();
    for (const value of input.externalDeps ?? []) {
        const id = normalizeExternalName(value);
        if (!id) continue;
        requested.set(id, [...(requested.get(id) ?? []), value]);
    }
    const ids: ApiContractId[] = [];
    const warnings: string[] = [];
    const declaredCore = (input.coreType ?? "").toLowerCase();
    const coreDependency = dependencies.find((dependency) => {
        const artifact = dependency.artifactId.toLowerCase();
        return artifact === "paper-api" || artifact === "spigot-api";
    });
    const core = coreDependency?.artifactId.toLowerCase() === "spigot-api"
        ? "spigot"
        : coreDependency?.artifactId.toLowerCase() === "paper-api"
            ? "paper"
            : declaredCore.includes("spigot") ? "spigot" : "paper";
    ids.push(core);

    for (const contract of CONTRACTS.filter((item) => !["spigot", "paper"].includes(item.id))) {
        const matchedDependency = dependencies.find((dep) => contract.matches?.(dep));
        const requestedValues = requested.get(contract.id) ?? [];
        const detected = !!matchedDependency || requestedValues.length > 0 || !!contract.importPattern?.test(source);
        if (!detected) continue;
        const matchedMajor = matchedDependency ? dependencyMajor(matchedDependency.version) : null;
        const unsupportedDependencyMajor = matchedMajor == null
            ? null
            : unsupportedContractMajor(contract, [matchedMajor]);
        const unsupportedRequestedMajor = unsupportedContractMajor(
            contract,
            requestedValues.flatMap((value) => explicitContractMajors(value, contract.id)),
        );
        const unsupportedVersion = unsupportedDependencyMajor != null
            ? matchedDependency!.version
            : unsupportedRequestedMajor != null ? String(unsupportedRequestedMajor) : "";
        if (unsupportedVersion) {
            warnings.push(`${contract.title} 版本 ${unsupportedVersion} 不在内置契约范围内；只服从编译器诊断，不套用近似签名。`);
            continue;
        }
        ids.push(contract.id);
    }

    return { ids, warnings };
}

function knowledgeNeedText(need: KnowledgeNeed): string {
    return [
        need.claim.subject,
        need.claim.question,
        need.scope.dependency,
        need.scope.packageName,
        need.scope.symbol,
    ].filter(Boolean).join(" ").toLowerCase();
}

function knowledgeNeedHasSupportedMajor(contract: ApiContract, need: KnowledgeNeed): boolean {
    const majors = [
        ...explicitContractMajors(need.scope.dependency ?? "", contract.id),
        ...explicitContractMajors(need.claim.question, contract.id),
    ];
    return unsupportedContractMajor(contract, majors) == null;
}

function coordinateKnowledgeContractId(value: string): ApiContractId | null {
    const normalized = value.toLowerCase().replace(/[^a-z0-9]/g, "");
    if (/^(?:placeholderapi|meclipplaceholderapi)\d*$/.test(normalized)) return "placeholderapi";
    if (/^(?:vault|vaultapi|comgithubmilkbowlvaultapi)\d*$/.test(normalized)) return "vault";
    if (/^(?:worldguard|worldguardbukkit|comsk89qworldguardworldguardbukkit)\d*$/.test(normalized)) return "worldguard";
    return null;
}

export function isKnowledgeNeedCoveredByApiContracts(input: ApiContractInput, need: KnowledgeNeed): boolean {
    const activeIds = new Set(resolveApiContractIds(input).ids);
    const text = knowledgeNeedText(need);

    if (need.claim.answerType === "coordinate") {
        const dependencyId = coordinateKnowledgeContractId(need.scope.dependency || need.claim.subject);
        if (!dependencyId || !activeIds.has(dependencyId)) return false;
        const contract = CONTRACTS.find((item) => item.id === dependencyId)!;
        return knowledgeNeedHasSupportedMajor(contract, need);
    }

    for (const id of activeIds) {
        const contract = CONTRACTS.find((item) => item.id === id)!;
        if (!knowledgeNeedHasSupportedMajor(contract, need)) continue;
        if (CONTRACT_KNOWLEDGE_PATTERNS[id].some((pattern) => pattern.test(text))) return true;
    }
    return false;
}

export function partitionKnowledgeNeedsByApiContracts(
    input: ApiContractInput,
    needs: KnowledgeNeed[],
): { covered: KnowledgeNeed[]; uncovered: KnowledgeNeed[] } {
    const covered: KnowledgeNeed[] = [];
    const uncovered: KnowledgeNeed[] = [];
    for (const need of needs) {
        (isKnowledgeNeedCoveredByApiContracts(input, need) ? covered : uncovered).push(need);
    }
    return { covered, uncovered };
}

export function buildApiContractContext(input: ApiContractInput): string {
    const resolved = resolveApiContractIds(input);
    const blocks = resolved.ids.map((id) => {
        const contract = CONTRACTS.find((item) => item.id === id)!;
        return [`【${contract.title}】`, ...contract.rules.map((rule) => `- ${rule}`)].join("\n");
    });
    if (resolved.warnings.length) {
        blocks.push(["【版本边界】", ...resolved.warnings.map((warning) => `- ${warning}`)].join("\n"));
    }
    return [
        "═══ 目标依赖 API 契约（高优先级） ═══",
        "编译器 required/found 与下列契约优先于模型记忆；不得臆造返回类型、重载或版本变化。",
        ...blocks,
    ].join("\n\n");
}

export function findKnownApiIssues(input: ApiContractInput, content: string): string[] {
    if (!content.trim()) return [];
    // 当前候选尚未写回 generatedFiles 时，也要能凭 import 启用对应第三方契约。
    const { ids } = resolveApiContractIds({
        ...input,
        generatedFiles: [...(input.generatedFiles ?? []), { path: "<candidate>.java", content }],
    });
    const active = new Set(ids);
    const issues: string[] = [];
    const componentVariables = new Set<string>();
    const importsKyoriTextComponent = /\bimport\s+net\.kyori\.adventure\.text\.(?:TextComponent|\*)\s*;/.test(content);
    for (const match of content.matchAll(/\b(Component|TextComponent)\s+([A-Za-z_$][\w$]*)\s*=/g)) {
        // Paper 另有合法的 Bungee TextComponent 重载；只有 Kyori TextComponent（或 Spigot）才按此规则拦截。
        if (match[1] === "Component" || importsKyoriTextComponent || active.has("spigot")) {
            componentVariables.add(match[2]);
        }
    }
    const looksLikeComponent = (expression: string) => {
        const trimmed = expression.trim();
        return componentVariables.has(trimmed)
            || /LegacyComponentSerializer[^;]*\.deserialize\s*\(/.test(trimmed)
            || /\bComponent\s*\./.test(trimmed);
    };

    if (active.has("placeholderapi")) {
        if (/\b(?:Component|TextComponent)\s+[A-Za-z_$][\w$]*\s*=\s*PlaceholderAPI\.set(?:Bracket)?Placeholders\s*\(/.test(content)) {
            issues.push("PlaceholderAPI.setPlaceholders/setBracketPlaceholders 返回 String，不能赋给 Component。");
        }
        if (/\.serialize\s*\(\s*PlaceholderAPI\.set(?:Bracket)?Placeholders\s*\(/.test(content)) {
            issues.push("不得把 PlaceholderAPI 的 String 返回值直接传给 Component serializer.serialize。");
        }
    }

    if (active.has("spigot") || active.has("paper")) {
        for (const match of content.matchAll(/\.setPlayerListHeaderFooter\s*\(([\s\S]{0,600}?)\)\s*;/g)) {
            const args = match[1].split(",");
            if (args.length >= 2 && (looksLikeComponent(args[0]) || looksLikeComponent(args.slice(1).join(",")))) {
                issues.push("setPlayerListHeaderFooter 接收 String；Component 页眉页脚必须改用目标核心明确提供的 Component 方法。");
                break;
            }
        }
        if (active.has("spigot") || (active.has("paper") && !supportsPaperAdventure(targetMinecraftVersion(input)))) {
            for (const match of content.matchAll(/\.registerNewObjective\s*\(([\s\S]{0,600}?)\)\s*;/g)) {
                const args = match[1].split(",");
                if (args.length >= 3 && looksLikeComponent(args.slice(2).join(","))) {
                    issues.push("registerNewObjective 的展示名参数与目标核心签名不符，不得臆造 Component 重载。");
                    break;
                }
            }
        }
    }

    if (active.has("vault") && /\b(?:boolean|double|String)\s+[A-Za-z_$][\w$]*\s*=\s*[^;\n]*\.(?:depositPlayer|withdrawPlayer)\s*\(/.test(content)) {
        issues.push("Vault depositPlayer/withdrawPlayer 返回 EconomyResponse，不能赋给 boolean、double 或 String。");
    }

    if (active.has("worldguard") && /RegionContainer[\s\S]{0,800}\.get\s*\(\s*(?:[A-Za-z_$][\w$]*\.getWorld\(\)|Bukkit\.getWorld\([^)]*\))\s*\)/.test(content)) {
        issues.push("RegionContainer#get 需要 WorldEdit World；Bukkit World 必须先经 BukkitAdapter.adapt。");
    }

    for (const file of input.generatedFiles ?? []) {
        const summary = file.apiSummary;
        if (!summary?.className || !summary.constructors?.length) continue;
        if (summary.constructors.some((constructor) => !(constructor.params ?? "").trim())) continue;
        const escapedClass = summary.className.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
        if (new RegExp(`\\bnew\\s+${escapedClass}\\s*\\(\\s*\\)`).test(content)) {
            const signatures = summary.constructors.map((constructor) => `${summary.className}(${constructor.params ?? ""})`).join(" / ");
            issues.push(`${summary.className} 不存在 public 无参构造器；必须使用摘要中的构造器：${signatures}。`);
        }
    }

    return [...new Set(issues)];
}
