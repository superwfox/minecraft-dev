# 完整演示：维护插件生成

本文展示一个完整的插件生成案例，从需求描述到最终 JAR，演示 AI 如何处理多文件项目和自动修正错误。

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

## 第一阶段：Planner 规划

用户点击"生成项目"后，系统调用 Planner 分析需求。

### Planner 输入

```json
{
  "userPrompt": "请帮我完成一个玩家进服后被踢出并提示正在维护的插件，并且支持用 /setNotice 命令设置踢出时的提示",
  "coreType": "PAPER",
  "version": "1.20.6"
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
- Planner 自动识别需要 6 个文件
- 每个文件声明 `depends` 依赖，服务端按拓扑排序确定生成顺序
- 主类 `MaintenanceKicker.java` 依赖 JoinListener 和 SetNoticeCommand，排在最后生成
- 工具类/监听器/命令处理器先生成，主类最后整合调用

<!-- 截图：Planner 生成的文件树展示 -->

## 第二阶段：FileGen 逐文件生成

系统按拓扑排序后的 `order` 顺序逐个生成文件。注意主类排在最后，因为它依赖 JoinListener 和 SetNoticeCommand。

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

**reChecker 审查**：✅ 通过

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

**reChecker 审查**：✅ 通过

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

**reChecker 审查**：✅ 通过

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

**reChecker 审查**（含跨文件一致性检查）：✅ 通过

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

**reChecker 审查**（含跨文件一致性检查）：✅ 通过

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

✅ 一次通过，无需修正 — 因为主类最后生成，已拥有完整的依赖信息

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

✅ 所有文件已生成

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

✅ 构建成功

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

✅ 所有功能正常

<!-- 截图：MC 客户端显示被踢出界面，提示消息为自定义内容 -->

## 技术亮点总结

### 1. 依赖拓扑排序 + 主类最后生成

- Planner 自动识别需要 6 个文件，并声明 `depends` 依赖关系
- 服务端 Kahn 算法拓扑排序，被依赖的文件先生成
- 主类排在最后，生成时已拥有所有依赖文件的完整 API 摘要
- 本例中主类一次通过审查，无需修正 — 因为它精确知道 JoinListener 和 SetNoticeCommand 的构造函数签名

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

- [了解 AI 工作流](/features/ai-workflow)：深入理解 Planner、FileGen、reChecker 的设计
- [查看架构设计](/technical/architecture)：了解系统如何协调各个组件
- [API 参考](/technical/api-reference)：查看完整的 API 文档
