---
layout: home

hero:
  name: "踏海 · MC DevTool"
  text: "用自然语言生成 Minecraft 插件"
  tagline: 从需求描述到可运行的 JAR，全程 AI 驱动
  actions:
    - theme: brand
      text: 快速开始
      link: /guide/quick-start
    - theme: alt
      text: 查看演示
      link: /guide/demo-showcase
    - theme: sponsor
      text: 访问平台
      link: https://minecraft-dev-platform.pages.dev/

features:
  - title: 加入 QQ 群聊
    details: 点击跳转 QQ 入群链接
    link: https://qm.qq.com/q/QicMlpHp6c
    linkText: 【TAHAI | 踏海善后群 - DevRelated】

  - title: AI 多智能体工作流
    details: 多轮澄清 → Planner 出主类蓝图 + 11 类专职生成器 → 深度桶并发生成 → 跨文件审查 + 三层错误恢复
    link: /features/ai-workflow
    linkText: 了解 AI 设计

  - title: 浏览器内 IDE
    details: Monaco 编辑器 + 浏览器内解析 .class 字节码补全 + AI 选区改写，生成后直接在线编辑再编译
    link: /features/ide
    linkText: 了解浏览器 IDE

  - title: 现代化前端体验
    details: Vue 3 + Canvas 粒子背景 + 毛玻璃 UI，实时进度反馈
    link: /features/frontend-highlights
    linkText: 查看前端亮点

  - title: 语音输入支持
    details: 讯飞 WebSocket STT，云端鉴权，解放双手
    link: /features/voice-input
    linkText: 了解语音识别

  - title: 云原生架构
    details: Cloudflare Pages + KV + GitHub Actions，零服务器维护
    link: /technical/architecture
    linkText: 查看架构设计

  - title: 多核心支持
    details: Paper / Bukkit / Spigot / Forge / Fabric，覆盖 MC 1.7-1.21
    link: /guide/introduction
    linkText: 了解项目背景

  - title: 一键构建部署
    details: 自动触发 Maven 构建，5 分钟内获得可用 JAR
    link: /guide/demo-showcase
    linkText: 查看完整演示
---

## 为什么选择踏海？

传统 Minecraft 插件开发需要：
- 熟悉 Java 和 Bukkit/Paper API
- 配置 Maven/Gradle 构建环境
- 理解事件系统和插件生命周期
- 手动编写 plugin.yml 和配置文件

**踏海让这一切变得简单**：只需用自然语言描述需求，AI 自动生成完整项目并构建 JAR。

## 快速体验

```
用户输入：
"请帮我完成一个玩家进服后被踢出并提示正在维护的插件，
并且支持用 /setNotice 命令设置踢出时的提示"

AI 输出：
● 生成 pom.xml（Maven 配置）
● 生成 plugin.yml（插件描述）
● 生成 MaintenancePlugin.java（主类 + 事件监听）
● 生成 SetNoticeCommand.java（命令处理）
● 生成 config.yml（配置文件）
● 触发 GitHub Actions 构建
● 下载 MaintenancePlugin.jar
```

[查看完整演示 →](/guide/demo-showcase)

## 技术亮点

- **多智能体编排**：Pre-checker / Clarifier / Planner / 11 类 Generator / Reviewer / Fixer 协作，主类蓝图 + 深度桶并发生成
- **三层错误恢复**：单文件 rework、动态补缺类、重新规划、编译失败自动修复，层层兜底
- **精准上下文**：AI 提取结构化 API 摘要（类名、方法签名、事件），跨文件契约传递，杜绝虚空调用
- **浏览器内 IDE**：纯前端解析 Java `.class` 字节码做补全，无需任何后端语言服务
- **云原生**：Cloudflare Pages Functions + KV + GitHub Actions，无需自建服务器
- **安全设计**：密钥存环境变量，前端不接触敏感信息

[深入了解架构 →](/technical/architecture)

## 开始使用

1. 访问 [踏海 MC DevTool](https://minecraft-dev-platform.pages.dev)
2. 描述你的插件需求
3. 选择核心类型和 MC 版本
4. 点击"生成项目 & 构建 JAR"
5. 等待 3-5 分钟，下载可用的 JAR 文件

[阅读快速开始指南 →](/guide/quick-start)

---

<p style="text-align:center; font-size:12px; opacity:.7; margin-top:24px;">
  鸣谢 <a href="https://pages.cloudflare.com/" target="_blank" rel="noreferrer">Cloudflare Pages</a> 提供托管服务
</p>
