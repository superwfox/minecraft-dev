# 历史与停用功能

以下功能已停用，代码和原始说明保存在仓库的 `.deprecated/` 目录，不参与应用构建。完整变更记录见仓库根目录的 [CHANGELOG.md](https://github.com/superwfox/minecraft-dev/blob/master/CHANGELOG.md)。

| 功能 | 停用时间 | 现状 | 归档位置 |
| --- | --- | --- | --- |
| 浏览器 IDE 与在线编辑 | 2026-10-23 | 旧 `/ide` 地址跳转到对话页；源码可下载 ZIP 查看 | `.deprecated/ide/` |
| 可视化蓝图编辑器 | 2026-10-23 | 生成流程中的 Main 装配蓝图不受影响 | `.deprecated/ide/` |
| Maven 补全接口 | 2026-10-23 | 已移除 | `.deprecated/ide/` |
| 需求分级、流程图与 Planner | 2026-10-24 | 由结构树与行为路径取代；`plan`、`grade`、`file` 接口返回 `410 FEATURE_DEPRECATED` | `.deprecated/flowchart-planner/` |
| 路径选择门 | 2026-10-24 | 由结构树上的多条并列路径取代 | `.deprecated/flowchart-planner/` |
| Responses `web_search` 学习 | 2026-10-25 | 改用 DeepSeek Search/Fetch，沿用 `DEEPSEEK_RESPONSES_WEB_SEARCH` 开关名 | 已删除 |
| 语音输入 | — | 已停用 | `.deprecated/voice-input/` |

2026-10-23 停用的“追加需求并重建”已在 2026-10-26 以新的增量修改流程恢复，见[工程历史](/features/project-history#追加修改)。
