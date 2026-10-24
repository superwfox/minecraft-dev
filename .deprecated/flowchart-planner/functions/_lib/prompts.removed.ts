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
        system: `你是一个 Minecraft ${coreType} ${version} 插件需求的「结构规划 + 实现路径」分析器。在生成完整 plan 之前，先抽取打分向量、定级，并在非直接级时给出可视化的实现路径。

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
        ? "\n\n据结构规划，本需求点亮了以下轴，plan 必须覆盖对应内容（写进相关文件的 role），但实现一律取最简：\n"
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
