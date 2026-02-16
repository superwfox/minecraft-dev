# API 设计

## DeepSeek API 接入

项目通过 DeepSeek 的 Chat Completions 接口（兼容 OpenAI 格式）实现 AI 能力。接入分为两层：

**服务端代理层**（`functions/api/`）：接收前端请求，注入 API Key，转发到 DeepSeek。非流式接口返回完整 JSON，流式接口透传 SSE 事件流。

**前端请求层**（`src/api/`）：
- `askDeepSeek(prompt, preset)` — 非流式请求，用于需求分析和步骤生成
- `consistChat(history, prompt, onDelta, onDone)` — 流式请求，用于降级时的实时文本输出

## 为什么用 JSON 表示开发步骤

AI 返回的开发步骤使用 JSON 数组格式：

```json
[
  {
    "step": 1,
    "content": "创建主类并注册事件监听器",
    "event": "PlayerJoinEvent",
    "function": "onPlayerJoin",
    "params": ["Player player", "String message"]
  }
]
```

选择 JSON 而非纯文本的原因：

**结构化渲染**：JSON 的键值对可以直接映射到 UI 组件。`event`、`function`、`params` 分别用不同颜色的标签渲染，比纯文本的正则解析更可靠。

**前端可编程**：拿到 JSON 后可以做排序、过滤、分组等操作。比如按 step 排序保证顺序，按是否有 event 字段区分事件驱动步骤和普通步骤。

**降级兼容**：通过 system prompt 约束 AI 返回 JSON，但 AI 不一定总是遵守。前端尝试解析 JSON，失败时自动降级为流式文本输出，保证任何输入都有响应。

## 两阶段请求设计

对话处理分为两次 API 调用：

**第一次：getInfo** — 从用户输入中提取 `coreType`（Paper/Bukkit/Spigot 等）和 `version`（1.8-1.21），返回结构化参数。如果用户没有明确说明，前端弹出选择面板让用户补充。

**第二次：getTodoList** — 将确认后的参数 + 原始需求组合为精确的 JSON prompt 发送，返回步骤数组。

这种拆分的好处是：第一次请求轻量快速，用于校验和补全信息；第二次请求带着完整上下文，生成质量更高。避免了一次性发送模糊需求导致 AI 返回不可用结果的问题。
