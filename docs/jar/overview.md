# JAR 生成：总体流程

## 概述

系统将自然语言需求自动转化为完整的 Minecraft 插件 Java 项目，编译为 JAR 文件并提供下载。整个过程由前端按步驱动，服务端无状态执行，中间结果持久化在 Cloudflare KV 中。

## 六步流程

```
用户点击「生成项目」
       ↓
┌─────────────────────────────┐
│ 1. Planner 规划              │  POST /api/generate/plan
│    需求 → 项目名、Java 版本、 │
│    包名、文件树（含职责和顺序）│
└──────────────┬──────────────┘
               ↓
┌─────────────────────────────┐
│ 2. 逐文件生成（循环）         │  POST /api/generate/file
│    按 Planner 顺序逐个调用    │
│    每生成一个 → reChecker 审查│
│    不通过 → 带 reason 返工    │
└──────────────┬──────────────┘
               ↓
┌─────────────────────────────┐
│ 3. 文件校验                  │  POST /api/generate/verify
│    plan vs generatedFiles    │
└──────────────┬──────────────┘
               ↓
┌─────────────────────────────┐
│ 4. 上传 + 触发构建            │  POST /api/generate/build
│    创建临时分支 → 上传文件    │
│    → workflow_dispatch       │
└──────────────┬──────────────┘
               ↓
┌─────────────────────────────┐
│ 5. 轮询构建状态               │  GET /api/generate/status
│    每 5s 查询 GitHub Actions  │
│    完成后获取 artifact 信息   │
│    无论成功失败删除临时分支   │
└──────────────┬──────────────┘
               ↓
┌─────────────────────────────┐
│ 6. 下载 JAR                  │  GET /api/generate/download
│    代理 GitHub artifact 下载  │
│    清理 KV 记录              │
└─────────────────────────────┘
```

## 任务状态（KV 数据结构）

每个生成任务在 KV 中存储一个 JSON 对象：

| 字段 | 类型 | 说明 |
|------|------|------|
| taskId | string | 唯一标识 |
| status | string | 当前阶段 |
| projectName | string | 项目名 |
| javaVersion | string | Java 版本 |
| packageName | string | 包名 |
| plan | array | 文件树 [{path, role, order}] |
| generatedFiles | array | 已生成 [{path, content, summary}] |
| currentFileIndex | number | 下一个待生成文件索引 |
| buildBranch | string | GitHub 临时分支名 |
| runId | number | Actions run ID |
| artifactId | number | 构建产物 ID |
| logs | string[] | 操作日志 |

TTL 1 小时，过期自动清理。

## 前端展示

生成流程用 4 张独立卡片展示（与对话块分离）：

1. **规划卡片**：阶段指示器 + 项目信息标签
2. **代码生成卡片**：文件树（带状态图标），点击展开代码预览
3. **构建卡片**：等待动画 / 下载按钮 / 错误信息
4. **日志卡片**：自动滚动的实时日志

导航栏文字通过 `watch(genTask.phase)` 自动同步更新。
