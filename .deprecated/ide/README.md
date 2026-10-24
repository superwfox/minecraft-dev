# IDE 与追加需求功能归档

2026-10-23 停用。此目录只保留历史实现，不参与当前应用打包、类型检查或 Pages Functions 部署。

- `src/ide/`：浏览器 IDE、AI 编辑助手、IndexedDB 存储与 JAR 符号补全。
- `src/blueprint/`：IDE 内的可视化蓝图编辑器，不影响生成流程的 `MainBlueprint` 规划契约。
- `src/logic/generateHandler.ts`：原文件构建、追加需求及重建逻辑片段。
- `functions/api/maven/jar.ts`：原 IDE 专用 Maven 代理。
- `functions/api/generate/build.ts`、`functions/api/stream.ts`：移除本地文件上传、过期任务重建和追加需求支持前的接口快照。
- `append-feature.md`：原“继续完善”面板、事件和样式片段。
- `docs/features/`：原 IDE 与蓝图说明。

路径按原工程目录保留；其中的共享模块引用仍指向历史路径，不能直接作为独立应用运行。恢复功能时需重新对齐当前任务、授权、计费与构建协议。

主工程移除的专用依赖：`idb ^8.0.3`、`java-parser ^3.0.1`、`monaco-editor ^0.55.1`、`vite-plugin-monaco-editor ^1.1.0`。`jszip` 仍被技能上传使用，因此保留。

旧 `/ide/:taskId?` 地址跳转 `/chat`；旧追加需求或本地文件覆盖构建请求返回 `410 FEATURE_DEPRECATED`。历史浏览器存档不会被本次迁移自动删除。
