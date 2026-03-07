# 步骤生成：AI 如何解读需求

## 两阶段请求设计

步骤生成分两次 AI 调用，而非一次性完成。这是有意为之的架构选择。

### 第一阶段：getInfo — 需求分析

用户输入自然语言后，先发一个轻量请求提取关键参数：

```
Prompt 核心指令：
从用户的 Minecraft 插件需求中提取：
1. coreType（Paper/Bukkit/Spigot/Forge/Fabric）
2. version（1.8 ~ 1.21）
返回 JSON：{ coreType, version }
```

**设计要点**：
- 要求 AI 返回 JSON，用 `JSON.parse` 解析。如果用户没说版本或类型，对应字段为空
- 解析后检查哪些字段缺失，弹出选择面板让用户补充
- 这一步极快（200ms 级），用户几乎无感等待

**为什么不让用户自己填表**：自然语言中已经包含了这些信息（"用 Paper 1.21 写个..."），再让用户重复填写体验很差。AI 提取 + 缺失时才弹选择，是最优平衡。

### 第二阶段：getTodoList — 步骤生成

参数确认后，组装精确的 prompt：

```
Prompt 结构：
System: 你是 {coreType} {version} 的插件开发指导器
        返回 JSON 数组，每个元素 { step, event, method, params }
User:   {用户原始需求}
```

**设计要点**：
- `response_format: json_object` 未启用（因为需要返回 JSON 数组而非对象）
- 改为在 system prompt 中强制约束格式
- 返回后先尝试 `JSON.parse`，成功则走结构化渲染，失败则降级到流式文本输出

## 解析操作

```typescript
// chatHandler.ts 核心解析逻辑
const raw = await sendRequest(prompt);
try {
    const steps = JSON.parse(raw);        // 尝试结构化解析
    if (Array.isArray(steps)) {
        block.steps = steps;              // 走 StepRender 渲染
        block.phase = "done";
    }
} catch {
    // JSON 解析失败 → 降级为 SSE 流式输出
    await streamFallback(block, prompt);
}
```

### 降级策略

并非所有用户输入都适合结构化输出（比如"什么是 Bukkit?"）。当 AI 返回的内容不是 JSON 数组时，自动切换到 SSE 流式文本输出：

1. 调用 `/api/stream` 端点
2. 通过 `EventSource` 实时接收文本片段
3. 逐句追加到 `block.streamText`
4. Vue 的 `reactive` 驱动视图逐步更新，产生"逐字打印"效果

这保证了任何输入都不会卡死——结构化需求走步骤渲染，开放式问题走流式文本。

## Prompt 中的细节处理

| 处理点 | 做法 | 原因 |
|--------|------|------|
| coreType 注入 | 写入 system prompt | 确保 AI 使用正确的 API 体系 |
| version 注入 | 写入 system prompt | 不同版本 API 差异显著 |
| 格式约束 | system 中要求 JSON 数组 | 统一解析入口 |
| 异常兜底 | try-catch + 流式降级 | 避免白屏 |
| streamTick | 每次追加文本后递增 | 强制 Vue 检测变化并重渲染 |
