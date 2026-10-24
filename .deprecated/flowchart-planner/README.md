# 旧分级、流程图与 Planner 归档

2026-10-24 由结构树业务协议替代。归档保留历史工程相对路径，不参与类型检查、应用打包或 Pages Functions 部署。

替代流程为：任务创建 → 需求确认 → 行为路径规划、自然语言修正与锁定 → 按文件依赖生成 → 契约与路径静态审查 → 编译修复 → JAR 和源码下载。

- `functions/api/generate/plan.ts`、`grade.ts`、`file.ts`：原端点；当前对应路径仅保留 410 FEATURE_DEPRECATED 桩。
- `functions/_lib/complexity.ts`、`learning/plannerAuthorization.ts`：旧复杂度与 Planner 授权。
- `src/components/`：旧路径卡、分组树与文件列表等；当前树在正式页面按行为路径展示，并原位展开。
- 根目录 `.tree-*.vue`：早期独立预览组件，正式预览现在复用 src/components 内组件。
- `tests/`：随旧协议下线的用例；其余关联用例已迁移到现有阶段和工具协议。
- `docs/`：更新前的工作流、架构、API 及演示资料。
- `*.removed.ts`、`*.removed.vue.txt`：从持续维护文件中移除的原始片段，包含本次重构前已有归档。

旧实现中的共享引用对应历史结构，不能直接恢复运行。需要恢复时，先对齐当前接口、任务状态、授权、计费、Skill、Learning 与构建协议，再迁回原位置并按协作约定验证。
