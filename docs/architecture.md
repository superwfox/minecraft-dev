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
