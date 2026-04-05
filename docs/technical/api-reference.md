# API 参考文档

所有 API 端点由 Cloudflare Pages Functions 提供，路径映射关系：

```
functions/api/chat.ts         → POST /api/chat
functions/api/stream.ts       → POST /api/stream
functions/api/voice-auth.ts   → GET  /api/voice-auth
functions/api/generate/plan.ts     → POST /api/generate/plan
functions/api/generate/file.ts     → POST /api/generate/file  (SSE)
functions/api/generate/verify.ts   → POST /api/generate/verify
functions/api/generate/build.ts    → POST /api/generate/build
functions/api/generate/fix.ts      → POST /api/generate/fix   (SSE)
functions/api/generate/status.ts   → GET  /api/generate/status
functions/api/generate/download.ts → GET  /api/generate/download
```

## 对话 API

### POST /api/chat

非流式对话请求，用于需求分析和步骤生成。

**请求**：
```json
{
  "model": "deepseek-chat",
  "messages": [
    { "role": "system", "content": "..." },
    { "role": "user", "content": "..." }
  ]
}
```

**响应**：
```json
{
  "content": "AI 返回的文本内容"
}
```

### POST /api/stream

流式对话请求，用于 fallback 场景的文本输出。

**请求**：
```json
{
  "model": "deepseek-chat",
  "messages": [...],
  "stream": true
}
```

**响应**：SSE 流
```
data: {"choices":[{"delta":{"content":"文本片段"}}]}

data: [DONE]
```

## 语音识别 API

### GET /api/voice-auth

获取讯飞 WebSocket 连接的签名 URL。

**响应**：
```json
{
  "url": "wss://iat-api.xfyun.cn/v2/iat?authorization=...&date=...&host=...",
  "appId": "讯飞应用 ID"
}
```

**说明**：
- URL 包含 HMAC-SHA256 签名，有效期约 5 分钟
- 响应头包含 `Cache-Control: no-store` 防止缓存过期签名

## 项目生成 API

### POST /api/generate/plan

调用 Planner 生成项目规划。

**请求**：
```json
{
  "userPrompt": "用 Paper 1.21 写一个玩家加入时发送欢迎消息的插件",
  "coreType": "PAPER",
  "version": "1.21"
}
```

**响应**：
```json
{
  "taskId": "1710556800000-abc123",
  "projectName": "WelcomePlugin",
  "packageName": "com.example.welcomeplugin",
  "javaVersion": "21",
  "plan": [
    { "path": "pom.xml", "role": "Maven 构建配置", "order": 1, "depends": [] },
    { "path": "src/main/resources/plugin.yml", "role": "插件描述文件", "order": 2, "depends": [] },
    { "path": "src/main/java/com/example/welcomeplugin/WelcomePlugin.java", "role": "插件主类", "order": 3, "depends": [] }
  ]
}
```

**说明**：
- 返回的 `taskId` 用于后续所有请求
- `plan` 数组经过依赖拓扑排序，`depends` 字段声明该文件依赖的其他文件名
- 插件主类（继承 JavaPlugin）始终排在所有 Java 文件最后生成
- 任务状态写入 KV，TTL 1 小时

### POST /api/generate/file

流式生成下一个待生成的文件。返回 SSE（Server-Sent Events）流。

**请求**：
```json
{
  "taskId": "1710556800000-abc123"
}
```

**响应**：`Content-Type: text/event-stream`

如果所有文件已生成完毕，返回 JSON：`{"done": true, "fileIndex": N}`

否则返回 SSE 流，事件格式：

```
data: {"type":"phase","phase":"generating","file":"src/.../Main.java"}

data: {"type":"delta","content":"package com.example"}

data: {"type":"log","msg":"▸ 审查 Main.java..."}

data: {"type":"new_file","path":"src/.../WelcomeCommand.java","role":"...","content":"..."}

data: {"type":"result","done":false,"fileIndex":0,"path":"...","content":"...","remaining":2,"reworkCount":0}

data: [DONE]
```

**SSE 事件类型**：

| 类型 | 说明 |
|------|------|
| `phase` | 阶段切换：`generating` / `reviewing` / `reworking` / `summarizing` |
| `delta` | AI 输出的流式文本片段 |
| `log` | 日志消息（审查结果、修正信息等） |
| `new_file` | 动态生成的缺失类（含 path、role、content） |
| `result` | 文件生成完成，含最终内容和元数据 |

**说明**：
- 自动从 KV 读取 `currentFileIndex`，生成对应文件
- 调用 DeepSeek API 时使用 `stream: true`，逐 chunk 转发给前端
- 生成后经过 reChecker 审查（含跨文件调用一致性检查和插件主类引用检查）
- reChecker 返回 `missing_classes` 时，自动动态生成缺失类并通过 `new_file` 事件通知前端
- 审查不通过且无缺失类时自动返工（最多 2 次）
- 审查通过后，由 summaryExtract 提取结构化 API 摘要
- `reworkCount` 表示该文件经过了几次修正

### POST /api/generate/verify

校验文件完整性。

**请求**：
```json
{
  "taskId": "1710556800000-abc123",
  "fixMissing": false  // 可选，true 时将缺失文件加入重试队列
}
```

**响应**：
```json
{
  "verified": true,
  "total": 3,
  "generated": 3,
  "missing": []
}
```

**说明**：
- 对比 `plan` 和 `generatedFiles`，检查是否有文件缺失
- `fixMissing: true` 时，将缺失文件重新加入 `plan` 队列，供后续 `/file` 调用生成

### POST /api/generate/build

上传文件到 GitHub 并触发构建。

**请求**：
```json
{
  "taskId": "1710556800000-abc123"
}
```

**响应**：
```json
{
  "buildBranch": "build-1710556800000-abc123",
  "runId": 12345678
}
```

**说明**：
- 创建临时分支 `build-{taskId}`
- 使用 Git Tree API 批量上传所有文件（一次 commit）
- 触发 `maven.yml` workflow，传入 `branch` 和 `java_version` 参数
- 等待 2 秒后尝试查找 run ID

### GET /api/generate/status

轮询构建状态。

**请求**：
```
GET /api/generate/status?taskId=1710556800000-abc123
```

**响应**：
```json
{
  "status": "done",
  "conclusion": "success",
  "artifactReady": true
}
```

**可能的 status 值**：
- `waiting`：等待 run 创建
- `building`：构建中（附带 `runStatus`: queued/in_progress）
- `done`：构建成功
- `error`：构建失败（附带 `error` 字段）

**说明**：
- 如果 `runId` 不存在，尝试通过 `buildBranch` 查找
- 成功时删除临时分支并获取 artifact ID 写入 KV
- 失败时保留分支和 runId，供 `/api/generate/fix` 端点使用

### POST /api/generate/fix

编译失败后的自动修复端点。拉取 GitHub Actions 构建日志，解析编译错误，AI 修复出错文件。返回 SSE 流。

**请求**：
```json
{
  "taskId": "1710556800000-abc123"
}
```

**响应**：`Content-Type: text/event-stream`

```
data: {"type":"log","msg":"▸ 正在获取构建错误日志..."}

data: {"type":"phase","phase":"fixing","file":"src/.../Main.java"}

data: {"type":"delta","content":"package com.example"}

data: {"type":"log","msg":"● Main.java 修复完成"}

data: {"type":"result","fixed":2}

data: [DONE]
```

**说明**：
- 通过 GitHub API 获取失败 Job 的日志（`/actions/jobs/{id}/logs`）
- 解析 Maven `[ERROR]` 行，提取出错文件路径和错误信息
- 对每个出错文件，调用 AI 传入编译错误上下文进行修复（流式输出）
- 修复完成后更新 `state.generatedFiles`，清除 error 状态
- 前端收到结果后重新调用 `/api/generate/build` 触发重建
- `result.fixed` 为 0 表示未能修复任何文件

### GET /api/generate/download

下载构建产物。

**请求**：
```
GET /api/generate/download?taskId=1710556800000-abc123
```

**响应**：
- Content-Type: `application/zip`
- Content-Disposition: `attachment; filename="{projectName}.zip"`
- Body: ZIP 文件流

**说明**：
- 从 KV 读取 `artifactId`，调用 GitHub API 下载
- 下载完成后清理 KV 记录和临时分支（如果还存在）
- GitHub artifact API 返回 302 重定向，需手动处理避免 auth 头泄露

## 错误处理

所有 API 遵循统一的错误响应格式：

```json
{
  "error": "错误描述"
}
```

HTTP 状态码：
- `400`：缺少必需参数
- `404`：taskId 不存在或已过期
- `409`：资源未就绪（如 artifact 还未生成）
- `422`：AI 返回格式错误
- `500`：服务端内部错误

## 环境变量

Pages Functions 需要以下环境变量：

| 变量名 | 用途 | 获取方式 |
|--------|------|---------|
| `DEEPSEEK_API_KEY` | DeepSeek API 认证 | https://platform.deepseek.com |
| `GITHUB_PAT` | GitHub API 认证 | Settings → Developer settings → Personal access tokens |
| `XFYUN_APP_ID` | 讯飞应用 ID | https://console.xfyun.cn |
| `XFYUN_API_KEY` | 讯飞 API Key | 同上 |
| `XFYUN_API_SECRET` | 讯飞 API Secret | 同上 |

本地开发时，在项目根目录创建 `.dev.vars` 文件（非 `.env`）：

```
DEEPSEEK_API_KEY=sk-...
GITHUB_PAT=ghp_...
XFYUN_APP_ID=...
XFYUN_API_KEY=...
XFYUN_API_SECRET=...
```

## KV 绑定

需要在 Cloudflare Dashboard 中创建 KV 命名空间并绑定到 Pages 项目：

1. Workers & Pages → KV → Create namespace → 命名为 `TASKS`
2. Pages 项目 → Settings → Functions → KV namespace bindings
3. 添加绑定：Variable name = `TASKS`，KV namespace = `TASKS`

本地开发时，`wrangler pages dev --kv TASKS` 会自动创建本地 KV 存储。
