# 项目参考资料

参考资料统一存放在 `ref/`；`reference/`、`参考/` 等称呼按目录别名理解，不再新建同用途目录。此目录不参与应用运行或构建。

- [refer.html](refer.html)：窗棂卡片、按钮与层级的独立设计样稿，保留设计存档时的样式。
- [首页山谷参考与 Prompt](home-valley-prompts.md)：ImageGen 完整构图、独立透明景层与网页素材说明；对应 `/home` 的滚轮视差实现。
- [首页矩形构图参考](home-block-layout-reference.png)：用户提供的黑底浅黄色错落块面草图，用于下方文档和 QQ 群板块；首屏继续使用山谷。

## 工具调用动画参考

- `stamp-card-vue.zip`：用户提供的原始 Vue 动画参考包，保留用于后续对照；不参与项目运行或构建。
- 动作参考：展开、持续加载、结果反馈、卡片翻转、缩小收拢、摘要与恢复。
- 卡面参考：项目 `src/pages/SkillsPage.vue` 中的 `sk-dots` 圆点邮票边框，使用现有麦色与黑色主题。

项目实现位于 `src/components/ToolActivityStamp.vue`（正反卡面）、`ToolActivityIsland.vue`（动画）及 `ProjectTreeStatusCard.vue`（状态卡入口）。使用现有 Vue 与浏览器 Web Animations API，无新增依赖。

与参考包的固定时间成功演示不同，实际调用必须收到真实完成、失败或取消结果后才收拢；长调用持续加载，动画不阻塞请求。频繁状态刷新合并提示；开始编译仅表示构建请求已确认。

连续调用按开始顺序展示。前一项完成反馈后保留展开状态，先淡出旧卡面与结果提示，再淡入下一项，仅最后一项执行翻转与收拢；后续调用若已结束，直接展示实际结果。预览中的“完成／失败／取消”每次只提交一项结果。

本地预览：`http://127.0.0.1:5178/.tree-preview.html?tool-preview=1`。模拟入口不执行模型、Learning 或远端构建请求。

结构预览与正式页面共用 `ProjectTree.vue`、`ProjectTreePathNode.vue`、`ProjectTreePathSparks.vue` 和 `ProjectTreeEdgePortal.vue`。`?business-preview=1` 用示例数据展示正式进度页组合；预览快照使用独立键，不覆盖正式任务。真实路径验证采用模型静态审查与对应代码编译，游戏内行为由用户实测。

`?business-preview=1&planning-error-preview=1` 使用系统文件空树及较长的字段错误展示规划失败、禁用确认和自然语言修正入口，不会调用模型。

## 真实业务链路验证

- [本轮功能检查链接与完成情况](project-lifecycle-checks.md)：逐项列出本地界面预览、真实 Actions／Issue、重放报告及尚未完成的验收范围。
- [本地工程、公开反馈与 ResolveJAR](project-lifecycle.md)：IndexedDB、过期恢复、增量修改、执行 journal、反馈公开边界、执行工作流安装及真实／模拟验证范围。
- [公开反馈联调预览](feedback-live-validation.md)：拟公开的自建测试资料、Issue 内容、丢失响应后的重试方式与 Pages 分支配置前提。

- [结构规划与 DeepSeek 真实调用记录](project-tree-real-validation.md)：旧版故障复现、修复版规划和源码生成结果、逐路径静态审查结论；明确区分真实模型调用、模拟预览和未执行的 Java 编译。
- [DeepSeek Prompt 清单](deepseek-prompts.md)：仅列 Prompt 文件行号、所处阶段、调用代码位置和期望输出要求，包含专项生成规则、Skill／Learning 上下文及遗留接口的使用状态。
- [DeepSeek Search / Fetch 迁移与验证](deepseek-search-fetch.md)：新接口的调用边界、兼容开关、按次费用，以及真实接口、Learning 核验与缓存续接记录。

## 头像风格偏好

- [用户头像风格偏好](avatar-style-preferences.md)：用户已确认喜欢的白毛狮子头像及其角色、超大色块眼睛、像素颗粒和构图偏好。
- [已确认头像样本](white-lion-avatar-large-eyes-v9.png)：后续同类头像的优先视觉参考。
