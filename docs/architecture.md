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
需求分析（getInfo）
    ├─ 提取 coreType + version
    ├─ 缺失参数 → 弹出选择面板
    └─ 参数完整 → 继续
    ↓
步骤生成（getTodoList）
    ├─ 返回 JSON 数组 → 结构化渲染
    └─ 返回文本 → SSE 流式输出（fallback）
    ↓
用户点击「生成项目」
```

### 生成流程

```
1. Planner 规划
   需求 → 项目名 + Java 版本 + 包名 + 文件树
   ↓
2. 逐文件生成（循环）
   FileGen → reChecker 审查 → 通过/返工（最多2次）
   ↓
3. 文件校验
   对比 plan vs generatedFiles，缺失文件自动补齐
   ↓
4. 上传 + 触发构建
   创建临时分支 → 批量上传 → workflow_dispatch
   ↓
5. 轮询构建状态
   每 5s 查询 Actions run，完成后获取 artifact
   ↓
6. 下载 JAR
   代理 GitHub artifact 下载，清理 KV 和临时分支
```

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

### 生成任务状态（KV）

```typescript
interface TaskState {
  taskId: string;
  status: "planning" | "generating" | "verifying" | "uploading" | "building" | "done" | "error";
  projectName: string;
  javaVersion: string;
  packageName: string;
  coreType: string;
  version: string;
  plan: { path: string; role: string; order: number }[];
  generatedFiles: { path: string; content: string; summary: string }[];
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

- **摘要上下文**：已生成文件只传前 3 行 120 字符，避免 token 爆炸
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
