# 踏海 · TAHAI

用自然语言描述 Minecraft 插件需求，在浏览器中完成需求确认、代码生成、构建与 JAR 下载。

这是一个 Vue 3 前端与 Cloudflare Pages Functions 组成的 Web 平台。插件项目由多个专职 AI 角色协作生成，再交给独立的 GitHub Actions 构建仓编译；本仓库本身不是 Minecraft 插件。

**开始阅读**：[快速使用](docs/guide/quick-start.md) · [核心变更与接力记录](CHANGELOG.md) · [开发与部署](docs/technical/development.md) · [API 参考](docs/technical/api-reference.md)

## 可以做什么

- 输入需求，提取服务端核心与版本，通过多轮澄清确认关键行为。
- 按项目蓝图和文件依赖顺序生成代码，同一依赖层的文件并发处理，并进行审查与补缺。
- 实时查看思考、输出和阶段进度；中断后保留状态，由用户继续任务。
- 构建失败时解析编译诊断，按需查证版本化公开 API，约束修复候选后重新构建。
- 下载构建成功的 JAR 和 Maven 源码 ZIP，在路径节点中查看契约与源码；通过 Skill 为生成过程提供专门约束。
- 在浏览器保存工程、源码、版本和已下载产物，从历史恢复现场后手动继续；构建结束后可以追加需求、确认结构变更并增量修改。
- 从输入区的 `+` 或拖入普通 Java Paper/Spigot JAR 还原工程，再进入同一套结构确认、修改与编译流程。
- 从 Debug 旁提交游戏实测或执行失败反馈；确认公开范围后，将源码与诊断 ZIP、截图发布到产品仓库 Issue。

旧 IDE 与其中的可视化蓝图、追加需求实现保留在 [`.deprecated/ide/`](.deprecated/ide/)，旧 `/ide` 地址跳转到对话页。当前追加需求通过结构树和工程版本完成，详见[工程生命周期](ref/project-lifecycle.md)。

## 一次生成如何完成

```text
输入需求 → 流式预检与信息提取 → 创建任务 → 多轮澄清
        → 行为路径规划 → 修正或确认锁定 → 按依赖生成、契约核对与补缺
        → 沿需求路径静态审查 → GitHub Actions 编译 → 下载 JAR 与源码 ZIP
                                            └→ 失败诊断 → 按需学习 API → 修复并重新审查、编译
```

路径连接线仅在模型静态审查和对应代码编译均通过后变实线；游戏内行为由用户实测。

前端负责按阶段调用 API；服务端管理任务、授权、费用与模型请求。`MainBlueprint` 约束主类装配，`FileSummary` 向后续文件传递已生成的 API 契约。公开 API 学习通过 `learn_public_api` 工具和 Learning 端点接回模型对话。

刷新或从历史恢复进行中任务时，先还原本地现场并等待用户手动继续。服务端任务有效则对账续接，过期时使用拥有者绑定的签名 checkpoint 重建；代码可复用，授权、计费和验证由服务端重新确定。

## 技术与服务

| 部分 | 实现 |
| --- | --- |
| 页面与交互 | Vue 3、TypeScript、Vite、Vue Router |
| API 与托管 | Cloudflare Pages + Pages Functions |
| 持久化 | IndexedDB：本地工程、版本和产物；D1：任务、费用、知识、临时执行记录与提交状态；KV `TASKS`：用户资料、额度与缓存等 |
| 模型适配 | DeepSeek 为默认提供方；支持用户自带 DeepSeek Key，以及受档位限制的 GLM Key |
| 编译 | 独立 GitHub 构建仓执行 Maven，平台代理状态查询与产物下载 |
| 测试与文档 | Vitest、VitePress |

仓库当前将 DeepSeek 模型名统一为 `deepseek-flash`，原 flash/pro 档分别映射到 `low`/`high` 思考强度，具体规则集中在 [`llm.ts`](functions/_lib/llm.ts)。这些是当前代码配置，调整模型时应同步更新调用与计费规则。

平台模型密钥、GitHub PAT 和 OAuth secret 存放在服务端。用户自带模型 Key 保存在浏览器，调用时随请求临时传递给服务端处理，不写入任务数据库。

## 本地开始

需要 Node.js `^20.19.0` 或 `>=22.12.0`、npm 和 Git。

```bash
npm install
```

在根目录创建 `.dev.vars`，按需要配置；不要提交真实密钥：

```dotenv
DEEPSEEK_API_KEY=<平台模型密钥>
GITHUB_PAT=<构建仓访问令牌>
GITHUB_OAUTH_CLIENT_ID=<GitHub OAuth App Client ID>
GITHUB_OAUTH_CLIENT_SECRET=<GitHub OAuth App Secret>
SESSION_SECRET=<会话签名密钥>
DEEPSEEK_RESPONSES_WEB_SEARCH=false
```

OAuth 回调地址为 `<站点地址>/api/auth/callback`。`GITHUB_PAT` 需有访问构建仓、写入构建分支及触发工作流的权限。

```bash
npm run dev
```

访问 Wrangler 输出的地址，通常为 `http://localhost:8788`。这个入口同时提供前端和 `/api/*`，直接访问 Vite 端口不能代替完整 API 环境。

**完整生成流程还需要 D1。** 默认 `dev` 脚本只绑定本地 KV `TASKS`；需另外在 Wrangler 本地配置中绑定 D1 为 `DB` 并应用迁移。任务读取或存储的部分路径有 KV 兼容逻辑，但澄清、结构规划等操作的执行锁依赖 D1，不能将 KV 回退视为完整流程保障。

新数据库按顺序执行 [`migrations/`](migrations/) 下 `0001` 至 `0006` 的 SQL；已有数据库只执行尚未应用的迁移。`0006_project_journal_feedback.sql` 是新版模型调用记录与提交去重的前置条件，Pages 推送部署不会自动执行。Git 登录、平台额度、模型凭证和构建仓配置也会影响相关功能能否使用。

## 常用命令

| 命令 | 用途 |
| --- | --- |
| `npm run dev` | Vite + Wrangler 开发入口，默认绑定本地 `TASKS` |
| `npm run build` | 生成前端生产资源到 `dist/` |
| `npm run preview` | 预览前端构建资源 |
| `npm run cf:dev` | 用 Wrangler 运行已有 `dist/` 与 Functions |
| `npm test` | 运行根项目 Vitest 测试，包含前端逻辑与服务端端点测试 |
| `npx tsc --noEmit` | 按当前 TypeScript 配置检查类型 |
| `npm run versions:update` | 更新 Minecraft 版本列表 |

文档站脚本位于 [`docs/package.json`](docs/package.json)。根项目的 `npm test` 才是业务测试入口，文档子项目的 `test` 仍为占位脚本。

日常修改按协作约定验证；会触发部署的提交、合并或推送前，必须完成完整测试、类型检查、服务端检查及必要构建。不要在普通文档整理中顺带部署。

## 代码从哪里看

| 位置 | 职责与入口 |
| --- | --- |
| [`src/pages/`](src/pages/) / [`src/components/`](src/components/) | 页面与共享组件；对话页 `ChatPage.vue`、生成进度 `GenerateProgress.vue` |
| [`src/styles/lattice.css`](src/styles/lattice.css) / [`src/ui/lattice.ts`](src/ui/lattice.ts) | 共享窗棂外观、角花与运行态动画；设计基准见 [`ref/refer.html`](ref/refer.html)，技能卡面暂时保留原样 |
| [`src/styles/typography.css`](src/styles/typography.css) | 顶栏品牌与 chat / craft 导航用 Minecrafter，其他固定文案用全量江西拙楷，输入与生成内容用钉钉进步体；动态内容标记 `data-font="dynamic"`，字体文件存放在 `public/` |
| [`src/logic/`](src/logic/) | 对话、生成状态、恢复与 Learning 续跑；优先看 `chatHandler.ts`、`generateHandler.ts`、`generateState.ts` |
| [`src/api/deepseek.ts`](src/api/deepseek.ts) | 预检、信息提取与前端流式调用 |
| [`.deprecated/`](.deprecated/) | 已停用功能与重构片段归档；旧 IDE 及其追加需求实现见 `.deprecated/ide/` |
| [`ref/`](ref/) | 界面样稿与用户提供的动画参考包，不参与应用构建 |
| [`functions/api/generate/`](functions/api/generate/) | 任务创建、需求确认、结构树、分桶生成、路径审查、构建、修复、下载 |
| [`functions/api/learning/`](functions/api/learning/) | 公开 API 学习任务的创建、推进和查询 |
| [`functions/_lib/`](functions/_lib/) | `prompts.ts` 提示词契约、`llm.ts` 模型适配、`taskStore.ts` 存储与执行锁、`quota.ts` 计费 |
| [`functions/_lib/learning/`](functions/_lib/learning/) | 学习授权、证据验证、公共知识及不可用 API 事实 |
| [`public/`](public/) | 静态资源、构建工作流模板 `maven.yml`、证据采集脚本 `compile_api_evidence.py` |
| [`tests/`](tests/) / [`migrations/`](migrations/) | 回归测试与 D1 数据库迁移 |

## 部署时要对齐什么

前端产物部署到 Cloudflare Pages，输出目录为 `dist`，同时发布 Pages Functions。需要配置 `TASKS` KV、`DB` D1、对应环境变量及 OAuth 回调地址。Production 和 Preview 的绑定与开关分别配置。

构建仓目前由 [`functions/_lib/github.ts`](functions/_lib/github.ts) 指向 `superwfox/minecraft-dev-workflow`，并调用其 `maven.yml` 工作流。更换部署归属时需同步检查仓库地址、令牌权限及工作流输入，不能只改前端配置。

ResolveJAR 使用该仓库单独的受控反编译工作流。公开反馈还需 `GITHUB_FEEDBACK_TOKEN` 及 Pages 排除 `feedback-data` 分支；功能默认启用，可设置 `FEEDBACK_DATA_BRANCH_READY=false` 关闭。分支限制、权限和安装步骤见[工程生命周期](ref/project-lifecycle.md)。

`DEEPSEEK_RESPONSES_WEB_SEARCH` 默认关闭，开启后才允许符合条件的 DeepSeek 自动联网学习；GLM 路由只读取已有公共知识。不可用 API 共享缓存还要求 `0005_negative_api_facts.sql` 和可信构建证据链就绪，详见[编译学习闭环](docs/technical/compile-learning.md)。

本地执行过迁移、代码已合入或模板已更新，都不能据此认定线上数据库与外部构建仓已经同步；发布时需分别核实。

## 后续开发与新对话接力

先读本页了解项目，再读 [`CHANGELOG.md`](CHANGELOG.md) 顶部的最新修改记录，随后定位到对应模块。后续核心修改按“日期 → 修改方面 → 编号列表”的格式记录，每次在 CHANGELOG 顶部新增。

深入阅读：[生成流水线](docs/technical/generation-pipeline.md) · [Skill 系统](docs/features/skills.md) · [系统架构](docs/technical/architecture.md) · [编译学习闭环](docs/technical/compile-learning.md)。详细文档若与当前实现不一致，以代码为准，并在相关改动中同步修正。
