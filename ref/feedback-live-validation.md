# 公开反馈联调预览

目标仓库：`superwfox/minecraft-dev`。这次仅使用开发者自建测试插件及其测试调用记录，不包含用户历史工程、真实账号资料或凭据。

拟创建的 Issue 首行：`[用户反馈] [联调测试] 公开反馈附件与重试去重验证`。

拟公开的描述：这是功能联调记录，并非用户故障。验证源码、资源、图片和脱敏诊断能以不可变提交链接展示；模拟一次 GitHub 已创建 Issue 但本地未收到响应的连接中断，然后用相同 submission ID 重试，确认不重复创建。验证结束后关闭此测试 Issue，资料仍按既定公开规则保留。

资料写入 `feedback-data/<submission-id>/`，包括：

- `manifest.json`：测试来源、执行记录完整性及资料清单。
- `project.json`：自建插件的核心、目标版本及代码版本。
- `events.json`、`validation-report.json`：这次隔离测试的脱敏执行记录及结果。
- `source/`：自建 OriginalPlugin 的源码、受控 POM 和文本资源。
- `resources.json`：自建插件的二进制资源。
- `images/validation.png`：自行生成的简单测试图片。
- `REPRODUCE.md`：测试目的与复现方式。

发布前必须确认 Cloudflare Pages 的 preview 构建已排除 `feedback-data`；产品 Actions 当前仅 schedule／workflow_dispatch，不由数据分支 push 触发。

用户已授权上述自建资料的公开测试。2026-10-26 已通过用户完成的 Wrangler OAuth 授权，实际修改并回读确认产品仓库关联的 `minecraft-dev-platform` 与 `minecraft-dev` 两个 Pages 项目：preview 使用 custom 分支规则，包含 `*`、排除 `feedback-data`，生产分支仍为 `master`。未推送产品代码或部署。

实际验证调用生产反馈 handler，使用隔离的已认证测试上下文与原生 D1，再请求真实 GitHub API；不将此项等同于生产浏览器登录的全流程验收。

早期实际尝试在第一个附件 blob 写入时返回 403，GitHub 明确报告 `Resource not accessible by personal access token`，要求 `contents=write`。本地旧 `GITHUB_PR_TOKEN` 与 `GITHUB_PAT` 均不具备产品仓库的该权限。用户随后在 `.dev.vars` 配置专用 `GITHUB_FEEDBACK_TOKEN`，检查仅输出存在／非空状态，不显示值；实际上传、创建及关闭成功，证明此次所需写入权限可用。

## 真实发布结果

- 稳定 submission ID：`feedback-live-6560ca84-489f-4ea4-a955-1b8d35e9e74b`。
- 附件不可变提交：[b6175f2](https://github.com/superwfox/minecraft-dev/commit/b6175f2b940a40f4d2a9b94a7acdc8ae23c9927f)。12 个附件逐一下载并与公开预览的字节比较一致，包含 PNG；目录未包含 `.github`。
- [测试 Issue #10](https://github.com/superwfox/minecraft-dev/issues/10) 已创建并关闭。真实创建请求成功后，在本地故意丢弃返回，D1 保留附件 commit 和待对账标记；首次立即重试返回待确认，随后重试找到原 Issue，第三次重复提交返回同一地址。总计只有一次 Issue POST、一个对应 Issue，附件 commit 未改变。
- GitHub 查询 `feedback-data` 的 Actions run 为 0；2026-10-26 16:05（Asia/Singapore）查询该提交的 commit statuses、check runs 和 GitHub deployments 均为空。数据分支仅公开这份自建测试资料，产品业务代码没有提交或推送。

Pages 排除配置已经实际写入并回读确认。发布后的 Pages 管理 API 部署列表二次复核未完成：原 OAuth access token 已到期，自动续期时本机登录缓存写入被沙箱拒绝，随后续期返回 400；未重复要求用户授权，也未将这项检查记为通过。上述 GitHub 侧观察不能替代 Pages 管理 API 的发布后列表回读。

## 后续反馈重做的验证边界

后续表单改为成功／失败两类、共用 Markdown 输入框及强制公开范围弹窗；新版 `bundleVersion: 2` 由服务端脱敏后生成 `source.zip`、`diagnostics.zip`，另附截图，Issue @ 认证会话的 GitHub login。上述真实 Issue #10 仍保留原来的 12 个散文件，不改写历史证据。

新版已通过 ZIP 解包／资源／脱敏及端点重试的受控回归；图片、Markdown 与公开弹窗返回由用户实际检查。尚未用新版重新创建公开 Issue，不能将旧测试结果标为新版 ZIP 的真实发布通过。普通下载与反馈使用同一源码打包器，不新增 npm 生产依赖。
