# API 参考文档

所有 API 端点由 Cloudflare Pages Functions 提供，路径映射关系：

```
functions/api/chat.ts              → POST /api/chat
functions/api/stream.ts            → POST /api/stream
functions/api/maven/jar.ts         → GET  /api/maven/jar        (IDE 补全：Maven 仓库代理)
functions/api/generate/plan.ts     → POST /api/generate/plan    (双模式：建任务 / 出蓝图+文件树+深度桶)
functions/api/generate/clarify.ts  → POST /api/generate/clarify (SSE，多轮澄清)
functions/api/generate/bucket.ts   → POST /api/generate/bucket  (SSE，单桶并发生成，主路径)
functions/api/generate/file.ts     → POST /api/generate/file    (SSE，legacy 单文件，仅补缺用)
functions/api/generate/verify.ts   → POST /api/generate/verify
functions/api/generate/build.ts    → POST /api/generate/build
functions/api/generate/status.ts   → GET  /api/generate/status
functions/api/generate/fix.ts      → POST /api/generate/fix     (SSE)
functions/api/generate/download.ts → GET  /api/generate/download
functions/api/learning/start.ts    → POST /api/learning/start
functions/api/learning/step.ts     → POST /api/learning/step
functions/api/learning/status.ts   → GET  /api/learning/status
functions/api/learning/evidence.ts → GET  /api/learning/evidence
```

## 模型与 Thinking 参数

| 模型 | 用途 | 自动注入 |
|------|------|----------|
| `deepseek-v4-flash` | Generator / Summarizer / Dynamic Gen / IDE 助手 / 对话兜底 | — |
| `deepseek-v4-pro` | precheck / clarify / planner / reChecker / rework / fix | `reasoning_effort: "high"` + `thinking: { type: "enabled" }` |

`/api/chat` 和 `/api/stream` 在 `model` 包含 `pro` 时自动注入上述两个字段；调用方只需传模型名。

## 对话 API

### POST /api/chat

非流式对话，用于需求完整性预检（precheck）、信息提取（getInfo）等。

**请求**：
```json
{
  "model": "deepseek-v4-flash",
  "messages": [ { "role": "system", "content": "..." }, { "role": "user", "content": "..." } ],
  "response_format": { "type": "json_object" }
}
```

`model` 缺省为 `deepseek-v4-flash`；含 `pro` 时服务端追加 thinking 字段。`response_format` 可选透传。

**响应**：`{ "content": "AI 返回的文本" }`

### POST /api/stream

流式对话，用于 IDE 助手、对话兜底等。

**请求**：`{ "model": "deepseek-v4-flash", "messages": [...], "stream": true }`

**响应**：SSE 流
```
data: {"choices":[{"delta":{"content":"文本片段"}}]}

data: [DONE]
```

## Maven 代理 API（IDE 补全）

### GET /api/maven/jar

浏览器无法直接拉 Maven 仓库（CORS），IDE 通过此端点代理拉取 API JAR / metadata 用于补全。仅允许白名单仓库（PaperMC / SpigotMC / Maven Central）。

**请求**：
```
GET /api/maven/jar?coords=<groupId>:<artifactId>:<version>&kind=jar|metadata
```

- `kind=jar`（默认）：返回 JAR 二进制（`application/java-archive`）
- `kind=metadata`：返回 `maven-metadata.xml` 文本（`application/xml`）

**说明**：
- 按 groupId 自动选仓库；`-SNAPSHOT` 版本会读 `maven-metadata.xml` 解析出真实 `timestamp-buildNumber` 文件名
- 边缘缓存 6 小时，响应带 `Access-Control-Allow-Origin: *` 与 `X-Resolved-Url`
- 错误：`400`（coords 格式错误）/ `404`（snapshot 无法解析 / 上游 404）

## 项目生成 API

### POST /api/generate/plan

双模式端点。

**模式 1：创建任务**（不传 `taskId`）—— 仅创建 D1 任务、写入 `userPrompt`/`coreType`/`version`，进入 `clarifying` 状态，**不调用 Planner**。

请求：`{ "userPrompt": "...", "coreType": "PAPER", "version": "1.21" }`
响应：`{ "taskId": "1710556800000-abc123" }`

**模式 2：出蓝图 + 文件树**（传 `taskId`）—— 要求 `state.clarifyDone === true`。调 `deepseek-v4-pro`（thinking），把 `clarifyRounds` 拼成「已确认决策」喂给 `plannerPrompt`，产出主类蓝图与带类型的文件树，服务端做拓扑排序 + 深度桶划分后写回 D1。

Planner 若缺少版本敏感的公开 API 事实，可先返回 `learningToolRequests`。前端推进对应 Learning job 后，以同一 `plannerRequestId` 和 `learningToolJobs` 重入；服务端把验证结果作为 `role: "tool"` 消息接回原始 thinking/tool-call 对话，再继续产出计划。Generator、Reviewer、Reworker 与 Fixer 使用同一协议。

请求：`{ "taskId": "1710556800000-abc123" }`

**响应**：
```json
{
  "taskId": "1710556800000-abc123",
  "projectName": "MaintenanceKicker",
  "packageName": "com.example.maintenancekicker",
  "javaVersion": "21",
  "mainBlueprint": {
    "events":   [ { "event": "PlayerJoinEvent", "listenerClass": "JoinListener", "priority": "NORMAL" } ],
    "commands": [ { "name": "setnotice", "executorClass": "SetNoticeCommand", "permission": "..." } ],
    "tasks":    [],
    "services": [ { "managerClass": "DataManager", "lifecycle": "onEnable" } ],
    "config":   { "defaultsCopied": true, "files": ["config.yml"] }
  },
  "plan": [
    { "path": "pom.xml", "role": "...", "order": 1, "depends": [], "generatorType": "FileRelatedGen", "tag": null, "bucket": 0 },
    { "path": "src/main/java/.../SetNoticeCommand.java", "role": "...", "order": 3, "depends": ["DataManager.java"], "generatorType": "CommandGen", "bucket": 1 },
    { "path": "src/main/java/.../Main.java", "role": "...", "order": 5, "depends": ["..."], "generatorType": "MainGen", "bucket": 2 }
  ],
  "buckets": [ ["pom.xml", "..."], ["SetNoticeCommand.java", "..."], ["Main.java"] ]
}
```

**校验与说明**：
- 模式 2 若 `clarifyDone === false` 返回 400
- `mainBlueprint` 缺失或非法（`isValidBlueprint`）返回 422
- 每个文件必须带合法 `generatorType`（`GENERATOR_TYPES` 之一），否则 422
- `plan` 经拓扑排序（`order` 单调），并计算 `bucket` 深度；**`MainGen` 强制放最后一桶**
- 任务状态写入 D1，逻辑有效期 1 小时

### POST /api/generate/clarify

多轮 TodoList 澄清，返回 SSE 流。每轮调一次，直到 `result.done === true` 或达 `MAX_CLARIFY_ROUNDS = 5`。

**请求**：
```json
{
  "taskId": "1710556800000-abc123",
  "answers": { "ui-interaction": "聊天命令 + SendMessage", "persistence": "文本存储" },
  "extraPrompt": "needMoreInput 后用户补充的描述（可选）"
}
```

- 首轮无 `answers`；`answers` 会回填到 `state.clarifyRounds[last].answers`
- `extraPrompt` 仅在上一轮返回 `needMoreInput` 时由前端补充，会追加到 `state.userPrompt`

**响应**：`text/event-stream`

| 事件 `type` | 说明 |
|------|------|
| `phase` | 阶段切换，含 `round` 当前轮次 |
| `reasoning` | `deepseek-v4-pro` 的思考流（前端写入折叠区） |
| `delta` | 最终 JSON 的流式片段（前端可增量解析提前渲染卡片） |
| `result` | 解析完成：`{ done, todos }`，或 `{ needMoreInput: true, hint }` |
| `log` | 日志（解析失败、超过最大轮次等） |

**特殊情况**：达到 5 轮 / AI 返回非 JSON → 强制 `done: true` 进入 Planner。

### POST /api/generate/bucket

**生成主路径**。生成指定深度桶的所有文件，桶内并发，返回 SSE 流。前端按 `bucket` 升序逐桶调用。

**请求**：`{ "taskId": "1710556800000-abc123", "bucketIndex": 0 }`

**响应**：`text/event-stream`，事件均带 `path` 标签便于前端按文件路由：

| 事件 `type` | 说明 |
|------|------|
| `bucket_start` | `{ bucketIndex, paths[], concurrency }` 桶启动 |
| `phase` | `{ path, phase }`：`generating` / `reviewing` / `reworking` / `summarizing` |
| `delta` | `{ path, content }` 流式代码片段 |
| `log` | 日志（审查结果、rework、动态补缺等） |
| `new_file` | `{ path, role, content }` 动态生成的缺失类 |
| `file_done` | `{ path, content }` 单文件完成 |
| `file_error` | `{ path, reason }` 单文件异常 |
| `result` | 桶结束（见下） |

**`result` 事件**：
- 正常：`{ bucketIndex, done, completed:[{path,content,reworkCount}], newFiles[], bucketsRemaining }`
- 需重新规划：`{ bucketIndex, replan: true, path?, reason }`

**说明**：
- 并发上限 `GEN_CONCURRENCY`（环境变量，默认 2）
- 每文件经 reChecker 审查；`missing_classes` 非空时动态补生（`MAX_DYNAMIC_GEN = 3`）；其他错误 rework（`MAX_REWORK = 5`）
- 单文件 5 次未过、桶内任意文件抛异常、或整桶执行失败 → 始终发出 `result`（`replan=true`），避免前端拿到 null
- 桶完成后所有文件的 `FileSummary` 回填 D1 任务状态，供下一桶注入

### POST /api/generate/file（legacy）

单文件流式生成，**已被 bucket 取代**，仅在 `verify` 发现缺失文件、需补齐时由前端调用。

**请求**：`{ "taskId": "..." }`
**响应**：若无待生成文件返回 `{ "done": true, "fileIndex": N }`；否则返回 SSE（含 `phase` / `delta` / `log` / `new_file` / `result`，reChecker 不通过自动 rework）。

### POST /api/generate/verify

校验文件完整性。

**请求**：`{ "taskId": "...", "fixMissing": false }`

**响应**：`{ "verified": true, "total": 6, "generated": 6, "missing": [] }`

- 对比 `plan` 与 `generatedFiles`
- `fixMissing: true` 时把缺失文件重新加入 `plan` 队列，供 `/file` 补齐

### POST /api/generate/build

上传文件到 GitHub 并触发构建。

**请求**：`{ "taskId": "..." }`
**响应**：`{ "buildBranch": "build-1710556800000-abc123", "runId": 12345678 }`

- 创建临时分支 `build-{taskId}`
- 用 Git Tree API 一次性 `createTree + commit`（所有文件单 commit）
- 触发 workflow，传入 `branch` 和 `java_version`
- 等 2 秒后尝试查找 run ID（找不到也返回，后续 status 再找）

### GET /api/generate/status

轮询构建状态。

**请求**：`GET /api/generate/status?taskId=...`

**响应**：`{ "status": "done", "conclusion": "success", "artifactReady": true }`

可能的 `status`：
- `waiting`：等待 run 创建（`runId` 未知，会尝试用 `buildBranch` 查找）
- `building`：构建中，附带 `runStatus`（queued / in_progress）
- `done`：编译成功（删除临时分支并获取 `artifactId`）
- `error`：编译失败（附带 `error`；**保留分支与 runId 供 fix 端点读日志**）

### POST /api/generate/fix

编译失败后的自动修复，返回 SSE。

**请求**：`{ "taskId": "..." }`

**响应**：`text/event-stream`
```
data: {"type":"log","msg":"▸ 正在获取构建错误日志..."}
data: {"type":"phase","phase":"fixing","file":"src/.../Main.java"}
data: {"type":"delta","content":"package com.example"}
data: {"type":"result","fixed":2}
data: [DONE]
```

- 拉失败 Job 日志 → 解析 Maven `[ERROR]` 行定位出错文件 → 对每个文件用 `buildFixPrompt` 流式改写 → 更新 `generatedFiles`
- 前端收到结果后重新调 `/build`；`result.fixed === 0` 表示未修复任何文件
- 前端 `buildWithRetry` 最多修复重试 2 次（`MAX_FIX_ATTEMPTS`）

### GET /api/generate/download

下载构建产物。

**请求**：`GET /api/generate/download?taskId=...`
**响应**：`application/zip`，`Content-Disposition: attachment; filename="{projectName}.zip"`

- 从 D1 读 `artifactId`，调 GitHub API 下载
- 下载后清理 D1 记录与临时分支
- GitHub artifact API 返回 302，需手动处理避免 auth 头泄露

## 错误处理

统一错误响应：`{ "error": "错误描述" }`

| 状态码 | 含义 |
|------|------|
| `400` | 缺少必需参数 / 澄清未完成 / bucketIndex 非法 |
| `404` | taskId 不存在或已过期 |
| `422` | AI 返回格式错误 / 蓝图非法 / generatorType 非法 |
| `500` | 服务端内部错误（如密钥未配置） |

## 环境变量

| 变量名 | 用途 | 获取方式 |
|--------|------|---------|
| `DEEPSEEK_API_KEY` | DeepSeek API 认证 | https://platform.deepseek.com |
| `DEEPSEEK_RESPONSES_WEB_SEARCH` | DeepSeek Responses 自动联网学习开关；默认关闭，接受 `1`、`true`、`yes` | 设置为 `true` |
| `GITHUB_PAT` | GitHub API 认证（repo + workflow） | GitHub → Developer settings → PAT |
| `GEN_CONCURRENCY` | 桶内并发上限（可选，默认 2） | — |

本地开发时在项目根创建 `.dev.vars`（非 `.env`）填入上述变量。`DEEPSEEK_RESPONSES_WEB_SEARCH` 默认关闭；Production 和需要验证联网学习的 Preview 环境需分别配置，保存后重新部署 Pages Functions。开启后，服务端编排中的 Planner、Generator、Reviewer、Reworker 与 Fixer 会收到 `learn_public_api` function tool，并自行判断是否调用；只有 Grader 确认存在未被静态契约或公共知识覆盖的原子技术缺口时才启动 URL discovery，并不强制每个任务联网。运行时只接受版本化公开 API 或任务已声明的外部依赖，最多连续调用两轮，并继续执行来源验证、配额、任务授权和 D1 缓存。用户自带的 DeepSeek Key 在服务端编排阶段遵循同一开关，浏览器直连请求不参与该服务端学习流程；GLM BYOK 只读取已有公共知识，不会收到该工具。

## KV 绑定

需在 Cloudflare 创建 KV 命名空间并以变量名 `TASKS` 绑定到 Pages 项目。本地开发 `wrangler pages dev --kv TASKS` 会自动创建本地 KV。

可选绑定 `API_RATE_LIMITER` 使用 Cloudflare Rate Limiting API。存在该绑定时，中间件按登录用户（匿名入口按 IP）限流且不访问 KV。若改用域名级 WAF Rate Limiting，请设置 Production 环境变量 `EDGE_RATE_LIMITING=true` 关闭 KV 兜底。两者均缺失时仅昂贵写端点使用 `TASKS` 兜底，`status`、`verify`、`download` 等端点不会为限流产生 KV 操作。

## D1 绑定

生产环境以变量名 `DB` 绑定 D1 数据库，并按编号依次执行 `migrations/0001_generation_tasks.sql`、`0002_autonomous_learning.sql`、`0003_generation_task_quota.sql`、`0004_generation_task_planner_lease.sql`。Cloudflare Pages 部署不会自动执行这些 migration；已有数据库发布新版本时只执行尚未应用的后续文件。D1 保存生成任务、单任务成本和公共技术知识；用户额度、订单、赞助及缓存继续保留在 `TASKS` KV。
