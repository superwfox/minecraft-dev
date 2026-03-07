工作顺序：

调用方把源码工程传给你的 Logic
你的 Logic 获取仓库默认分支
你的 Logic 读取默认分支 HEAD SHA
你的 Logic 基于这个 SHA 创建临时分支 build-{id}
你的 Logic 把 pom.xml / src / resources 等文件逐个写入临时分支
你的 Logic 调用 workflow_dispatch 触发 superwfox/minecraft-dev-workflow 的 maven.yml
GitHub Actions 在临时分支 checkout 代码并执行 mvn package
GitHub Actions 上传 target/*.jar 为 artifact
你的 Logic 轮询 run 状态直到 success / failure
你的 Logic 下载 artifact 中的 jar
你的 Logic 把 jar 回传给调用方
你的 Logic 删除临时分支 build-{id}

接口对应关系：

获取仓库信息
GET /repos/superwfox/minecraft-dev-workflow

获取默认分支引用
GET /repos/superwfox/minecraft-dev-workflow/git/ref/heads/{default_branch}

创建临时分支
POST /repos/superwfox/minecraft-dev-workflow/git/refs

上传文件
PUT /repos/superwfox/minecraft-dev-workflow/contents/{path}

触发工作流
POST /repos/superwfox/minecraft-dev-workflow/actions/workflows/maven.yml/dispatches

查询 workflow runs
GET /repos/superwfox/minecraft-dev-workflow/actions/workflows/maven.yml/runs

查询单次 run
GET /repos/superwfox/minecraft-dev-workflow/actions/runs/{run_id}

列出产物
GET /repos/superwfox/minecraft-dev-workflow/actions/runs/{run_id}/artifacts

下载产物
GET /repos/superwfox/minecraft-dev-workflow/actions/artifacts/{artifact_id}/{archive_format}

删除临时分支
DELETE /repos/superwfox/minecraft-dev-workflow/git/refs/heads/build-{id}
