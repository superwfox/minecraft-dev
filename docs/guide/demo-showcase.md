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
  "plan": [
    {
      "path": "pom.xml",
      "role": "Maven 构建配置，定义依赖和编译参数",
      "order": 1
    },
    {
      "path": "src/main/resources/plugin.yml",
      "role": "插件描述文件，声明插件信息、命令和权限",
      "order": 2
    },
    {
      "path": "src/main/resources/config.yml",
      "role": "默认配置文件，存储踢出提示消息",
      "order": 3
    },
    {
      "path": "src/main/java/com/example/maintenancekicker/MaintenanceKicker.java",
      "role": "插件主类，负责初始化和注册事件、命令",
      "order": 4
    },
    {
      "path": "src/main/java/com/example/maintenancekicker/listener/JoinListener.java",
      "role": "玩家加入事件监听器，踢出玩家并显示提示",
      "order": 5
    },
    {
      "path": "src/main/java/com/example/maintenancekicker/command/SetNoticeCommand.java",
      "role": "命令处理器，处理 /setNotice 命令并更新配置",
      "order": 6
    }
  ]
}
```

**关键点**：
- Planner 自动识别需要 6 个文件
- 按依赖关系排序（配置文件 → 主类 → 监听器/命令）
- 为每个文件分配明确的职责

<!-- 截图：Planner 生成的文件树展示 -->

## 第二阶段：FileGen 逐文件生成

系统按 `order` 顺序逐个生成文件。

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
已生成文件：无
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

**reChecker 审查**：
```json
{
  "is_ok": true,
  "reason": "pom.xml 格式正确，依赖版本匹配"
}
```

✅ 通过审查，无需修正

### 文件 2：plugin.yml

**FileGen 输入**：
```
角色：插件描述文件，声明插件信息、命令和权限
已生成文件摘要：
- pom.xml: Maven 构建配置，定义了项目基本信息和 Paper 1.20.6 依赖
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

**reChecker 审查**：
```json
{
  "is_ok": true,
  "reason": "plugin.yml 格式正确，main 类路径与包名一致"
}
```

✅ 通过审查

### 文件 3：config.yml

**FileGen 输出**：
```yaml
# 维护提示消息
notice: "服务器正在维护，请稍后再试"
```

**reChecker 审查**：
```json
{
  "is_ok": true,
  "reason": "配置文件格式正确"
}
```

✅ 通过审查

### 文件 4：MaintenanceKicker.java（主类）

**FileGen 输出**：
```java
package com.example.maintenancekicker;

import com.example.maintenancekicker.listener.JoinListener;
import com.example.maintenancekicker.command.SetNoticeCommand;
import org.bukkit.plugin.java.JavaPlugin;

public class MaintenanceKicker extends JavaPlugin {

    @Override
    public void onEnable() {
        // 保存默认配置
        saveDefaultConfig();

        // 注册事件监听器
        getServer().getPluginManager().registerEvents(new JoinListener(this), this);

        // 注册命令
        getCommand("setnotice").setExecutor(new SetNoticeCommand(this));

        getLogger().info("MaintenanceKicker 已启用");
    }

    @Override
    public void onDisable() {
        getLogger().info("MaintenanceKicker 已禁用");
    }
}
```

**reChecker 审查**：
```json
{
  "is_ok": false,
  "reason": "缺少 import 语句，JoinListener 和 SetNoticeCommand 类未导入"
}
```

❌ 审查不通过，触发返工

**reworkPrompt 输入**：
```
原代码存在问题：缺少 import 语句，JoinListener 和 SetNoticeCommand 类未导入
请修正代码，确保所有类都正确导入
```

**修正后的代码**：
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

**reChecker 二次审查**：
```json
{
  "is_ok": true,
  "reason": "代码格式正确，import 语句完整"
}
```

✅ 修正后通过审查（修正 1 次）

<!-- 截图：生成日志显示"🔄 MaintenanceKicker.java 需修正 (1/2): 缺少 import 语句" -->

### 文件 5：JoinListener.java（事件监听器）

**FileGen 输入**：
```
角色：玩家加入事件监听器，踢出玩家并显示提示
已生成文件摘要：
- MaintenanceKicker.java: 主类，注册了 JoinListener 并传入 plugin 实例
- config.yml: 配置文件，包含 notice 键存储提示消息
```

**FileGen 输出**：
```java
package com.example.maintenancekicker.listener;

import com.example.maintenancekicker.MaintenanceKicker;
import org.bukkit.event.EventHandler;
import org.bukkit.event.Listener;
import org.bukkit.event.player.PlayerJoinEvent;

public class JoinListener implements Listener {

    private final MaintenanceKicker plugin;

    public JoinListener(MaintenanceKicker plugin) {
        this.plugin = plugin;
    }

    @EventHandler
    public void onPlayerJoin(PlayerJoinEvent event) {
        String notice = plugin.getConfig().getString("notice", "服务器正在维护");
        event.getPlayer().kickPlayer(notice);
    }
}
```

**reChecker 审查**：
```json
{
  "is_ok": true,
  "reason": "事件监听器实现正确，import 完整，逻辑清晰"
}
```

✅ 通过审查

### 文件 6：SetNoticeCommand.java（命令处理器）

**FileGen 输出**：
```java
package com.example.maintenancekicker.command;

import com.example.maintenancekicker.MaintenanceKicker;
import org.bukkit.command.Command;
import org.bukkit.command.CommandExecutor;
import org.bukkit.command.CommandSender;

public class SetNoticeCommand implements CommandExecutor {

    private final MaintenanceKicker plugin;

    public SetNoticeCommand(MaintenanceKicker plugin) {
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

**reChecker 审查**：
```json
{
  "is_ok": true,
  "reason": "命令处理器实现正确，参数校验完整"
}
```

✅ 通过审查

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

### 1. 多文件协同生成

- Planner 自动识别需要 6 个文件
- FileGen 按依赖顺序生成，避免引用未定义的类
- 每个文件生成时传入已生成文件摘要，保证 import 一致性

### 2. reChecker 自动修正

- MaintenanceKicker.java 第一次生成缺少 import
- reChecker 发现问题，自动触发返工
- 修正后再次审查通过，无需人工干预

### 3. 云端构建验证

- Maven 编译验证代码可运行
- 如果有语法错误，构建会失败并返回错误日志
- 双重保障（reChecker + Maven）确保代码质量

### 4. 完整的项目结构

- 符合 Maven 标准目录结构
- 包名、类名遵循 Java 命名规范
- plugin.yml 配置完整，包含命令和权限声明

## 下一步

- [了解 AI 工作流](/features/ai-workflow)：深入理解 Planner、FileGen、reChecker 的设计
- [查看架构设计](/technical/architecture)：了解系统如何协调各个组件
- [API 参考](/technical/api-reference)：查看完整的 API 文档
