# 本轮 Plan 的完成情况与检查链接

## 完成情况

三大功能的代码已经实现；生命周期实现阶段本地完整测试 71 个文件、524 项通过，类型检查、前端构建及 Functions 打包通过。真实 DeepSeek、Actions 编译、ResolveJAR 和旧版 GitHub 反馈发布已分别验证。后续反馈表单与双 ZIP 形式已重做并通过针对性回归、类型检查和构建；新版 ZIP 尚未再次公开发布 Issue。

2026-10-26 推送前完整回归更新为 72 个文件、532 项通过，类型检查、前后端构建通过；用户已在产品 DB 执行 0006 迁移并收到成功结果。当前工作区全部变更已获授权统一提交推送。

不能称为 Plan 全部验收完成：完整生产浏览器登录流程和最新生产配置尚未验收。历史的边界检查包含端点测试和受控存储测试，未逐项完成真实浏览器中的刷新、跨账号、容量不足、旧数据迁移和未完成请求对账的组合验收。Pages 数据分支排除已实际写入并回读；反馈提交后的 Pages 部署列表二次回读因 OAuth 续期失败未完成。

## 可以直接操作的本地页面

以下页面由 `npx vite --host 127.0.0.1 --port 5178 --strictPort` 提供，只在运行服务的电脑上可直接访问。手机 RC 的普通浏览器打开 127.0.0.1 不会连接该电脑；可在连接电脑的应用内浏览器查看。

| 功能 | 检查入口 | 如何看 |
| --- | --- | --- |
| 历史搜索、复制、恢复、删除与按钮动画 | [历史菜单](http://127.0.0.1:5178/.wrangler/lifecycle-validation/preview.html) | 点击时钟，悬停记录；使用两个同 Prompt 的示例任务，检查三个操作和关键词搜索。刷新会重建这两条示例，不能用它证明完整刷新恢复验收通过。 |
| 游戏实测反馈、路径与节点定位 | [编译成功表单](http://127.0.0.1:5178/.wrangler/lifecycle-validation/feedback-preview.html?status=success) | 可选相关路径和节点，在同一个 Markdown 输入框描述差异并粘贴／拖入图片；发布先显示公开范围弹窗，返回可修改。默认附两份 ZIP，无逐文件勾选。 |
| 失败反馈、空表单与公开确认 | [编译失败表单](http://127.0.0.1:5178/.wrangler/lifecycle-validation/feedback-preview.html?status=failure) | 无需重填错误，空内容也能进入公开确认。此页阻止真实提交；示例缺少 journal，会如实标记不完整。用户已检查图片／Markdown／弹窗返回三项正常。 |
| 下载后存 IndexedDB、远端不可用后下载 | [产物缓存](http://127.0.0.1:5178/.wrangler/lifecycle-validation/artifact-preview.html) | 依次点击首次下载、关闭远端后再次下载；显示 Blob 大小及请求次数。ZIP 来自真实 Actions，HTTP 由本地页拦截提供。 |
| ResolveJAR 的小加号及拖拽入口 | [导入入口](http://127.0.0.1:5178/.wrangler/lifecycle-validation/preview.html) · [自建测试 JAR](http://127.0.0.1:5178/.wrangler/lifecycle-validation/fixture/input.jar) | 在输入区点击 `+` 或拖入该 JAR；此页的仓库可见性使用演示数据，不能真实解析，真实运行见下表。 |

上述隔离页面不发起真实 Issue 发布。反馈组件已按确认范围更新；其他页面、结构树及主题保持现有设计。

## 真实调用与可检查的报告

| 功能 | 记录 | 已验证的范围 |
| --- | --- | --- |
| 过期任务从本地工程重建 | [实际端点报告](../.wrangler/lifecycle-validation/real-route-report.json) · [恢复端点测试](../tests/project/lifecycle.test.ts) | 4 文件保留，编译证据清空，跨拥有者返回 403；真实模型使用隔离 Pages／D1／KV，不等于生产页面完整恢复。 |
| 追加需求、增量修改、重新编译 | [修改前构建](https://github.com/superwfox/minecraft-dev-workflow/actions/runs/40255178062) → [修改后构建](https://github.com/superwfox/minecraft-dev-workflow/actions/runs/40255656295) · [具体文件与资源核对](../.wrangler/lifecycle-validation/real-jar/report.json) | 从导入工程追加问候和禁用逻辑，实际模型修改、路径审查及整工程编译通过；Main 类名、配置和图片资源保留。 |
| 普通生成的失败、模型修复与重新编译 | [失败构建](https://github.com/superwfox/minecraft-dev-workflow/actions/runs/40277943458) → [修复后成功构建](https://github.com/superwfox/minecraft-dev-workflow/actions/runs/40278031349) | 在自建工程编译边界注入一处类型错误，生产前端编排调用实际 DS 修复和路径审查，再实际编译通过；不是自然生成错误。 |
| 完整执行记录与离线重放 | [成功链重放报告](../.wrangler/lifecycle-validation/playback-success/real-route-report.json) · [失败修复链重放报告](../.wrangler/lifecycle-validation/playback-auto-repair/report.json) · [重放源码及 javac 报告](../.wrangler/lifecycle-validation/real-auto-repair-final/replay-output/report.json) | 使用已记录的模型输出和工具响应；失败修复链 3 次模型请求、43 次工具请求一致，源码和编译证据匹配。重放没有再实时调用模型。 |
| 公开反馈、源码日志和图片、部分成功重试 | [真实 Issue #10](https://github.com/superwfox/minecraft-dev/issues/10) · [不可变资料目录](https://github.com/superwfox/minecraft-dev/tree/b6175f2b940a40f4d2a9b94a7acdc8ae23c9927f/feedback-live-6560ca84-489f-4ea4-a955-1b8d35e9e74b) · [实际请求报告](../.wrangler/lifecycle-validation/real-feedback/report.json) | 旧版 12 个散文件附件回读字节一致；创建成功后故意丢失响应，重试找回同一 Issue，只有一次创建，测试 Issue 已关闭。新版双 ZIP 的打包及重试已通过受控端点回归，尚未重新真实发布。 |
| 普通 Paper JAR 反编译及基线编译 | [ResolveJAR 真实运行](https://github.com/superwfox/minecraft-dev-workflow/actions/runs/40255088901) · [已安装工作流](https://github.com/superwfox/minecraft-dev-workflow/commit/74d91cca9c219a33dea242b05c76d73bbd1fef74) | 固定 Vineflower、提取源码／资源、实际基线编译并接入结构树；不运行插件。 |
| JAR 缺失依赖、保留工程、修改后构建 | [带阻塞项的导入](https://github.com/superwfox/minecraft-dev-workflow/actions/runs/40256113302) → [修改后成功构建](https://github.com/superwfox/minecraft-dev-workflow/actions/runs/40256232518) | 基线编译失败仍可取得源码；提交移除缺失依赖的需求后，经实际模型修改和编译成功。 |
| 数据分支不会触发产品部署 | [Pages 配置回读记录](../.wrangler/lifecycle-validation/cloudflare-feedback-branch.json) · [GitHub 发布后检查](../.wrangler/lifecycle-validation/feedback-postflight.json) | 两个项目均排除 feedback-data，生产分支 master；GitHub 侧没有 Actions、提交检查或部署。Pages 管理 API 的发布后列表复核尚未完成。 |

详细说明：[工程生命周期](project-lifecycle.md)；反馈发布边界：[反馈验证记录](feedback-live-validation.md)。本地与真实调用证据不替代部署后的生产验收。
