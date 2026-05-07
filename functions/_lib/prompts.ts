/** 结构化文件摘要，用于跨文件上下文传递 */
export interface FileSummary {
    path: string;
    className?: string;
    extends?: string;
    implements?: string[];
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
): { system: string; user: string } {
    const history = priorRounds.length
        ? "\n\n已完成的澄清轮次：\n" + priorRounds.map((r, i) =>
            `第 ${i + 1} 轮：\n${r.todos.map(t => `  Q[${t.id}] ${t.question} → 用户选择：${JSON.stringify(r.answers[t.id])}`).join("\n")}`
        ).join("\n")
        : "";

    return {
        system: `你是一个 Minecraft ${coreType} ${version} 插件项目规划器的澄清阶段。你的任务不是直接产出文件列表，而是先列出所有不明晰、需用户确认的决策点，组织成 TodoList。

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
- 只要能识别出至少一个明确功能点（如"一个出生点"、"记录玩家击杀数"），就正常产出 todos，不要用 needMoreInput

强制规则（必须在某一轮产出，已在历史中出现过的不要重复）：
- 必须包含 id="ui-interaction"：玩家如何触发与获得反馈？
  options 固定为：["聊天命令 + SendMessage 文本反馈", "聊天命令 + Inventory GUI 反馈"]
  （其他方案难以保证最终质量，只能通过 allowCustom 让用户输入）
- 必须包含 id="persistence"：options 固定为 ["文本存储", "二进制存储"]
- 如果上一轮 persistence 答案为"文本存储"，本轮必须追问 id="text-format"，
  options 固定为 ["CSV", "TXT", "YAML"]

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

核心类型：${coreType}，MC 版本：${version}`,
        user: `用户原始需求：${userPrompt}${history}\n\n请产出本轮的 TodoList（若已充分覆盖则返回 done:true）。`,
    };
}

// ─── Planner ────────────────────────────────────────────────

export function plannerPrompt(
    userPrompt: string,
    coreType: string,
    version: string,
    clarifyRounds?: ClarifyRound[],
): { system: string; user: string } {
    const clarifyBlock = clarifyRounds?.length
        ? "\n\n用户已确认的决策（必须严格遵守）：\n" + clarifyRounds.flatMap(r =>
            r.todos.map(t => `- ${t.question} → ${JSON.stringify(r.answers[t.id])}`)
        ).join("\n")
        : "";

    return {
        system: `你是一个 Minecraft ${coreType} 插件项目规划器。根据用户需求输出一个 JSON 对象（不要输出其他内容），格式如下：
{
  "projectName": "插件名（英文，驼峰）",
  "javaVersion": "8|11|17|21",
  "packageName": "com.example.pluginname",
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
    { "path": "src/main/java/com/example/.../SetNoticeCommand.java", "role": "/setnotice 命令：CommandExecutor + TabCompleter", "order": 3, "depends": ["DataManager.java"], "generatorType": "CommandGen", "tag": null },
    { "path": "src/main/java/com/example/.../Main.java", "role": "插件主类，注册所有命令/监听器/任务并管理生命周期", "order": 4, "depends": ["SetNoticeCommand.java","DataManager.java"], "generatorType": "MainGen", "tag": null }
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
- 根据 MC 版本推导 Java 版本：1.20+ 用 21，1.17-1.19 用 17，1.13-1.16 用 11，1.12 及以下用 8
- 核心类型为 ${coreType}，MC 版本 ${version}
- pom.xml 的 order 必须为 1
- depends 数组填写该文件依赖的其他文件的文件名（不含路径前缀），例如 ["DataManager.java"]
- MainGen 文件的 order 必须最大；其 depends 必须列出所有 Listener / Command / Task / Manager 的文件名
- files 按依赖拓扑排序：被依赖的文件 order 小，依赖方 order 大
- 同深度（depends 互相不引用）的文件之间不能相互调用——若两个 leaf 都需要某 helper，把 helper 下沉为它们共同的依赖
- path 使用 Maven 标准目录结构
- 包名使用全小写
- 必须包含 plugin.yml（放 src/main/resources/，generatorType 为 ConfigGen）
- 只输出 JSON，不要解释

极简原则（严格遵守）：
- 只规划用户需求中明确提到或逻辑上必需的文件，不要自行扩展功能范围
- 每个文件的 role 必须精确描述该文件需要实现的具体功能点，不要使用笼统描述如"管理器"、"工具类"
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
- **YAML 数据持久化**：用户选择文本/YAML 存储时，规划须包含一个独立的 ManagerGen 类（自行管理 File + YamlConfiguration.loadConfiguration / save），并由 Main.onDisable 中触发落盘
- **调度任务（TaskGen）**：若涉及定时/重复任务，规划须明确该 TaskGen 类，并通过 mainBlueprint.tasks 声明 schedule 与 periodTicks
- **plugin.yml**：必须列出 name / version / main / api-version；所有命令需在 commands 节点声明（含 description / usage / aliases / permission）；若涉及权限节点，必须在 permissions 节点声明
- **Main.java（MainGen）**：必须 extends JavaPlugin；onEnable 负责 saveDefaultConfig（如有）+ 注册所有 Executor/TabCompleter + 注册所有 Listener + 启动调度任务 + 实例化所有 services；onDisable 负责数据落盘`,
        user: `${userPrompt}${clarifyBlock}`,
    };
}

// ─── FileGen ────────────────────────────────────────────────

export function fileGenPrompt(
    filePath: string,
    fileRole: string,
    projectContext: { projectName: string; packageName: string; coreType: string; version: string; javaVersion: string },
    generatedSummaries: FileSummary[],
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
- 你只能调用上面「已生成文件的可用 API」中列出的类和方法，不要假设任何未列出的方法或类存在
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
- **Inventory GUI**：自定义 GUI 必须用 InventoryHolder 标识（推荐让 GUI 类 implements InventoryHolder 并由 Bukkit.createInventory(this, size, title) 创建）。监听 InventoryClickEvent 时先判断 event.getInventory().getHolder() instanceof YourGUI，再 event.setCancelled(true) 阻止取出物品，然后用 event.getRawSlot() 派发点击逻辑
- **配置读取**：通过 getConfig().getXxx("path", default) 读取。Main.onEnable 必须先调用 saveDefaultConfig() 才能读到 resources/config.yml 的默认值
- **YAML 数据持久化**：用 File dataFile = new File(getDataFolder(), "data.yml"); YamlConfiguration cfg = YamlConfiguration.loadConfiguration(dataFile); 读写后 cfg.save(dataFile) 落盘。getDataFolder() 不存在时先 mkdirs()。Main.onDisable 必须保存所有可变数据
- **调度任务**：用 new BukkitRunnable() { @Override public void run() { ... } }.runTaskTimer(plugin, delay, period) 启动周期任务；一次性延迟用 runTaskLater；同步任务避免阻塞主线程，耗时操作用 runTaskAsynchronously
- **plugin.yml 完整性**：必须含 name、version、main（全限定主类名）、api-version。命令必须在 commands 节点声明（每条至少 description；可选 usage/aliases/permission）。声明的权限节点必须列在 permissions 节点（含 description、default）
- **权限检查**：通过 sender.hasPermission("plugin.cmd.xxx") 判断，未通过时 sender.sendMessage 提示并 return true
- **消息着色**：使用 ChatColor 枚举或 § 字符常量（如 ChatColor.GOLD + "..."），不要在字符串字面量中写 §
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
): { system: string; user: string } {
    const crossFileBlock = generatedSummaries?.length
        ? "\n\n项目中已生成文件的可用 API：" + formatSummaries(generatedSummaries) +
          "\n\n除上述 API 外，还需检查：当前文件调用的项目内方法是否在上述 API 列表中存在。如果调用了未列出的项目内方法，视为错误。"
        : "";

    return {
        system: `你是一个 Java 代码审查器。审查给定文件是否存在明显错误（语法错误、未关闭的括号、错误的 import、缺少 return、类型不匹配等）。${crossFileBlock}
检查是否存在对插件主类的直接类型引用或强制转换（如 (MainClass) getPlugin(...)、MainClass.getInstance()）。代码应通过 Bukkit.getPluginManager().getPlugin("${projectName || "PluginName"}") 获取插件实例，类型为 Plugin 接口。发现此类模式视为错误。
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
): { system: string; user: string } {
    const apiBlock = generatedSummaries?.length ? formatSummaries(generatedSummaries) : "";

    return {
        system: `你是一个 Minecraft ${ctx.coreType} ${ctx.version} 插件代码修正器。
项目名：${ctx.projectName}，包名：${ctx.packageName}，Java ${ctx.javaVersion}
${apiBlock}
只输出修正后的完整文件正文，不要包裹 markdown 代码块，不要解释。
你只能调用上面列出的已生成文件中的类和方法，不要凭空调用不存在的方法。
禁止直接引用或转换插件主类类型，必须使用 Bukkit.getPluginManager().getPlugin("${ctx.projectName}") 获取实例。`,
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
                    "      - 通过 Bukkit.createInventory(this, size, ChatColor.* + title) 构造 Inventory",
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
                    "- 加入 papermc / spigotmc 仓库（按 coreType）",
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
): {
    gen: { system: string; user: string };
    checker: (filePath: string, fileContent: string) => { system: string; user: string };
} {
    const base = fileGenPrompt(file.path, file.role, ctx, ancestorSummaries);
    const spec = specializationBlock(file, slice, ctx);
    const gen = {
        system: spec ? base.system + "\n\n" + spec : base.system,
        user: base.user,
    };
    const checkerSpec = checkerSpecializationBlock(file, slice);
    const checker = (path: string, content: string) => {
        const baseChk = reCheckerPrompt(path, content, ancestorSummaries, ctx.projectName);
        return {
            system: checkerSpec ? baseChk.system + "\n\n" + checkerSpec : baseChk.system,
            user: baseChk.user,
        };
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
): { system: string; user: string } {
    const apiBlock = generatedSummaries?.length ? formatSummaries(generatedSummaries) : "";

    return {
        system: `你是一个 Minecraft ${ctx.coreType} ${ctx.version} 插件代码修正器。
项目名：${ctx.projectName}，包名：${ctx.packageName}，Java ${ctx.javaVersion}
${apiBlock}
Maven 编译失败。根据下方的编译错误日志修正文件，使其能通过编译。
只输出修正后的完整文件正文，不要包裹 markdown 代码块，不要解释。
你只能调用上面列出的已生成文件中的类和方法，不要凭空调用不存在的方法。
禁止直接引用或转换插件主类类型，必须使用 Bukkit.getPluginManager().getPlugin("${ctx.projectName}") 获取实例。`,
        user: `文件 ${filePath} 编译失败。\n\n编译错误日志：\n${buildErrors}\n\n文件内容：\n${fileContent}`,
    };
}
