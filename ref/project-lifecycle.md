# 本地工程、公开反馈与 ResolveJAR

工程共用链路：Prompt 创建或 JAR 导入 → 结构树确认 → 增量生成／修改 → 路径静态审查 → 编译 → 下载 → 追加需求。

前端复用现有 Vue、结构树、状态卡、输入区及按钮。历史菜单提供本地关键词搜索；悬停先收窄提示词，再淡入复制／恢复／删除，退出时反向执行。操作按钮与提示词等高，采用窄按钮。JAR 入口为输入区角落的 `+`，支持拖入文件。

## 本地保存与恢复

`src/logic/projectDb.ts` 使用原生 IndexedDB `tahai-projects`，schema version 为 1。`projects`、`versions`、`blobs`、`events`、`drafts`、`meta` 分别存工程现场、版本快照、JAR／产物、执行事件、输入／反馈草稿和当前工程指针。

键由 preview/live、GitHub 身份 ID、工程 ID 组成；相同 Prompt 的不同任务分别保存。阶段变化、文件阶段写回、结构修正和构建结束同步 checkpoint；草稿防抖保存，pagehide／页面隐藏补充保存。请求持久存储；浏览器拒绝或用户清理站点数据仍可能移除本地资料。存储异常显示提示，不自动淘汰旧工程。

恢复只还原现场，进行中状态改为中断；用户点击继续后才调用模型。旧 localStorage 迁移成功后删除旧值；只有 Prompt 的旧记录仅能复制。删除工程清理其各存储，并尝试取消远程构建／导入、移除临时分支；已公开反馈保留。

服务端有效时按现有 request ID／租约对账。过期时上传拥有者绑定的 HMAC checkpoint，创建稳定 successor task ID。恢复接口验证身份、路径、文件、结构和签名；从源码重新检查契约，清空计费、执行授权、租约、模型阶段缓存、路径验证和编译证据。完成的源码可复用，无法确认的输出作为草稿；尚未结束的模型阶段可能需要重做。SESSION_SECRET 轮换会使旧恢复凭证失效，本地源码仍保留。

每次追加需求创建新 revision；按文件契约、依赖和路径绑定扩散修改范围，保留不受影响的文件。项目依赖／命令注册变化同步更新 pom／plugin.yml，Main 在业务文件后处理。结构确认前展示新增、影响和删除清单。旧 revision 和已缓存构建不被失败修改覆盖；源码和缓存产物可从历史版本下载。

点击“下载 JAR”时先读取当前工程版本的 IndexedDB Blob；首次从远端取得完整构建 ZIP（内含 JAR）后，先写入本地再交给浏览器下载。后续下载直接读取本地，服务端任务或远程制品过期不影响已缓存文件。后台构建完成缓存与手动下载共用同一请求，不重复拉取；各工程版本分别保存，远端接口核对 revision，防止新产物写入旧版本。保存失败会显示本地存储错误，不静默宣称已缓存。

## 服务端接口

全部接口沿用登录与拥有者校验；没有执行授权的本地数据不能启动受保护步骤。

| 接口 | 用途 |
| --- | --- |
| GET `/api/generate/checkpoint?taskId=…` | 白名单工程快照、schema version、恢复签名 |
| POST `/api/generate/checkpoint` | 校验快照，复用有效任务或重建过期任务 |
| GET `/api/generate/journal?taskId=…&cursor=…` | 顺序拉取 journal 块与缺失／待同步状态 |
| POST `/api/generate/revise` | 使用稳定 requestId 追加需求并建立工作版本 |
| GET／POST `/api/generate/feedback` | 服务状态、发布反馈、按 submissionId 查询结果 |
| GET／POST `/api/generate/jar` | 执行仓库可见性、上传／调度、导入状态与工程结果 |

## 执行 journal 与复现

先执行 `migrations/0006_project_journal_feedback.sql`。新增独立的 journal／健康计数及 submission 表，不向完整任务对象不断追加模型原文。服务端 journal 暂存 24 小时，浏览器按序持久化；未及时同步的过期事件无法补回，诊断必须标为不完整。

记录产品 commit（本地开发为 development）、Prompt 协议版本、调用参数、公开模型输入输出、工具定义／调用／结果、请求 ID、耗时、Learning 网络请求与返回、源码阶段和指纹、构建提交／配置／日志。凭据及 reasoning_content 被排除，错误字符串也脱敏。缺失块、观察流中断、存储失败和超限均不能标为完整。普通无 taskId 聊天不强制要求工程 journal。

原有“编译失败 → 诊断 → 模型修复 → 重新编译”链路继续保留，自动修复上限为三次。诊断重放验收与产品中的自动修复是两件事，不能把尚未完成的重放验证表述为产品不支持自动修复。Actions 日志采用手动重定向，不向签名存储地址转发 GitHub Authorization；终态返回前保存日志及对应 job 清单，失败则先记录明确缺口，避免前端立即导出时遗漏后台日志。编译失败导致后续 job 被跳过时，记录其 skipped 结论及 job_not_executed 原因，不下载不存在的日志；一个实际日志下载失败不阻止收集其他 job。反馈导出与重放 CLI 都核对构建的日志完成清单，旧档案即使未保存错误事件，也不能将缺失日志标为完整。历史下载失败仍如实保留为缺口。

公开反馈默认附 `source.zip` 与 `diagnostics.zip`，不提供逐文件勾选。源码 ZIP 复用普通源码下载打包器，包含当前源码、资源、PROJECT_TREE.md 及可用的 JAR 还原报告；尚无源码时加入说明。诊断 ZIP 包含 manifest、project、events、browser-state、versions、resources、REPRODUCE.md 和反馈定位信息。二进制资源同时保留在源码 ZIP 与 resources.json。记录不能保证重新调用模型得到相同答案，也不能保证远程依赖一直可用。

重放前解压两个 ZIP，将源码包内工程目录的内容放入诊断目录的 `source/`。REPRODUCE.md 说明具体目录与缺失记录的检查方法。

Node 24+ 环境在本仓库执行：

```text
node scripts/replay-project.mjs <诊断目录> [输出目录]
node scripts/replay-project.mjs <诊断目录> [输出目录] --compile --release=21 --classpath=<已核对依赖的classpath>
```

重放真实记录的公开模型输出与工具结果，重新运行结构工具、契约检查并导出源码指纹。从已有锁定工程继续、没有新的构树事件时，仍读取 project.json 中的最终树进行契约检查，不跳过已有源码的校验。可选编译仅运行受控 javac，关闭 annotation processing，不运行归档的构建脚本、测试或插件。用相应 JDK 和明确的依赖 classpath 重编译；缺失依赖会真实失败并保留 compile.log。需要 Maven／Actions 时使用受控工作流并核对记录的配置、提交和依赖，不直接执行不可信构建脚本。重放发现差异或缺失时返回非零状态。

## 公开反馈配置

1. 应用 D1 迁移；配置服务端 `GITHUB_FEEDBACK_TOKEN`，授予产品仓库 `superwfox/minecraft-dev` 的 Contents write 与 Issues write。兼容已有 `GITHUB_PR_TOKEN`，但必须具备相应权限。凭据不进入浏览器或工程档案。
2. 在 Cloudflare Pages 的分支构建设置中，生产分支沿用现有配置，preview 排除 `feedback-data`。数据分支从无父提交的空树创建，仅保存反馈资料，不继承产品源码或 `.github/workflows`。
3. 检查产品 Actions 不对数据分支执行部署或其他写操作；现有 workflow 仅 schedule／workflow_dispatch。完成分支限制后才设置 `FEEDBACK_DATA_BRANCH_READY=true`。未设置时发布接口返回 503，不会尝试写仓库。

最终失败自动展开一次反馈；查看旧失败工程不自动弹出。成功后可从 Debug 旁手动打开“实现与预期不符”，可选具体路径和节点，自动附上绑定文件信息。失败反馈自动带入错误摘要，不要求输入文字。

表单复用聊天 MarkdownComposer，单个输入框支持 Markdown、换行、图片粘贴／拖入及删除，不设独立图片区域。最多 5 张 PNG／JPEG／WebP，原文件每张 5 MiB；浏览器重新编码去掉元数据。相关路径与节点共用 ThemedSelect，自定义黑金菜单、选中勾、内部滚动及键盘操作，不使用系统原生选项弹层。两个菜单各自从 1 开始编号（含默认项），收起后的选中值也显示序号；金色细描边圆圈内的数字使用现有钉钉进步体，选项文字字体不变。编号仅用于显示，不写入路径、节点或反馈定位数据。

点击发布先整理资料并打开原生 modal dialog，展示即将公开的正文、图片、两份 ZIP 的概况、仓库与长期公开范围，诊断缺失如实提示。只有点击“确认公开并发布”才发送发布请求；返回修改不提交。Issue 的 @ 用户由已认证会话的 GitHub login 确定，不接受浏览器提供的账号覆盖；用于跟进回复与修复，通知仍遵循 GitHub 设置。

确认公开后固定此次资料，重试复用相同内容和 submissionId。附件 blob、commit 与 Issue 地址持久保存；上传成功但 Issue 失败会复用原 commit。网络中断导致创建结果不明确时先查找标记，找不到也不会盲目再次创建；保持“待对账”，需稍后查询。已完成后可填写新的反馈。旧版已冻结的待发布资料沿用原协议及附件提交，不重新包装为另一份公开资料；可编辑旧草稿的四字段合并为 Markdown，保留截图。

Issue 和链接资料均公开，链接绑定不可变 commit；删除 Issue 不保证删除 Git 历史。接口含身份、内容大小、限流、路径及服务端脱敏检查。单次结构化请求总量约 30 MiB，超限时保留草稿并提示减少图片，不要求用户选择源码文件。浏览器仍发送结构化记录与文件，服务端再次脱敏后生成两份 ZIP，防止不透明 ZIP 绕过脱敏；固定文件顺序与日期使相同资料打包一致。ZIP 与图片写入 Git blob，再通过 Git Trees 关联至不可变提交；Issue 提供两个 ZIP 下载及图片，避免长文件列表。旧协议仅用于兼容已有冻结提交。

本次反馈重做的针对性验证 4 个文件、20 项通过，包括：公开确认前无发布请求、空失败表单、路径与节点绑定、旧草稿迁移、ZIP 解包与资源保留、服务器凭据脱敏、登录用户 @、新版与旧版的响应丢失重试及源码下载端点。TypeScript、Vite 构建与 Functions 打包通过。用户已确认图片及 Markdown 操作和公开弹窗返回正常；已完成自定义下拉框基础视觉与键盘检查。新版 ZIP 的 GitHub 发布使用受控响应检查，未重新创建公开 Issue；此前真实 Issue #10 使用旧散文件协议，不能替代新版打包的真实发布验证。

## ResolveJAR 配置与边界

执行仓库固定为现有 `superwfox/minecraft-dev-workflow`。沿用服务端 `GITHUB_PAT`：需要读取仓库／Actions、写入临时输入分支及调度工作流。每次上传前真实查询仓库可见性；公开时必须在导入框明确确认。查询失败不上传；这与反馈公开确认独立。

以下文件已安装到执行仓库 `main`，提交 [74d91cc](https://github.com/superwfox/minecraft-dev-workflow/commit/74d91cca9c219a33dea242b05c76d73bbd1fef74)。后续修改脚本或模板时仍需同步安装：

- `ref/workflows/resolve-jar.yml` → `.github/workflows/resolve-jar.yml`
- `scripts/resolve-jar.py` → `scripts/resolve-jar.py`

工作流只由 workflow_dispatch 启动。读取输入的步骤与处理不可信内容的步骤分开，checkout 不保留凭据；反编译和基线编译不持有写权限，不运行插件、加载主类或执行包内脚本。Actions 输出 resolved-project.json，保留 7 天。临时输入分支包含原始 JAR；公开仓库会公开它，原始 JAR 也缓存在本地。

反编译器固定为 Vineflower 1.12.0，下载来自 Maven Central，SHA-256：

```text
1dfcfe974395734fa467ce620661c7623d05ba83670de0529b1fbd63ff548b9d
```

限制：原始 JAR 20 MiB、展开总量 100 MiB、2,000 条目；可编辑工程 12 MiB。浏览器和服务端先检查 ZIP 中央目录，Actions 再验证实际解压结果；拒绝路径穿越、危险重复路径、加密、符号链接、ZIP64 等不支持格式。超过编辑容量时保留原 JAR 和阻塞原因。

解析描述文件、Manifest／class 版本、资源及 Maven 元数据，以主类所在包区分候选插件代码；主包外的类记录为归属／依赖待确认，不能假装已解决。普通 Java Paper／Spigot 为首版范围；混淆、其他 JVM 语言及特殊 loader 不承诺自动还原。原签名在重新打包后失效，移除的签名记入报告。

用受控 Maven 模板尝试基线编译，关闭 annotation processing。失败仍返回源码和诊断，展示树及阻塞项；缺失类明确列出。模型分析实际源码，保留 sourcePath／sourceClass，不按 Prompt 重新生成整个工程。确认结构后沿用增量流程；JAR 还原报告随源码 ZIP 下载。

`plugin.yml` 契约及生成规则读取实际主类绑定，不强制改名为 Main。构树和路径审查包含保留资源证据；二进制按清单证明存在，完整内容参与源码指纹。文本资源被结构树纳入修改时转入可编辑文件，构建与检查采用相同的最终文件集合。导入报告记录原始输入 commit、SHA-256、Actions run、workflow head SHA 和结果 artifact，便于追踪具体还原过程；导入期间原任务开始其他工作时拒绝覆盖。

调度有稳定 submissionId 与 D1 租约。上传／调度中断后先对账已有 run，不盲目重复调度。服务端任务过期时可将同一拥有者的解析结果接到重建任务；远程制品过期且本地未取得结果时需要重新导入，不伪装为已缓存。

## 实施验证记录

以下记录区分真实调用和受控模拟。产品仓库尚未推送或部署；执行仓库已安装工作流，并公开上传了自建测试 JAR：

- 真实 DeepSeek + 隔离 Pages／D1／KV：两轮分别调用 15 次；完成需求确认、构树、4 文件生成／审查、路径检查和过期恢复。第二轮两条路径静态通过，跨拥有者恢复返回 403，4 文件保留且编译证明清空；未绑定 GitHub 写凭据。
- 真实调用暴露零参数 public 构造器摘要丢失、SSE 结束与取消竞态；已修复。使用第二轮真实公开输出重放 15 个请求，请求匹配，85 条执行事件、4 轮确定性构树重放一致，journal 无缺口。重放没有再次请求模型。
- 真实生成的 Java 使用 JDK 25、release 21、实际 Paper 1.21.4 与其 Adventure 依赖通过 javac；归档重放 CLI 也重新导出 4 文件、核对 2 份 Java 契约并真实编译通过。这不是远端 Actions 编译证明，不会据此将产品中的路径标为实线。
- 实际 Paper 插件 JAR 经固定 Vineflower 反编译并在本地受控 Maven 环境通过基线编译，配置和二进制资源保留。首次冷缓存请求曾超时，缓存后的重跑成功；超时没有误记为成功。
- 缺失第三方依赖的真实 JAR 反编译成功，真实 Maven 编译失败，源码及阻塞报告保留。
- 真实远端 ResolveJAR：普通测试 JAR 的 [导入 run 40255088901](https://github.com/superwfox/minecraft-dev-workflow/actions/runs/40255088901) 基线通过；从实际源码推导结构树后，[首次构建 40255178062](https://github.com/superwfox/minecraft-dev-workflow/actions/runs/40255178062) 成功；追加需求后由模型修改并静态审查，[构建 40255656295](https://github.com/superwfox/minecraft-dev-workflow/actions/runs/40255656295) 成功。下载结果 JAR，确认实际主类名保留，config.yml 与 icon.png 的字节与原始 JAR 一致。
- 真实远端缺失依赖场景：[导入 run 40256113302](https://github.com/superwfox/minecraft-dev-workflow/actions/runs/40256113302) 基线失败仍返回源码与阻塞项；在结构树提交移除不可用依赖的需求，经模型修改后，[构建 40256232518](https://github.com/superwfox/minecraft-dev-workflow/actions/runs/40256232518) 成功。未运行插件或模拟游戏。
- 原生浏览器 IndexedDB 验证：使用上述真实 Actions 下载的 2,217 字节构建 ZIP，在隔离页面调用实际下载函数；首次写入 Blob，随后拦截下载端点模拟远端不可用，再次下载成功且总网络请求仍为一次。HTTP 响应由本地测试页提供，IndexedDB 及下载函数未模拟。
- SQLite／端点回归覆盖 journal 分块、拥有者隔离、签名篡改、租约隔离、Issue 重试对账、公开上传确认、JAR 调度重试、并行任务防覆盖及失败基线接入恢复任务。这些回归的 GitHub 操作使用受控响应；真实 Actions 和真实反馈发布验证分别另列。
- Web 基础检查覆盖历史展开／搜索／窄按钮、反馈表单和长文字；不增加移动端适配。此前首轮真实失败链的旧 journal 已记录不完整，不将其改写为完整记录。
- 修正日志下载后，使用缺失依赖场景的真实 [导入 40256769033](https://github.com/superwfox/minecraft-dev-workflow/actions/runs/40256769033) 和 [编译 40256883263](https://github.com/superwfox/minecraft-dev-workflow/actions/runs/40256883263) 验证。终态日志检查将隔离库中的同一真实构建恢复为等待完成，再由实际状态接口重新核对 run／SHA 并获取日志，没有重新调用模型或触发 workflow；会话暂停后只延长隔离测试行的 TTL，此检查不作为生产过期恢复证明。两份实际 job 日志及完成清单均在终态返回前落盘，归档 104 条事件、13 次模型调用、无缺口；CLI 重放 5 轮构树工具、导出 3 文件、核对契约并通过真实 javac。早期记录中的日志缺口仍保留；这不是对普通生成自动修复 handler 全链路的重放证明。
- 普通生成自动修复的真实录制：使用此前模型生成的自建 OriginalPlugin，在隔离任务的编译边界注入一处 String 赋给 int 的类型错误；初始路径明确标为未验证，没有伪造静态通过。真实 [失败构建 40277943458](https://github.com/superwfox/minecraft-dev-workflow/actions/runs/40277943458) 后，直接运行生产前端 resumeGenerate／buildWithRetry 和后端 diagnose／repair，DS 修复 1 文件、重新审查两条路径，再由真实 [构建 40278031349](https://github.com/superwfox/minecraft-dev-workflow/actions/runs/40278031349) 编译成功。3 次模型调用、60 条 journal 事件、无缺口，失败与成功提交分别记录；这是受控故障注入，不是自然生成错误或浏览器 UI 全流程验收。
- 自动修复离线重放：隔离运行同一前后端处理器，只返回上述真实记录的公开模型输出和工具响应，没有访问 DeepSeek／GitHub。3 次模型请求和 43 次工具请求参数一致，修复后源码、路径审查、编译指纹／run／SHA 与真实运行一致；重放 CLI 另行导出 4 文件、检查两份 Java 契约并通过真实 javac（JDK 25，release 21，实际 Paper 1.21.4 依赖）。早期宿主脚本未正确记录空请求体或 204 响应的记录保留，最终验收使用修正后重新录制的完整场景。
- 最终完整测试 71 个文件、524 项通过；TypeScript、Vite 生产构建、Pages Functions 打包通过。沿用当前依赖，本轮没有新增 npm 生产依赖或调整现有产品界面样式。

2026-10-26 已经用户完成 Wrangler OAuth 授权，通过 Cloudflare API 修改并回读确认产品仓库关联的 `minecraft-dev-platform`、`minecraft-dev`：preview 使用 custom 规则，包含 `*`，排除 `feedback-data`；生产分支仍为 `master`。公开自建测试资料的范围已经授权。旧 Token 曾被真实附件写入返回 403；用户配置专用 `GITHUB_FEEDBACK_TOKEN` 后，实际反馈 handler 使用隔离已认证上下文与原生 D1，真实发布 12 个附件到 [b6175f2](https://github.com/superwfox/minecraft-dev/commit/b6175f2b940a40f4d2a9b94a7acdc8ae23c9927f)，创建并关闭 [测试 Issue #10](https://github.com/superwfox/minecraft-dev/issues/10)。故意丢弃真实创建成功的响应后，首次立即重试保持待对账，随后重试找回同一 Issue；重复提交不新增 Issue，附件 commit 复用，12 份资料回读字节一致。此项没有绕过真实 GitHub 写入，但不等于生产浏览器登录全链路已验收。

GitHub 侧核对数据分支 Actions 为 0，该提交没有 commit status、check run 或 GitHub deployment。发布后 Pages 管理 API 的部署列表二次回读因本机 OAuth 续期失败尚未完成，不将其标为通过；此前已确认的分支排除配置及具体边界见 [feedback-live-validation.md](feedback-live-validation.md)。

2026-10-26 推送前完整回归更新为 72 个文件、532 项通过；TypeScript、Vite 与 Functions 打包通过。用户已在产品绑定的 D1 执行 0006 迁移，Console 返回成功。当前工作区全部变更已获授权统一提交推送；生产环境凭据和 `FEEDBACK_DATA_BRANCH_READY=true` 仍需在实际 Pages 环境核对，不能由本地配置推定线上已经生效。

反馈数据分支公开测试和执行仓库安装属于另行授权的外部操作。本地隔离函数调用真实 Actions，不等于生产浏览器全流程已验收。
