# 系统架构

应用由 Vue 3 前端、Cloudflare Pages Functions、D1/KV、模型服务和独立 GitHub Actions 构建仓组成。Pages 编排请求与状态，Java 编译在构建仓执行，游戏内实测交给用户。

## 前端

- `ChatPage.vue`：需求输入、核心与版本选择、需求澄清、任务重置。
- `GenerateProgress.vue`：正式生成页面，承载结构树、查证记录、流式输出、构建、下载、中断与错误信息。
- `ProjectTree.vue`：Main 与并列的纵向行为路径；步骤使用 `ProjectTreePathNode.vue`，绑定实现文件并原位展开 `ProjectTreeNodeDetails.vue`。
- `TreeGate.vue`：底部自然语言修正与确认锁定，不需要手动勾选范围。
- `ProjectTreeStatusCard.vue`、`ToolActivityIsland.vue`、`ToolActivityStamp.vue`：真实工具活动驱动的状态卡与邮票动画。
- `generateState.ts`：模块级 reactive/ref 状态与快照；`generateHandler.ts`：分阶段请求、Learning 续接、桶推进、恢复、审查与构建修复。

前端快照不包含源码正文。刷新后进入中断态，由用户手动继续；源码通过 source 单文件接口懒加载。独立结构预览使用独立快照键，不覆盖正式任务。

## 服务端接口

| 接口 | 职责 |
| --- | --- |
| POST generate/task | 创建任务，加载所选 Skill 上下文 |
| POST generate/clarify | 多轮需求确认，SSE 回传思考与问题 |
| POST generate/tree | build/refine/continue 单轮规划，confirm 核对修订并锁定 |
| GET generate/tree | 恢复结构、会话、检查结论、文件计划和桶位置 |
| POST generate/bucket | 按持久化阶段生成、审查、返工、补缺及路径静态审查 |
| POST generate/verify | 按树校验文件完整性，安排修补桶或路径审查桶 |
| POST generate/build | 上传已保存文件，调度 GitHub Actions 编译 |
| GET generate/status | 读取真实构建结果，返回路径检查状态 |
| POST generate/fix | 读取编译诊断，按现有授权与 Learning 流程修复 |
| GET generate/source | 当前任务的单文件或完整源码数据 |
| GET generate/download | 构建产物下载，保留任务至过期 |

旧 plan、grade、file 接口返回 410 FEATURE_DEPRECATED，原始实现归档在 `.deprecated/flowchart-planner/`。IDE 与追加需求历史代码保存在 `.deprecated/ide/`。

## 同一份结构数据

`ProjectTree` 同时保存两种关联：

- `modules`、`nodes`：Java 子包与实现文件，节点含稳定 id、职责、依赖、成员契约、GUI 配对及来源。
- `paths`：需求行为路径。每条路径包含有序步骤，步骤通过 fileIds 绑定一个或多个文件。跨路径复用不产生重复文件。

稳定映射为：步骤 fileIds → 文件 nodeId → nodePath → 文件计划与 generatedFiles.path → nodeChecks → 前端 GenFile。文件合并与删除同步维护步骤引用。

Main、plugin.yml 和 pom.xml 属于系统节点。结构锁定时确定性派生项目元信息、Main 装配蓝图和依赖分桶，Main 单独放在最后一个生成桶。锁定后只允许受限的审查追加。

## 文件契约与路径验证

`projectTreeContract.ts` 为生成、审查和编译修复提供模块、职责、路径步骤、成员及依赖契约；确定性检查发现契约不满足时进入有限返工。动态补缺追加树节点、依赖和文件计划，并通过 tree_patch 更新页面。

`projectPathReview.ts` 在文件齐全后沿每条需求路径读取关联完整源码，模型检查注册、触发、调用、分支、状态和结果，返回逐步骤证据或问题。契约核对不会替代这项审查。

路径报告与源文件内容、路径绑定和锁定修订的 SHA-256 指纹关联。`build.ts` 把编译绑定到相同指纹及 Git 提交；`status.ts` 仅在真实工作流成功并取得产物后确认编译结果。

只有同一版本的路径静态审查与编译均通过，前端才播放方块粒子并把连线改成实线。编译修复使旧结论失效，重新构建前再次审查；静态失败会保留，编译成功不覆盖它。该验证不包含 Minecraft 服务端或模拟玩家操作。

## 状态、Learning 与费用

生成任务与成本使用 D1，KV TASKS 继续用于用户、额度及缓存等。状态整体保存，不按节点逐条写库。树请求使用请求 ID、输入哈希、执行租约、取消处理、结果重放与原子计费；确认锁定不调用模型。

Skill 在任务与结构规划中装载。适用的结构规划、Generator、Reviewer、Reworker、路径审查与 Fixer 可以调用 learn_public_api；前端推进 start/step/status，验证结果接回模型原始工具对话。学习结果继续受任务栅栏、授权、时限、取消和配额约束。

## Pages 与下载约束

- 树规划每请求一轮模型调用，后续轮次由前端推进。
- 生成与审查每请求每个目标最多一次模型调用，保留非流式模型响应解析；阶段进度落库后再继续。
- Java 编译与 JAR 打包使用现有独立 GitHub Actions 仓，不在 Pages 启动 JVM。
- 源码 ZIP 使用浏览器已有 JSZip 生成，包含 Maven 目录、代码、资源和记录路径、绑定、契约及结论的 PROJECT_TREE.md。
- source 接口检查任务归属，仅文件齐全时提供整包；源码的 plugin.yml 与构建使用相同水印处理。
- 不引入 R2、Durable Objects 或新的生产依赖。参考资料存放在 `ref/`。
