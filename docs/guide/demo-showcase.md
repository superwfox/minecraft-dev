# 完整演示：维护插件生成

本文展示一个完整的插件生成案例，从需求描述到最终 JAR，演示 AI 如何处理多文件项目和自动修正错误。

> **开始前**：用户已用 GitHub 登录平台，并填写自己的 DeepSeek API Key；也可以使用已有充值余额走平台模型。本文聚焦生成流程本身，登录与额度细节见 [快速开始](/guide/quick-start)。

## 需求描述

```
请帮我完成一个玩家进服后被踢出并提示正在维护的插件，
并且支持用 /setNotice 命令设置踢出时的提示
```

### 需求分析

这个需求包含以下功能点：

1. **事件监听**：监听玩家加入服务器事件
2. **踢出玩家**：在玩家加入时立即踢出
3. **配置系统**：提示消息可配置
4. **命令系统**：提供命令修改配置
5. **权限控制**：命令需要权限

这是一个典型的**多文件项目**，需要：
- 主类（注册事件和命令）
- 事件监听器类
- 命令处理器类
- 配置文件（plugin.yml、config.yml）
- Maven 构建配置（pom.xml）

## 第零阶段：需求确认

### 步骤 1：precheck 完整性预检（deepseek-v4-pro + thinking）

用户提交后，前端先调用 `/api/chat` 走 `deepseek-v4-pro` 判断需求是否闭环。

**输入**：
```json
{
  "model": "deepseek-v4-pro",
  "messages": [
    { "role": "system", "content": "你是 Minecraft 插件需求完整性检查器..." },
    { "role": "user", "content": "请帮我完成一个玩家进服后被踢出..." }
  ]
}
```

**输出**：
```json
{ "complete": true }
```

● 需求闭环（含核心功能 + 玩家行为 + 命令触发），直接进入下一步。若返回 `complete: false`，输入框会预填"原始内容 + 补充方向：xxx"，等用户补完再提交。

### 步骤 2：getInfo 提取核心 + 版本 → 用户确认

`deepseek-v4-flash` 提取出 `coreType: "PAPER"`、`version: "1.20.6"`，因为已写在需求中无需再问。

### 步骤 3：多轮 Clarify 澄清（deepseek-v4-pro + thinking）

确认版本后调用 `POST /api/generate/plan`（无 taskId）创建任务，再循环调用 `POST /api/generate/clarify` 进入澄清。

**第 1 轮 Clarify 输出**（前端通过 SSE 增量收到 `reasoning` 写入折叠区，`todos` 增量解析逐张推到 ClarifyPanel）：

```json
{
  "done": false,
  "todos": [
    {
      "id": "ui-interaction",
      "question": "玩家与维护提示的交互方式？",
      "options": ["聊天命令 + sendMessage", "聊天命令 + Inventory GUI", "其他（无法保证最终质量）"],
      "allowCustom": true,
      "multiSelect": false
    },
    {
      "id": "persistence",
      "question": "维护提示如何持久化？",
      "options": ["文本存储", "二进制存储"],
      "allowCustom": false,
      "multiSelect": false
    },
    {
      "id": "permission",
      "question": "/setNotice 命令的权限节点前缀？",
      "options": ["maintenancekicker.*", "admin.*", "自定义"],
      "allowCustom": true,
      "multiSelect": false
    }
  ]
}
```

ClarifyPanel 顶部显示进度 `1/3`，单卡片纵向选项。用户选择：
- ui-interaction → `聊天命令 + sendMessage`
- persistence → `文本存储`
- permission → `maintenancekicker.*`

**第 2 轮 Clarify**（系统检测到 persistence=文本，自动追问 text-format）：
```json
{
  "done": false,
  "todos": [
    {
      "id": "text-format",
      "question": "文本存储格式？",
      "options": ["YAML", "CSV", "TXT"],
      "allowCustom": false,
      "multiSelect": false
    }
  ]
}
```

用户选 `YAML`。

**第 3 轮 Clarify**：
```json
{ "done": true, "todos": [] }
```

● 澄清结束，共 2 轮真问 + 1 轮收尾，clarifyRounds 写回 KV。

## 第零·五阶段：复杂度分级与实现路径

澄清结束后、进入 Planner 之前，前端调用 `POST /api/generate/grade`（`deepseek-v4-pro` + thinking），先给需求评一个复杂度，必要时让用户拍板实现路径。

### grade 输出

前端通过 SSE 收到 `reasoning`（思考流）+ 最终 `result`：

```json
{
  "direct": false,
  "level": "中等",
  "paths": [
    {
      "id": "config-reload",
      "title": "命令直接写 config.yml",
      "summary": "/setNotice 把新提示写进 config.yml 并 saveConfig()，进服时实时读取。最简，零额外状态。"
    },
    {
      "id": "memory-cache",
      "title": "内存缓存 + 启动加载",
      "summary": "onEnable 读入内存，命令改内存并落盘；进服读内存，省一次磁盘 IO。"
    }
  ]
}
```

**为什么是「中等」而不是「简单」？** 提示消息要**持久化**到 YAML 文件——`functions/_lib/complexity.ts` 的硬规则把「persistent」一律顶到至少「中等」，模型即便想判低也会被 `enforceLevelFloor` 拉回。广度轴（就一个命令 + 一个监听）不抬等级，只影响 plan 体量。

### 实现路径确认门

因为不是「直接」级、且给出了多条 `paths`，前端进入 `confirming` 阶段，以「手牌」式卡片展示两条路径。用户选择：

- `config-reload` → 最贴合「服主就想改个提示语」的朴素诉求。

> 若两条都不满意，可填一句修正打回，Grader 带着修正重新分级。需求若被判「直接」级、或没有给出可选路径，这道门会自动跳过，直接进 Planner。

被选定的 `chosenPathId = "config-reload"` 与打分向量一起带进下一步——Planner 据此把体量收在「一个命令 + 一个监听 + config 读写」，不画蛇添足。

## 第一阶段：Planner 规划

澄清与分级完成后，前端再次调用 `POST /api/generate/plan`（带 taskId 与 `chosenPathId`），后端把已确认决策 + 所选实现路径拼接进 `plannerPrompt` 并调用 `deepseek-v4-pro` 出文件树。

### Planner 输入

KV 中聚合后传入 `plannerPrompt` 的上下文：

```json
{
  "userPrompt": "请帮我完成一个玩家进服后被踢出并提示正在维护的插件，并且支持用 /setNotice 命令设置踢出时的提示",
  "coreType": "PAPER",
  "version": "1.20.6",
  "clarifyRounds": [
    {
      "answers": {
        "ui-interaction": "聊天命令 + sendMessage",
        "persistence": "文本存储",
        "permission": "maintenancekicker.*"
      }
    },
    {
      "answers": { "text-format": "YAML" }
    }
  ]
}
```

### Planner 输出

```json
{
  "projectName": "MaintenanceKicker",
  "packageName": "com.example.maintenancekicker",
  "javaVersion": "17",
  "files": [
    {
      "path": "pom.xml",
      "role": "Maven 构建配置，定义依赖和编译参数",
      "order": 1,
      "depends": []
    },
    {
      "path": "src/main/resources/plugin.yml",
      "role": "插件描述文件，声明插件信息、命令和权限",
      "order": 2,
      "depends": []
    },
    {
      "path": "src/main/resources/config.yml",
      "role": "默认配置文件，存储踢出提示消息",
      "order": 3,
      "depends": []
    },
    {
      "path": "src/main/java/com/example/maintenancekicker/listener/JoinListener.java",
      "role": "玩家加入事件监听器，踢出玩家并显示提示",
      "order": 4,
      "depends": []
    },
    {
      "path": "src/main/java/com/example/maintenancekicker/command/SetNoticeCommand.java",
      "role": "命令处理器，处理 /setNotice 命令并更新配置",
      "order": 5,
      "depends": []
    },
    {
      "path": "src/main/java/com/example/maintenancekicker/MaintenanceKicker.java",
      "role": "插件主类，负责初始化和注册事件、命令",
      "order": 6,
      "depends": ["JoinListener.java", "SetNoticeCommand.java"]
    }
  ]
}
```

**关键点**：
- Planner 先产出主类蓝图（mainBlueprint：注册哪些命令 / 监听 / 任务），再列出 6 个文件，每个带 `generatorType`（如 ConfigGen / ListenerGen / CommandGen / MainGen）
- 每个文件声明 `depends` 依赖；服务端拓扑排序后按依赖深度划分「并发桶」
- 同一深度的文件互不依赖、可并发生成；主类（MainGen）强制放在最后一个桶
- 工具类/监听器/命令处理器先生成，主类最后整合调用

> 上面的 JSON 为便于阅读做了简化；真实 Planner 输出还包含 `mainBlueprint`、每个文件的 `generatorType` 与服务端计算的 `bucket` 深度。

<!-- 截图：Planner 生成的文件树展示 -->

## 第二阶段：分桶并发生成

系统按桶号升序逐桶生成；同一桶内的文件并发生成（默认并发 2）。注意主类在最后一个桶，因为它依赖 JoinListener 和 SetNoticeCommand。下面按文件逐一展示生成与审查过程（实际上同桶文件是并发进行的）。

### 文件 1：pom.xml

**FileGen 输入**：
```
角色：Maven 构建配置，定义依赖和编译参数
上下文：
- 项目名：MaintenanceKicker
- 包名：com.example.maintenancekicker
- 核心：PAPER
- 版本：1.20.6
- Java 版本：17
已生成文件的可用 API：无
```

**FileGen 输出**：
```xml
<project xmlns="http://maven.apache.org/POM/4.0.0"
         xmlns:xsi="http://www.w3.org/2001/XMLSchema-instance"
         xsi:schemaLocation="http://maven.apache.org/POM/4.0.0
         http://maven.apache.org/xsd/maven-4.0.0.xsd">
    <modelVersion>4.0.0</modelVersion>

    <groupId>com.example</groupId>
    <artifactId>MaintenanceKicker</artifactId>
    <version>1.0.0</version>
    <packaging>jar</packaging>

    <properties>
        <maven.compiler.source>17</maven.compiler.source>
        <maven.compiler.target>17</maven.compiler.target>
        <project.build.sourceEncoding>UTF-8</project.build.sourceEncoding>
    </properties>

    <repositories>
        <repository>
            <id>papermc</id>
            <url>https://repo.papermc.io/repository/maven-public/</url>
        </repository>
    </repositories>

    <dependencies>
        <dependency>
            <groupId>io.papermc.paper</groupId>
            <artifactId>paper-api</artifactId>
            <version>1.20.6-R0.1-SNAPSHOT</version>
            <scope>provided</scope>
        </dependency>
    </dependencies>
</project>
```

**reChecker 审查**：● 通过

**summaryExtract 提取摘要**：
```json
{
  "description": "Maven 构建配置，定义了 Paper 1.20.6 依赖和 Java 17 编译参数"
}
```

### 文件 2：plugin.yml

**FileGen 输入**（已注入 pom.xml 的摘要）：
```
已生成文件的可用 API：

【pom.xml】
  职责：Maven 构建配置，定义了 Paper 1.20.6 依赖和 Java 17 编译参数
```

**FileGen 输出**：
```yaml
name: MaintenanceKicker
version: 1.0.0
main: com.example.maintenancekicker.MaintenanceKicker
api-version: 1.20
author: AI Generated

commands:
  setnotice:
    description: 设置维护提示消息
    usage: /setnotice <消息>
    permission: maintenancekicker.setnotice

permissions:
  maintenancekicker.setnotice:
    description: 允许修改维护提示
    default: op
```

**reChecker 审查**：● 通过

**summaryExtract 提取摘要**：
```json
{
  "description": "插件描述文件，main 类为 com.example.maintenancekicker.MaintenanceKicker",
  "commands": ["setnotice"],
  "configKeys": ["maintenancekicker.setnotice"]
}
```

### 文件 3：config.yml

**FileGen 输出**：
```yaml
# 维护提示消息
notice: "服务器正在维护，请稍后再试"
```

**reChecker 审查**：● 通过

**summaryExtract 提取摘要**：
```json
{
  "description": "默认配置文件，存储踢出提示消息",
  "configKeys": ["notice"]
}
```

### 文件 4：JoinListener.java（事件监听器）

注意：在新的拓扑排序下，监听器和命令处理器先于主类生成。

**FileGen 输入**（已注入前 3 个文件的摘要）：
```
已生成文件的可用 API：

【pom.xml】
  职责：Maven 构建配置，定义了 Paper 1.20.6 依赖和 Java 17 编译参数

【plugin.yml】
  职责：插件描述文件，main 类为 com.example.maintenancekicker.MaintenanceKicker
  注册命令：setnotice

【config.yml】
  职责：默认配置文件，存储踢出提示消息
  配置键：notice
```

**FileGen 输出**：
```java
package com.example.maintenancekicker.listener;

import org.bukkit.event.EventHandler;
import org.bukkit.event.Listener;
import org.bukkit.event.player.PlayerJoinEvent;
import org.bukkit.plugin.java.JavaPlugin;

public class JoinListener implements Listener {

    private final JavaPlugin plugin;

    public JoinListener(JavaPlugin plugin) {
        this.plugin = plugin;
    }

    @EventHandler
    public void onPlayerJoin(PlayerJoinEvent event) {
        String notice = plugin.getConfig().getString("notice", "服务器正在维护");
        event.getPlayer().kickPlayer(notice);
    }
}
```

**reChecker 审查**（含跨文件一致性检查）：● 通过

**summaryExtract 提取摘要**：
```json
{
  "className": "JoinListener",
  "implements": ["Listener"],
  "publicMethods": [
    { "name": "JoinListener", "params": "JavaPlugin plugin", "returns": "constructor" },
    { "name": "onPlayerJoin", "params": "PlayerJoinEvent event", "returns": "void" }
  ],
  "events": ["PlayerJoinEvent"],
  "description": "玩家加入事件监听器，踢出玩家并显示配置中的提示消息"
}
```

### 文件 5：SetNoticeCommand.java（命令处理器）

**FileGen 输入**（已注入前 4 个文件的结构化 API 摘要，包括 JoinListener 的类名和方法签名）：
```
已生成文件的可用 API：
...（前 3 个文件摘要省略）

【.../listener/JoinListener.java】
  职责：玩家加入事件监听器，踢出玩家并显示配置中的提示消息
  类名：JoinListener implements Listener
  公开方法：
    - constructor JoinListener(JavaPlugin plugin)
    - void onPlayerJoin(PlayerJoinEvent event)
  监听事件：PlayerJoinEvent
```

**FileGen 输出**：
```java
package com.example.maintenancekicker.command;

import org.bukkit.command.Command;
import org.bukkit.command.CommandExecutor;
import org.bukkit.command.CommandSender;
import org.bukkit.plugin.java.JavaPlugin;

public class SetNoticeCommand implements CommandExecutor {

    private final JavaPlugin plugin;

    public SetNoticeCommand(JavaPlugin plugin) {
        this.plugin = plugin;
    }

    @Override
    public boolean onCommand(CommandSender sender, Command command, String label, String[] args) {
        if (args.length == 0) {
            sender.sendMessage("§c用法: /setnotice <消息>");
            return true;
        }

        String notice = String.join(" ", args);
        plugin.getConfig().set("notice", notice);
        plugin.saveConfig();

        sender.sendMessage("§a维护提示已更新为: " + notice);
        return true;
    }
}
```

**reChecker 审查**（含跨文件一致性检查）：● 通过

**summaryExtract 提取摘要**：
```json
{
  "className": "SetNoticeCommand",
  "implements": ["CommandExecutor"],
  "publicMethods": [
    { "name": "SetNoticeCommand", "params": "JavaPlugin plugin", "returns": "constructor" },
    { "name": "onCommand", "params": "CommandSender sender, Command command, String label, String[] args", "returns": "boolean" }
  ],
  "commands": ["setnotice"],
  "description": "命令处理器，处理 /setnotice 命令并更新配置文件中的提示消息"
}
```

### 文件 6：MaintenanceKicker.java（主类 — 最后生成）

主类排在最后生成，此时已拥有所有依赖文件的完整 API 摘要，能精确知道 JoinListener 和 SetNoticeCommand 的构造函数签名。

**FileGen 输入**（注入全部 5 个已生成文件的结构化 API 摘要）：
```
已生成文件的可用 API：
...（配置文件摘要省略）

【.../listener/JoinListener.java】
  职责：玩家加入事件监听器
  类名：JoinListener implements Listener
  公开方法：
    - constructor JoinListener(JavaPlugin plugin)
    - void onPlayerJoin(PlayerJoinEvent event)
  监听事件：PlayerJoinEvent

【.../command/SetNoticeCommand.java】
  职责：命令处理器，处理 /setnotice 命令
  类名：SetNoticeCommand implements CommandExecutor
  公开方法：
    - constructor SetNoticeCommand(JavaPlugin plugin)
    - boolean onCommand(CommandSender sender, Command command, String label, String[] args)
  注册命令：setnotice

你只能调用上面列出的类和方法，不要假设任何未列出的方法或类存在。
```

**FileGen 输出**：
```java
package com.example.maintenancekicker;

import com.example.maintenancekicker.listener.JoinListener;
import com.example.maintenancekicker.command.SetNoticeCommand;
import org.bukkit.plugin.java.JavaPlugin;

public class MaintenanceKicker extends JavaPlugin {

    @Override
    public void onEnable() {
        saveDefaultConfig();
        getServer().getPluginManager().registerEvents(new JoinListener(this), this);
        getCommand("setnotice").setExecutor(new SetNoticeCommand(this));
        getLogger().info("MaintenanceKicker 已启用");
    }

    @Override
    public void onDisable() {
        getLogger().info("MaintenanceKicker 已禁用");
    }
}
```

**reChecker 审查**（含跨文件一致性检查）：
```json
{
  "is_ok": true,
  "reason": "import 正确，JoinListener(JavaPlugin) 和 SetNoticeCommand(JavaPlugin) 构造函数签名与已生成文件一致"
}
```

● 一次通过，无需修正 — 因为主类最后生成，已拥有完整的依赖信息

## 第三阶段：校验与构建

### 文件完整性校验

```json
{
  "verified": true,
  "total": 6,
  "generated": 6,
  "missing": []
}
```

● 所有文件已生成

### 上传到 GitHub

系统创建临时分支 `build-1710556800000-abc123`，使用 Git Tree API 一次性上传所有文件：

```
MaintenanceKicker/
├── pom.xml
└── src/
    └── main/
        ├── java/
        │   └── com/example/maintenancekicker/
        │       ├── MaintenanceKicker.java
        │       ├── listener/
        │       │   └── JoinListener.java
        │       └── command/
        │           └── SetNoticeCommand.java
        └── resources/
            ├── plugin.yml
            └── config.yml
```

### 触发 Maven 构建

GitHub Actions 执行：

```yaml
- name: Set up JDK 17
  uses: actions/setup-java@v3
  with:
    java-version: '17'

- name: Build with Maven
  run: mvn clean package

- name: Upload artifact
  uses: actions/upload-artifact@v3
  with:
    name: MaintenanceKicker
    path: target/*.jar
```

构建日志：
```
[INFO] Building MaintenanceKicker 1.0.0
[INFO] Compiling 3 source files to target/classes
[INFO] Building jar: target/MaintenanceKicker-1.0.0.jar
[INFO] BUILD SUCCESS
```

● 构建成功

<!-- 截图：GitHub Actions 构建成功的界面 -->

## 第四阶段：下载和测试

### 下载 JAR

用户点击"下载 JAR"，获得 `MaintenanceKicker.zip`，解压后得到 `MaintenanceKicker-1.0.0.jar`。

### 安装测试

1. 将 JAR 放入 `plugins` 目录
2. 重启服务器

**控制台输出**：
```
[Server] Loading MaintenanceKicker v1.0.0
[MaintenanceKicker] MaintenanceKicker 已启用
```

### 功能测试

**测试 1：玩家进服被踢出**
```
玩家 "Steve" 尝试加入服务器
→ 被踢出，显示："服务器正在维护，请稍后再试"
```

**测试 2：修改提示消息**
```
OP 执行：/setnotice 服务器升级中，预计 30 分钟后开放
→ 控制台显示："§a维护提示已更新为: 服务器升级中，预计 30 分钟后开放"
→ config.yml 自动更新
```

**测试 3：新提示生效**
```
玩家 "Alex" 尝试加入服务器
→ 被踢出，显示："服务器升级中，预计 30 分钟后开放"
```

● 所有功能正常

<!-- 截图：MC 客户端显示被踢出界面，提示消息为自定义内容 -->

## 技术亮点总结

### 0. precheck + 多轮 Clarify 把模糊需求收敛为可执行决策

- precheck（`deepseek-v4-pro` + thinking）拦截"功能闭环 / 玩家行为 / 触发方式"未交代的输入，输入框预填补充提示
- ClarifyPanel 单卡片纵向选项，强制覆盖 UI 方式 / 持久化（含文本格式追问）/ 权限节点等关键项
- Reasoner 的思考流写入折叠区，todos 增量解析逐张推到面板，无空档
- clarifyRounds 全部回灌 `plannerPrompt`，让 Planner 按"已确认决策"出文件树，避免冗余

### 0.5 复杂度分级 + 实现路径确认门

- grade（`deepseek-v4-pro` + thinking）对需求打**分向量**，`enforceLevelFloor` 用确定性硬规则强制等级下限（如"持久化"必到中等）
- 非"直接"级时列出多条**实现路径**让用户选定，或填修正打回重评——在"有多种合理做法"时把决定权交还用户，而非让 Planner 替用户猜
- 所选路径 + 打分向量带进 Planner，控制 plan 体量与实现方向

### 1. 主类蓝图 + 依赖深度桶 + 主类最后生成

- Planner 先确定主类蓝图（MainBlueprint），再声明每个文件的 `generatorType` 与 `depends`
- 服务端拓扑排序 + 计算依赖深度，划分并发桶：同深度并发、桶间串行
- 主类（MainGen）强制放最后一桶，生成时已拥有所有依赖文件的完整 API 摘要
- 本例中主类一次通过审查 — 因为它精确知道 JoinListener 和 SetNoticeCommand 的构造函数签名

### 2. 结构化 API 摘要传递

- 每个文件生成后由 summaryExtract 提取结构化摘要（类名、方法签名、事件、命令等）
- 后续文件的 FileGen Prompt 注入完整的 API 签名块，而非简单的文本截断
- 明确约束"只能调用已列出的 API"，杜绝虚空调用

### 3. reChecker 跨文件一致性检查

- reChecker 接收已生成文件的结构化 API 摘要
- 不仅检查语法错误，还验证跨文件调用是否真的存在
- 双重防线：FileGen 约束 + reChecker 验证

### 4. 云端构建验证

- Maven 编译验证代码可运行
- 如果有语法错误，构建会失败并返回错误日志
- 三重保障（FileGen 约束 + reChecker 审查 + Maven 构建）确保代码质量

## 下一步

- [了解 AI 工作流](/features/ai-workflow)：深入理解 Grader、Planner、Generator、reChecker 的设计
- [技能库](/features/skills)：挂载额外能力扩展生成边界
- [浏览器 IDE](/features/ide)：在生成结果上继续在线编辑
- [可视化蓝图](/features/blueprint)：把生成的逻辑变成可视节点图
- [查看架构设计](/technical/architecture)：了解系统如何协调各个组件
