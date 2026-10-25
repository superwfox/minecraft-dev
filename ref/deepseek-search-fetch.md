# DeepSeek Search / Fetch 迁移记录

日期：2026-10-25。仅迁移 Learning 的来源发现与网页抓取；代码生成、需求确认和证据核验继续使用现有 Chat Completions。

## 调用边界

- [deepseekSearch.ts](../functions/_lib/deepseekSearch.ts)：直接调用 `POST /v1/tools/search`，替代 Responses 加 `web_search` 的模型调用。模型的 `learn_public_api` 仍决定是否需要查证，并提供经过任务隐私筛查的原子技术问题和查询。
- [deepseekWebTools.ts](../functions/_lib/deepseekWebTools.ts)：共用当前 DeepSeek Key，处理 Search / Fetch 的 JSON、超时、有界重试和费用。使用手动重定向，避免携带鉴权跨主机；真实 Pages runtime 验证中发现 `redirect: "error"` 不兼容，现已改为 `manual` 并验证通过。
- [sourceFetch.ts](../functions/_lib/learning/sourceFetch.ts)：保留公共 HTTPS URL、重定向目标、内容类型、体积、哈希和来源分类检查。网页直读发生访问阻断、网络失败或正文过薄时，使用 `POST /v1/tools/fetch` 补充 Markdown；POM、metadata、原始源码及制品不走提取式 Fetch。非法 URL、私网跳转或体积／类型拒绝不使用该回退。
- [learning/step.ts](../functions/api/learning/step.ts)：沿用任务授权、租约、revision、阶段时限、取消和 D1 缓存，并在来源发现及抓取阶段结算真实请求费用。证据不足仍降级或待审核，不能以搜索分数、摘要或无结果推断已验证事实。
- [quota.ts](../functions/_lib/quota.ts)：Search 和 Fetch 各按 HTTP 200 且非空的成功请求计入 ¥0.005，与模型 token 成本合并累计。成功后本地过滤或核验失败仍保留费用；BYOK 不扣平台额度。失败和空结果不计费。

每轮最多 3 个问题、6 条查询，每个问题最多 3 个候选；按问题轮转，避免一个问题占满查询预算。查询最多 128 个 Unicode 字符，`count=10`、`need_content=false`。优先本地来源规则识别的官方与目标版本资料，搜索引擎的权威分不直接写入知识权威等级。Fetch 的 Markdown 保留为待核验证据，不自动升级成原文 `ground_truth`。

## 配置与兼容

`DEEPSEEK_API_KEY` 和 `DEEPSEEK_RESPONSES_WEB_SEARCH=true` 沿用现有值。后者仅保留历史名称，实际启用 Search / Fetch；默认关闭，GLM BYOK 继续只读取已有知识。无需新增生产依赖、密钥或数据库 migration。已有候选、终态诊断代码和任务恢复协议继续兼容。

来源发现现在没有模型 Prompt；因此已从 [Prompt 清单](deepseek-prompts.md) 删除旧的 Responses discovery 项。查询约束位于 `learning/tool.ts` 的 `searchQueries` schema，证据核验 Prompt 仍位于 `learning/verification.ts`。

接口与计费依据：[官方指南](https://api-docs.deepseek.com/zh-cn/guides/search/)、[Search Schema](https://api-docs.deepseek.com/zh-cn/api/search/)、[Fetch Schema](https://api-docs.deepseek.com/zh-cn/api/fetch/)。HTTP 408、429、5xx 最多重试一次；其他 4xx 不以同一请求重试。固定费用不依赖模型 token 定价或峰谷时段。

## 实际验证

使用本地 DeepSeek Key，全部密钥只在内存中读取；没有调用线上用户任务或线上 D1，没有推送或部署。

1. 原始 Search API 返回 HTTP 200，实际找到了 Paper 1.21.8 `AsyncChatEvent` 的版本化官方 JavaDoc。Fetch API 对同一页面返回 HTTP 200、标题 `Class AsyncChatEvent` 和非空 Markdown；这是实际外部请求。
2. 使用实际编译后的 Pages Functions、隔离本地 D1/KV 和登录会话。真实模型输出 `learn_public_api` tool call 后，由正式 `learning/start`、`learning/step` 完成 `queued → discovering → fetching → verifying → ready`。
3. 正式路由实际通过 Search 获取候选，直接读取 3 个 JavaDoc，实际调用模型核验并写入 1 条 active 知识。模型恢复解析到 `resolved/ready`，取得 1 条知识及非空上下文。
4. Search 成功后 D1 成本为 ¥0.005；核验结束该任务总成本为 ¥0.032314，包含模型 token 费用。重放 start 命中 `knowledge_cache_hit`，新增外部调用为 0，费用没有增加。测试准备阶段创建工具请求的独立模型调用不包含在该任务费用中。
5. 另一轮真实请求的构造器问题包含额外的父类／super 语义验收条件，最终进入 `needs_review`，没有自动采纳；后续独立验证问题仅核对精确构造器签名，真实链路完成上述 ready 与缓存命中。没有修改产品核验门槛来促成通过。
6. 真实来源直读成功，因此访问阻断后自动改走 Fetch 的分支、错误重试、空结果、危险跳转和 BYOK 计费区别使用回归用例检查；不把这些模拟异常用例称作真实站点失败复现。

以上 ready 表示公开知识证据核验与保存完成，不代表实现通例已通过 Java 编译或插件工程已构建。未执行 Java 编译、远端构建或游戏内运行。

必要 TypeScript 检查及 Pages Functions 打包通过。Learning、LLM、早期修复与配额合并检查共 267 项，265 项当次通过，两个已有 SQLite 缓存用例在并行检查时达到 5 秒超时；随后隔离复查该文件，12 项全部通过。此前的一轮相关回归 262 项全部通过。最新费用用例同时覆盖 Search / Fetch 的平台结算与 BYOK 跳过。

原始验证结果保存在本机忽略目录 `.wrangler/search-validation/`，没有纳入版本管理。该目录不参与产品部署。
