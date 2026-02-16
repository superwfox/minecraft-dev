# 踏海 · MC DevTool

面向 Minecraft 插件开发者的 AI 辅助开发平台，输入自然语言需求，返回结构化的开发步骤。

## 项目结构

```
src/
├── api/                  # 前端请求层，调用 /api/* 代理接口
│   ├── DeepseekRequester.ts   # 底层请求：非流式 + SSE 流式
│   └── AdvancedRequest.ts     # 业务请求：需求分析、步骤生成
├── logic/                # 对话状态与处理流程
│   ├── chatState.ts           # 响应式对话状态（reactive）
│   ├── chatHandler.ts         # 三阶段处理：分析 → 生成 → 渲染
│   └── StepRender.vue         # 步骤渲染组件
├── pages/                # 路由页面
│   ├── HomePage.vue           # 首页：打字机 + 滚动展示
│   └── ChatPage.vue           # 对话页：输入 → 选择 → 结果
├── index/                # 首页子组件
│   ├── cubeBackground.vue     # Canvas 粒子背景
│   ├── glassCard.vue          # 毛玻璃导航栏 + 通用样式
│   ├── ConsistantTypingText.vue  # 打字机效果
│   └── FloorDown.vue          # 滚动展示区
├── App.vue               # 根组件：背景 + 导航 + router-view
├── router.ts             # vue-router 路由配置
└── main.js               # 入口

functions/api/            # Cloudflare Pages Functions（服务端）
├── chat.ts               # 非流式代理，注入 API Key 转发 DeepSeek
└── stream.ts             # 流式代理，SSE 透传

docs/                     # VitePress 项目文档
```

## 架构设计

**前后端分离的代理架构**：API Key 存储在 Cloudflare Pages 的环境变量中，前端通过 `/api/chat` 和 `/api/stream` 请求自己的 Pages Functions，由服务端注入密钥后转发至 DeepSeek。密钥不会出现在前端代码中。

**对话处理采用三阶段流水线**：
1. 需求分析（getInfo）— 提取 coreType、version 等结构化参数，缺失时弹出选择面板
2. 步骤生成（getTodoList）— 将结构化参数 + 原始 prompt 组合为 JSON 发送，返回步骤数组
3. 渲染 / 降级 — JSON 数组走结构化渲染（标签 + 步骤），非 JSON 返回走 SSE 流式文本输出

这种设计避免了单次大请求的不确定性：先用轻量请求提取参数并校验，再用精确 prompt 生成步骤，降低了 AI 返回格式不可控的风险。非 JSON 时自动降级为流式输出，保证任何输入都有响应。

**Canvas 背景使用 requestAnimationFrame 驱动**，不使用定时器，跟随浏览器刷新率，空闲时自动降频。方块的可见性通过 scale 渐变控制，scale 为 0 时跳过全部计算，避免不可见元素的无效开销。

**响应式状态使用 Vue 的 reactive 而非 Vuex/Pinia**，对话块数组直接 reactive 化，组件通过 import 引用同一份状态，省去了状态管理库的模板代码和额外依赖。provide/inject 仅用于导航栏文字这一个跨层级通信点。
