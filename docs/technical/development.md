# 开发与部署

本文档介绍如何在本地开发踏海项目，以及如何部署到生产环境。

## 环境要求

- **Node.js**：18.x 或更高
- **npm**：9.x 或更高
- **Git**：用于版本控制

## 本地开发

### 1. 克隆项目

```bash
git clone https://github.com/superwfox/minecraft-dev.git
cd minecraft-dev
```

### 2. 安装依赖

```bash
npm install
```

### 3. 配置环境变量

在项目根目录创建 `.dev.vars` 文件（注意不是 `.env`）：

```
DEEPSEEK_API_KEY=sk-...
GITHUB_PAT=ghp_...
XFYUN_APP_ID=...
XFYUN_API_KEY=...
XFYUN_API_SECRET=...
```

**获取密钥**：

| 密钥 | 获取方式 |
|------|---------|
| `DEEPSEEK_API_KEY` | 访问 [DeepSeek 平台](https://platform.deepseek.com)，注册并创建 API Key |
| `GITHUB_PAT` | GitHub Settings → Developer settings → Personal access tokens → Generate new token，勾选 `repo` 权限 |
| `XFYUN_APP_ID` | 访问[讯飞开放平台](https://console.xfyun.cn)，创建语音听写应用 |
| `XFYUN_API_KEY` | 同上，在应用详情中查看 |
| `XFYUN_API_SECRET` | 同上 |

### 4. 启动开发服务器

```bash
npm run dev
```

这个命令（`wrangler pages dev --kv TASKS --proxy=5173 -- npx vite`）会：
1. 启动 Vite 开发服务器（前端，端口 5173）
2. 启动 Wrangler Pages Dev 并代理到 Vite，同时提供 `/api/*` Functions 与本地 KV

访问 Wrangler 输出的本地地址（默认 `http://localhost:8788`）查看完整应用（前端 + Functions）。

### 5. KV 命名空间

本地开发时，`npm run dev` 脚本中的 `wrangler pages dev --kv TASKS` 会**自动创建本地 KV 存储**，无需额外配置或 `wrangler.toml`。

生产环境则在 Cloudflare Dashboard 创建 KV 命名空间，并以变量名 `TASKS` 绑定到 Pages 项目（见下方「部署到 Cloudflare Pages」章节）。

生成任务与单任务成本在生产环境优先使用变量名为 `DB` 的 D1 绑定。本地 `npm run dev` 未绑定 D1 时会自动回退本地 `TASKS` KV，不影响开发流程。

生产环境可选择变量名为 `API_RATE_LIMITER` 的 Cloudflare Rate Limiting binding；配置后所有受保护 API 使用原生软限流，不再为限流读写 `TASKS`。Pages + Git 集成更推荐在域名上建立 WAF Rate Limiting rule，并在 Pages 的 Production 环境变量中设置 `EDGE_RATE_LIMITING=true`，同样会关闭 KV 限流兜底。两者均未配置时，代码仅对会触发 LLM、GitHub 写入等昂贵端点回退 KV 限流，本地开发无需额外绑定。

## 项目结构

```
minecraft-dev/
├── src/                      # 前端源码
│   ├── pages/                # 页面组件（HomePage / ChatPage）
│   ├── components/           # 通用组件
│   ├── logic/                # 业务逻辑（chat / generate / session / voice）
│   ├── ide/                  # 浏览器内 IDE 模块
│   ├── api/deepseek.ts       # 前端 LLM 调用封装
│   └── router.ts             # 路由配置（/ /chat /ide/:taskId?）
├── functions/                # Cloudflare Functions
│   ├── api/                  # API 端点（generate / chat / stream / voice-auth / maven）
│   └── _lib/                 # 共享库（prompts / github）
├── public/                   # 静态资源
├── docs/                     # 文档（VitePress）
├── package.json              # 依赖与脚本
├── vite.config.js            # Vite 配置（含 Monaco 插件）
└── .dev.vars                 # 本地环境变量（不提交）
```

## 部署到 Cloudflare Pages

### 1. 创建 GitHub 仓库

将项目推送到 GitHub：

```bash
git remote add origin https://github.com/your-username/minecraft-dev.git
git push -u origin master
```

### 2. 连接 Cloudflare Pages

1. 登录 [Cloudflare Dashboard](https://dash.cloudflare.com)
2. 进入 **Workers & Pages** → **Create application** → **Pages**
3. 选择 **Connect to Git**
4. 授权 GitHub，选择 `minecraft-dev` 仓库
5. 配置构建设置：
   - **Framework preset**：Vite
   - **Build command**：`npm run build`
   - **Build output directory**：`dist`

### 3. 配置环境变量

在 Pages 项目设置中，添加环境变量：

1. **Settings** → **Environment variables**
2. 添加以下变量（Production 和 Preview 都需要）：
   ```
   DEEPSEEK_API_KEY=sk-...
   GITHUB_PAT=ghp_...
   XFYUN_APP_ID=...
   XFYUN_API_KEY=...
   XFYUN_API_SECRET=...

   # GitHub 登录（OAuth）—— 缺这三个会导致点登录后 500 / 登录失败
   GITHUB_OAUTH_CLIENT_ID=...           # OAuth App 的 Client ID
   GITHUB_OAUTH_CLIENT_SECRET=...       # OAuth App 设置页生成的 client secret
   SESSION_SECRET=...                   # 会话签名密钥，可用 npm run gen:secret 生成
   ```

   > 登录使用 **OAuth App**（不是 GitHub App）：Settings → Developer settings →
   > **OAuth Apps** → New OAuth App。**Authorization callback URL** 填
   > `https://<你的域名>/api/auth/callback`，并确认该域名指向的是带 Functions 的**平台**
   > Pages 项目。把它的 Client ID / client secret 填入上面两个变量即可。
   >
   > 注：OAuth App 对任意 GitHub 用户开箱即用，无需安装、无 public/private 开关；
   > 这也是登录场景比 GitHub App 更合适的原因（GitHub App 会强制「先安装再授权」）。

### 4. 创建 KV 命名空间

1. **Workers & Pages** → **KV** → **Create namespace**
2. 命名为 `TASKS`
3. 在 Pages 项目设置中绑定：
   - **Settings** → **Functions** → **KV namespace bindings**
   - Variable name: `TASKS`
   - KV namespace: `TASKS`

### 4.1 创建 D1 任务数据库

1. **D1 SQL Database** → **Create database**
2. 在 Pages 项目的 **Settings** → **Bindings** 中新增 D1 database binding
3. Variable name 固定为 `DB`
4. 在 D1 Console 执行 `migrations/0001_generation_tasks.sql`

D1 仅承载高频生成任务状态和单任务成本；用户额度、订单、赞助、Skill 缓存和限流兜底继续使用 `TASKS` KV。

### 5. 部署

推送代码到 GitHub，Cloudflare 自动触发部署：

```bash
git add .
git commit -m "Initial deployment"
git push
```

部署完成后，访问 Cloudflare 提供的 URL（如 `https://minecraft-dev.pages.dev`）。

## 配置 GitHub Actions

### 1. 创建构建仓库

创建一个独立的 GitHub 仓库用于构建（如 `minecraft-dev-workflow`），添加以下文件：

```yaml
# .github/workflows/maven.yml
name: Build Plugin

on:
  workflow_dispatch:
    inputs:
      branch:
        description: 'Branch to build'
        required: true
      java_version:
        description: 'Java version'
        required: true

jobs:
  build:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v3
        with:
          ref: ${{ github.event.inputs.branch }}

      - uses: actions/setup-java@v3
        with:
          java-version: ${{ github.event.inputs.java_version }}
          distribution: 'temurin'

      - name: Build with Maven
        run: mvn clean package

      - uses: actions/upload-artifact@v3
        with:
          name: plugin-jar
          path: target/*.jar
          retention-days: 1
```

### 2. 创建 GitHub PAT

1. GitHub Settings → Developer settings → Personal access tokens
2. Generate new token (classic)
3. 勾选权限：
   - `repo`（完整权限）
   - `workflow`（触发 Actions）
4. 复制 token，添加到 Cloudflare 环境变量 `GITHUB_PAT`

### 3. 更新 Functions 配置

修改 `functions/_lib/github.ts`，将仓库名改为你的构建仓库：

```typescript
const REPO_OWNER = "your-username";
const REPO_NAME = "minecraft-dev-workflow";
```

## 常见问题

### 本地开发时 Functions 无法访问

**问题**：访问 `/api/chat` 返回 404

**解决**：
1. 确认 `npm run dev` 同时启动了 Wrangler 与 Vite（`wrangler pages dev --kv TASKS --proxy=5173 -- npx vite`）
2. 通过 Wrangler 的端口（默认 8788）访问，而非直接访问 Vite 的 5173——`/api/*` Functions 与本地 KV 由 Wrangler 提供

### KV 存储无法访问

**问题**：Functions 报错 `env.TASKS is undefined`

**解决**：
1. 本地开发：确认 `wrangler.toml` 中配置了 KV 绑定
2. 生产环境：在 Cloudflare Dashboard 中绑定 KV 命名空间

### GitHub Actions 构建失败

**问题**：Maven 构建报错 `Could not resolve dependencies`

**解决**：
1. 检查 `pom.xml` 中的依赖版本是否正确
2. 确认 Maven 仓库 URL 可访问
3. 查看 Actions 日志中的详细错误信息

### 语音识别无法使用

**问题**：点击麦克风按钮无反应

**解决**：
1. 确认浏览器支持 `getUserMedia`（需 HTTPS 或 localhost）
2. 检查麦克风权限是否授予
3. 查看浏览器控制台是否有错误信息
4. 确认讯飞 API 密钥配置正确

## 性能优化

### 前端优化

1. **代码分割**：Vite 自动按路由分割代码
2. **懒加载**：大组件使用 `defineAsyncComponent`
3. **图片优化**：使用 WebP 格式，压缩图片
4. **字体子集化**：只包含使用的字符

### Functions 优化

1. **缓存 AI 响应**：相同需求可缓存结果（可选）
2. **并发控制**：限制同时生成的任务数
3. **KV TTL**：合理设置过期时间，避免存储浪费

### 构建优化

1. **Maven 缓存**：GitHub Actions 缓存 `.m2` 目录
2. **并行构建**：`mvn -T 1C` 使用多核编译
3. **Artifact 清理**：设置 `retention-days: 1`

## 监控和日志

### Cloudflare Analytics

在 Cloudflare Dashboard 中查看：
- 请求量
- 错误率
- 响应时间
- 流量分布

### Functions 日志

使用 `wrangler tail` 实时查看日志：

```bash
npx wrangler pages deployment tail
```

### GitHub Actions 日志

在 GitHub 仓库的 **Actions** 标签页查看构建日志。

## 下一步

- [查看 API 参考](/technical/api-reference)：了解所有 API 端点
- [了解架构设计](/technical/architecture)：深入理解系统设计
- [查看 AI 工作流](/features/ai-workflow)：了解 AI 如何生成代码
