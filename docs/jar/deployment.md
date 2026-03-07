# JAR 生成：部署要点

## GitHub Actions 构建

### 为什么用 GitHub Actions 而非自建编译服务

- **零维护成本**：不需要维护 Java/Maven 编译环境
- **隔离性**：每次构建在独立容器中执行，互不干扰
- **灵活性**：`workflow_dispatch` 支持传参，一个 workflow 覆盖 Java 8/11/17/21

### 工作流设计

workflow 文件 `maven.yml` 部署在独立仓库 `superwfox/minecraft-dev-workflow`：

```yaml
on:
  workflow_dispatch:
    inputs:
      branch:        # 临时分支名，决定 checkout 哪份代码
      java_version:  # JDK 版本，默认 21
```

关键点：
- **`workflow_dispatch` 必须在默认分支上**：GitHub 只从默认分支读取 workflow 定义文件，临时分支上的 workflow 不会被识别
- **`ref` 参数只决定 checkout 代码**：触发时传 `ref: build-xxx`，workflow 从这个分支 checkout 源代码，但 workflow 本身来自默认分支
- **`retention-days: 1`**：构建产物只保留 1 天，因为下载完就清理了

### 临时分支生命周期

```
getDefaultBranchSha() → createBranch("build-{taskId}")
    → uploadFile() × N
    → triggerWorkflow()
    → pollStatus()
    → 构建结束 → deleteBranch()  // 无论成功失败
```

分支在 `status.ts` 中构建结束后立即删除，不在 `download.ts` 中删除。这样即使用户不下载，临时分支也不会残留。

### 空仓库处理

如果 `minecraft-dev-workflow` 仓库是空的（无 commit），`git/ref/heads/main` 会返回 404。代码中处理了这种情况：自动创建一个 README.md 作为初始 commit，建立默认分支后再继续。

### 构建产物下载

GitHub 的 artifact 下载 API 返回 302 重定向到 Azure Blob Storage 的预签名 URL。这里有一个坑：

```typescript
// ❌ 错误：redirect:follow 会把 Authorization 头带到 Azure，导致 401
const resp = await fetch(url, { redirect: "follow", headers: { Authorization: ... } });

// ✅ 正确：手动跟随重定向，第二次请求不带 auth
const resp = await fetch(url, { redirect: "manual", headers: { Authorization: ... } });
const location = resp.headers.get("Location");
const dl = await fetch(location);  // 无 Authorization
```

## Cloudflare Pages 部署

### Pages Functions 作为后端

`functions/` 目录下的 TypeScript 文件自动映射为 API 路由：

```
functions/api/chat.ts         → POST /api/chat
functions/api/generate/plan.ts → POST /api/generate/plan
```

优势：
- **零配置路由**：文件路径即 URL 路径
- **环境变量隔离**：`DEEPSEEK_API_KEY`、`GITHUB_PAT` 存在 Cloudflare 环境变量中，前端代码完全接触不到
- **`_lib/` 前缀**：以 `_` 开头的目录不会映射为路由，专门用于放共享工具函数

### KV 绑定

Cloudflare KV 用于持久化生成任务的中间状态：

- **命名空间**：`TASKS`，需要在 Cloudflare Dashboard 中手动创建并绑定到 Pages 项目
- **TTL**：每条记录 `expirationTtl: 3600`（1 小时），过期后自动删除
- **本地开发**：`wrangler pages dev --kv TASKS` 自动创建本地 KV 存储

### 本地开发配置

```json
"dev": "wrangler pages dev --compatibility-date=2024-01-01 --kv TASKS -- npx vite"
```

这条命令做了三件事：
1. 启动 Vite 作为前端开发服务器
2. wrangler 作为代理层，拦截 `/api/*` 请求执行 Pages Functions
3. `--kv TASKS` 提供本地 KV 存储

环境变量从 `.dev.vars` 读取（非 `.env`），格式为 `KEY=VALUE`。

### 遇到的挑战

| 挑战 | 原因 | 解决方案 |
|------|------|---------|
| GitHub API 403 | 缺少 User-Agent 头 | 所有请求加 `"User-Agent": "mc-devtool"` |
| 下载 artifact 401 | redirect:follow 带 auth 头到 Azure | 手动处理 302 |
| 空仓库无法创建分支 | 无 commit 时不存在 ref | 自动创建初始 README |
| Java 版本不匹配 | Paper 1.20+ API 需要 Java 21 | 修正版本推导规则 |
| wrangler 读不到 .env | Pages Functions 用 .dev.vars | 创建 .dev.vars 文件 |
| KVNamespace 类型报错 | IDE 不识别 CF Workers 类型 | 运行时正常，忽略 IDE lint |
