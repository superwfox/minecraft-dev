# 工程生命周期

一个工程可以由 Prompt 创建，也可以由 JAR 导入；之后共用同一条链路：结构树确认 → 增量生成／修改 → 路径静态审查 → 编译 → 下载 → 追加需求。本页说明本地保存、恢复、追加修改、执行记录、公开反馈和 ResolveJAR 的实现与配置。真实调用的验证记录保存在仓库 [`ref/project-lifecycle.md`](https://github.com/superwfox/minecraft-dev/blob/master/ref/project-lifecycle.md)。

## 本地保存与恢复

`src/logic/projectDb.ts` 使用原生 IndexedDB 数据库 `tahai-projects`（schema version 1）：

| store | 内容 |
| --- | --- |
| `projects` | 工程现场 |
| `versions` | 版本快照 |
| `blobs` | 原始 JAR 与构建产物 |
| `events` | 执行事件 |
| `drafts` | 输入与反馈草稿 |
| `meta` | 当前工程指针 |

键由 preview/live、GitHub 身份 ID 和工程 ID 组成。阶段变化、文件写回、结构修正和构建结束时同步 checkpoint；草稿防抖保存，`pagehide` 与页面隐藏时补充保存。存储异常会提示，不自动淘汰旧工程。

恢复只还原现场，进行中状态改为中断，用户点击继续后才调用模型。旧 localStorage 记录迁移成功后才删除原值。

服务端任务仍有效时，按现有 request ID 与租约对账。任务过期时上传拥有者绑定的 HMAC checkpoint，创建稳定的 successor task ID：

- 接口验证身份、路径、文件、结构和签名，并从源码重新检查契约；
- 清空计费、执行授权、租约、模型阶段缓存、路径验证和编译证据；
- 已完成的源码复用，无法确认的输出作为草稿；
- `SESSION_SECRET` 轮换会使旧恢复凭证失效，本地源码仍保留。

## 追加修改

`POST /api/generate/revise` 使用稳定 requestId 建立新的工作 revision。修改范围按文件契约、依赖、路径绑定和装配关系扩散，不受影响的文件原样保留；依赖或命令注册变化同步更新 `pom.xml`／`plugin.yml`，Main 在业务文件之后处理。结构确认前展示新增、影响和删除清单。

旧 revision 及其缓存产物不会被失败的修改覆盖。下载 JAR 时先读取当前版本的 IndexedDB Blob；首次从远端取得构建 ZIP 后先写入本地再交给浏览器。后台缓存与手动下载共用同一请求，远端接口核对 revision，防止新产物写入旧版本。

## 执行 journal 与重放

迁移 `0006_project_journal_feedback.sql` 新增独立的 journal 分块、完整性计数和提交去重表。服务端 journal 暂存 24 小时，浏览器通过 `GET /api/generate/journal` 按序拉取并持久化。

记录内容包括产品 commit、Prompt 协议版本、调用参数、公开的模型输入输出、工具定义／调用／结果、Learning 网络请求、源码指纹以及构建提交、配置和日志。凭据与 `reasoning_content` 被排除，错误字符串也会脱敏。缺失块、观察流中断、存储失败和超限都会标为不完整。

Actions 日志使用手动重定向下载，不向签名存储地址转发 GitHub 授权头；终态返回前保存日志及 job 清单。被跳过的 job 记录 `job_not_executed`，单个日志下载失败不阻止保存其他 job。

重放 CLI（Node 24+）：

```bash
node scripts/replay-project.mjs <诊断目录> [输出目录]
node scripts/replay-project.mjs <诊断目录> [输出目录] --compile --release=21 --classpath=<已核对依赖的classpath>
```

重放先解压反馈的两个 ZIP，把源码包的工程目录放进诊断目录的 `source/`。CLI 重放记录的模型输出与工具结果，重新运行结构工具、契约检查并导出源码指纹；`--compile` 只运行关闭 annotation processing 的受控 javac，不执行归档中的构建脚本、测试或插件。发现差异或缺失时返回非零状态。重放不保证重新调用模型会得到相同答案。

## 公开反馈

### 内容

- **source.zip**：复用普通源码下载打包器，包含当前源码、资源、`PROJECT_TREE.md` 和可用的 JAR 还原报告。
- **diagnostics.zip**：manifest、project、events、browser-state、versions、resources、`REPRODUCE.md` 和反馈定位信息。

浏览器发送结构化记录与文件，服务端再次脱敏后生成两份 ZIP，防止不透明 ZIP 绕过脱敏；固定文件顺序与日期，相同资料打包结果一致。单次请求总量约 30 MiB。

### 发布

1. 用户在公开确认弹窗点击「确认公开并发布」后，资料被冻结，重试复用相同内容与 submissionId。
2. ZIP 与图片写入 Git blob，经 Git Trees 关联到 `feedback-data` 分支上的不可变提交。
3. 创建产品 Issue，@ 用户由服务端会话的 GitHub login 决定，不接受浏览器覆盖。
4. 上传成功但 Issue 失败时复用原 commit；创建结果不明确时先查找标记，找不到也不盲目重建，保持“待对账”。

### 配置

1. 执行 D1 迁移 `0006`。
2. 在 Pages Production 配置 Secret `GITHUB_FEEDBACK_TOKEN`，授予 `superwfox/minecraft-dev` 的 Contents write 与 Issues write；兼容已有的 `GITHUB_PR_TOKEN`。凭据不进入浏览器或工程档案。
3. Pages 的 preview 分支规则排除 `feedback-data`。数据分支从无父提交的空树创建，不包含产品源码或 workflow。
4. 功能默认启用；设置 `FEEDBACK_DATA_BRANCH_READY=false` 可暂停公开写入，此时发布接口返回 503。缺少数据库或仓库凭据同样返回 503。

## ResolveJAR

### 配置

执行仓库固定为 `superwfox/minecraft-dev-workflow`，沿用服务端 `GITHUB_PAT`（读取仓库与 Actions、写临时输入分支、调度工作流）。以下文件需安装到执行仓库 `main`，修改后需重新同步：

- `ref/workflows/resolve-jar.yml` → `.github/workflows/resolve-jar.yml`
- `scripts/resolve-jar.py` → `scripts/resolve-jar.py`

每次上传前真实查询执行仓库可见性；仓库公开时必须在导入框单独确认，查询失败则不上传。

### 边界

- 工作流只由 `workflow_dispatch` 启动；读取输入与处理不可信内容的步骤分离，checkout 不保留凭据，反编译与基线编译不持有写权限，不运行插件或包内脚本。
- 反编译器固定为 Vineflower 1.12.0（Maven Central，SHA-256 `1dfcfe974395734fa467ce620661c7623d05ba83670de0529b1fbd63ff548b9d`）。
- 原始 JAR 20 MiB、展开总量 100 MiB、2,000 条目，可编辑工程 12 MiB。浏览器与服务端先检查 ZIP 中央目录，Actions 再验证实际解压结果，拒绝路径穿越、危险重复路径、加密、符号链接与 ZIP64。
- 以主类所在包区分插件代码，主包外的类记为归属待确认。混淆、其他 JVM 语言及特殊 loader 不承诺还原；原签名失效并记入报告。
- 用受控 Maven 模板做基线编译（关闭 annotation processing）。失败仍返回源码、诊断和阻塞项。
- `plugin.yml` 契约读取实际主类，不强制改名为 Main。文本资源被纳入修改时转为可编辑文件，指纹按最终有效文件计算。

调度使用稳定 submissionId 与 D1 租约，中断后先对账已有 run，不盲目重复调度。导入报告记录原始输入 commit、SHA-256、Actions run、workflow head SHA 和结果 artifact。

## 接口

全部接口沿用登录与拥有者校验。

| 接口 | 用途 |
| --- | --- |
| `GET /api/generate/checkpoint?taskId=` | 白名单工程快照、schema version、恢复签名 |
| `POST /api/generate/checkpoint` | 校验快照，复用有效任务或重建过期任务 |
| `GET /api/generate/journal?taskId=&cursor=` | 顺序拉取 journal 块与缺失／待同步状态 |
| `POST /api/generate/revise` | 追加需求并建立工作版本 |
| `GET`／`POST /api/generate/feedback` | 服务状态、发布反馈、按 submissionId 查询结果 |
| `GET`／`POST /api/generate/jar` | 执行仓库可见性、上传与调度、导入状态与工程结果 |

<a class="detail-link" href="./api-reference">API 参考 →</a>
