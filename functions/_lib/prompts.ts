import type { SkillBundle } from "./skills";

/** 结构化文件摘要，用于跨文件上下文传递 */
export interface FileSummary {
    path: string;
    className?: string;
    extends?: string;
    implements?: string[];
    constructors?: { params: string }[];
    publicMethods?: { name: string; params: string; returns: string }[];
    publicFields?: string[];
    events?: string[];
    commands?: string[];
    configKeys?: string[];
    description?: string;
}

/** 文件生成器类型 */
export type GeneratorType =
    | "CommandGen"
    | "ListenerGen"
    | "TaskGen"
    | "ManagerGen"
    | "ConfigGen"
    | "ConfigClassGen"
    | "ModelGen"
    | "EnumGen"
    | "UtilGen"
    | "FileRelatedGen"
    | "MainGen";

export const GENERATOR_TYPES: GeneratorType[] = [
    "CommandGen", "ListenerGen", "TaskGen", "ManagerGen",
    "ConfigGen", "ConfigClassGen", "ModelGen", "EnumGen",
    "UtilGen", "FileRelatedGen", "MainGen",
];

/** Planner 输出中描述主类编排的"主干蓝图" */
export interface MainBlueprint {
    events: { event: string; listenerClass: string; priority?: string }[];
    commands: { name: string; executorClass: string; aliases?: string[]; permission?: string }[];
    tasks: { taskClass: string; schedule: "timer" | "once" | "async"; periodTicks?: number; delayTicks?: number; async?: boolean }[];
    services: { managerClass: string; lifecycle: "onEnable" | "lazy" }[];
    config: { defaultsCopied: boolean; files: string[] };
}

/** 单个文件的蓝图切片（dispatchGen 时计算） */
export interface BlueprintSlice {
    eventEntry?: MainBlueprint["events"][number];
    commandEntry?: MainBlueprint["commands"][number];
    taskEntry?: MainBlueprint["tasks"][number];
    serviceEntry?: MainBlueprint["services"][number];
    /** ListenerGen 且 tag=gui 时填充：配对的另一份文件路径 */
    guiPairPath?: string;
    /** MainGen 时填充：完整蓝图 */
    fullBlueprint?: MainBlueprint;
}

/** Planner 输出的单个文件项 */
export interface PlanFileItem {
    path: string;
    role: string;
    order: number;
    depends?: string[];
    generatorType: GeneratorType;
    /** ListenerGen 时可选："gui" 表示自定义 GUI 监听 */
    tag?: "gui" | null;
    /** GUI 配对：tag="gui" 时存放配对 GUI 持有类的路径 */
    pairPath?: string;
    /** 服务端计算后的深度桶索引 */
    bucket?: number;
}

/** TodoList 单项（澄清阶段） */
export interface TodoItem {
    id: string;
    question: string;
    options: string[];
    allowCustom: boolean;
    multiSelect: boolean;
    chart?: "linear" | "power2" | "power0.5" | "log" | "exp" | null;
}

/** 一轮澄清快照：一组 todos + 用户答案 */
export interface ClarifyRound {
    todos: TodoItem[];
    answers: Record<string, string | string[]>;
}

/** 将结构化摘要格式化为可读的 API 签名块 */
function formatSummaries(summaries: FileSummary[]): string {
    if (summaries.length === 0) return "";

    const lines: string[] = ["\n已生成文件的可用 API："];
    for (const s of summaries) {
        lines.push(`\n【${s.path}】`);
        if (s.description) lines.push(`  职责：${s.description}`);
        if (s.className) {
            let classLine = `  类名：${s.className}`;
            if (s.extends) classLine += ` extends ${s.extends}`;
            if (s.implements?.length) classLine += ` implements ${s.implements.join(", ")}`;
            lines.push(classLine);
        }
        if (s.publicMethods?.length) {
            lines.push("  公开方法：");
            for (const m of s.publicMethods) {
                lines.push(`    - ${m.returns} ${m.name}(${m.params})`);
            }
        }
        if (s.constructors?.length) {
            lines.push("  构造器：");
            for (const constructor of s.constructors) {
                lines.push(`    - ${s.className ?? "<class>"}(${constructor.params})`);
            }
        }
        if (s.publicFields?.length) {
            lines.push(`  公开字段：${s.publicFields.join(", ")}`);
        }
        if (s.events?.length) {
            lines.push(`  监听事件：${s.events.join(", ")}`);
        }
        if (s.commands?.length) {
            lines.push(`  注册命令：${s.commands.join(", ")}`);
        }
        if (s.configKeys?.length) {
            lines.push(`  配置键：${s.configKeys.join(", ")}`);
        }
    }
    return lines.join("\n");
}

// ─── Planner Clarify ────────────────────────────────────────

export function plannerClarifyPrompt(
    userPrompt: string,
    coreType: string,
    version: string,
    priorRounds: ClarifyRound[],
    skillContext?: string,
): { system: string; user: string } {
    const history = priorRounds.length
        ? "\n\n已完成的澄清轮次：\n" + priorRounds.map((r, i) =>
        `第 ${i + 1} 轮：\n${r.todos.map(t => `  Q[${t.id}] ${t.question} → 用户选择：${JSON.stringify(r.answers[t.id])}`).join("\n")}`
    ).join("\n")
        : "";

    return {
        system: `你是一个 Minecraft ${coreType} ${version} 插件项目规划器的澄清阶段。你的任务不是直接产出文件列表，而是先判断是否存在少数真正必须由用户确认的产品决策；没有必要问题时直接完成澄清，不得为了流程生成 TodoList。

只输出 JSON，格式如下：
{
  "done": false,
  "todos": [
    {
      "id": "persistence",
      "question": "数据持久化采用哪种方式？",
      "options": ["文本存储", "二进制存储"],
      "allowCustom": true,
      "multiSelect": false,
      "chart": null
    }
  ]
}

**需求完整性判断（最优先）**：
- 如果用户的原始需求过分模糊（如仅"写个插件"、"来点好玩的"、字数过少且无任何可识别的核心功能），或功能描述严重不完善以致无法识别出任何明确的核心玩法/操作/目标，则不要产出 todos，改为返回：
  { "needMoreInput": true, "hint": "为了帮你规划，请补充：1) ...；2) ...；3) ..." }
- hint 中列出 2-4 条具体、简短的补充问题，引导用户完善需求
- 只要能识别出至少一个明确功能点（如"一个出生点"、"记录玩家击杀数"），就不要用 needMoreInput；继续判断是否真的存在必须由用户决定的产品分叉，如果没有则直接返回 done:true

提问总原则（精简优先，宁缺毋滥）：
- 只有同时存在至少两个合理、互不兼容且会明显改变用户可感知行为的方案，并且没有自然的最小默认值时才提问。实现模型可以安全决定的技术细节必须自动补偿，不得转交用户。
- 玩家能直接触发、语义已清楚的简单操作（给物品/传送/广播/即时效果/执行一条命令等），**不要**为走流程而提问其反馈方式、权限、存储方式或异常处理；未要求反馈时默认不额外发消息，无状态操作默认无需持久化。
- 只问「确认后会显著改变实现」的决策点。若某澄清项即便确认也只带来微小功能、却会引入持久化 / 管理器等重类（大幅抬高复杂度、易生成失败），**不要问**，默认用最轻方式（内存 / PDC / 直接 config）。
- 【行为语义消歧·高优先】用户常用「动作/结果」描述需求（如「右键吃东西」「打怪掉钱」「破坏方块给经验」），但同一句话往往对应多个不同的底层事件或实现路径，选错监听事件＝整份代码跑偏，这类歧义比「要不要持久化」更致命，**只要出现且会改变实现就必须问**。但提问只能用玩家能直观理解的「行为差别」来描述，**绝不向用户暴露 PlayerInteractEvent / Consume / BlockBreak 这类事件名或 API**。仅是措辞不同、底层实现完全一致的，不问。

默认补偿规则（用户未明确指定其他行为时直接采用，不提问）：
- “进入服务器 / 进服 / 加入游戏时”默认指玩家成功进入世界后的加入事件；每次实际加入都触发，包括断线后重新加入。插件加载时已经在线的玩家不追溯触发。
- “进入服务器时发放物品”不属于登录阶段歧义，不询问握手、白名单或人物生成时机；按成功加入后发放实现。
- 未说明首次奖励、防刷或跨重启记录时，不擅自增加这些产品规则和持久化；按原文事件每次触发。
- 背包容量、空返回值等纯技术边界由代码生成阶段采用不会静默丢失结果的安全处理，不作为澄清问题。

条件规则（满足条件才问；已在历史出现过的不重复）：
- id="ui-interaction" —— **仅当**需求涉及「需要可视化选择 / 列表 / 分页 / 图形界面」时才问；纯文本提示就够的简单命令不要问，默认文本反馈。
  options 固定为：["聊天命令 + SendMessage 文本反馈", "聊天命令 + Inventory GUI 反馈"]
- id="persistence" —— **仅当**需求确实需要「跨服务器重启保留的数据」（如玩家记录 / 余额 / 积分 / 可增删的配置数据）时才问；无状态操作、或仅运行时内存状态，**绝不问** persistence，也不要因此引入任何存储类。
  options 固定为 ["文本存储", "二进制存储"]
- id="text-format" —— 仅当 persistence 已问且答「文本存储」时追问，options 固定为 ["CSV", "TXT", "YAML"]

行为语义消歧（满足条件才问；同上：历史已问过的不重复；这类优先在前几轮问，因为答案会决定后面要不要问持久化/作用域/数值）：
- id="trigger-event" —— **仅当**用户的触发描述对应多个底层事件、且选不同事件会导致不同实现时才问。本 id 的 options **不固定**、且不受下方「3~5 项」下限约束（真实分叉几个就给几个，最少 2 个，不要凑数）：针对具体歧义生成用玩家能懂的「行为差别」选项，措辞要精确到实现侧能据此唯一确定用哪个事件；严禁出现事件类名，allowCustom=true，chart=null。典型参考：
    · 「右键/使用某物」 → 「右手一按就触发（哪怕没吃成/用成）」 vs 「真正吃完/用完那一下才触发」
    · 「打/攻击生物」 → 「左键碰一下就算」 vs 「真正造成伤害才算」 vs 「把目标打死才算」
    · 「挖/破坏方块」 → 「开始挖的瞬间」 vs 「方块真正被挖断」
    · 「进服/加入」本身不问，默认成功进入世界后的加入事件；只有需求明确涉及准入校验、白名单、登录前认证或踢出玩家时，才区分登录阶段与进入世界后
- id="trigger-mode" —— **仅当**需求含「禁止/不让玩家做某事」或「当玩家做某事时…」、且分不清要阻止动作还是仅事后响应时才问。
  options 固定为：["阻止这个行为发生", "允许行为发生、只额外触发效果"]
- id="target-match" —— **仅当**需求针对「特定物品 / 某把特定武器 / 特定方块」判断、且判断依据不明时才问。
  options 固定为：["按种类判断（如所有钻石剑都算）", "只认带特定名字或特殊标记的自定义物品/方块"]
- id="effect-duration" —— **仅当**需求授予持续性能力/状态（飞行/加速/无敌/发光等）、且生效时长不明时才问。
  options 固定为：["一次性永久获得", "限定时长后自动失效", "满足某条件时持续生效、条件消失即取消"]

按需包含（根据用户需求语义判断是否需要）：
- id="growth-curve" — 当需求涉及价格/经验/等级/冷却/数值成长时必须包含
  options 必须从下列集合中选取 3-5 个：["linear", "power2", "power0.5", "log", "exp"]
  chart 字段必须为 "multi"（特殊值，前端会对每个选项分别绘制曲线）；
  或 chart 为 null 但 options 值对应函数类型字符串（推荐前者）
  实际格式：chart 设为 "multi"，options 就是函数类型名
- id="permission-prefix" — 涉及操作权限时
- id="world-scope" — 涉及方块/区域时
- id="external-plugin" — 涉及经济/占位符时（Vault/PlaceholderAPI/WorldGuard/无）
- id="command-alias" — 声明了新命令时
- id="message-config" — 声明玩家反馈文本时
- id="reload-strategy" — 有可变运行时状态时

每个 todo：
- options 数量 3~5 项
- allowCustom 一律为 true（允许用户输入其他想法）
- multiSelect 除非明确需要多选（如 external-plugin）否则为 false
- 不要产出空 todos；若确认所有必要项已覆盖，返回 {"done": true, "todos": []}

最多 5 轮澄清，其后即使还有模糊点也必须 done:true。

核心类型：${coreType}，MC 版本：${version}${skillContext ?? ""}`,
        user: `用户原始需求：${userPrompt}${history}\n\n请产出本轮的 TodoList（若已充分覆盖则返回 done:true）。`,
    };
}

// ─── Grader（复杂度分级 + 实现路径）────────────────────────────

export function graderPrompt(
    userPrompt: string,
    coreType: string,
    version: string,
    clarifyRounds?: ClarifyRound[],
    correction?: string,
    skillContext?: string,
): { system: string; user: string } {
    const clarifyBlock = clarifyRounds?.length
        ? "\n\n用户已确认的决策（分级与画图必须据此）：\n" + clarifyRounds.flatMap(r =>
        r.todos.map(t => `- ${t.question} → ${JSON.stringify(r.answers[t.id])}`)
    ).join("\n")
        : "";
    const correctionBlock = correction?.trim()
        ? `\n\n【用户对上一版理解的修正，必须采纳重画】：${correction.trim()}`
        : "";

    return {
        system: `你是一个 Minecraft ${coreType} ${version} 插件需求的「复杂度分级 + 实现路径」分析器。在生成完整 plan 之前，先抽取打分向量、定级，并在非直接级时给出可视化的实现路径。

只输出 JSON（不要任何解释、不要 markdown 代码块），格式：
{
  "valid": true,
  "vector": {
    "triggers": 1,
    "features": 1,
    "branches": 0,
    "ui": "none|command|gui_static|gui_session",
    "state_lifecycle": "none|memory|persistent",
    "state_scope": "none|player|global|cross",
    "temporality": "instant|scheduled|continuous",
    "state_shared": false,
    "external_deps": []
  },
  "level": "直接|简单|中等|复杂",
  "level_reason": "命中的主导维度一句话",
  "paths": [],
  "knowledgeNeeds": [
    {
      "id": "stable-short-id",
      "kind": "fact",
      "trigger": "contract_miss|version_gap|dependency_gap|skill_staleness",
      "specificity": "exact|scoped",
      "integrationKind": "nms|craftbukkit|version_reflection|external_plugin",
      "triggerReason": "nms_version_sensitive|reflection_contract|external_plugin_contract",
      "pathIds": ["p1"],
      "claim": {
        "subject": "明确的依赖、包名或 API 符号",
        "question": "目标版本下需要查证的单一技术事实",
        "answerType": "signature|coordinate|behavior|migration|rule"
      },
      "scope": {
        "coreType": "Paper|Spigot",
        "mcVersion": "目标 MC 版本",
        "dependency": "可选：groupId:artifactId 或插件名",
        "packageName": "可选：公开包名",
        "symbol": "可选：公开类#方法或配置键"
      },
      "risk": "low|medium|high",
      "sourcePolicy": "api_signature|dependency|behavior|release",
      "searchQueries": ["带版本与符号的精确查询"],
      "acceptanceCriteria": ["能直接判断该事实真假的验收条件"]
    }
  ]
}

打分字段含义：
- triggers 触发源数量(1|"2-3"|"4+")，features 功能点数，branches 条件分支数(含无状态分支)
- ui: none/command/gui_static/gui_session(带会话状态的 GUI)
- state_lifecycle: memory=重启丢失；persistent=跨重启需存储
- state_scope: global=全局控制变量；cross=跨世界/跨服
- temporality: scheduled=延时/定时一次；continuous=重复 task 持续监控
- state_shared: ≥2 个功能/task 读写同一份可变状态
- external_deps: 硬集成插件名，仅限 Vault / PlaceholderAPI / WorldGuard 这类 Paper 生态；软依赖不算

【核心原则】复杂度由「状态」驱动，不由功能数量驱动：
- "进服给钻石" = 无状态单动作 → 直接
- "进服给钻石 + 退服广播 + /heal" = 三需求叠加但全无状态、互不相干 → 仍是简单
- "余额持久化 + 多处读写余额" = 功能可能更少，但状态被多处共享且跨重启 → 复杂
区分「大」与「复杂」的不是功能数，是有没有被多处共享/修改的（尤其持久的）状态。

【定级指引】（你只给建议，代码侧会再按硬规则强制下限，所以宁可判高不要判低）：
- memory 或 gui_static → 至少 简单
- persistent / state_scope=global|cross / scheduled|continuous / gui_session / 1 个硬集成 → 至少 中等
- state_shared=true / ≥2 硬集成 → 复杂
- 都不命中 → 直接

【最简实现 + Paper 专项（最高优先）】下游用低端模型生成代码，路径与图必须导向最简可行实现：
- 持久化只用 YAML 配置文件 或 PDC（PersistentDataContainer）；**绝不出现 SQL / JDBC / SQLite / MySQL / 数据库 / D1** 等词。
- 微小功能不要为它引入持久化或独立管理器类；少量数据（单玩家 / 几个值）优先 PDC / 内存，路径与流程图中**不要出现 DataManager 这类重类**——无谓重类抬高复杂度、易生成失败而收益极小。
- 外部依赖能省则省；只认 Vault / PlaceholderAPI / WorldGuard 这类硬集成。
- 全程 Paper/Bukkit 语义（事件 / 命令 / 调度任务 / Inventory GUI / config.yml / PDC），不要 Web/后端词汇。

【paths：实现路径（直接级必须为空数组 []）】level != 直接 时给 1~3 条：
- 简单级通常只给 1 条（仅供用户确认理解，不是让他选）。
- 中等/复杂级：只有存在真实实现取舍分歧时才给 2~3 条；无实质分歧就给 1 条，**严禁为凑数造复杂或冗余方案**。每条都必须是最简可行实现。
- 每条：{ "id":"p1", "title":"简短标题", "summary":"一句话取舍说明", "mermaid":"flowchart TD ...", "axes":["persistent","task"] }
  · axes 填该路径点亮的深度轴（persistent/task/state_shared/external/gui_session）。

【mermaid 内容约束】（随等级递增，每个图元素都要能对应 vector，图即 plan 自检源）：
- 简单：flowchart，展示 触发源 → 分支判断 → 各分支动作。
- 中等及以上：在此基础上标注状态读写节点（注释或不同形状区分）；定时/持续 task 用循环或子图。
- 涉及外部插件：外部调用画成独立节点并标依赖方向。
- 必须是合法可渲染的 mermaid flowchart；节点文字用中文并以 A["中文标签"] 形式包裹，避免括号/特殊字符导致语法错误。
- 不要用 style / classDef 给节点自定义填充色或文字色（深色背景下常不可读）；统一用默认主题配色，强调关键节点请靠形状（菱形判断、子图分组）而非颜色。

【knowledgeNeeds：外部 API 实现缺口，最多 3 条】
- 只允许四类：NMS、CraftBukkit、与 NMS/CraftBukkit 绑定的 Spigot/Paper 版本反射、用户需求中明确点名的第三方插件/API（如 PlaceholderAPI、Vault、WorldGuard）。没有这四类明确缺口时必须返回 []。
- 普通 Java、普通 Bukkit/Paper API、Kyori、配置/YAML/PDC、命令/事件/GUI 等常规业务逻辑一律不学习；禁止提出“学习 Paper API”“研究 Minecraft 插件”等泛化主题。
- 每条必须是 kind=fact，并完整输出 integrationKind 与 triggerReason：NMS/CraftBukkit 用 nms_version_sensitive；反射用 reflection_contract；第三方插件用 external_plugin_contract。
- external_plugin 只能来自用户需求中明确出现、且已写入 vector.external_deps 的插件/API；不得凭空扩展依赖。subject、dependency 或 symbol 必须能明确回指该名称。
- 仅某条实现路径需要的知识必须填写对应 pathIds；所有路径都需要时可返回空数组。路径 ID 必须来自本次 paths。
- 必须落到目标版本 + 公开依赖、包名或 API 符号；用户意图不清属于澄清问题，不属于知识缺口。
- 每条只问一个可验证问题，searchQueries 必须包含目标版本和核心符号，acceptanceCriteria 必须说明什么证据可直接支持或推翻结论。
- 不得包含用户源码、用户包名、完整 Prompt、密钥、私有仓库或构建日志；只允许公开可共享的技术主题。
- 不要把实现偏好、代码风格或“最佳实践”包装成事实。

核心类型：${coreType}，MC 版本：${version}${skillContext ?? ""}`,
        user: `用户需求：${userPrompt}${clarifyBlock}${correctionBlock}\n\n请输出分级 JSON。`,
    };
}

// ─── Planner ────────────────────────────────────────────────

export interface PlannerGradeContext {
    axes: string[];
    chosenPath?: { title: string; summary: string; mermaid: string };
}

// ─── Skill 注入（能力参考）────────────────────────────────────
// 用户挂载的 skill 作为「可照抄的能力参考」注入：Planner 看摘要把文件规划进蓝图，FileGen 看骨架照抄。

/** 给 Planner 的能力摘要段（能力 + 宿主依赖符号 + 建议文件清单） */
export function skillPlannerContext(bundles: SkillBundle[]): string {
    if (!bundles?.length) return "";
    const blocks = bundles.map((b) => {
        const lines = [`【能力包：${b.name}】`];
        if (b.capability) lines.push(`能力：${b.capability}`);
        if (b.deny) lines.push(`⛔ 禁止事项（规划时不得安排、不要为这些另造文件）：\n${b.deny}`);
        if (b.usage) lines.push(`用法要点：\n${b.usage}`);
        if (b.expectedGlobals && Object.keys(b.expectedGlobals).length) {
            lines.push(`依赖宿主已有符号：${Object.keys(b.expectedGlobals).join("、")}`);
        }
        const gens = b.files.filter((f) => f.kind === "gen");
        if (gens.length) {
            lines.push("建议生成的类（命名/职责可参考；实现骨架会在逐文件生成时提供）：");
            for (const f of gens) lines.push(`  - ${f.role || f.file}${f.fileGen ? `（${f.fileGen}）` : ""}`);
        }
        return lines.join("\n");
    });
    return "\n\n══ 已挂载能力包（用户主动选择，请在 files[] 中规划出实现这些能力所需的文件，并让相关业务文件依赖它们；实现细节会在逐文件生成时提供可照抄的骨架，此处只需把文件规划进蓝图） ══\n"
        + blocks.join("\n\n");
}

// 蒸馏 skill md：只留 frontmatter（pom/globals/depends/main_wiring）+ 代码块，去掉散文，控制注入体积
function distillSkillMd(md: string): string {
    const fm = md.match(/^---\n([\s\S]*?)\n---/);
    const front = fm ? fm[1].trim() : "";
    const codes = [...md.matchAll(/```[\w-]*\n([\s\S]*?)```/g)].map((m) => m[1].replace(/\s+$/, "")).join("\n\n");
    const out: string[] = [];
    if (front) out.push(front);
    if (codes) out.push("```java\n" + codes + "\n```");
    return out.length ? out.join("\n\n") : md;
}

/** 给 FileGen 的照抄参考段（精炼：pom 坐标 + 暴露符号 + 骨架代码，去散文控体积；usage 教学已在前序阶段注入） */
export function skillFileGenContext(bundles: SkillBundle[]): string {
    if (!bundles?.length) return "";
    const blocks = bundles.map((b) => {
        const parts = [`【能力包：${b.name}】${b.capability ? " — " + b.capability : ""}`];
        if (b.deny) parts.push(`⛔ 绝对禁止（违反即视为错误，必须严格遵守）：\n${b.deny}`);
        const files = b.files.map((f) => {
            const tag = f.kind === "gen" ? `gen/${f.fileGen || "?"}` : "ref";
            return `── ${f.file}（${tag}）${f.role ? "：" + f.role : ""} ──\n${distillSkillMd(f.body)}`;
        }).join("\n\n");
        parts.push(files);
        return parts.join("\n\n");
    });
    return "\n\n══ 已挂载能力包 · 可照抄实现参考 ══\n"
        + "以下是用户挂载能力包的库坐标与骨架代码（pom 依赖 / 暴露符号 globals / Main 接线 main_wiring / Java 骨架）。\n"
        + "若本文件属于或涉及这些能力，请照抄其库坐标与骨架，按本项目包名与业务调整；不要臆造文档未给出的其它库。与本文件无关的能力包可忽略。\n\n"
        + blocks.join("\n\n────────\n\n");
}

/** 给 clarify / grade 阶段的能力引导：让澄清问题与分级都围绕已挂载能力来做 */
export function skillClarifyContext(bundles: SkillBundle[]): string {
    if (!bundles?.length) return "";
    const blocks = bundles.map((b) => {
        const lines = [`【能力包：${b.name}】`];
        if (b.capability) lines.push(`能力：${b.capability}`);
        if (b.usage) lines.push(`用法：\n${b.usage}`);
        if (b.deny) lines.push(`⛔ 禁止：\n${b.deny}`);
        return lines.join("\n");
    });
    return "\n\n══ 用户已挂载以下能力包（生成时会按此实现，分析需求时必须纳入考虑）══\n"
        + blocks.join("\n\n")
        + "\n\n要点：澄清问题 / 复杂度分级都要**优先围绕这些能力的落地细节**——要对接的服务端/地址/端口/凭证、目标对象（群号等）、要启用能力包里的哪些子功能、与现有业务如何衔接；不要问能力包已替用户决定好的事，也不要给出与能力包 deny 冲突的方向。";
}

export function plannerPrompt(
    userPrompt: string,
    coreType: string,
    version: string,
    clarifyRounds?: ClarifyRound[],
    gradeContext?: PlannerGradeContext,
    apiContractContext?: string,
    knowledgeContext?: string,
    skillContext?: string,
): { system: string; user: string } {
    const clarifyBlock = clarifyRounds?.length
        ? "\n\n用户已确认的决策（必须严格遵守）：\n" + clarifyRounds.flatMap(r =>
        r.todos.map(t => `- ${t.question} → ${JSON.stringify(r.answers[t.id])}`)
    ).join("\n")
        : "";

    // 据分级结果点亮的深度轴，追加 plan 必须交代的章节（实现仍取最简）
    const AXIS_REQ: Record<string, string> = {
        persistent: "【持久化】只用 YAML 配置文件 或 PDC（PersistentDataContainer），禁止 SQL/JDBC/数据库；须写明：存什么、读写时机、由 Main.onDisable 落盘。**状态极少（单玩家数据 / 几个值）时优先用 PDC 或直接 getConfig()，不要为此新建独立 ManagerGen / DataManager 重类**。",
        task: "【调度任务】须写明：周期(periodTicks)或一次性、主线程约束、由 Main 启动并在 onDisable cancel。",
        state_shared: "【共享状态】须写明：这份可变状态唯一写入方是谁、其他类只读、读取一致性如何保证（避免多处并发写）。",
        external: "【外部硬集成】须在 plugin.yml 声明 depend/softdepend，写明缺失该插件时的降级行为；只用 Vault/PlaceholderAPI/WorldGuard 这类。",
        gui_session: "【GUI 会话】须写明：会话状态存哪、InventoryClickEvent 点击如何路由、InventoryCloseEvent 关闭时如何清理。",
    };
    const axes = gradeContext?.axes ?? [];
    const axisBlock = axes.length
        ? "\n\n据复杂度分级，本需求点亮了以下轴，plan 必须覆盖对应内容（写进相关文件的 role），但实现一律取最简：\n"
        + axes.map(a => "- " + (AXIS_REQ[a] || a)).join("\n")
        : "";
    const pathBlock = gradeContext?.chosenPath
        ? `\n\n用户已选定的实现路径，plan 必须严格按此方案，且覆盖其流程图中每个元素：\n标题：${gradeContext.chosenPath.title}\n说明：${gradeContext.chosenPath.summary}\n流程图(mermaid)：\n${gradeContext.chosenPath.mermaid}`
        : "";
    const gradeBlock = axisBlock + pathBlock;

    return {
        system: `你是一个 Minecraft ${coreType} 插件项目规划器。根据用户需求输出一个 JSON 对象（不要输出其他内容），格式如下：
{
  "projectName": "插件名（英文，驼峰）",
  "javaVersion": "8|11|17|21|25",
  "packageName": "com.tahai.pluginname",
  "mainBlueprint": {
    "events":   [ { "event": "PlayerJoinEvent", "listenerClass": "JoinListener", "priority": "NORMAL" } ],
    "commands": [ { "name": "setnotice", "executorClass": "SetNoticeCommand", "aliases": [], "permission": "plugin.cmd.setnotice" } ],
    "tasks":    [ { "taskClass": "AutoSaveTask", "schedule": "timer", "periodTicks": 1200, "delayTicks": 0, "async": false } ],
    "services": [ { "managerClass": "DataManager", "lifecycle": "onEnable" } ],
    "config":   { "defaultsCopied": true, "files": ["config.yml"] }
  },
  "files": [
    { "path": "pom.xml", "role": "Maven 构建配置", "order": 1, "depends": [], "generatorType": "FileRelatedGen", "tag": null },
    { "path": "src/main/resources/plugin.yml", "role": "插件描述文件", "order": 2, "depends": [], "generatorType": "ConfigGen", "tag": null },
    { "path": "src/main/java/com/tahai/.../SetNoticeCommand.java", "role": "/setnotice 命令：CommandExecutor + TabCompleter", "order": 3, "depends": ["DataManager.java"], "generatorType": "CommandGen", "tag": null },
    { "path": "src/main/java/com/tahai/.../Main.java", "role": "插件主类，注册所有命令/监听器/任务并管理生命周期", "order": 4, "depends": ["SetNoticeCommand.java","DataManager.java"], "generatorType": "MainGen", "tag": null }
  ]
}

mainBlueprint（必填，先想清楚整体编排再列文件）：
- events：每个监听器声明触发的事件类（如 PlayerJoinEvent）+ 监听类名（与 files[].path 中的类名匹配）+ 可选 priority
- commands：每条命令的 name（小写，与 plugin.yml 一致）、executorClass（同时实现 CommandExecutor 与 TabCompleter 的类名）、aliases、permission
- tasks：每个调度任务的类名 + schedule（timer 周期 / once 一次性 / async 异步）+ periodTicks（仅 timer 需要）+ delayTicks
- services：作为 Main 字段持有的单例服务类（DataManager / EconomyManager 等），lifecycle 通常为 onEnable
- config：是否需要 saveDefaultConfig + 涉及的 yml 文件名

files[].generatorType 必须从下列枚举中精确选择：
- "CommandGen"        — 命令类（同时实现 CommandExecutor + TabCompleter，逻辑写在一个文件内）
- "ListenerGen"       — 事件监听类（implements Listener）。如果是自定义 Inventory GUI 的点击监听，标记 "tag": "gui" 并在 "pairPath" 填写配对的 GUI 持有类相对路径，规划阶段同样要单独列出该 GUI 持有类条目（generatorType="ListenerGen"，tag="gui"，pairPath 指向自身）
- "TaskGen"           — BukkitRunnable / 调度任务类（不要在文件内自行调用 runTaskTimer，由 Main 启动）
- "ManagerGen"        — 数据/服务单例（被 Main 实例化、持有，被其他类通过 Bukkit.getPluginManager().getPlugin() 反查取实例）
- "ConfigGen"         — 资源 yml（plugin.yml / config.yml / lang.yml 等）
- "ConfigClassGen"    — 包装 YamlConfiguration 的 Java 配置加载类
- "ModelGen"          — POJO/DTO（不依赖 Bukkit）
- "EnumGen"           — 枚举类
- "UtilGen"           — 静态工具类（无实例状态、无插件引用）
- "FileRelatedGen"    — 非 Java 项目文件（pom.xml / .gitignore / README.md）
- "MainGen"           — 主类（extends JavaPlugin），有且仅有一个

规则：
- 根据 MC 版本推导 Java 版本：26.1+ 用 25，1.20-1.21 用 21，1.17-1.19 用 17，1.13-1.16 用 11，1.12 及以下用 8
- 核心类型为 ${coreType}，MC 版本 ${version}
- pom.xml 的 order 必须为 1
- depends 数组填写该文件依赖的其他文件的文件名（不含路径前缀），例如 ["DataManager.java"]
- MainGen 文件的 order 必须最大；其 depends 必须列出所有 Listener / Command / Task / Manager 的文件名
- files 按依赖拓扑排序：被依赖的文件 order 小，依赖方 order 大
- 同深度（depends 互相不引用）的文件之间不能相互调用——若两个 leaf 都需要某 helper，把 helper 下沉为它们共同的依赖
- path 使用 Maven 标准目录结构
- 包名使用全小写；**必须以 com.tahai 开头，形如 com.tahai.<插件名全小写>**，对应源码路径 src/main/java/com/tahai/<插件名>/...（禁止用 com.example）
- 必须包含 plugin.yml（放 src/main/resources/，generatorType 为 ConfigGen）
- 只输出 JSON，不要解释

极简原则（严格遵守）：
- 只规划用户需求中明确提到或逻辑上必需的文件，不要自行扩展功能范围
- 对无状态的事件动作采用自然最小默认值：未要求反馈就不额外发消息，未要求权限就不增加权限节点，未要求首次奖励或防刷就不增加持久化记录；“进入服务器时”按每次成功加入后的事件处理，不追溯插件加载时已经在线的玩家
- 规划向玩家物品栏发放物品的职责时，必须在相关 files[].role 中写明处理 Inventory.addItem 返回的剩余物，背包已满时在玩家位置自然掉落，避免静默丢失；这是技术完整性处理，不扩展为邮件、暂存或领取系统
- 每个文件的 role 必须精确描述该文件需要实现的具体功能点，不要使用笼统描述如"管理器"、"工具类"
- 用户原始需求若明确指定了某条输出的颜色或格式，必须把该要求原样写入每个相关 files[].role，供逐文件生成与审查识别例外；未明确指定时不得自行添加其他颜色
- 如果用户需求是"添加任务"，不要自行扩展出"删除任务"、"查询任务"、"任务列表"等未要求的功能
- 能在一个文件中实现的逻辑不要拆分成多个文件
- 不要规划与用户需求无关的辅助类、工具类、基类、接口
- 功能类只实现 role 中描述的功能，不要预留扩展方法
- 禁止把 Manager 标成 Util；禁止把 TabCompleter 与 Executor 拆成两个文件

Paper / Bukkit 配套结构知识（规划必备文件时强制遵守）：
- **命令类（CommandGen）**：onCommand + onTabComplete 必须在同一个类中，不要拆文件；无论需求是否明说，规划阶段都必须为命令准备完整实现并在 plugin.yml 的 commands 节点声明
- **事件监听类（ListenerGen）**：由 Main.onEnable 通过 getServer().getPluginManager().registerEvents 注册；规划要为 Listener 与 Main 之间建立 depends 关系
- **Inventory GUI**：若涉及自定义 GUI，必须列出两条 ListenerGen 文件——一条是 GUI 持有类（implements InventoryHolder，提供构造 Inventory 的方法），一条是 InventoryClickEvent 监听类。两条都标 tag="gui"，pairPath 互相指向对方
- **配置文件**：若涉及任何可配置参数或文本，必须规划 src/main/resources/config.yml（ConfigGen），并由 Main.onEnable 调用 saveDefaultConfig
- **数据持久化**：**仅当**需要集中管理「较多结构化数据」（多条记录 / 需增删查的集合）时，才规划独立 ManagerGen 类（管理 File + YamlConfiguration，Main.onDisable 落盘）；**少量数据（单玩家数据 / 几个值）优先用 PDC 或直接 getConfig()/saveConfig()，不要为此引入 ManagerGen 重类**——无谓的重类会抬高复杂度、易生成失败而功能收益极小
- **调度任务（TaskGen）**：若涉及定时/重复任务，规划须明确该 TaskGen 类，并通过 mainBlueprint.tasks 声明 schedule 与 periodTicks
- **plugin.yml**：必须列出 name / version / main / api-version；所有命令需在 commands 节点声明（含 description / usage / aliases / permission）；若涉及权限节点，必须在 permissions 节点声明
- **Main.java（MainGen）**：必须 extends JavaPlugin；onEnable 负责 saveDefaultConfig（如有）+ 注册所有 Executor/TabCompleter + 注册所有 Listener + 启动调度任务 + 实例化所有 services；onDisable 负责数据落盘${gradeBlock}${apiContractContext ? `\n\n${apiContractContext}` : ""}${knowledgeContext ?? ""}${skillContext ?? ""}`,
        user: `${userPrompt}${clarifyBlock}`,
    };
}

// ─── FileGen ────────────────────────────────────────────────

/** FileGen 全链路共用的输出配色约束：生成、审查返工与构建修复必须保持一致。 */
const FILEGEN_OUTPUT_STYLE_RULES = `
输出与消息配色规范（强制；除非用户明确指定其他颜色）：
- 先区分输出通道，不得混用 ANSI 与 Minecraft 颜色代码：
  1) System.out.println / System.err.println：普通内容直接输出终端默认白色，不加任何颜色转义；只有需要黄色强调时才使用 ANSI 黄色，并在同一条消息末尾复位。固定对照：默认白色 = 无转义，ANSI 黄色 = \\u001B[33m，ANSI 复位 = \\u001B[0m。不得在 println 中使用 §、& 或 ChatColor。
  2) Bukkit / Java logger 与游戏内可见消息（sendMessage、broadcast、聊天栏、标题等）：普通内容直接输出默认白色，不要为了白色添加格式；需要着色时只能使用下方 ChatColor / § 对照表中的默认色与格式。
- Bukkit / Minecraft 固定对照：
  · 系统层级的聊天提示、状态、说明：ChatColor.GRAY ↔ §7
  · 重要消息或成功结果：ChatColor.YELLOW ↔ §e
  · 失败消息：ChatColor.AQUA ↔ §b（不要擅自改成红色）
  · 重要消息中最关键的短语：ChatColor.BOLD ↔ §l；仅局部加粗，且应叠加在 §e / ChatColor.YELLOW 等允许的颜色上；后续要取消加粗时重新应用允许的颜色（如 ChatColor.YELLOW 或 ChatColor.WHITE），不要使用 §r / ChatColor.RESET
  · 普通输出：默认白色 = 不添加颜色代码；仅在确实需要显式白色时 ChatColor.WHITE ↔ §f
  · 特殊语义确需紫色时可例外使用 ChatColor.LIGHT_PURPLE ↔ §d；除此之外，只有用户明确点名某种颜色时才能使用对应颜色，并且只应用到用户要求的范围
- 未获用户明确授权时，禁止使用红、绿、金、深色系等其他颜色，也禁止斜体、下划线、删除线、随机字符等其他格式。不得把传统的“成功=绿色、失败=红色”习惯带入代码。
- Java 源码中的 Bukkit / 游戏消息使用 ChatColor 枚举，禁止在 Java 字符串字面量中直接写 § 或 &。YAML / properties 中使用上表对应的 § 代码，禁止用 &；若必须兼容历史 & 配置，Java 读取后必须先调用 ChatColor.translateAlternateColorCodes('&', text)。
- 用户若明确要求其他颜色或特定格式，以用户要求为准并灵活调整；这种例外不得扩散到未被指定的其他消息。`;

export function fileGenPrompt(
    filePath: string,
    fileRole: string,
    projectContext: { projectName: string; packageName: string; coreType: string; version: string; javaVersion: string },
    generatedSummaries: FileSummary[],
    additionalContext?: string,
): { system: string; user: string } {
    const apiBlock = formatSummaries(generatedSummaries);

    return {
        system: `你是一个 Minecraft ${projectContext.coreType} ${projectContext.version} 插件代码生成器。
项目名：${projectContext.projectName}
包名：${projectContext.packageName}
Java 版本：${projectContext.javaVersion}
构建工具：Maven
${apiBlock}

要求：
- 只输出文件正文内容，不要包裹 markdown 代码块
- 不要输出文件名或解释
- 确保 import 与已生成文件一致
- 你只能使用上面「已生成文件的可用 API」中列出的类、构造器和方法，不要假设任何未列出的无参构造器、方法或类存在
- 如果需要的功能在已生成文件中不存在，请在当前文件中自行实现，不要凭空调用不存在的方法
- 禁止直接引用或转换插件主类类型。获取插件实例必须使用 Bukkit.getPluginManager().getPlugin("${projectContext.projectName}")，返回类型使用 org.bukkit.plugin.Plugin 接口，不要强转为具体主类
- 不要使用 XxxPlugin.getPlugin()、XxxPlugin.getInstance() 或 (XxxPlugin) 强转等模式
- 代码简洁实用，注释极少

极简原则（严格遵守）：
- 只实现文件职责描述中明确要求的功能，不要自行添加任何额外的方法、命令、事件监听器
- 例如：职责是"处理/addtask命令"，就只实现 addtask 命令，不要额外添加 deletetask、listtask 等
- 不要生成"预留"或"可能有用"的方法，只写必需的代码
- 不要为类添加 getInstance()、getManager() 等单例模式，除非职责中明确要求

Paper / Bukkit 配套实现规范（强制遵守，不能省略）：
- **命令实现**：实现命令类时必须同时实现 CommandExecutor.onCommand 与 TabCompleter.onTabComplete。onTabComplete 至少根据 args.length 返回当前层级的合理候选（无候选则返回空 List），不要返回 null。一个类可同时 implements CommandExecutor, TabCompleter
- **命令注册**：在 Main.onEnable 中：PluginCommand cmd = getCommand("xxx"); cmd.setExecutor(new XxxCommand()); cmd.setTabCompleter(new XxxCommand()); 同一个类做两件事时只 new 一个实例
- **Listener 注册**：在 Main.onEnable 中调用 getServer().getPluginManager().registerEvents(new XxxListener(), this)。Listener 类必须 implements Listener，事件方法必须加 @EventHandler 注解
- **物品发放**：向玩家物品栏添加物品时必须检查 Inventory.addItem(...) 返回的剩余物；无法放入的部分使用玩家世界的 dropItemNaturally 在玩家位置掉落，不得静默丢弃，也不得自行扩展为邮件或暂存系统
- **Inventory GUI**：自定义 GUI 必须用 InventoryHolder 标识（推荐让 GUI 类 implements InventoryHolder 并由 Bukkit.createInventory(this, size, title) 创建）。监听 InventoryClickEvent 时先判断 event.getInventory().getHolder() instanceof YourGUI，再 event.setCancelled(true) 阻止取出物品，然后用 event.getRawSlot() 派发点击逻辑
- **配置读取**：通过 getConfig().getXxx("path", default) 读取。Main.onEnable 必须先调用 saveDefaultConfig() 才能读到 resources/config.yml 的默认值
- **YAML 数据持久化**：用 File dataFile = new File(getDataFolder(), "data.yml"); YamlConfiguration cfg = YamlConfiguration.loadConfiguration(dataFile); 读写后 cfg.save(dataFile) 落盘。getDataFolder() 不存在时先 mkdirs()。Main.onDisable 必须保存所有可变数据
- **调度任务**：用 new BukkitRunnable() { @Override public void run() { ... } }.runTaskTimer(plugin, delay, period) 启动周期任务；一次性延迟用 runTaskLater；同步任务避免阻塞主线程，耗时操作用 runTaskAsynchronously
- **plugin.yml 完整性**：必须含 name、version、main（全限定主类名）、api-version。命令必须在 commands 节点声明（每条至少 description；可选 usage/aliases/permission）。声明的权限节点必须列在 permissions 节点（含 description、default）
- **权限检查**：通过 sender.hasPermission("plugin.cmd.xxx") 判断，未通过时 sender.sendMessage 提示并 return true
${additionalContext ? `\n${additionalContext}` : ""}
${FILEGEN_OUTPUT_STYLE_RULES}
- **Main.onEnable 模板（按需调用）**：saveDefaultConfig() → 注册所有 PluginCommand 的 Executor/TabCompleter → 注册所有 Listener → 启动调度任务；onDisable 负责数据落盘和 cancelTasks`,
        user: `请生成文件 ${filePath}\n职责：${fileRole}`,
    };
}

// ─── reChecker ──────────────────────────────────────────────

export function reCheckerPrompt(
    filePath: string,
    fileContent: string,
    generatedSummaries?: FileSummary[],
    projectName?: string,
    fileRole?: string,
    additionalContext?: string,
): { system: string; user: string } {
    const crossFileBlock = generatedSummaries?.length
        ? "\n\n项目中已生成文件的可用 API：" + formatSummaries(generatedSummaries) +
        "\n\n除上述 API 外，还需检查：当前文件调用的项目内方法和构造器是否在上述 API 列表中存在。如果调用了未列出的方法，或在没有 public 无参构造器时使用 new Xxx()，视为错误。"
        : "";

    return {
        system: `你是一个 Java 代码审查器。审查给定文件是否存在明显错误（语法错误、未关闭的括号、错误的 import、缺少 return、类型不匹配等）。${crossFileBlock}
检查是否存在对插件主类的直接类型引用或强制转换（如 (MainClass) getPlugin(...)、MainClass.getInstance()）。代码应通过 Bukkit.getPluginManager().getPlugin("${projectName || "PluginName"}") 获取插件实例，类型为 Plugin 接口。发现此类模式视为错误。
文件职责：${fileRole || "未提供显式颜色例外"}
${additionalContext ?? ""}
将违反下述输出配色规则的代码或配置视为错误；当前文件没有任何输出消息时忽略本项。
${FILEGEN_OUTPUT_STYLE_RULES}
只输出 JSON，格式如下：
- 通过：{"is_ok":true,"reason":"","missing_classes":[]}
- 不通过：{"is_ok":false,"reason":"具体错误描述","missing_classes":["ClassName"]}
missing_classes 列出当前文件引用了但未在已生成 API 列表中存在的项目内 Java 类名（不含包名，仅类名如 "WelcomeCommand"）。只列出确实被当前文件 import 或直接使用、但不在已知 API 中的类。如果错误与缺失类无关则为空数组。
不要输出其他内容。`,
        user: `文件：${filePath}\n\n${fileContent}`,
    };
}

// ─── Rework ─────────────────────────────────────────────────

export function reworkPrompt(
    filePath: string,
    fileRole: string,
    originalContent: string,
    reason: string,
    ctx: { projectName: string; packageName: string; coreType: string; version: string; javaVersion: string },
    generatedSummaries?: FileSummary[],
    apiContractContext?: string,
    knowledgeContext?: string,
): { system: string; user: string } {
    const apiBlock = generatedSummaries?.length ? formatSummaries(generatedSummaries) : "";

    return {
        system: `你是一个 Minecraft ${ctx.coreType} ${ctx.version} 插件代码修正器。
项目名：${ctx.projectName}，包名：${ctx.packageName}，Java ${ctx.javaVersion}
${apiBlock}
${apiContractContext ?? ""}
${knowledgeContext ?? ""}
只输出修正后的完整文件正文，不要包裹 markdown 代码块，不要解释。
你只能使用上面列出的已生成文件中的类、构造器和方法，不要凭空调用不存在的无参构造器或方法。
禁止直接引用或转换插件主类类型，必须使用 Bukkit.getPluginManager().getPlugin("${ctx.projectName}") 获取实例。
${FILEGEN_OUTPUT_STYLE_RULES}`,
        user: `文件 ${filePath}（职责：${fileRole}）存在错误：${reason}\n\n原始内容：\n${originalContent}`,
    };
}

// ─── Summary Extractor ──────────────────────────────────────

export function summaryExtractPrompt(filePath: string, fileContent: string): { system: string; user: string } {
    return {
        system: `你是一个 Java 代码分析器。分析给定文件，提取其公开 API 摘要。
只输出 JSON 对象（不要输出其他内容），格式如下：
{
  "className": "类名（如果是 Java 类文件）",
  "extends": "父类名（没有则为 null）",
  "implements": ["接口名"],
  "constructors": [{ "params": "构造参数列表，如 Plugin plugin, ConfigManager config" }],
  "publicMethods": [
    { "name": "方法名", "params": "参数列表如 Player player, double amount", "returns": "返回类型" }
  ],
  "publicFields": ["public static 字段声明，如 static EconomyManager instance"],
  "events": ["监听的事件类名，如 PlayerJoinEvent"],
  "commands": ["注册或处理的命令名，如 /setnotice"],
  "configKeys": ["读写的配置键名，如 starting-balance"],
  "description": "一句话描述该文件的核心职责"
}

规则：
- 只提取 public 和 public static 的方法和字段
- constructors 必须列出所有 public 构造器；public Java 类完全未声明构造器时填 [{"params":""}] 表示隐式 public 无参构造器，只有不存在可用 public 构造器或非 Java 文件时才使用空数组
- 对于非 Java 文件（如 pom.xml、plugin.yml、config.yml），className 为 null，只填 description
- publicMethods 中不要包含 private/protected 方法
- 如果某个字段不适用，使用 null 或空数组
- 只输出 JSON，不要解释`,
        user: `文件：${filePath}\n\n${fileContent}`,
    };
}

// ─── Dispatch (per-generator routing) ───────────────────────

/** 把蓝图片段格式化成 system prompt 中的强制清单 */
function formatBlueprintForMain(bp: MainBlueprint): string {
    const events = bp.events.length
        ? bp.events.map(e => `  - ${e.listenerClass} 监听 ${e.event}${e.priority ? `（priority=${e.priority}）` : ""}`).join("\n")
        : "  - 无";
    const commands = bp.commands.length
        ? bp.commands.map(c => `  - /${c.name} → executor=${c.executorClass}` +
            (c.aliases?.length ? `, aliases=${c.aliases.join(",")}` : "") +
            (c.permission ? `, permission=${c.permission}` : "")).join("\n")
        : "  - 无";
    const tasks = bp.tasks.length
        ? bp.tasks.map(t => `  - ${t.taskClass} → schedule=${t.schedule}` +
            (t.periodTicks != null ? `, periodTicks=${t.periodTicks}` : "") +
            (t.delayTicks != null ? `, delayTicks=${t.delayTicks}` : "") +
            (t.async ? ", async=true" : "")).join("\n")
        : "  - 无";
    const services = bp.services.length
        ? bp.services.map(s => `  - ${s.managerClass}（lifecycle=${s.lifecycle}）`).join("\n")
        : "  - 无";
    const cfgFiles = bp.config.files.length ? bp.config.files.join(", ") : "无";
    return [
        "事件监听：", events,
        "命令：", commands,
        "调度任务：", tasks,
        "服务（Main 持有）：", services,
        `配置：defaultsCopied=${bp.config.defaultsCopied}, files=${cfgFiles}`,
    ].join("\n");
}

/** 根据文件类型 + 蓝图切片产出附加在 system prompt 末尾的"专项规则" */
function specializationBlock(
    file: PlanFileItem,
    slice: BlueprintSlice,
    ctx: { projectName: string; packageName: string; coreType: string; version: string; javaVersion: string },
): string {
    const className = (file.path.split("/").pop() ?? "").replace(/\.java$/, "");
    switch (file.generatorType) {
        case "CommandGen": {
            const e = slice.commandEntry;
            const meta = e
                ? `命令名=/${e.name}` +
                (e.aliases?.length ? `；aliases=${e.aliases.join(",")}` : "") +
                (e.permission ? `；permission=${e.permission}` : "")
                : "（无蓝图条目，按 role 推断命令名）";
            return [
                "═══ CommandGen 专项规则 ═══",
                meta,
                "- 必须在同一个类中同时 implements CommandExecutor, TabCompleter",
                "- 实现 onCommand(...) 与 onTabComplete(...)；onTabComplete 至少根据 args.length 返回当前层级合理候选，没有候选时返回 Collections.emptyList()",
                "- 不要在本文件中调用 getCommand(...).setExecutor / setTabCompleter；命令注册由 Main.onEnable 统一完成",
                "- 权限校验：通过 sender.hasPermission(\"...\") 判断，未通过 sendMessage 后 return true",
                "- 通过 Bukkit.getPluginManager().getPlugin(\"" + ctx.projectName + "\") 获取插件实例（Plugin 接口），不要强转主类",
            ].join("\n");
        }
        case "ListenerGen": {
            if (file.tag === "gui") {
                const pair = slice.guiPairPath ?? file.pairPath ?? "（未知配对文件）";
                return [
                    "═══ ListenerGen / GUI 专项规则 ═══",
                    `本文件是 GUI 配对的一部分，配对文件：${pair}`,
                    "GUI 配对约定：必有两份文件——",
                    "  (A) GUI 持有类：implements org.bukkit.event.Listener, org.bukkit.inventory.InventoryHolder",
                    "      - 通过 Bukkit.createInventory(this, size, title) 构造 Inventory；标题默认不着色，只有文件职责明确要求时才按统一配色规范着色",
                    "      - 暴露 open(Player p) 给外部打开",
                    "      - 提供 getInventory() 返回当前 Inventory 实例",
                    "  (B) 点击监听类：implements org.bukkit.event.Listener",
                    "      - 监听 InventoryClickEvent",
                    "      - 先 if (event.getInventory().getHolder() instanceof <配对持有类>)，再 event.setCancelled(true)",
                    "      - 然后用 event.getRawSlot() 派发点击逻辑（调用持有类提供的方法或直接处理）",
                    `根据当前类名 "${className}" 自行判断本文件属于 (A) 还是 (B)：包含 GUI/Menu/Inventory/Holder 字样者通常为 (A)；以 Listener 结尾者通常为 (B)`,
                    "- 不要在本文件中调用 registerEvents；监听器注册由 Main.onEnable 统一完成",
                    "- 事件处理方法必须加 @EventHandler 注解",
                ].join("\n");
            }
            const e = slice.eventEntry;
            const meta = e
                ? `监听事件=${e.event}${e.priority ? `；priority=${e.priority}` : ""}`
                : "（无蓝图条目，按 role 推断事件类）";
            return [
                "═══ ListenerGen 专项规则 ═══",
                meta,
                "- 必须 implements org.bukkit.event.Listener",
                "- 事件处理方法必须加 @EventHandler 注解" + (e?.priority ? `，并设置 priority = EventPriority.${e.priority}` : ""),
                "- 不要在本文件中调用 registerEvents；监听器注册由 Main.onEnable 统一完成",
                "- 不要包含与监听职责无关的方法",
            ].join("\n");
        }
        case "TaskGen": {
            const t = slice.taskEntry;
            const meta = t
                ? `schedule=${t.schedule}` +
                (t.periodTicks != null ? `, periodTicks=${t.periodTicks}` : "") +
                (t.delayTicks != null ? `, delayTicks=${t.delayTicks}` : "") +
                (t.async ? ", async=true" : "")
                : "（无蓝图条目）";
            return [
                "═══ TaskGen 专项规则 ═══",
                meta,
                "- 必须 extends org.bukkit.scheduler.BukkitRunnable，实现 run() 中的单次执行逻辑",
                "- 不要在本文件中调用 runTaskTimer / runTaskLater / runTaskAsynchronously；调度由 Main.onEnable 统一启动",
                "- 不要持有 Plugin 字段（除非业务必需）；通过 Bukkit.getPluginManager().getPlugin(\"" + ctx.projectName + "\") 获取必要服务",
                "- run() 内若有耗时操作且 schedule=async，可使用 async 调用；同步任务避免阻塞主线程",
            ].join("\n");
        }
        case "ManagerGen": {
            const s = slice.serviceEntry;
            const lifecycle = s ? `lifecycle=${s.lifecycle}` : "（无蓝图条目）";
            return [
                "═══ ManagerGen 专项规则 ═══",
                lifecycle,
                "- 这是被 Main 持有的服务/数据单例。Main 在 onEnable 中 new 一次并保留引用，其它类通过 Bukkit.getPluginManager().getPlugin(\"" + ctx.projectName + "\") 反查后调用",
                "- 禁止使用 static getInstance() 单例模式；不要写 private static <ClassName> instance",
                "- 构造时载入数据（YamlConfiguration 等），提供 save() / shutdown() 方法供 Main.onDisable 调用",
                "- 公共方法应聚焦数据访问与变更；不要在 ManagerGen 内自行注册命令/监听/任务",
            ].join("\n");
        }
        case "ConfigGen": {
            return [
                "═══ ConfigGen 专项规则 ═══",
                "- 本文件是 YAML 资源文件（plugin.yml / config.yml / lang.yml 等），不是 Java 代码",
                "- 直接输出 YAML 内容，不包含任何 Java 关键字、import、class 声明",
                file.path.endsWith("plugin.yml")
                    ? `- plugin.yml 必须含字段：name: ${ctx.projectName}, version: 1.0.0, main: ${ctx.packageName}.Main, api-version: ${ctx.version}\n- 所有命令必须在 commands 节点声明（每条至少 description；可选 usage / aliases / permission）\n- 涉及的权限节点必须在 permissions 节点声明（含 description 与 default）`
                    : "- config.yml 仅放运行时可变默认值，注释用 # 说明每个字段的作用",
            ].join("\n");
        }
        case "ConfigClassGen": {
            return [
                "═══ ConfigClassGen 专项规则 ═══",
                "- 本类包装 org.bukkit.configuration.file.YamlConfiguration / FileConfiguration",
                "- 提供 reload() / save() / get*(key, default) 等公共方法",
                "- 不要在类内硬编码默认值；默认值统一由 resources/config.yml 提供，通过 saveDefaultConfig() 释放后读取",
                "- 不要在本文件内注册命令/监听/任务",
            ].join("\n");
        }
        case "ModelGen": {
            return [
                "═══ ModelGen 专项规则 ═══",
                "- 本文件是纯数据 POJO/DTO，禁止 import org.bukkit.* 或任何 Bukkit/Paper API",
                "- 玩家引用使用 java.util.UUID，不使用 Player 对象",
                "- 提供必要的构造函数与 getter/setter，可附 toString/equals/hashCode",
                "- 不持有插件实例，不调用任何插件方法",
            ].join("\n");
        }
        case "EnumGen": {
            return [
                "═══ EnumGen 专项规则 ═══",
                "- 本文件是 Java enum 声明",
                "- 可附少量字段、构造函数、values()/valueOf() 之外的简单查询方法",
                "- 禁止在 enum 中实现复杂业务逻辑或依赖 Bukkit/Paper API",
            ].join("\n");
        }
        case "UtilGen": {
            return [
                "═══ UtilGen 专项规则 ═══",
                "- 本类是静态工具类：所有方法 public static，private 构造禁止实例化",
                "- 不持有任何实例字段，不持有插件引用",
                "- 不要在 UtilGen 中处理事件、注册任务、读写配置文件",
            ].join("\n");
        }
        case "FileRelatedGen": {
            const lower = file.path.toLowerCase();
            if (lower.endsWith("pom.xml")) {
                return [
                    "═══ FileRelatedGen / pom.xml 专项规则 ═══",
                    `- groupId 取自包名前两段（如 ${ctx.packageName.split(".").slice(0, 2).join(".")}），artifactId=${ctx.projectName}`,
                    `- maven-compiler-plugin 的 source/target 设为 ${ctx.javaVersion}`,
                    `- 加入 ${ctx.coreType.toLowerCase()}-api 依赖，version 与 MC ${ctx.version} 匹配（Paper 推荐 io.papermc.paper:paper-api:${ctx.version}-R0.1-SNAPSHOT，Spigot 推荐 org.spigotmc:spigot-api 对应版本）；scope 为 provided`,
                    "- 加入 papermc / spigotmc 仓库（按 coreType）；Paper 仓库必须使用 https://repo.papermc.io/repository/maven-public/，禁止使用已返回 403 的旧地址 https://papermc.io/repo/repository/maven-public/",
                    "- 配置 maven-shade-plugin 输出 shaded jar（artifactId 名）",
                ].join("\n");
            }
            if (lower.endsWith(".gitignore")) {
                return [
                    "═══ FileRelatedGen / .gitignore 专项规则 ═══",
                    "- 至少忽略 target/、*.class、.idea/、.vscode/、*.iml",
                ].join("\n");
            }
            if (lower.endsWith("readme.md")) {
                return [
                    "═══ FileRelatedGen / README 专项规则 ═══",
                    "- 简洁中文说明：插件名 / 简介 / 命令列表 / 配置项；不要营销话术",
                ].join("\n");
            }
            return "═══ FileRelatedGen 专项规则 ═══\n- 输出对应文件的常规内容；不要与其他文件类型混合";
        }
        case "MainGen": {
            const bp = slice.fullBlueprint;
            const blueprintBlock = bp ? formatBlueprintForMain(bp) : "（无完整蓝图）";
            return [
                "═══ MainGen 专项规则 ═══",
                "- 本文件是插件唯一主类，必须 extends JavaPlugin",
                "- 严格按下方蓝图实现 onEnable / onDisable，不得遗漏或新增任何条目：",
                blueprintBlock,
                "",
                "onEnable 顺序（必须按此顺序）：",
                "  1) saveDefaultConfig()（仅当蓝图 defaultsCopied=true）",
                "  2) 实例化所有服务（lifecycle=onEnable 的 ManagerGen），保存为字段",
                "     - 实例化时必须严格使用上方 API 摘要列出的 public 构造器参数；没有无参构造器时禁止 new Xxx()",
                "  3) 注册所有命令：getCommand(\"name\").setExecutor(executorInstance) 与 setTabCompleter(executorInstance)（同一类的同一实例）",
                "  4) 注册所有监听：getServer().getPluginManager().registerEvents(listenerInstance, this)",
                "  5) 启动调度任务：根据 schedule 字段调用 runTaskTimer / runTaskLater / runTaskAsynchronously",
                "",
                "onDisable：",
                "  - 调用所有服务的 save()/shutdown() 方法（如其暴露），确保数据落盘",
                "  - 取消调度任务（getServer().getScheduler().cancelTasks(this)）",
                "",
                "- Main 必须为以上每个 service 持有 getter（如 public DataManager getDataManager()），供其他类通过 Bukkit.getPluginManager().getPlugin(...) 反查后调用",
                "- 禁止 static getInstance() 单例；插件实例通过 Bukkit.getPluginManager().getPlugin(\"" + ctx.projectName + "\") 获取",
            ].join("\n");
        }
    }
    return "";
}

/** 类型专项的 reChecker 增量断言 */
function checkerSpecializationBlock(file: PlanFileItem, slice: BlueprintSlice): string {
    switch (file.generatorType) {
        case "CommandGen":
            return "类型专项断言：本文件应同时 implements CommandExecutor 与 TabCompleter，并实现 onCommand 与 onTabComplete；不应包含 setExecutor / setTabCompleter / registerEvents 调用。";
        case "ListenerGen":
            return file.tag === "gui"
                ? "类型专项断言：本文件应 implements Listener；若是 GUI 持有类还应 implements InventoryHolder；不应在文件内调用 registerEvents。"
                : "类型专项断言：本文件应 implements Listener，事件方法必须加 @EventHandler；不应在文件内调用 registerEvents。";
        case "TaskGen":
            return "类型专项断言：本文件应 extends BukkitRunnable 并实现 run()；不应直接调用 runTaskTimer / runTaskLater / runTaskAsynchronously（启动由 Main 完成）。";
        case "ManagerGen":
            return "类型专项断言：本文件不应使用 static getInstance() 单例模式，不应直接注册命令/监听/任务。";
        case "MainGen": {
            const bp = slice.fullBlueprint;
            if (!bp) return "类型专项断言：MainGen 必须 extends JavaPlugin 且实现完整 onEnable / onDisable。";
            const must: string[] = [];
            for (const e of bp.events) must.push(`onEnable 必须注册 ${e.listenerClass}（registerEvents）`);
            for (const c of bp.commands) must.push(`onEnable 必须为 /${c.name} 设置 ${c.executorClass} 为 Executor 与 TabCompleter`);
            for (const t of bp.tasks) must.push(`onEnable 必须按 schedule=${t.schedule} 启动 ${t.taskClass}`);
            for (const s of bp.services) must.push(`onEnable 必须实例化 ${s.managerClass}`);
            return "类型专项断言（MainGen 必须满足）：\n- " + must.join("\n- ");
        }
        case "ModelGen":
            return "类型专项断言：本文件不应 import org.bukkit.* 或任何 Bukkit/Paper API。";
        case "UtilGen":
            return "类型专项断言：本文件所有公共方法应 public static，不应持有实例字段或插件引用。";
        case "ConfigGen":
            return "类型专项断言：本文件应是 YAML，不应包含 Java 语法。";
        default:
            return "";
    }
}

/** 根据 generatorType 选择 FileGen 与 reChecker 的 prompt 构造器 */
export function dispatchGen(
    file: PlanFileItem,
    ctx: { projectName: string; packageName: string; coreType: string; version: string; javaVersion: string },
    ancestorSummaries: FileSummary[],
    slice: BlueprintSlice,
    skillContext?: string,
    apiContractContext?: string,
    knowledgeContext?: string,
): {
    gen: { system: string; user: string };
    checker: (filePath: string, fileContent: string) => { system: string; user: string };
} {
    const spec = specializationBlock(file, slice, ctx);
    const additionalContext = [spec, apiContractContext, knowledgeContext, skillContext].filter((v): v is string => !!v).join("\n\n");
    // 统一输出规范由 fileGenPrompt 放在最终尾部，确保专项规则与 skill 骨架不能覆盖它。
    const gen = fileGenPrompt(file.path, file.role, ctx, ancestorSummaries, additionalContext);
    const checkerSpec = [checkerSpecializationBlock(file, slice), apiContractContext, knowledgeContext]
        .filter((v): v is string => !!v)
        .join("\n\n");
    const checker = (path: string, content: string) => {
        return reCheckerPrompt(path, content, ancestorSummaries, ctx.projectName, file.role, checkerSpec);
    };
    return { gen, checker };
}

/** 计算文件对应的 BlueprintSlice */
export function computeSlice(file: PlanFileItem, blueprint: MainBlueprint | null): BlueprintSlice {
    if (!blueprint) return {};
    const className = (file.path.split("/").pop() ?? "").replace(/\.java$/, "");
    const slice: BlueprintSlice = {};

    if (file.generatorType === "ListenerGen") {
        slice.eventEntry = blueprint.events.find(e => e.listenerClass === className);
        if (file.tag === "gui" && file.pairPath) slice.guiPairPath = file.pairPath;
    } else if (file.generatorType === "CommandGen") {
        slice.commandEntry = blueprint.commands.find(c => c.executorClass === className);
    } else if (file.generatorType === "TaskGen") {
        slice.taskEntry = blueprint.tasks.find(t => t.taskClass === className);
    } else if (file.generatorType === "ManagerGen") {
        slice.serviceEntry = blueprint.services.find(s => s.managerClass === className);
    } else if (file.generatorType === "MainGen") {
        slice.fullBlueprint = blueprint;
    }
    return slice;
}

/** 根据类名后缀启发式推断 generatorType（用于动态缺失类补全） */
export function inferGeneratorType(className: string, filePath: string): GeneratorType {
    if (!filePath.endsWith(".java")) return "FileRelatedGen";
    if (/Listener$/.test(className)) return "ListenerGen";
    if (/Command$/.test(className) || /Cmd$/.test(className) || /Executor$/.test(className)) return "CommandGen";
    if (/Task$/.test(className) || /Runnable$/.test(className) || /Scheduler$/.test(className)) return "TaskGen";
    if (/Manager$/.test(className) || /Service$/.test(className) || /Repository$/.test(className) || /Store$/.test(className)) return "ManagerGen";
    if (/Config$/.test(className) || /Settings$/.test(className)) return "ConfigClassGen";
    if (/Util$/.test(className) || /Utils$/.test(className) || /Helper$/.test(className)) return "UtilGen";
    if (/Enum$/.test(className) || /Type$/.test(className)) return "EnumGen";
    return "UtilGen";
}

// ─── Build Fix ─────────────────────────────────────────────

export function buildFixPrompt(
    filePath: string,
    fileContent: string,
    buildErrors: string,
    ctx: { projectName: string; packageName: string; coreType: string; version: string; javaVersion: string },
    generatedSummaries?: FileSummary[],
    fileRole?: string,
    apiContractContext?: string,
    knowledgeContext?: string,
    progressContext?: string,
): { system: string; user: string } {
    const apiBlock = generatedSummaries?.length ? formatSummaries(generatedSummaries) : "";
    const isPom = filePath.toLowerCase().endsWith("pom.xml");
    const fileRules = isPom
        ? `这是 Maven pom.xml。只修正仓库、依赖、版本或构建插件配置，不得输出 Java。Paper 仓库必须使用 https://repo.papermc.io/repository/maven-public/。`
        : `你只能使用上面列出的已生成文件中的类、构造器和方法，不要凭空调用不存在的无参构造器或方法。
禁止直接引用或转换插件主类类型，必须使用 Bukkit.getPluginManager().getPlugin("${ctx.projectName}") 获取实例。
文件职责：${fileRole || "未提供显式颜色例外"}
${FILEGEN_OUTPUT_STYLE_RULES}`;

    return {
        system: `你是一个 Minecraft ${ctx.coreType} ${ctx.version} 插件构建修正器。
项目名：${ctx.projectName}，包名：${ctx.packageName}，Java ${ctx.javaVersion}
${apiBlock}
${apiContractContext ?? ""}
${knowledgeContext ?? ""}
Maven 编译失败。根据下方的编译错误日志修正文件，使其能通过编译。
编译器给出的 required/found、候选重载和符号信息是事实，优先级高于模型记忆。
必须处理列出的每一条诊断；只修改诊断涉及的代码及必要 import，不要顺手改动无关逻辑，也不要臆测第三方 API 在目标版本改变了返回类型。
只输出修正后的完整文件正文，不要包裹 markdown 代码块，不要解释。
${fileRules}`,
        user: `文件 ${filePath} 编译失败。\n\n${progressContext ? `修复进度：\n${progressContext}\n\n` : ""}编译错误诊断：\n${buildErrors}\n\n文件内容：\n${fileContent}`,
    };
}
