# 技术架构

## 前端技术栈

项目使用 Vue 3 + Vite 构建，选择 Composition API 的 `<script setup>` 语法，配合 TypeScript 进行类型约束。

路由使用 vue-router 4，采用 `createWebHistory` 模式，页面按需懒加载：

```ts
routes: [
    {path: "/", component: () => import("./pages/HomePage.vue")},
    {path: "/chat", component: () => import("./pages/ChatPage.vue")},
]
```

状态管理没有引入 Vuex 或 Pinia，对话状态通过 Vue 的 `reactive` 直接管理，组件间通过 import 同一模块共享状态。这种方式在单一数据流场景下足够，省去了额外依赖和模板代码。

## Cloudflare Pages 部署

项目部署在 Cloudflare Pages 上，利用其两个能力：

**静态托管**：Vite 构建产物（`dist/`）作为静态站点部署，`public/_redirects` 配置 SPA 回退：

```
/*  /index.html  200
```

**Pages Functions**：`functions/api/` 目录下的文件自动部署为边缘 Worker，路径即路由：

- `functions/api/chat.ts` → `POST /api/chat`（非流式）
- `functions/api/stream.ts` → `POST /api/stream`（流式 SSE）

API Key 存储在 Cloudflare 的环境变量（Secrets）中，由 Worker 在服务端注入请求头，前端代码不接触密钥。

## 本地开发

本地开发时没有 Pages Functions 运行环境，通过 Vite 的 `server.proxy` 将 `/api/*` 代理到 DeepSeek，API Key 从 `.env` 文件读取：

```
VITE_DEEPSEEK_API_KEY=sk-xxx
```

Vite proxy 在转发时自动注入 Authorization 头，开发体验与线上一致。

## Canvas 背景

首页的方块粒子背景使用原生 Canvas 2D 绘制，通过 `requestAnimationFrame` 驱动渲染循环，不使用 `setInterval`。这样渲染频率自动跟随显示器刷新率，页面不可见时浏览器会自动暂停 rAF 回调，避免后台空转。

方块的出现和消失通过 `scale` 属性渐变实现，`scale` 降到 0 时跳过该方块的全部物理计算和绘制调用，减少不可见元素的开销。

## 项目生成与构建架构

项目代码生成采用三层架构：

### AI 生成层

Planner 使用 `response_format: json_object` 强制模型输出结构化 JSON，包含 `projectName`、`javaVersion`、`packageName` 和文件树。文件树中每个文件带有 `path`、`role`（职责描述）和 `order`（生成顺序）。

逐文件生成时，每次调用只传目标文件路径和职责，同时附带已生成文件的摘要（前 3 行，截断 120 字符），保证后续文件的 import 和引用与已生成文件一致。

### 任务编排层

使用 Cloudflare KV 持久化任务状态（TTL 1 小时），前端按步骤依次调用 6 个 API 端点：

```
plan → file (循环) → verify → build → status (轮询) → download
```

每个端点执行完更新 KV，前端读取返回值更新 UI。用户刷新页面后可通过 `taskId` 从 KV 恢复状态。

### 构建打包层

生成的文件上传到 `superwfox/minecraft-dev-workflow` 仓库的临时分支 `build-{taskId}`，通过 `workflow_dispatch` 触发 GitHub Actions 执行 Maven 构建。构建完成后，JAR 作为 artifact 上传，由 `download` 端点代理下载给用户，同时清理临时分支和 KV 记录。

