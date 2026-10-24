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

/** 锁定结构派生的主类装配"主干蓝图" */
export interface MainBlueprint {
    fqcn?: Record<string, string>;
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

/** 结构派生计划中的单个实现文件 */
export interface PlanFileItem {
    nodeId?: string;
    moduleId?: string;
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

// ─── Grader（结构规划 + 实现路径）────────────────────────────

export function skillTreeContext(bundles: SkillBundle[]): string {
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
    return "\n\n══ 已挂载能力包（用户主动选择，请通过结构树工具规划出实现这些能力所需的文件，并让相关业务文件依赖它们；实现细节会在逐文件生成时提供可照抄的骨架，此处只需把文件及其职责、契约规划进结构树） ══\n"
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

/** 给需求澄清阶段的能力引导，问题围绕已挂载能力提出 */
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
        + "\n\n要点：澄清问题 / 结构规划都要**优先围绕这些能力的落地细节**——要对接的服务端/地址/端口/凭证、目标对象（群号等）、要启用能力包里的哪些子功能、与现有业务如何衔接；不要问能力包已替用户决定好的事，也不要给出与能力包 deny 冲突的方向。";
}

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
        system: `missing_classes 只列出既不在结构树类名列表、也不在已生成摘要中的类。
你是一个 Java 代码审查器。审查给定文件是否存在明显错误（语法错误、未关闭的括号、错误的 import、缺少 return、类型不匹配等）。${crossFileBlock}
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
        ...Object.values(bp.fqcn ?? {}).map(fqcn => `import ${fqcn};`),
    ].join("\n");
}

function pomCoreRules(ctx: { coreType: string; version: string }): {
    dependencyRule: string;
    repositoryRule: string;
} {
    const coreType = ctx.coreType.trim();
    const normalizedCore = coreType.toLowerCase();
    if (normalizedCore === "paper") {
        return {
            dependencyRule: /^26\./.test(ctx.version)
                ? ctx.version === "26.2"
                    ? "Paper 26.x 使用官方 Maven metadata 中带 build 号的 stable 版本；Paper 26.2 当前已核验为 io.papermc.paper:paper-api:26.2.build.112-stable。禁止拼接 -R0.1-SNAPSHOT"
                    : `Paper 26.x 使用官方 Maven metadata 中与 ${ctx.version} 对应的最新 <version>.build.<number>-stable 完整版本。必须以 https://repo.papermc.io/repository/maven-public/io/papermc/paper/paper-api/maven-metadata.xml 为准，禁止拼接 -R0.1-SNAPSHOT`
                : `Paper 1.x 使用传统版本 io.papermc.paper:paper-api:${ctx.version}-R0.1-SNAPSHOT`,
            repositoryRule: "Paper 仓库必须使用 https://repo.papermc.io/repository/maven-public/，禁止使用已返回 403 的旧地址 https://papermc.io/repo/repository/maven-public/",
        };
    }
    if (normalizedCore === "spigot") {
        return {
            dependencyRule: `Spigot 使用 org.spigotmc:spigot-api 与 MC ${ctx.version} 匹配的官方版本`,
            repositoryRule: "Spigot 仓库使用 https://hub.spigotmc.org/nexus/content/repositories/snapshots/",
        };
    }
    const label = coreType || "当前核心";
    return {
        dependencyRule: `${label} 使用其官方构建体系中与 MC ${ctx.version} 匹配的依赖坐标；不得套用 Paper 或 Spigot API 坐标`,
        repositoryRule: `${label} 只使用该核心官方文档指定的仓库；不得无条件加入 Paper 或 Spigot 仓库`,
    };
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
                const { dependencyRule, repositoryRule } = pomCoreRules(ctx);
                return [
                    "═══ FileRelatedGen / pom.xml 专项规则 ═══",
                    `- groupId 取自包名前两段（如 ${ctx.packageName.split(".").slice(0, 2).join(".")}），artifactId=${ctx.projectName}`,
                    `- maven-compiler-plugin 的 source/target 设为 ${ctx.javaVersion}`,
                    `- ${dependencyRule}；scope 为 provided`,
                    `- ${repositoryRule}`,
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
    treeContext = "",
): {
    gen: { system: string; user: string };
    checker: (filePath: string, fileContent: string) => { system: string; user: string };
} {
    const spec = specializationBlock(file, slice, ctx);
    const additionalContext = [spec, apiContractContext, knowledgeContext, skillContext, treeContext].filter((v): v is string => !!v).join("\n\n");
    // 统一输出规范由 fileGenPrompt 放在最终尾部，确保专项规则与 skill 骨架不能覆盖它。
    const gen = fileGenPrompt(file.path, file.role, ctx, ancestorSummaries, additionalContext);
    if (treeContext) gen.user += "\n\n" + treeContext;
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
    treeContext?: string,
): { system: string; user: string } {
    const apiBlock = generatedSummaries?.length ? formatSummaries(generatedSummaries) : "";
    const isPom = filePath.toLowerCase().endsWith("pom.xml");
    const pomRules = pomCoreRules(ctx);
    const fileRules = isPom
        ? `这是 Maven pom.xml。只修正仓库、依赖、版本或构建插件配置，不得输出 Java。${pomRules.dependencyRule}；${pomRules.repositoryRule}。`
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
${fileRules}
${treeContext ?? ""}`,
        user: `文件 ${filePath} 编译失败。\n\n${progressContext ? `修复进度：\n${progressContext}\n\n` : ""}编译错误诊断：\n${buildErrors}\n\n文件内容：\n${fileContent}`,
    };
}

export interface TreeBuilderInput {
    userPrompt: string; coreType: string; version: string; clarifyRounds?: ClarifyRound[];
    treeSnapshot: string; issues: { code: string; message: string }[];
    lastResults: { ok: boolean; error?: string; tool?: string; field?: string; errorCode?: string }[]; mode: "build" | "refine";
    correction: string; focusIds: string[]; round: number; maxRounds: number;
    apiContractContext?: string; knowledgeContext?: string; skillContext?: string;
}
export function treeBuilderPrompt(input: TreeBuilderInput): { system: string; user: string } {
    const decisions = input.clarifyRounds?.flatMap(round => round.todos.map(todo => `- ${todo.question} → ${JSON.stringify(round.answers[todo.id])}`)).join("\n") ?? "";
    return {
        system: `你是 Minecraft ${input.coreType} ${input.version} 项目结构规划器。用工具构建结构树，不输出 JSON 正文。
模块对应 Java 子包，模块数等于业务域数；只有一个业务域时只建一个模块。只有被两个以上模块共用的代码才放 common。
节点对应单个文件并携带完整成员契约。项目名 PascalCase，模块 id 小写英文，Java 节点 id 为类名且全项目不区分大小写唯一。
页面每列对应一条需求行为路径，每个可见节点是业务步骤，并绑定一个或多个实现文件。先用 upsert_module/upsert_node 建文件，再用 upsert_path 编排从触发到结果的步骤。不同触发方式分别建路径，共享逻辑绑定同一文件；不能把模块文件清单冒充行为路径，不新增需求之外的功能。
upsert_path 的 nodes 按执行顺序排列，kind 使用“触发”“条件”“动作”“结果”等简短标签；路径 id 为小写英文、数字、连字符，步骤 id 全项目唯一，建议路径 id 加步骤后缀。最多 10 条路径、每条 12 步、合计 80 步，每步必须绑定已有文件 id。删除业务时用 remove_path 删除对应路径，同时用文件工具同步清理不再需要的文件和契约。
最多 10 个业务模块、40 个业务节点，每轮最多 60 次工具调用。
CommandGen：commands 非空，同时实现 CommandExecutor 和 TabCompleter。
ListenerGen：events 非空，实现 Listener；GUI 持有类可以无事件，但必须与监听类 tag=gui、pairId 互指，并包含 InventoryClickEvent。
TaskGen：schedule 非空，继承 BukkitRunnable，由 Main 启动。
ManagerGen：集中服务状态；ConfigClassGen：YAML 配置包装；ModelGen：POJO；EnumGen：枚举；UtilGen：无状态工具。
ConfigGen 只能放 _resources，声明 configKeys 时必须添加 config.yml。所有 methods、constructors、events、commands、schedule、configKeys、lifecycle 都是必须遵守的契约。
contract.events 填事件类名，如 AsyncChatEvent（接受完整包名并规范为简类名），不要填处理方法或方法签名。contract.configKeys 填 YAML 配置路径，如 rewardAmount 或 reward.item，保留大小写；命令名与 aliases 使用不含 / 的小写名称。
每轮先查看当前树快照和上一轮工具结果：已存在且内容不变的项目或模块无需再次写入；优先修正失败工具所指出的字段，再补齐缺失文件、路径及步骤。重复提交相同模块不算规划进展。
一轮可以批量调用多个树工具。认为完成时调用 finish_tree。learn_public_api 不能与树工具在同一轮混用。
系统模块 _build、_resources、_root 不可删除改名；pom.xml、plugin.yml、Main 由系统维护，不能改动；MainGen 和 FileRelatedGen 不可由模型创建。
不使用的 schedule.mode、lifecycle、tag 填 none，其余可选语义用空字符串或空数组。
refine 模式只改动修正意见和选中对象所涉及的部分，保持其余节点 id 不变。
极简原则（严格遵守）：
- 只规划用户需求中明确提到或逻辑上必需的文件，不要自行扩展功能范围
- 对无状态的事件动作采用自然最小默认值：未要求反馈就不额外发消息，未要求权限就不增加权限节点，未要求首次奖励或防刷就不增加持久化记录；“进入服务器时”按每次成功加入后的事件处理，不追溯插件加载时已经在线的玩家
- 规划向玩家物品栏发放物品的职责时，必须在相关 节点职责 中写明处理 Inventory.addItem 返回的剩余物，背包已满时在玩家位置自然掉落，避免静默丢失；这是技术完整性处理，不扩展为邮件、暂存或领取系统
- 每个文件的 role 必须精确描述该文件需要实现的具体功能点，不要使用笼统描述如"管理器"、"工具类"
- 用户原始需求若明确指定了某条输出的颜色或格式，必须把该要求原样写入每个相关 节点职责，供逐文件生成与审查识别例外；未明确指定时不得自行添加其他颜色
- 如果用户需求是"添加任务"，不要自行扩展出"删除任务"、"查询任务"、"任务列表"等未要求的功能
- 能在一个文件中实现的逻辑不要拆分成多个文件
- 不要规划与用户需求无关的辅助类、工具类、基类、接口
- 功能类只实现 role 中描述的功能，不要预留扩展方法
- 禁止把 Manager 标成 Util；禁止把 TabCompleter 与 Executor 拆成两个文件

Paper / Bukkit 配套结构知识（规划必备文件时强制遵守）：
- **命令类（CommandGen）**：onCommand + onTabComplete 必须在同一个类中，不要拆文件；无论需求是否明说，规划阶段都必须为命令准备完整实现并在 plugin.yml 的 commands 节点声明
- **事件监听类（ListenerGen）**：由 Main.onEnable 通过 getServer().getPluginManager().registerEvents 注册；规划要为 Listener 与 Main 之间建立 depends 关系
- **Inventory GUI**：若涉及自定义 GUI，必须列出两条 ListenerGen 文件——一条是 GUI 持有类（implements InventoryHolder，提供构造 Inventory 的方法），一条是 InventoryClickEvent 监听类。两条都标 tag="gui"，pairId 互相指向对方
- **配置文件**：若涉及任何可配置参数或文本，必须规划 src/main/resources/config.yml（ConfigGen），并由 Main.onEnable 调用 saveDefaultConfig
- **数据持久化**：**仅当**需要集中管理「较多结构化数据」（多条记录 / 需增删查的集合）时，才规划独立 ManagerGen 类（管理 File + YamlConfiguration，Main.onDisable 落盘）；**少量数据（单玩家数据 / 几个值）优先用 PDC 或直接 getConfig()/saveConfig()，不要为此引入 ManagerGen 重类**——无谓的重类会抬高复杂度、易生成失败而功能收益极小
- **调度任务（TaskGen）**：若涉及定时/重复任务，规划须明确该 TaskGen 类，并通过 mainBlueprint.tasks 声明 schedule 与 periodTicks
- **plugin.yml**：必须列出 name / version / main / api-version；所有命令需在 commands 节点声明（含 description / usage / aliases / permission）；若涉及权限节点，必须在 permissions 节点声明
- **Main.java（MainGen）**：必须 extends JavaPlugin；onEnable 负责 saveDefaultConfig（如有）+ 注册所有 Executor/TabCompleter + 注册所有 Listener + 启动调度任务 + 实例化所有 services；onDisable 负责数据落盘
按需求落实以下约束，不新增用户未要求的业务：
【持久化】只用 YAML 配置文件 或 PDC（PersistentDataContainer），禁止 SQL/JDBC/数据库；须写明：存什么、读写时机、由 Main.onDisable 落盘。**状态极少（单玩家数据 / 几个值）时优先用 PDC 或直接 getConfig()，不要为此新建独立 ManagerGen / DataManager 重类**。
【调度任务】须写明：周期(periodTicks)或一次性、主线程约束、由 Main 启动并在 onDisable cancel。
【共享状态】须写明：这份可变状态唯一写入方是谁、其他类只读、读取一致性如何保证（避免多处并发写）。
【外部硬集成】须在 plugin.yml 声明 depend/softdepend，写明缺失该插件时的降级行为；只用 Vault/PlaceholderAPI/WorldGuard 这类。
【GUI 会话】须写明：会话状态存哪、InventoryClickEvent 点击如何路由、InventoryCloseEvent 关闭时如何清理。
${input.apiContractContext ?? ""}
${input.knowledgeContext ?? ""}
${input.skillContext ?? ""}`,
        user: `原始需求：${input.userPrompt}\n\n用户已确认的决策（必须严格遵守）：\n${decisions}\n\n当前树快照：\n${input.treeSnapshot}\n\n上一轮失败操作：\n${input.lastResults.filter(r => !r.ok).map(r => `${r.tool ?? "工具"}${r.field ? ` / ${r.field}` : ""} [${r.errorCode ?? "TREE_TOOL_FAILED"}]：${r.error ?? "操作失败"}`).join("\n")}\n\n校验问题：\n${input.issues.map(i => `${i.code}: ${i.message}`).join("\n")}\n\n第 ${input.round}/${input.maxRounds} 轮\n${input.mode === "refine" ? `用户修正原文：${input.correction}\n选中对象（id 与标题见快照）：${input.focusIds.join(", ")}` : ""}`,
    };
}
