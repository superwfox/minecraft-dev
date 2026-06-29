---
layout: home

hero:
  name: "踏海 · MC DevTool"
  text: "用一句话生成 Minecraft 插件"
  tagline: 描述需求 → AI 自动写代码 → 云端构建出可用 JAR，全程不用写一行 Java
  actions:
    - theme: brand
      text: 开始使用（快速教程）
      link: /guide/quick-start
    - theme: alt
      text: 加入 QQ 群
      link: https://qm.qq.com/q/QicMlpHp6c
    - theme: sponsor
      text: 访问平台
      link: https://minecraft-dev-platform.pages.dev/

features:
  - title: 💬 加入 QQ 群聊
    details: 使用遇到问题、需求做不出、想反馈建议，都来群里找作者。点此跳转入群链接。
    link: https://qm.qq.com/q/QicMlpHp6c
    linkText: 【TAHAI | 踏海善后群 - DevRelated】

  - title: 🚀 使用教程 · 快速开始
    details: 五分钟跑通：登录领免费额度 → 描述需求 → 选核心版本 → 等生成 → 下载 JAR 丢进服务器。
    link: /guide/quick-start
    linkText: 阅读快速开始 →
---

## 三步上手

1. **登录领额度** — 打开 [踏海平台](https://minecraft-dev-platform.pages.dev/)，右上角用 GitHub 登录，每月白送 **5 件** 免费生成额度。
2. **说需求** — 进对话页，用大白话把插件要干什么写清楚（按提示选核心和 MC 版本）。
3. **拿 JAR** — AI 自动写代码并云端构建，几分钟后点「下载 JAR」，丢进服务器 `plugins/` 重启即可。

> 不会写代码也没关系——你只负责描述，剩下交给 AI。

```
你说：
  玩家进服时发欢迎消息，并支持用 /setNotice 命令修改这条消息

它给：
  ● MaintenancePlugin.java（主类 + 进服监听）
  ● SetNoticeCommand.java（命令处理）
  ● plugin.yml / config.yml / pom.xml
  ● 云端构建 → 下载 MaintenancePlugin.jar
```

[👉 看完整图文教程](/guide/quick-start) ·  [遇到问题进群问](https://qm.qq.com/q/QicMlpHp6c)

---

<p style="text-align:center; font-size:12px; opacity:.7; margin-top:24px;">
  鸣谢 <a href="https://pages.cloudflare.com/" target="_blank" rel="noreferrer">Cloudflare Pages</a> 提供托管服务
</p>
