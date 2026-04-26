# 架构设计

## 系统概览

踏海是一个三层架构的 AI 辅助开发平台：

```
┌─────────────────────────────────────────────────┐
│              前端层（Vue 3 + Vite）               │
│  - 对话界面：需求输入 → 步骤展示                   │
│  - 生成界面：进度追踪 → JAR 下载                   │
│  - 语音输入：WebSocket 流式识别                    │
└────────────────┬────────────────────────────────┘
                 │ HTTP/SSE/WebSocket
┌────────────────┴────────────────────────────────┐
│         服务层（Cloudflare Pages Functions）      │
│  - AI 代理：chat / stream                        │
│  - 生成编排：plan → file → verify → build        │
│  - 状态管理：KV 持久化（TTL 1h）                   │
│  - 语音鉴权：讯飞 WSS 签名                         │
└────────────────┬────────────────────────────────┘
                 │ API 调用
┌────────────────┴────────────────────────────────┐
│              外部服务                             │
│  - DeepSeek API：代码生成 + 审查                  │
│  - GitHub API：仓库操作 + Actions 触发            │
│  - 讯飞语音：WebSocket 流式识别                    │
└─────────────────────────────────────────────────┘
```

## 核心流程

### 对话流程

```
用户输入需求
    ↓
precheck 完整性预检（deepseek-v4-pro + thinking）
    ├─ complete=false → 输入框预填补充提示，回到上一步
    └─ complete=true → 继续
    ↓
需求分析（getInfo, deepseek-v4-flash）
    ├─ 提取 coreType + version
    ├─ 缺失参数 → 弹出选择面板
    └─ 参数完整 → 继续
    ↓
步骤生成（getTodoList, deepseek-v4-flash）
    ├─ 返回 JSON 数组 → 结构化渲染
    └─ 返回文本 → SSE 流式输出（fallback）
    ↓
用户点击「生成项目」
```

### 生成流程

```
1. 创建任务（POST /plan，无 taskId）
   写入 userPrompt/coreType/version → status=clarifying
   ↓
2. 多轮 Clarify 澄清（POST /clarify, deepseek-v4-pro + thinking, SSE）
   reasoning 流入折叠区 → todos 增量渲染卡片
   ClarifyPanel 单卡片确认（UI 方式 / 持久化 / 增长曲线 / ...）
   needMoreInput=true → 回到输入框补充
   循环到 done=true 或 5 轮
   ↓
3. Planner 规划（POST /plan，带 taskId, deepseek-v4-pro + thinking）
   注入 clarifyRounds 作为已确认决策 + Paper 配套结构知识
   产出文件树（含依赖拓扑）→ 主类排最后
   ↓
4. 逐文件生成循环（POST /file, SSE）
   FileGen（deepseek-v4-flash，注入已生成文件的 API 摘要 + Paper 配套实现规范）
   → reChecker 审查（deepseek-v4-pro + thinking，跨文件调用一致性）
   → 缺失类 → 动态生成 / 不通过 → rework（最多 2 次）
   → summaryExtract 提取结构化摘要
   ↓
5. 文件校验
   对比 plan vs generatedFiles，缺失文件自动补齐
   ↓
6. 上传 + 触发构建
   创建临时分支 → 批量上传 → workflow_dispatch
   ↓
7. 轮询构建状态
   每 5s 查询 Actions run，失败 → /fix 自动修复 → 重新构建（最多 2 次）
   ↓
8. 下载 JAR
   代理 GitHub artifact 下载，清理 KV 和临时分支
```

### 模型分工

| 模型 | 调用位置 |
|------|---------|
| `deepseek-v4-flash` | FileGen 主生成、summaryExtract、对话兜底（chat / stream 默认） |
| `deepseek-v4-pro` | precheck、clarify、planner、reChecker、rework、动态缺失类、fix；自动注入 `reasoning_effort: "high"` + `thinking: { type: "enabled" }` |

## 技术栈

### 前端
- **Vue 3**：Composition API + `<script setup>`
- **Vue Router**：单页路由
- **Vite**：构建工具
- **Canvas 2D**：粒子背景动画
- **Web Audio API**：语音录音采集

### 后端
- **Cloudflare Pages Functions**：Serverless API
- **Cloudflare KV**：任务状态持久化
- **DeepSeek API**：代码生成和审查
- **GitHub API**：仓库操作和 Actions 触发
- **讯飞语音**：WebSocket 流式识别

### 构建
- **GitHub Actions**：Maven 编译环境
- **Maven**：Java 项目构建

## 数据流

### 对话状态（前端）

```typescript
// chatState.ts
export const chatBlocks = reactive<ChatBlock[]>([]);

interface ChatBlock {
  id: string;
  userInput: string;
  phase: "analyzing" | "fetching" | "rendering" | "done" | "error";
  coreType?: string;
  version?: string;
  title?: string;
  steps?: Step[];
  streamText?: string;
  error?: string;
}
```

### 生成任务状态（前端 + KV）

前端 `GenTask` 在 KV 状态基础上扩展了澄清阶段所需字段：

```typescript
interface GenTask {
  taskId: string;
  phase: "idle" | "awaiting_input" | "clarifying" | "planning"
       | "generating" | "verifying" | "uploading" | "building" | "fixing" | "done" | "error";

  // Clarify 阶段
  clarifyTodos: TodoItem[];
  clarifyAnswers: Record<string, string | string[]>;
  clarifyHistory: { todos: TodoItem[]; answers: Record<string, any> }[];
  reasoningContent: string;     // deepseek-v4-pro 思考流（折叠显示）
  reasoningVisible: boolean;
  moreInputHint: string;        // needMoreInput 时给用户的补充提示

  // 生成阶段
  plan: PlanFile[];
  generatedFiles: GeneratedFile[];
  streamingContent: string;
  ...
}

// KV 端
interface TaskState {
  taskId: string;
  status: "clarifying" | "planning" | "generating" | "verifying"
        | "uploading" | "building" | "done" | "error";
  userPrompt: string;
  coreType: string;
  version: string;

  clarifyRounds: { todos: TodoItem[]; answers: Record<string, any> }[];
  clarifyDone: boolean;

  projectName: string;
  javaVersion: string;
  packageName: string;
  plan: { path: string; role: string; order: number; depends?: string[] }[];
  generatedFiles: { path: string; content: string; apiSummary: FileSummary }[];
  currentFileIndex: number;
  buildBranch?: string;
  runId?: number;
  artifactId?: number;
  logs: string[];
  error?: string;
}
```

## 安全设计

### 密钥隔离

所有敏感信息存储在 Cloudflare 环境变量中，前端代码完全接触不到：

- `DEEPSEEK_API_KEY`：DeepSeek API 密钥
- `GITHUB_PAT`：GitHub Personal Access Token
- `XFYUN_APP_ID` / `XFYUN_API_KEY` / `XFYUN_API_SECRET`：讯飞语音密钥

### 请求代理

前端所有 AI 请求都通过 Pages Functions 代理：

```
前端 → /api/chat → Pages Function → DeepSeek API
                    ↑ 注入 API Key
```

前端只发送 messages 数组，不包含任何认证信息。

### 临时分支隔离

每个生成任务使用独立的临时分支（`build-{taskId}`），构建结束后立即删除，不会污染主分支历史。

## 性能优化

### 前端

- **Canvas 自动暂停**：页面不可见时 `requestAnimationFrame` 自动停止
- **按需渲染**：方块 `scale === 0` 时跳过物理计算和绘制
- **响应式最小化**：只在必要时触发 Vue 更新（`streamTick` 手动控制）

### 后端

- **结构化 API 摘要**：已生成文件由 AI 提取结构化摘要（类名、公开方法签名、事件、命令等），精准传递跨文件上下文，避免 token 爆炸
- **并行上传**：使用 Git Tree API 批量创建 blob，一次 commit 提交所有文件
- **重试机制**：网络请求失败自动重试 3 次，指数退避

### 构建

- **artifact 保留期**：只保留 1 天，节省存储空间
- **临时分支清理**：构建结束立即删除，无论成功失败

## 可扩展性

### 支持新的 MC 核心

在 `chatHandler.ts` 中添加核心类型：

```typescript
const CORE_TYPES = ["PAPER", "BUKKIT", "SPIGOT", "FORGE", "FABRIC", "NEW_CORE"];
```

Planner prompt 会自动适配新类型。

### 支持新的 Java 版本

在 `prompts.ts` 的 Planner prompt 中更新版本推导规则：

```typescript
- 根据 MC 版本推导 Java 版本：1.21+ 用 21，1.20 用 17...
```

### 添加新的生成步骤

在 `generateHandler.ts` 中插入新阶段，在 KV state 中添加对应字段即可。前端通过 `genTask.phase` 自动同步状态。
