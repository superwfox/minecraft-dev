# 踏海 · MC DevTool

面向 Minecraft 插件开发者的 AI 辅助开发平台，输入自然语言需求，自动生成 Java 插件项目并编译为可下载的 JAR 文件。

## 项目结构

```
src/
├── api/                  # 前端请求层
│   └── deepseek.ts            # 非流式 + SSE 流式 + 业务 prompt
├── logic/                # 对话状态与处理流程
│   ├── chatState.ts           # 对话响应式状态
│   ├── chatHandler.ts         # 三阶段处理：分析 → 生成步骤 → 渲染
│   ├── generateState.ts       # 项目生成任务状态
│   └── generateHandler.ts     # 生成编排：规划 → 逐文件生成 → 校验 → 构建
├── components/           # 通用组件
│   ├── cubeBackground.vue     # Canvas 粒子背景
│   ├── glassCard.vue          # 毛玻璃导航栏
│   ├── consistentTypingText.vue  # 打字机效果
│   ├── floorDown.vue          # 滚动展示区
│   ├── StepRender.vue         # 步骤渲染
│   └── GenerateProgress.vue   # 项目生成进度
├── pages/
│   ├── HomePage.vue           # 首页
│   └── ChatPage.vue           # 对话页
├── App.vue / router.ts / main.js

functions/
├── _lib/                 # 服务端共享工具
│   ├── github.ts              # GitHub API 工具函数
│   └── prompts.ts             # Planner + FileGen prompt 模板
├── api/
│   ├── chat.ts                # 非流式代理
│   ├── stream.ts              # 流式 SSE 代理
│   └── generate/              # 项目生成 API
│       ├── plan.ts            # Planner：需求 → 文件树
│       ├── file.ts            # 逐文件代码生成
│       ├── verify.ts          # 文件完整性校验
│       ├── build.ts           # 上传 GitHub + 触发 Actions
│       ├── status.ts          # 轮询构建状态
│       └── download.ts        # 代理下载 JAR

docs/                     # VitePress 项目文档
```

## 架构设计

### 三层架构

**AI 生成层**：需求经过 Planner（提取项目类型、Java 版本、包名，生成带职责的文件树），再逐文件调用模型生成代码。每次只传一个目标文件 + 已生成文件摘要，保证 import 一致性。

**任务编排层**：前端按步骤驱动 6 个 Pages Function 端点（plan → file → verify → build → status → download），每步执行结果写入 Cloudflare KV 持久化。用户刷新页面后可通过 taskId 恢复。

**构建打包层**：生成的文件上传到 `superwfox/minecraft-dev-workflow` 仓库的临时分支，触发 GitHub Actions 执行 `mvn package`，构建产物作为 artifact 回传，最终代理下载给用户。

### 密钥管理

API Key（DeepSeek）和 GitHub PAT 存储在 Cloudflare 环境变量中，由 Pages Functions 在服务端注入，前端不接触任何密钥。

### 状态管理

对话状态和生成任务状态均使用 Vue `reactive` 直接管理，无额外状态管理库。服务端任务状态通过 Cloudflare KV 持久化，TTL 1 小时自动清理。
