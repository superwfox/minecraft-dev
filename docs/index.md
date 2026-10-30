---
layout: home

hero:
  name: "踏海 · TAHAI"
  text: "在对话框里生成 Minecraft 插件"
  tagline: 用中文描述需求，确认结构，等云端编译出 JAR，全程不用写 Java
  image:
    src: /avatar.png
    alt: 踏海
  actions:
    - theme: brand
      text: 快速开始
      link: /guide/quick-start
    - theme: alt
      text: 加入 QQ 群
      link: https://qm.qq.com/q/GQbHFjEp4k
    - theme: sponsor
      text: 访问平台
      link: https://tahai.xyz/

features:
  - icon:
      src: /icon.png
      alt: ""
    title: 快速开始
    details: 登录后在对话框里描述需求，确认结构树，下载编译好的 JAR 放进服务器。
    link: /guide/quick-start
    linkText: 阅读教程

  - icon:
      src: /silver.png
      alt: ""
    title: 先看结构，再生成
    details: 生成前把插件拆成一条条行为路径，你可以用一句话修正，满意后再开始写代码。
    link: /features/structure-tree
    linkText: 了解结构树

  - icon:
      src: /gold.png
      alt: ""
    title: 导入已有 JAR
    details: 把现有插件 JAR 拖进对话框，还原成可修改的工程，再用自然语言提修改需求。
    link: /features/jar-import
    linkText: 了解导入

  - icon:
      src: /diamond.png
      alt: ""
    title: 遇到问题
    details: 生成失败或实际效果不对，可以一键整理资料发布反馈，也可以进群找作者。
    link: /features/feedback
    linkText: 了解反馈
---

## 三步上手

1. **登录**：打开 [踏海平台](https://tahai.xyz/)，用 GitHub 登录，填写自己的 DeepSeek API Key；已有充值余额也可以继续使用。
2. **在对话框里说需求**：用大白话写清楚插件要做什么，可以用 Markdown 分点、贴代码块，也可以直接拖入一个 JAR 来修改。
3. **确认结构、拿 JAR**：检查模型给出的结构树，确认后自动生成代码并在云端编译，完成后下载 JAR，放进服务器的 `plugins/` 目录重启即可。

```
你说：
  玩家进服时发欢迎消息，并支持用 /setNotice 命令修改这条消息

它给：
  ● 结构树：进服欢迎、修改欢迎语两条路径
  ● 主类、进服监听、命令处理、plugin.yml、config.yml、pom.xml
  ● 云端编译后的 JAR 和 Maven 源码 ZIP
```

[阅读完整教程](/guide/quick-start) · [对话框能输入什么](/guide/chatbox) · [常见问题](/guide/faq)

---

<p class="home-thanks">
  鸣谢 <a href="https://pages.cloudflare.com/" target="_blank" rel="noreferrer">Cloudflare Pages</a> 提供托管服务
</p>
