# API 参考文档

所有 API 端点由 Cloudflare Pages Functions 提供，路径映射关系：

```
functions/api/chat.ts              → POST /api/chat
functions/api/stream.ts            → POST /api/stream
functions/api/generate/task.ts     → POST /api/generate/task    (创建任务)
functions/api/generate/tree.ts     → POST / GET /api/generate/tree (规划、修正、锁定与恢复)
functions/api/generate/source.ts   → GET /api/generate/source   (单文件或完整源码)
functions/api/generate/clarify.ts  → POST /api/generate/clarify (SSE，多轮澄清)
functions/api/generate/bucket.ts   → POST /api/generate/bucket  (SSE，单桶并发生成，主路径)
functions/api/generate/plan|grade|file.ts → 410 FEATURE_DEPRECATED
functions/api/generate/verify.ts   → POST /api/generate/verify
functions/api/generate/build.ts    → POST /api/generate/build
functions/api/generate/status.ts   → GET  /api/generate/status
functions/api/generate/fix.ts      → POST /api/generate/fix     (SSE)
functions/api/generate/download.ts → GET  /api/generate/download
functions/api/generate/checkpoint.ts → GET / POST /api/generate/checkpoint (工程快照与过期重建)
functions/api/generate/revise.ts   → POST /api/generate/revise  (追加需求)
functions/api/generate/journal.ts  → GET  /api/generate/journal (执行记录)
functions/api/generate/feedback.ts → GET / POST /api/generate/feedback (公开反馈)
functions/api/generate/jar.ts      → GET / POST /api/generate/jar (ResolveJAR 导入)
functions/api/learning/start.ts    → POST /api/learning/start
functions/api/learning/step.ts     → POST /api/learning/step
functions/api/learning/status.ts   → GET  /api/learning/status
functions/api/learning/evidence.ts → GET  /api/learning/evidence
```

## 模型与 Thinking 参数

| 模型 / 档位 | 用途 | 自动注入 |
|------|------|----------|
| `deepseek-flash` / 原 flash 档 | Pre-checker / Generator / Summarizer / Dynamic Gen / 对话兜底 | `reasoning_effort: "low"` + `thinking: { type: "enabled" }` |
| `deepseek-flash` / 原 pro 档 | clarify / 结构规划 / 路径审查 / reChecker / rework / fix / 证据验证 | `reasoning_effort: "high"` + `thinking: { type: "enabled" }` |

两档统一调用 DeepSeek-V4.1-Flash，API 模型名为 `deepseek-flash`。`/api/chat` 和 `/api/stream` 优先读取 `reasoning_effort`（`low`、`high`、`max`），默认 `low`；未提供有效 effort 时，旧客户端模型名中的 `pro` / `reason` 仍映射到 `high`。`max` 会原样用于 DeepSeek 请求。需求整理器固定使用 `low`。DeepSeek BYOK 与平台请求采用相同路由；GLM BYOK 保持现有模型和参数策略。

根据 [2026-09-10 官方更新](https://api-docs.deepseek.com/zh-cn/updates) 与 [思考模式文档](https://api-docs.deepseek.com/zh-cn/guides/thinking_mode) 核对。V4.1 Flash 人民币单价（每百万 tokens）为：闲时缓存命中 / 未命中 / 输出 `0.02 / 1 / 4` 元，高峰 `0.04 / 2 / 8` 元；高峰仅为北京时间周一至周五 09:00-12:00、14:00-18:00。详见 [官方价格](https://api-docs.deepseek.com/zh-cn/quick_start/pricing)。两档单价相同，成本随实际 token 用量计算。

## 对话 API

### POST /api/chat

非流式对话，用于提示词整理和普通结构化响应；需求完整性预检与信息提取使用 `/api/stream`。

**请求**：
```json
{
  "model": "deepseek-flash",
  "reasoning_effort": "low",
  "messages": [ { "role": "system", "content": "..." }, { "role": "user", "content": "..." } ],
  "response_format": { "type": "json_object" }
}
```

DeepSeek `model` 统一解析为 `deepseek-flash`；服务端显式启用 thinking 并设置对应 effort。`response_format` 可选透传。

**响应**：`{ "content": "AI 返回的文本" }`

### POST /api/stream

流式对话，用于需求预检、信息提取和对话兜底。旧 `purpose=append` 请求返回 `410 FEATURE_DEPRECATED`。

**请求**：`{ "model": "deepseek-flash", "reasoning_effort": "low", "messages": [...], "stream": true }`

**响应**：SSE 流
```
data: {"choices":[{"delta":{"content":"文本片段"}}]}

data: [DONE]
```

## 项目生成 API

### POST /api/generate/task

请求：{userPrompt, coreType, version, skillIds}。返回 {taskId, expiresAt, skillsLoaded}，创建 clarifying 任务；额度在中间件按 POST 创建请求扣除。PATCH 保活和 DELETE 取消不重复扣创建额度。

### POST /api/generate/tree

build/refine/continue 返回 SSE，每次请求只进行一轮模型调用。请求包含 taskId、treeRequestId、action，以及可选 correction、focusIds、skillIds、learningToolJobs。refine 的 correction 长度为 1–1000，范围由模型按自然语言定位。

事件：phase、reasoning、delta、heartbeat、skill_context、tool_call、tree_ops、result。结果包含 status（continue/learning/ready/failed）、round、tree、issues、results 与可选 learningToolRequests。

confirm 返回 JSON，请求 {taskId, action: "confirm", revision}，成功返回 {ok, tree, plan, bucketPaths}。确认不调用模型，相同锁定修订重复确认直接重放；过期修订返回 TREE_REVISION_MISMATCH，锁定后的修改返回 TREE_LOCKED。

其他主要错误：CLARIFY_REQUIRED、TREE_NOT_READY、TREE_INVALID、TREE_IN_PROGRESS、TREE_REQUEST_CONFLICT、TREE_RECOVERY_REQUIRED、TREE_CANCELLED、QUOTA_EXHAUSTED。

### GET /api/generate/tree?taskId=

返回 {tree, session, pendingOperation, nodeChecks, pathChecks, generation}；pendingOperation 提供待恢复请求的 id 和原始规范化输入，generation 包含 plan、currentBucket 和 fileStatuses，供手动恢复任务。tree 的 paths 是行为路径，nodes 是实现文件，两者通过步骤 fileIds 关联。

### 旧接口

/api/generate/plan、/api/generate/grade、/api/generate/file 返回 410 FEATURE_DEPRECATED，历史实现保存在仓库 .deprecated/flowchart-planner/。

### POST /api/generate/clarify

多轮 TodoList 澄清，返回 SSE 流。每轮调一次，直到 `result.done === true` 或达 `MAX_CLARIFY_ROUNDS = 5`。

**请求**：
```json
{
  "taskId": "1710556800000-abc123",
  "answers": { "ui-interaction": "聊天命令 + SendMessage", "persistence": "保存到插件数据文件（YAML）" },
  "extraPrompt": "needMoreInput 后用户补充的描述（可选）"
}
```

- 首轮无 `answers`；`answers` 会回填到 `state.clarifyRounds[last].answers`
- `extraPrompt` 仅在上一轮返回 `needMoreInput` 时由前端补充，会追加到 `state.userPrompt`

**响应**：`text/event-stream`

| 事件 `type` | 说明 |
|------|------|
| `phase` | 阶段切换，含 `round` 当前轮次 |
| `reasoning` | `deepseek-flash`（`reasoning_effort=high`）的思考流（前端写入折叠区） |
| `delta` | 最终 JSON 的流式片段（前端可增量解析提前渲染卡片） |
| `result` | 解析完成：`{ done, todos }`，或 `{ needMoreInput: true, hint }` |
| `log` | 日志（解析失败、超过最大轮次等） |

**特殊情况**：达到 5 轮 / AI 返回非 JSON → 强制 `done: true` 进入结构树规划。

### POST /api/generate/bucket

请求 {taskId, bucketIndex, superConcurrency?, learningToolJobs?}，要求树已锁定，否则返回 TREE_NOT_LOCKED。每次请求每个目标最多一次模型调用，结果落库后客户端继续同一桶。

SSE 包含 bucket_start、phase、delta、log、tree_patch、new_file、file_done、file_error、path_review 与 result。

- tree_patch：审查追加的实现文件及可选模块。
- file_done：path、content、contractCheck；new_file 同时携带 nodeId。
- path_review：pathId、title、status=started，供状态卡展示真实审查活动。
- result：bucketIndex、bucketDone、done、progressed、active、completed、newFiles、errors、learningToolRequests、bucketsRemaining、pathChecks。
- 契约失败先进入返工；最多 3 次返工、每个目标最多 3 个动态补缺类。

### POST /api/generate/verify

请求 {taskId, fixMissing?, reviewPaths?}。返回 {verified, total, generated, missing, changedFiles, pathChecks, repairBucketIndex?, reviewBucketIndex?}。

verified 仅表示树的实现文件齐全；fixMissing 将缺失文件放入修补桶。文件齐全且 reviewPaths=true 时，按当前代码指纹安排路径审查桶，返回 reviewBucketIndex；客户端通过 bucket 逐请求推进，之后再次 verify，直到无需新审查桶。

路径审查前先规范化已知迁移的 Maven 仓库地址，changedFiles 返回被调整的文件路径，客户端据此失效源码缓存。构建入口再次核对同一指纹；若代码变化则返回 PATH_REVIEW_REQUIRED，完成新审查后可沿用该次尚未启动的 buildRequestId。

pathChecks 按路径返回 status、staticStatus、compileStatus、summary、steps。status=passed 需要路径静态审查与相同代码版本编译均通过，不能把文件齐全、契约项通过或构建启动当成路径验证成功。

### GET /api/generate/source?taskId=&path=

带 path 时返回已生成文件 {path, content}，不存在时返回 404 SOURCE_NOT_FOUND；不带 path 时要求树已锁定且文件齐全，否则返回 409 SOURCE_NOT_READY。

整包返回 {projectName, files, tree, nodeChecks, pathChecks}。浏览器用 JSZip 生成 Maven 源码包和 PROJECT_TREE.md；plugin.yml 与构建使用相同水印处理。接口只允许访问自己的任务。

### POST /api/generate/build

仅构建服务端已保存的生成文件。旧 IDE 或追加需求提交的 `files`、`meta` 字段不再接受，返回 `410 FEATURE_DEPRECATED`。

上传文件到 GitHub 并触发构建。当前代码未完成路径静态审查时返回 409 PATH_REVIEW_REQUIRED；编译成功不会覆盖静态审查中的失败项。

**请求**：`{ "taskId": "...", "buildRequestId": "build_<32位十六进制ID>" }`

同一次构建的重试复用原 `buildRequestId`，避免重复触发工作流。
**响应**：`{ "buildBranch": "build-1710556800000-abc123", "runId": 12345678 }`

- 创建临时分支 `build-{taskId}`
- 用 Git Tree API 一次性 `createTree + commit`（所有文件单 commit）
- 触发 workflow，传入 `branch` 和 `java_version`
- 等 2 秒后尝试查找 run ID（找不到也返回，后续 status 再找）

### GET /api/generate/status

轮询构建状态。

**请求**：`GET /api/generate/status?taskId=...`

**响应**：`{ "status": "done", "conclusion": "success", "artifactReady": true, "pathChecks": {} }`，pathChecks 按每条路径返回真实检查结论。

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
- 修复变更使旧代码指纹的路径检查失效，前端重新进行路径审查后再调 `/build`；`result.fixed === 0` 表示未修复任何文件
- 前端 `buildWithRetry` 最多修复重试 3 次（`MAX_FIX_ATTEMPTS`）

### GET /api/generate/download

下载构建产物。

**请求**：`GET /api/generate/download?taskId=...`
**响应**：`application/zip`，`Content-Disposition: attachment; filename="{projectName}.zip"`

- 从 D1 读 `artifactId`，调 GitHub API 下载
- 下载后保留任务至过期；临时构建分支按现有逻辑清理
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
| `DEEPSEEK_RESPONSES_WEB_SEARCH` | 自动联网学习开关（沿用旧变量名，实际调用 Search/Fetch）；默认关闭，接受 `1`、`true`、`yes` | 设置为 `true` |
| `GITHUB_PAT` | GitHub API 认证（repo + workflow） | GitHub → Developer settings → PAT |
| `GEN_CONCURRENCY` | 桶内并发上限（可选，默认 2） | — |

本地开发时在项目根创建 `.dev.vars`（非 `.env`）填入上述变量。`DEEPSEEK_RESPONSES_WEB_SEARCH` 默认关闭；Production 和需要验证联网学习的 Preview 环境需分别配置，保存后重新部署 Pages Functions。开启后，服务端编排中的 结构规划器、Generator、Reviewer、Reworker 与 Fixer 会收到 `learn_public_api` function tool，并自行判断是否调用；只有技术缺口评估确认存在未被静态契约或公共知识覆盖的原子技术缺口时才启动 URL discovery，并不强制每个任务联网。运行时只接受版本化公开 API 或任务已声明的外部依赖，并继续执行来源验证、配额、任务授权、任务时限和 D1 缓存；模型可在取得验证结果后按需继续调用工具，不再受固定轮次上限约束。用户自带的 DeepSeek Key 通过统一服务端模型路由遵循同一开关，Key 只随请求临时传递并跳过平台计费；GLM BYOK 只读取已有公共知识，不会收到该工具。

### Learning 的 Search / Fetch

来源发现使用 `POST https://api.deepseek.com/v1/tools/search`，不再调用 Responses 或依赖模型内置 `web_search`。每个原子问题提交不超过 128 个 Unicode 字符的技术查询，`count=10`、`need_content=false`；最多处理 3 个问题、6 条查询，每个问题保留最多 3 个经过 URL 安全检查的候选。查询按问题轮转，优先本地规则识别的版本化 JavaDoc 与官方来源；服务端搜索分数和摘要不能作为核验结论。`ori_question` 仅发送经过任务隐私筛查的技术问题，不发送完整用户需求、源码或身份数据。

候选网页先直接读取；网页阻断、网络失败或正文过薄时，可在同一来源预算内调用 `POST https://api.deepseek.com/v1/tools/fetch` 获取 Markdown。POM、Maven metadata、原始源码和制品仍直接读取；非法 URL、私网重定向、体积与类型拒绝不通过 Fetch 绕过。保留内容哈希、逐字引用、来源核验及 D1 缓存。Fetch 提取的内容不作为已校验原文的 `ground_truth` 自动入库，仍须证据审核。

两接口使用当前 DeepSeek Bearer Key，无 `model` 参数。HTTP 408、429、5xx 最多重试一次且不超出当前阶段时限，其余 4xx 不以相同请求重试。按[官方 Search/Fetch 计费](https://api-docs.deepseek.com/zh-cn/guides/search/#计费)，HTTP 200 且 Search 结果非空或 Fetch 正文非空时，每次分别计入 ¥0.005；本地后续拒绝候选不抹掉已经发生的请求费用，失败和空结果不计费。平台任务与模型 token 成本合并累计，BYOK 不扣平台额度。迁移无需新密钥、D1 migration 或生产依赖；保留旧开关名与已有任务的诊断代码。

## KV 绑定

需在 Cloudflare 创建 KV 命名空间并以变量名 `TASKS` 绑定到 Pages 项目。本地开发 `wrangler pages dev --kv TASKS` 会自动创建本地 KV。

可选绑定 `API_RATE_LIMITER` 使用 Cloudflare Rate Limiting API。存在该绑定时，中间件按登录用户（匿名入口按 IP）限流且不访问 KV。若改用域名级 WAF Rate Limiting，请设置 Production 环境变量 `EDGE_RATE_LIMITING=true` 关闭 KV 兜底。两者均缺失时仅昂贵写端点使用 `TASKS` 兜底，`status`、`verify`、`download` 等端点不会为限流产生 KV 操作。

## D1 绑定

生产环境以变量名 `DB` 绑定 D1 数据库，按编号执行 `migrations/` 下 `0001` 至 `0006`；已有数据库只执行尚未应用的后续文件。Cloudflare Pages 部署不会自动执行 migration。D1 保存生成任务、单任务成本、公共技术知识、临时 journal 与提交去重状态；用户额度、订单、赞助及缓存继续保留在 `TASKS` KV。

## 工程生命周期接口

checkpoint、revise、journal、feedback 和 jar 接口及其权限、状态约束见[工程生命周期](./project-lifecycle.md#接口)。公开反馈需要服务端 `GITHUB_FEEDBACK_TOKEN` 及数据分支排除配置；浏览器不持有仓库写入凭据。
