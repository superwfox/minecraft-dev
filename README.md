# 踏海 · TAHAI

**面向 Minecraft 服务端插件开发的多智能体（Multi-Agent）自动化生产平台。** 用户用自然语言描述插件功能，系统在浏览器中完成"需求澄清 → 项目蓝图 → 并发代码生成 → 自审 → 上传构建 → 产出 JAR"的全链路闭环，最终给出一份可直接落地服务器的 `.jar` 文件。

整套系统部署在 Cloudflare Pages + Pages Functions 上，**前端不触碰任何模型密钥与 GitHub PAT**，所有 LLM 调用与构建编排都在 Edge Worker 中完成。

---

## 1. 项目定位

| 维度 | 说明 |
| --- | --- |
| 目标用户 | Minecraft 服务器运营者、插件作者、教学场景 |
| 输入 | 一段自然语言需求（如"做一个商店插件，物品按等级涨价"） |
| 输出 | 可直接部署的 Maven 插件项目 + 编译好的 `.jar` |
| 核心引擎 | DeepSeek `deepseek-v4-pro` (Reasoner, `reasoning_effort=high`) + `deepseek-v4-flash` |
| 部署形态 | Cloudflare Pages（前端静态资源 + Pages Functions Workers） |
| 状态后端 | Cloudflare D1（生成任务/任务成本）+ KV（用户额度与缓存） |
| 编译产物 | GitHub Actions → Maven artifact → 通过 Worker 代理下载 |

---

## 2. 整体定位为 Agent 系统

TAHAI 不是一个"对 LLM 套个壳"的工具，而是一个**带规划器（Planner）、多个专职生成器（Generators）、审查器（Reviewer）、修复器（Fixer）的多智能体协作系统**。整条流水线由前端发起、D1 持久化生成任务、SSE 流式回灌进度，任一阶段都可独立重入。

### 2.1 Agent 角色一览

| Agent | 模型 | 职责 | 输入 | 输出 |
| --- | --- | --- | --- | --- |
| **Pre-checker** | `flash` | 判断需求是否逻辑闭环、能否进入规划 | 用户原始描述 | `{complete, hint}` |
| **Clarifier** | `pro` (Reasoner) | 多轮 TodoList 形式产出关键决策点 | 需求 + 历史轮次 | `{done, todos[]}` 或 `{needMoreInput, hint}` |
| **Planner** | `pro` (Reasoner) | 产出主类蓝图 + 分类型文件树 + 拓扑序 | 需求 + 全部澄清答案 | `MainBlueprint + PlanFile[]` |
| **11 个 Generator** | `flash` | 各按文件类型生成代码 | 单文件 PlanItem + 蓝图切片 + 已生成文件 API 摘要 | Java/YAML/POM 文本 |
| **Reviewer (reChecker)** | `pro` JSON 模式 | 静态审查并指出语法/依赖问题，列出缺失类 | 当前文件 + 同桶 API 摘要 | `{is_ok, reason, missing_classes[]}` |
| **Dynamic Generator** | `flash` | 当审查指出"缺失类"时按推断类型补生 | 缺失类名 + 推断生成器类型 | 新增 PlanFile |
| **Summarizer** | `flash` JSON | 从生成的代码反向抽取结构化 `FileSummary` | 文件正文 | `{className, publicMethods, events, ...}` |
| **Fixer** | `pro` (Reasoner) | Maven 编译失败时按错误日志整文件改写 | 错误日志 + 受影响文件 + 全项目 API | 修订版文件 |

> 每个 Agent 的"角色 prompt + 输入 schema + 输出 schema"全部硬编码在 `functions/_lib/prompts.ts`（745 行），是整个系统的核心契约。

### 2.2 11 类专职 Generator

`functions/_lib/prompts.ts` 中的 `dispatchGen()` 根据 `PlanFileItem.generatorType` 路由到不同的 system prompt 子模板：

```
CommandGen        命令类（同实现 CommandExecutor + TabCompleter，不拆分）
ListenerGen       事件监听类，tag="gui" 时会带配对 pairPath
TaskGen           BukkitRunnable 调度任务（自身不启动，由 Main 启）
ManagerGen        数据/服务单例（禁止 getInstance 反模式）
ConfigGen         资源 yml（plugin.yml / config.yml / lang.yml）
ConfigClassGen    包装 YamlConfiguration 的 Java 配置类
ModelGen          POJO / DTO（不依赖 Bukkit）
EnumGen           枚举
UtilGen           静态工具类
FileRelatedGen    pom.xml / .gitignore 等非 Java 项目文件
MainGen           主类（extends JavaPlugin），强制最后一桶
```

针对每个类型，prompt 中嵌入了不同的**强制项**，例如：
- `CommandGen` 强制要求 `onCommand` + `onTabComplete` 必须在同一类中
- `ListenerGen tag=gui` 必须配对生成"GUI 持有类（InventoryHolder）"与"点击事件监听类"，两者互填 `pairPath`
- `MainGen` 必须遵循 `saveDefaultConfig → 注册 Executor/TabCompleter → 注册 Listener → 启动调度任务 → 实例化 services` 顺序模板
- `ManagerGen` 禁止 `getInstance()` 单例反模式，强制由 Main 持有并 `Bukkit.getPluginManager().getPlugin()` 反查

每个生成器都有**配套的 Reviewer 子模板**（`checkerSpecializationBlock`），按类型断言不同：例如 CommandGen 审查器会专门检查 TabCompleter 是否实现、是否返回 null 而非空 List。

---

## 3. 全链路工作流

```
┌────────────┐
│ 用户描述需求 │
└─────┬──────┘
      │
      ▼
┌──────────────┐  /api/chat (precheck)
│  Pre-checker │ → 不完整 → 前端 onIncomplete 回填补充提示
└─────┬────────┘
      │ complete
      ▼
┌──────────────┐  /api/generate/plan (mode 1: 仅建 taskId)
│ taskId 创建  │ → 写入 D1 (clarifying 状态)
└─────┬────────┘
      │
      ▼
┌──────────────┐  /api/generate/clarify (SSE, 多轮)
│  Clarifier   │ ← reasoning_content + content 双流式回前端
│  (Reasoner)  │   前端折叠展示"AI 思考中"区域
└─────┬────────┘ → 每轮产出 TodoList，前端 ClarifyPanel 收集答案
      │ done:true
      ▼
┌──────────────┐  /api/generate/plan (mode 2: 用 reasoner 出蓝图)
│   Planner    │ → MainBlueprint + PlanFile[] (带 generatorType, depends, tag, pairPath)
│  (Reasoner)  │ → 服务端 topoSort + computeDepths → 划分深度桶
└─────┬────────┘ → MainGen 强制放在 maxDepth+1 桶
      │
      ▼
┌─────────────────────────────────────────────┐
│  for bucket in 0..N:                        │  /api/generate/bucket (SSE per bucket)
│    并发 GEN_CONCURRENCY (默认 2) 个文件：    │
│    ┌─ Generator (flash) → 文件正文          │
│    ├─ Reviewer (pro JSON) → is_ok?          │
│    │  ├─ missing_classes → Dynamic Gen 补缺 │
│    │  └─ rework → 最多 5 次                 │
│    └─ Summarizer (flash JSON) → 注入下一桶   │
│  失败任意一项 → result.replan=true           │
└─────┬───────────────────────────────────────┘
      │ 所有桶完成
      ▼
┌──────────────┐  /api/generate/verify
│  完整性校验  │ → 对照 plan vs generatedFiles
└─────┬────────┘
      │
      ▼
┌──────────────┐  /api/generate/build
│  GitHub 提交 │ → 建临时分支 build-<taskId>
│              │ → 单次 createTree + commit 一次性提交所有文件
│              │ → workflow_dispatch 触发 GitHub Actions
└─────┬────────┘
      │
      ▼
┌──────────────┐  /api/generate/status (轮询)
│  Actions 编译│ → mvn package → upload-artifact
└─────┬────────┘
      │
      ▼
┌──────────────┐  /api/generate/fix (失败时, reasoner)
│  Fixer 回路  │ → 解析 mvn log → 定位错误文件 → 整文件改写 → 重新 build
└─────┬────────┘
      │ done
      ▼
┌──────────────┐  /api/generate/download (Worker 代理)
│  JAR 下载    │
└──────────────┘
```

---

## 4. 关键技术细节

### 4.1 主类蓝图（MainBlueprint）：消除"主类拼装失败"

LLM 单纯按文件列表生成 `Main.java` 时，容易漏注册命令、Listener 或 Task。我们引入了 `mainBlueprint` 作为**Planner 必须先确定的结构化契约**：

```ts
interface MainBlueprint {
    events:   { event, listenerClass, priority? }[];
    commands: { name, executorClass, aliases?, permission? }[];
    tasks:    { taskClass, schedule, periodTicks?, delayTicks?, async? }[];
    services: { managerClass, lifecycle }[];
    config:   { defaultsCopied, files[] };
}
```

- **Planner 阶段**：reasoner 先思考整个系统应有的 events/commands/tasks/services，再据此列文件。蓝图中的 `listenerClass / executorClass / managerClass` 必须与 `files[].path` 中的类名严格匹配。
- **MainGen 阶段**：把蓝图序列化成"按部就班的 onEnable/onDisable 装配清单"塞进 prompt，模型只需按照清单逐条写注册代码。
- **其他 Generator 阶段**：从蓝图切片中拿到自身条目（`eventEntry` / `commandEntry` 等），用于校准类名一致性。

### 4.2 拓扑桶（Depth Bucketing）+ 并发生成

Planner 输出的 `files[]` 带 `depends`（依赖的文件名）。`functions/api/generate/plan.ts` 中：

```ts
function computeDepths(files): Map<path, depth> {
    // 记忆化 DFS：depth(f) = 0 if no resolvable deps else 1 + max(depth(deps))
    // 循环依赖兜底返回 0；MainGen 强制 maxDepth+1
}
```

- 同一深度的文件之间**保证不互相调用**（同深度内若两个 leaf 都需要 helper，Planner 被要求把 helper 下沉为它们的共同依赖）。
- **同深度桶内可并发生成**：`functions/api/generate/bucket.ts` 用 `makeSemaphore(GEN_CONCURRENCY)` 控制并发上限（默认 2，可通过 CF 环境变量覆盖）。
- 桶完成后，所有新文件的 `FileSummary` 注入 D1 任务状态，下一桶的 `dispatchGen()` 在 prompt 中能看到上一桶的完整 API。

> 这里的设计**精确卡在 Cloudflare Workers 免费档约束上**：单请求 10s CPU 上限 + 50 子请求上限。一次桶请求一次性提交、流式输出，避免长连接超时；并发=2 平衡 DeepSeek 限速与 CF 子请求计数。

### 4.3 FileSummary：跨文件契约传递

每个文件生成完毕后，调用 Summarizer 反向抽取：

```ts
interface FileSummary {
    path; className; extends; implements;
    publicMethods: { name, params, returns }[];
    publicFields; events; commands; configKeys;
    description;
}
```

下一文件的 Generator prompt 中会被注入 `formatSummaries()` 渲染后的 API 块，prompt 里有硬性约束："你只能调用上面列出的方法，不要假设任何未列出的方法存在"。

这套机制比直接把整个文件正文塞进上下文**节省 ~70% token**，且强约束防止幻觉调用。

### 4.4 多轮澄清 + Reasoner 思考流式

`functions/api/generate/clarify.ts` 将 `deepseek-v4-pro` 的 `delta.reasoning_content` 与 `delta.content` **分别打 type tag** 推回前端：

```
event: { type: "reasoning", content: "..." }   ← AI 思考过程
event: { type: "delta",     content: "..." }   ← 最终 JSON 文本片段
event: { type: "result",    done, todos }      ← 解析后的结果
```

前端 `ChatPage.vue` 实时把 `reasoning` 流注入可折叠的"AI 思考中"区域。澄清阶段最多 5 轮，每轮 Reasoner 收到历史 Q&A 后决定还要追问什么——例如用户首轮选择"文本存储"，第二轮必须追问 `CSV / TXT / YAML`。

强制项规则（写死在 system prompt 中，AI 必须遵守）：
- 必含 `ui-interaction`（聊天命令 + SendMessage / Inventory GUI）
- 必含 `persistence`（文本 / 二进制）+ 条件追问 `text-format`
- 涉及价格/经验/等级 → 必含 `growth-curve`，options 是函数曲线名 (`linear / power2 / power0.5 / log / exp`)，前端用 `CurveChart.vue` 纯 SVG 渲染对比图

### 4.5 三层错误恢复

| 层级 | 触发条件 | 恢复策略 |
| --- | --- | --- |
| 单文件 rework | Reviewer 返回 `is_ok=false` | 最多 5 次，把 `reason` 回灌 `reworkPrompt` 让模型重写 |
| 动态补类 | Reviewer 返回 `missing_classes[]` | `inferGeneratorType` 按类名后缀（Manager/Listener/Task 等）推断类型，调对应 Generator 现场补 ≤3 个 |
| 重新规划 (Replan) | 单文件 5 次仍未通过 / 桶内出现异常 | 触发 `replan=true`，前端记录原因并可由用户选择重新进入 Planner |
| 编译失败 | GitHub Actions `conclusion != success` | `/api/generate/fix` 抓取 Maven 错误日志 → reasoner 整文件改写涉及文件 → 重提交 |

桶级别的**异常隔离**：单个文件抛错时其他并发任务继续，整桶汇总 `errors[]` 后才决策是否 replan，**避免一颗螺丝拖垮整条流水线**（`bucket.ts:339-371`）。

### 4.6 前端：单 Draft 上下文 + Session 持久化

`src/logic/chatState.ts` 重新设计了"规划前共享上下文"模型：

- 一次点击"生成项目"之前，所有用户消息追加到**同一个 draft block**（`userMessages: string[] + draft: true`）。
- 每条新消息触发 `combineUserMessages()` 重跑 precheck + getInfo + getTodoList，覆盖 draft 的 `steps / coreType / version`，UI 看起来像聊天但实际维护单一上下文。
- 点击"生成"后 `freezeDraft()`，下一次输入开新 draft。

`src/logic/sessionPersist.ts` 用 `watch(deep, debounce 300ms)` 把 `chatBlocks + genTask` 持久化到 `localStorage["tahai-session-v1"]`：
- 刷新后视觉状态完整恢复
- 但若 phase 处于 `planning / clarifying / generating / ...` 中断态，强制回到 `error` 提示"刷新中断，请重新生成"——避免 UI 卡在等待已死掉的 SSE 或 Promise resolver。

### 4.7 服务端 D1 状态机

生成任务状态以 JSON 分块写入 D1 的 `generation_tasks` 与 `generation_task_chunks`，逻辑有效期为 1 小时；旧 KV 任务会在首次访问时惰性迁移。状态机字段：

```ts
{ taskId, status,
  userPrompt, coreType, version,
  clarifyRounds, clarifyDone,
  projectName, packageName, javaVersion,
  mainBlueprint,
  plan, buckets,                 // 拓扑桶
  fileStatuses,                  // { path: pending|generating|done|error }
  currentBucket, generatedFiles, // 跨桶累积
  buildBranch, runId, artifactId,
  logs }
```

端点先读取任务快照，只有实际改变状态的阶段才写回；同一 bucket 的文件结果与 usage 在请求出口各批量落盘一次，`verify` 成功与非终态构建轮询不再产生任务写入。前端断网/刷新可恢复到最近一次批次快照。

### 4.8 GitHub Actions 构建桥

避免在 Worker 中跑 Maven（不可能），整个编译外包给 GitHub Actions：

1. `build.ts`：用 GitHub REST 一次性 `createTree + commit`（**所有文件单 commit**），节省 API 配额
2. `workflow_dispatch` 触发 `superwfox/minecraft-dev-workflow` 仓库的预置 workflow
3. `status.ts` 轮询 `runId`，完成后取 `artifactId`
4. `download.ts` 用 GitHub PAT 代理下载 artifact 流回给前端

`GITHUB_PAT` 与 `DEEPSEEK_API_KEY` 全部存在 CF 环境变量，前端永远拿不到。

---

## 5. 目录结构

```
src/
├── api/
│   └── deepseek.ts            # 前端调 /api/chat /api/stream 的薄封装 + 业务 prompt
├── logic/
│   ├── chatState.ts           # ChatBlock + draft 模型
│   ├── chatHandler.ts         # precheck → getInfo → getTodoList 编排
│   ├── generateState.ts       # GenTask 响应式状态 + Clarify/ExtraPrompt Promise resolver
│   ├── generateHandler.ts     # 桶遍历 + SSE 路由 + replan / fix 回路
│   ├── sessionPersist.ts      # localStorage 持久化 + 中断态恢复
│   └── voiceInput.ts          # WebSpeech 语音输入
├── components/
│   ├── ClarifyPanel.vue       # 多轮 TodoList 卡片，回车跳下一题
│   ├── CurveChart.vue         # 纯 SVG 5 种曲线对比图
│   ├── GenerateProgress.vue   # 按生成器类型分组展示文件 + 行内 streaming preview
│   └── StepRender.vue / cubeBackground / glassCard / floorDown / consistentTypingText
└── pages/
    ├── HomePage.vue
    └── ChatPage.vue

functions/
├── _lib/
│   ├── prompts.ts             # 745 行，所有 Agent 的角色 prompt + schema 契约
│   └── github.ts              # GitHub REST 工具集
└── api/
    ├── chat.ts                # 非流式 LLM 代理
    ├── stream.ts              # SSE LLM 代理
    ├── voice-auth.ts          # 语音服务鉴权
    └── generate/
        ├── plan.ts            # Planner（双模式：建 task + 出蓝图）
        ├── clarify.ts         # Clarifier (reasoner SSE)
        ├── bucket.ts          # 单桶并发生成 + reChecker + dynamic gen
        ├── file.ts            # 单文件生成（兼容历史串行模式）
        ├── verify.ts          # 文件完整性校验
        ├── build.ts           # 上传 GitHub + 触发 Actions
        ├── status.ts          # 轮询构建状态
        ├── fix.ts             # 编译失败的 reasoner 修复回路
        └── download.ts        # JAR 代理下载

docs/                          # VitePress 项目文档
```

文件行数节选（`wc -l`）：

```
functions/_lib/prompts.ts            745
functions/api/generate/bucket.ts     445
functions/api/generate/file.ts       350
src/logic/generateHandler.ts         481
functions/api/generate/plan.ts       275
functions/api/generate/fix.ts        253
functions/api/generate/clarify.ts    180
```

---

## 6. 性能与成本

| 指标 | 数值 / 说明 |
| --- | --- |
| 平均一个中等规模插件（10~15 个文件）端到端耗时 | 约 2~4 分钟 |
| 单文件生成 | flash 模型，~6~12 s |
| 单文件 review | pro 模型 JSON 模式，~8~15 s |
| Planner 出蓝图 | reasoner `high`，~20~40 s |
| Cloudflare Pages Functions 子请求计数 | 每个桶 ~`并发数 × (1 gen + ≤5 rework + 1 review + 1 summary)` |
| D1 写入 | 默认单文件 bucket 为 1 次分块任务状态写 + 1 次原子成本累计；不再占用任务 KV 写额度 |
| 模型成本（约） | 单次端到端 ¥0.05 ~ ¥0.20，取决于澄清轮次和 rework 次数 |

并发上限 `GEN_CONCURRENCY=2` 是经过试验的甜点：再高会触发 DeepSeek RPM 限速 + CF 子请求计数告警，再低则端到端时长翻倍。

---

## 7. 部署

```bash
# 本地开发：Pages Functions + Vite 同进程
npm run dev   # wrangler pages dev --kv TASKS --proxy=5173 -- npx vite

# 生产部署
npm run deploy  # vite build && wrangler pages deploy dist
```

CF 端需要的环境变量与绑定：
- `DEEPSEEK_API_KEY` —— DeepSeek 平台 API key
- `DEEPSEEK_RESPONSES_WEB_SEARCH=true` —— 启用 DeepSeek Responses 自动联网学习；默认关闭，Production 和需要验证该功能的 Preview 环境需分别配置
- `GITHUB_PAT` —— 对 `superwfox/minecraft-dev-workflow` 仓库有 `repo + workflow` 权限的 PAT
- `GEN_CONCURRENCY` —— 可选，默认 2
- KV namespace 绑定名 `TASKS`
- D1 database 绑定名 `DB`（生产任务状态与任务成本）
- `API_RATE_LIMITER` —— 可选 Cloudflare Rate Limiting binding；配置后 API 软限流不再读写 `TASKS`
- `EDGE_RATE_LIMITING=true` —— 使用域名级 WAF Rate Limiting 时设置；关闭代码内 KV 限流兜底

`DEEPSEEK_RESPONSES_WEB_SEARCH` 接受 `1`、`true`、`yes`（忽略大小写）。开启后也只在 Grader 提出真实、未被静态契约或已有公共知识覆盖的原子技术缺口时联网；GLM BYOK 始终只读取已有公共知识，不触发 DeepSeek 自动联网。Cloudflare 环境变量变更后需要重新部署对应环境的 Pages Functions。

---

## 8. 与"单次 LLM 调用 + 套模板"方案的差异

| 维度 | 朴素方案 | TAHAI |
| --- | --- | --- |
| 主类装配 | 让 LLM 自由发挥 → 经常漏注册 | 强制 `MainBlueprint` 结构化契约 |
| 文件间依赖 | 全文塞 context → token 爆炸 / 幻觉调用 | 结构化 `FileSummary` + 拓扑桶 |
| 错误处理 | 失败重试整个流程 | rework / dynamic-gen / replan / fix 四级回路 |
| 模糊需求 | 直接出代码，结果与预期偏差大 | 多轮 Reasoner 澄清 + TodoList 显式确认 |
| 并发 | 串行生成 | 拓扑桶内并发，桶间串行 |
| 状态恢复 | 刷新即丢 | D1 任务状态机 + 前端 localStorage |
| 模型选择 | 一律最强模型 | 规划/审查/修复用 reasoner，生成/摘要用 flash，控成本 |

---

## 9. 路线图

- [ ] 桶内动态调度：根据 token 用量动态调整并发，跑满 CF 限额
- [ ] FileSummary 缓存共享：相同接口签名跨任务复用，跳过重复 Summarizer 调用
- [ ] Planner 模型替换：试验 Claude Opus 4.7 / Qwen3-Coder 对蓝图质量影响
- [ ] 多核版本支持：Forge / Fabric 的 Generator 子模板分支
- [ ] Web 端实时编译反馈：用 Eclipse JDT 在浏览器内做轻量语法预检，缩短到 Actions 的链路
