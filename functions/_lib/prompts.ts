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

// ─── Planner ────────────────────────────────────────────────

export function plannerPrompt(userPrompt: string, coreType: string, version: string): { system: string; user: string } {
    return {
        system: `你是一个 Minecraft ${coreType} 插件项目规划器。根据用户需求输出一个 JSON 对象（不要输出其他内容），格式如下：
{
  "projectName": "插件名（英文，驼峰）",
  "javaVersion": "8|11|17|21",
  "packageName": "com.example.pluginname",
  "files": [
    { "path": "pom.xml", "role": "Maven 构建配置", "order": 1, "depends": [] },
    { "path": "src/main/java/com/example/.../SomeUtil.java", "role": "工具类", "order": 2, "depends": [] },
    { "path": "src/main/java/com/example/.../Main.java", "role": "插件主类", "order": 3, "depends": ["SomeUtil.java"] }
  ]
}

规则：
- 根据 MC 版本推导 Java 版本：1.20+ 用 21，1.17-1.19 用 17，1.13-1.16 用 11，1.12 及以下用 8
- 核心类型为 ${coreType}，MC 版本 ${version}
- pom.xml 的 order 必须为 1
- depends 数组填写该文件依赖的其他文件的文件名（不含路径前缀），例如 ["EconomyManager.java"]
- 插件主类（继承 JavaPlugin 的类）的 order 必须是所有 Java 文件中最大的，因为它依赖所有其他类
- files 按依赖拓扑排序：被依赖的文件 order 小，依赖方 order 大
- path 使用 Maven 标准目录结构
- 包名使用全小写
- 必须包含 plugin.yml（放 src/main/resources/）
- 只输出 JSON，不要解释`,
        user: userPrompt,
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
- 代码简洁实用，注释极少`,
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
