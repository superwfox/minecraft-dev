# 项目参考资料

参考资料统一存放在 `ref/`；`reference/`、`参考/` 等称呼按目录别名理解，不再新建同用途目录。此目录不参与应用运行或构建。

- [refer.html](refer.html)：窗棂卡片、按钮与层级的独立设计样稿，保留设计存档时的样式。

## 工具调用动画参考

- `stamp-card-vue.zip`：用户提供的原始 Vue 动画参考包，保留用于后续对照；不参与项目运行或构建。
- 动作参考：展开、持续加载、结果反馈、卡片翻转、缩小收拢、摘要与恢复。
- 卡面参考：项目 `src/pages/SkillsPage.vue` 中的 `sk-dots` 圆点邮票边框，使用现有麦色与黑色主题。

项目实现位于 `src/components/ToolActivityStamp.vue`（正反卡面）、`ToolActivityIsland.vue`（动画）及 `ProjectTreeStatusCard.vue`（状态卡入口）。使用现有 Vue 与浏览器 Web Animations API，无新增依赖。

与参考包的固定时间成功演示不同，实际调用必须收到真实完成、失败或取消结果后才收拢；长调用持续加载，动画不阻塞请求。频繁状态刷新合并提示；开始编译仅表示构建请求已确认。

连续调用按开始顺序展示。前一项完成反馈后保留展开状态，先淡出旧卡面与结果提示，再淡入下一项，仅最后一项执行翻转与收拢；后续调用若已结束，直接展示实际结果。预览中的“完成／失败／取消”每次只提交一项结果。

本地预览：`http://127.0.0.1:5178/.tree-preview.html?tool-preview=1`。模拟入口不执行模型、Learning 或远端构建请求。

结构预览与正式页面共用 `ProjectTree.vue`、`ProjectTreePathNode.vue`、`ProjectTreePathSparks.vue` 和 `ProjectTreeEdgePortal.vue`。`?business-preview=1` 用示例数据展示正式进度页组合；预览快照使用独立键，不覆盖正式任务。真实路径验证采用模型静态审查与对应代码编译，游戏内行为由用户实测。
