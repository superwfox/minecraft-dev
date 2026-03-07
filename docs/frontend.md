# 前端实现

## 技术栈

- **Vue 3** + Composition API（`<script setup>`）
- **Vite** 构建（开发时通过 wrangler pages dev 代理）
- **Vue Router** 单页路由
- **响应式状态**：直接使用 `reactive` / `ref`，无 Vuex/Pinia

## Vue 提供的便利

### reactive 免状态管理库

对话状态（`chatState.ts`）和生成任务状态（`generateState.ts`）都使用 Vue 的 `reactive()` 创建。多个组件通过 `import` 引用同一份响应式对象，数据变化自动触发视图更新，省去了状态管理库的模板代码。

```typescript
// chatState.ts
export const chatBlocks = reactive<ChatBlock[]>([]);

// 任何组件 import 后直接读写，视图自动刷新
import { chatBlocks } from "../logic/chatState";
```

### provide/inject 跨层级通信

导航栏中间的文字需要被对话页的深层逻辑控制。通过 `App.vue` 中 `provide("centerText", ref(""))` 注入，任何子组件 `inject` 后即可修改，无需 props 逐层传递。

### watch 响应式副作用

生成流程中，`watch(() => genTask.phase, ...)` 监听阶段变化自动更新导航栏文字；`watch(() => genTask.logs.length, ...)` 在日志更新时自动滚动到底部。这些副作用声明式地绑定在数据上，不需要手动注册回调。

### computed 派生状态

下载链接、构建面板可见性等都用 `computed` 从 `genTask` 派生，保证数据源唯一，避免手动同步。

## 路由设计

```typescript
// router.ts
const routes = [
    { path: "/", component: HomePage },
    { path: "/chat", component: ChatPage },
];
```

两个页面，`/` 首页展示项目介绍和打字机效果，`/chat` 是对话页。路由切换时 `App.vue` 中的背景和导航栏保持不变，只替换 `<router-view>` 内容。

## Canvas 粒子背景

首页的方块粒子背景使用原生 Canvas 2D 绘制：

- `requestAnimationFrame` 驱动渲染循环，自动跟随刷新率
- 页面不可见时浏览器自动暂停 rAF 回调，避免后台空转
- 方块的出现/消失通过 `scale` 渐变控制，`scale` 为 0 时跳过全部物理计算和绘制

## 毛玻璃 UI（Glass Card）

全局样式 `.glass2` 提供统一的毛玻璃效果：

```css
background: rgba(255, 255, 255, 0.02);
backdrop-filter: blur(8px) brightness(0.75);
border: 3px solid rgba(255, 255, 255, 0.03);
border-radius: 22px;
```

`brightness(0.75)` 降低背景亮度 25%，确保深色主题下文字可读性。导航栏、对话块、生成进度卡片都复用同一基础样式。

## 打字机效果

`consistentTypingText.vue` 组件逐字符显示文本，通过 `setInterval` 控制速度，中文标点后自动短暂停顿增强自然感。组件接收 `text` prop，当 prop 变化时重新开始动画。

## 步骤渲染组件

`StepRender.vue` 将 AI 返回的 JSON 步骤数组渲染为结构化卡片，每个步骤包含描述文本和彩色标签（事件名/方法名/参数），通过 `v-for` 遍历渲染，无需手动 DOM 操作。
