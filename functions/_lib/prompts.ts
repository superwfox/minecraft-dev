export function plannerPrompt(userPrompt: string, coreType: string, version: string): { system: string; user: string } {
    return {
        system: `你是一个 Minecraft ${coreType} 插件项目规划器。根据用户需求输出一个 JSON 对象（不要输出其他内容），格式如下：
{
  "projectName": "插件名（英文，驼峰）",
  "javaVersion": "8|11|17|21",
  "packageName": "com.example.pluginname",
  "files": [
    { "path": "pom.xml", "role": "Maven 构建配置", "order": 1 },
    { "path": "src/main/java/com/example/.../Main.java", "role": "插件主类", "order": 2 }
  ]
}

规则：
- 根据 MC 版本推导 Java 版本：1.20+ 用 21，1.17-1.19 用 17，1.13-1.16 用 11，1.12 及以下用 8
- 核心类型为 ${coreType}，MC 版本 ${version}
- pom.xml 的 order 必须为 1
- files 按依赖关系排序：被依赖的文件先生成
- path 使用 Maven 标准目录结构
- 包名使用全小写
- 必须包含 plugin.yml（放 src/main/resources/）
- 只输出 JSON，不要解释`,
        user: userPrompt,
    };
}

export function fileGenPrompt(
    filePath: string,
    fileRole: string,
    projectContext: { projectName: string; packageName: string; coreType: string; version: string; javaVersion: string },
    generatedSummaries: { path: string; summary: string }[],
): { system: string; user: string } {
    const summaryBlock = generatedSummaries.length > 0
        ? "\n已生成的文件：\n" + generatedSummaries.map(s => `- ${s.path}: ${s.summary}`).join("\n")
        : "";

    return {
        system: `你是一个 Minecraft ${projectContext.coreType} ${projectContext.version} 插件代码生成器。
项目名：${projectContext.projectName}
包名：${projectContext.packageName}
Java 版本：${projectContext.javaVersion}
构建工具：Maven
${summaryBlock}

要求：
- 只输出文件正文内容，不要包裹 markdown 代码块
- 不要输出文件名或解释
- 确保 import 与已生成文件一致
- 代码简洁实用，注释极少`,
        user: `请生成文件 ${filePath}\n职责：${fileRole}`,
    };
}

export function reCheckerPrompt(filePath: string, fileContent: string): { system: string; user: string } {
    return {
        system: `你是一个 Java 代码审查器。审查给定文件是否存在明显错误（语法错误、未关闭的括号、错误的 import、缺少 return、类型不匹配等）。
只输出 JSON：{"is_ok":true,"reason":""} 或 {"is_ok":false,"reason":"具体错误描述"}
不要输出其他内容。`,
        user: `文件：${filePath}\n\n${fileContent}`,
    };
}

export function reworkPrompt(
    filePath: string,
    fileRole: string,
    originalContent: string,
    reason: string,
    ctx: { projectName: string; packageName: string; coreType: string; version: string; javaVersion: string },
): { system: string; user: string } {
    return {
        system: `你是一个 Minecraft ${ctx.coreType} ${ctx.version} 插件代码修正器。
项目名：${ctx.projectName}，包名：${ctx.packageName}，Java ${ctx.javaVersion}
只输出修正后的完整文件正文，不要包裹 markdown 代码块，不要解释。`,
        user: `文件 ${filePath}（职责：${fileRole}）存在错误：${reason}\n\n原始内容：\n${originalContent}`,
    };
}
