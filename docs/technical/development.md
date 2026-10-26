# 开发与部署

## 环境要求

- Node.js 18 或更高（重放 CLI 需要 Node 24+）
- npm 9 或更高
- 可选：Python 3（真实 SQLite 回归用例）、JDK（本地重放编译）

## 本地开发

```bash
git clone https://github.com/superwfox/minecraft-dev.git
cd minecraft-dev
npm install
```

在项目根目录创建 `.dev.vars`（不是 `.env`，且不要提交）：

```
DEEPSEEK_API_KEY=sk-...
DEEPSEEK_RESPONSES_WEB_SEARCH=true
GITHUB_PAT=ghp_...
GITHUB_OAUTH_CLIENT_ID=...
GITHUB_OAUTH_CLIENT_SECRET=...
SESSION_SECRET=...
```

启动：

```bash
npm run dev
```

该命令运行 `wrangler pages dev --kv TASKS --proxy=5173 -- npx vite`：Vite 提供前端（5173），Wrangler 代理 Vite 并提供 `/api/*` Functions 与本地 KV。请访问 Wrangler 输出的地址（默认 `http://localhost:8788`），直接访问 5173 时 `/api/*` 会 404。

默认脚本只绑定 `TASKS` KV。完整生成流程还需要以 `DB` 绑定本地 D1 并执行迁移；部分读写支持 KV 回退，但执行锁、Learning 和 journal 依赖 D1。

## 测试与检查

| 命令 | 用途 |
| --- | --- |
| `npm test` | Vitest 全量回归，含前端逻辑、服务端端点与真实 SQLite 事务用例 |
| `npx tsc --noEmit` | 类型检查（排除 `.deprecated/` 与 `ref/`） |
| `npm run build` | Vite 生产构建 |

Windows 下 SQLite 用例在全量并发时可能触发 5 秒超时，可单 worker 运行或单独复查对应文件。会触发部署的推送前，上述检查必须全部通过。

## 环境变量

| 变量 | 必需 | 用途 |
| --- | --- | --- |
| `DEEPSEEK_API_KEY` | 是 | 平台模型调用与 Search/Fetch |
| `GITHUB_PAT` | 是 | 执行仓库的读写、调度 Actions、读取日志与产物（`repo` + `workflow`） |
| `GITHUB_OAUTH_CLIENT_ID`、`GITHUB_OAUTH_CLIENT_SECRET` | 是 | GitHub 登录（OAuth App） |
| `SESSION_SECRET` | 是 | 会话与恢复凭证签名，可用 `npm run gen:secret` 生成；轮换会使旧 checkpoint 失效 |
| `DEEPSEEK_RESPONSES_WEB_SEARCH` | 否 | 联网学习开关，默认关闭，接受 `1`、`true`、`yes`；沿用旧名，实际调用 Search/Fetch |
| `GITHUB_FEEDBACK_TOKEN` | 反馈 | 产品仓库 Contents 与 Issues 写权限，配置为 Secret |
| `FEEDBACK_DATA_BRANCH_READY` | 否 | 设为 `false` 时暂停公开反馈；默认启用 |
| `GEN_CONCURRENCY` | 否 | 桶内并发上限，默认 2 |
| `EDGE_RATE_LIMITING` | 否 | 使用域名级 WAF 限流时设为 `true`，关闭 KV 限流兜底 |

联网学习的资格、降级和负面事实规则见[编译诊断与 API 学习](./compile-learning.md)；Search/Fetch 的费用和边界见 [API 参考](./api-reference.md#learning-的-search--fetch)。

## 部署到 Cloudflare Pages

1. **连接仓库**：Workers & Pages → Create → Pages → Connect to Git，选择本仓库。Framework preset 选 Vite，Build command 为 `npm run build`，输出目录为 `dist`。
2. **环境变量**：在 Production 和需要的 Preview 环境分别配置上表变量，保存后重新部署才会生效。
3. **KV**：创建命名空间并以变量名 `TASKS` 绑定。
4. **D1**：创建数据库并以变量名 `DB` 绑定，在 D1 Console 按编号执行 `migrations/0001` 至 `0006`。已有数据库只执行尚未应用的后续文件，不能重复执行包含 `ALTER TABLE ... ADD COLUMN` 的文件。Pages 的 Git 自动部署不会执行迁移，包含新 SQL 文件的发布必须先执行迁移。
5. **限流（可选）**：绑定 Rate Limiting binding `API_RATE_LIMITER`，或在域名上配置 WAF Rate Limiting 并设置 `EDGE_RATE_LIMITING=true`。两者都未配置时，只有触发模型或 GitHub 写入的昂贵端点回退到 KV 限流。
6. **反馈**：配置 `GITHUB_FEEDBACK_TOKEN`，并在 Pages 的 preview 分支规则中排除 `feedback-data`。

### GitHub 登录

登录使用 **OAuth App**（不是 GitHub App）：Settings → Developer settings → OAuth Apps → New OAuth App。

| 字段 | 正式站点的值 |
| --- | --- |
| Homepage URL | `https://tahai.xyz` |
| Authorization callback URL | `https://tahai.xyz/api/auth/callback` |

`login.ts` 和 `callback.ts` 都用当前访问域名拼接 `redirect_uri`，所以必须从 `tahai.xyz` 发起登录。从 `*.pages.dev` 预览地址登录会因回调地址不匹配而失败；自建部署时把两处 `tahai.xyz` 换成自己绑定到平台 Pages 项目的域名。缺少三个登录变量会导致点击登录后返回 500。

## 执行仓库

编译与 ResolveJAR 在独立仓库 `superwfox/minecraft-dev-workflow` 执行，仓库名写在 `functions/_lib/github.ts` 与 `functions/_lib/projectGithub.ts`。自建部署需要：

- 编译工作流：以仓库内 `public/maven.yml` 与 `public/compile_api_evidence.py` 为准，安装到执行仓库。工作流通过 `workflow_dispatch` 接收分支与 Java 版本，并输出编译证据步骤。
- ResolveJAR 工作流：`ref/workflows/resolve-jar.yml` 与 `scripts/resolve-jar.py`，见[工程生命周期](./project-lifecycle.md#resolvejar)。
- 修改上述脚本后同步到执行仓库；服务端会核对已审查的 workflow 与扫描器 Git blob。

## 目录结构

```
minecraft-dev/
├── src/                 # 前端：pages、components、logic、styles
├── functions/
│   ├── api/             # Pages Functions 端点
│   └── _lib/            # Prompt、结构树、契约、路径审查、Learning、GitHub、journal 等
├── shared/              # 前后端共用的 ZIP 与归档逻辑
├── migrations/          # D1 迁移 0001–0006
├── scripts/             # 重放 CLI、ResolveJAR、版本更新等脚本
├── tests/               # Vitest 回归
├── public/              # 静态资源与执行仓库工作流模板
├── docs/                # 本文档站（VitePress）
├── ref/                 # 参考资料、Prompt 清单与真实验证记录
└── .deprecated/         # 已停用功能归档，不参与构建
```

## 文档站

```bash
cd docs
npm install
npx vitepress dev
```

构建使用 `npx vitepress build`。

<a class="detail-link" href="./history">历史与停用功能 →</a>
