# JAR 生成：AI 能力运用

## Planner — 结构解析

Planner 是代码生成的第一步，负责将模糊的用户需求转化为精确的项目规划。

### 输入

用户的自然语言需求 + 核心类型（Paper/Bukkit 等）+ MC 版本。

### 输出约束

通过 `response_format: { type: "json_object" }` 强制 DeepSeek 输出 JSON：

```json
{
  "projectName": "WelcomePlugin",
  "javaVersion": "21",
  "packageName": "com.example.welcomeplugin",
  "files": [
    { "path": "pom.xml", "role": "Maven 构建配置", "order": 1 },
    { "path": "src/main/resources/plugin.yml", "role": "插件描述文件", "order": 2 },
    { "path": "src/main/java/.../WelcomePlugin.java", "role": "插件主类", "order": 3 }
  ]
}
```

### Prompt 中的关键规则

| 规则 | 目的 |
|------|------|
| Java 版本自动推导 | 1.20+ → 21, 1.17-1.19 → 17, 1.13-1.16 → 11, ≤1.12 → 8 |
| pom.xml order 必须为 1 | 确保构建配置最先生成，后续文件可引用依赖 |
| 按依赖关系排序 | 被依赖的文件先生成，避免 import 不一致 |
| 必须包含 plugin.yml | Bukkit/Paper 插件的硬性要求 |

### 接近 MCP 的功能拆分

传统的 AI 代码生成是一次性输出整个项目。本系统采用类似 MCP（Model Context Protocol）的思路，将"生成项目"拆分为多个可控步骤：

1. **Planner** 做结构规划（相当于 MCP 中的"工具选择"）
2. **FileGen** 逐个执行（相当于"工具调用"）
3. **reChecker** 验证结果（相当于"结果校验"）

每一步的输入输出都是结构化的，前端可以追踪每一步的执行状态，用户能实时看到进度。这比一次性生成整个项目更可控、更可靠。

## FileGen — 逐文件代码生成

### 上下文传递

每次只生成一个文件，但传入已生成文件的摘要列表作为上下文：

```
System Prompt:
  项目名：WelcomePlugin
  包名：com.example.welcomeplugin
  
  已生成的文件：
  - pom.xml: <project>...（前3行截断120字符）
  - plugin.yml: name: WelcomePlugin version: 1.0...

User Prompt:
  请生成文件 src/main/java/.../WelcomePlugin.java
  职责：插件主类，注册事件监听器
```

**摘要而非全文**：每个已生成文件只取前 3 行截断 120 字符作为摘要。这样既提供了足够的上下文（包名、类名、关键 import），又避免 token 爆炸。

**为什么不一次传所有文件全文**：
- Token 限制：一个 10 文件项目的全文可能超过 20K tokens
- 噪音太多：后续文件只需要知道"前面文件叫什么、暴露了什么接口"
- 摘要足够：包含了 package 声明、类名和主要方法签名

### 代码清洗

AI 返回的内容可能包含 markdown 代码块包裹：

```typescript
content = content.replace(/^```[\w]*\n?/, "").replace(/\n?```$/, "");
```

这确保存入 KV 的是纯代码内容，不带格式标记。

## reChecker — 代码审查

### 设计思路

reChecker 是一个**无上下文的独立审查器**。它不知道项目的其他文件，只看当前文件本身是否有明显错误。

这个设计是有意为之的：
- 无上下文 = 审查标准不受其他文件影响
- 专注于语法和基本逻辑错误
- 快速执行（只传一个文件的内容）

### 审查 Prompt

```
System: 你是一个 Java 代码审查器。审查是否存在明显错误
        （语法错误、未关闭的括号、错误的 import、缺少 return、类型不匹配等）
        只输出 JSON：{"is_ok":true,"reason":""} 或 {"is_ok":false,"reason":"具体错误描述"}

User:   文件：{path}
        {文件内容}
```

### 返工循环

```
生成文件 → reChecker 审查
              ↓ is_ok: true → 提交
              ↓ is_ok: false
          带 reason 返工 → reChecker 再审查
              ↓ ...（最多 2 次返工）
```

返工时，原始内容 + 错误原因一起传给 AI：

```
文件 Main.java（职责：插件主类）存在错误：
onEnable 方法缺少 @Override 注解，getServer() 调用应在 onEnable 内部

原始内容：
{文件全文}
```

最多返工 2 次（`MAX_REWORK = 2`）。如果 2 次后仍未通过，使用最后一次的结果继续流程，避免死循环。

## 生成顺序的重要性

Planner 输出的 `order` 字段决定了文件的生成顺序，这直接影响代码质量：

| 顺序 | 文件类型 | 原因 |
|------|---------|------|
| 1 | pom.xml | 确定依赖关系和编译版本 |
| 2 | plugin.yml | 声明主类路径和插件信息 |
| 3 | 基础工具类 | 被其他类引用 |
| 4 | 主类 | 引用工具类，注册监听器 |
| 5 | 监听器和命令处理器 | 最终实现类 |

先生成的文件的摘要进入后续文件的上下文，保证 import 路径和方法签名的一致性。
