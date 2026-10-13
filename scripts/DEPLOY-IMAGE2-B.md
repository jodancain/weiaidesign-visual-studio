# 生图专业编辑 B：Windows 分阶段发布

本脚本用于已探查的 Windows `AI / qrrwi`，采用手工 Docker 容器方式。原公网 Web 是 `weiai-studio-v3-web`，宿主 18194；网络 `weiai-studio-v3-production`；旧图片卷 `weiaidesign-web_weiaidesign-data`；视频账本卷 `weiai-studio-v3-production-data`。这些是探查事实，脚本执行时仍检查实际运行状态、挂载和配置一致性，不把旧时间点快照当作部署验收。

当前交付是脚本与验证。上一版已在 Windows AI 实际 PowerShell 中验证 AST 解析错误 0、Prepare/Canary/Rollback dry-run、Cutover 缺回执拒绝。本版新增用户明确授权的“先部署生产再测试”顺序，尚未重新验证 Windows AST，也没有执行 Windows 真实构建、备份、canary 或生产切换。每次修改脚本后仍应用下面的 parse-only 命令复验。

```powershell
$tokens = $null; $parseErrors = $null
$null = [Management.Automation.Language.Parser]::ParseFile('C:\Users\qrrwi\studio-v3-production\tools\deploy-image2-b.ps1',[ref]$tokens,[ref]$parseErrors)
if ($parseErrors.Count) { throw 'PowerShell parse failed; do not deploy.' }
```

## 参数与执行边界

必填参数为 `ReleaseId`、`SourceArchive`、`ExpectedSha`、`Phase`。`Phase` 为 `Prepare | Canary | Cutover | Rollback`；可选 `GateReceipt` 和 `DryRun`。每个 release 使用新目录，不允许覆盖旧备份、已有来源不明的容器或数据卷。

`DryRun` 只输出动作清单，不调用 Docker、不读取 runtime.env、不访问健康端点、不写状态。`Cutover -DryRun` 仍要求正常验收回执或下述明确部署优先授权回执；成功的 dry-run 不表示实际配置、构建、备份或浏览器验收通过。

```powershell
& 'C:\Users\qrrwi\studio-v3-production\tools\deploy-image2-b.ps1' `
  -ReleaseId '20261013-b-example' -SourceArchive 'C:\private\web-release.tgz' `
  -ExpectedSha '<archive SHA-256>' -Phase Prepare -DryRun
```

真实操作必须在 Windows 持续本地会话或独立 Scheduled Task 中运行。直接从 SSH 启动的长进程可能在会话关闭时被杀死，使 finally 没机会恢复暂停的 Web；脚本检测到 `SSH_CONNECTION/SSH_CLIENT` 时拒绝真实操作。可以从 SSH 注册和启动任务，但不能把部署脚本作为 SSH 会话拥有的前台进程运行。

任务运行账号必须为已探查的 `qrrwi`，具有 Docker Desktop 使用权限。任务参数传文件路径，不传 token。把任务 stdout/stderr 保存至该 release 的私有日志；脚本只输出允许的回执字段，Docker 原始输出和环境值始终抑制。任务完成后读取退出码和 `release-state.json`，不能仅凭任务处于 Ready 就判定成功。

## 源码冻结

从本次完整 `web/` 候选 commit 导出，不同步旧 Windows 工作目录。通常使用 B 原首页验收对应的 commit；用户明确要求先部署再测试时使用已完成源码检查的候选，保留网页验收待办。所有新 helper、服务、字体和部署文件必须包含在同一冻结源码中；源码包不包含私有环境、运行数据、node_modules、模型缓存或符号链接。模型权重不进入源码包。

```sh
git -C '/Users/qiuxuanmai/SynologyDrive/ai/Ai vedio/web' archive --format=tar.gz --output='<private-dir>/web-<release>.tgz' '<verified release commit>' -- . ':!runtime'
shasum -a 256 '<private-dir>/web-<release>.tgz'
```

将源码包和同版部署脚本传到 Windows 私有位置。部署包排除仓库中的独立视频后台源码快照 `runtime/`，它不参与此次 Web 或图片服务构建；完整源码仍保留在 Git。`ExpectedSha` 是源码包实际 SHA-256，脚本中没有硬编码当前代码 SHA。Windows `Prepare` 会重算 hash、拒绝越界路径/私有文件/链接，解压到新的 `releases/<release>/web` 后构建。不要使用旧 wrapper `deploy-sync.sh` 或 `deploy-long-video-production.sh`；它们针对旧部署路径，范围过宽。

## 四个阶段

### Prepare

读取当前容器、端口、挂载和私有配置。在远端进程内逐值比较原 `web-runtime.env` / `gateway-runtime.env` 与容器，只记录匹配布尔和字段数量，绝不输出值。发现 drift、进行中或 uncertain 任务时失败，保留回执，不中断后重投。

使用 `node:sqlite` backup API 在线保存一致 V3 数据库，再归档不可变资产和辅助目录。对共享旧图片卷，先确认两套 Web 的旧任务均终态，再短暂 pause 两个 Web 取一致快照；内层及外层 finally 都执行 unpause。不会 pause/rebuild 视频 gateway 或原生 worker。

数据库和资产恢复到独立验证卷，检查 `quick_check` 与全部资产 hash；旧图片恢复到独立 canary 卷。SQLite 句柄只读，验证卷允许创建 WAL/shm；活动生产卷不被恢复或覆盖。随后构建独立 Node 22 核心和 Next Web，保存真实 image digest。私有配置、备份与状态目录 ACL 仅允许当前账号、SYSTEM 和管理员。

```powershell
# Run this command inside the persistent local session or Scheduled Task.
& $scriptPath -ReleaseId $release -SourceArchive $archive -ExpectedSha $sha -Phase Prepare
```

### Canary

要求 Prepare 已成功且生产镜像未被其他发布更换。新核心使用独立 `weiai-image2-data` 卷、现有 V3 内网、alias `image2`，仅内部监听 18088。**没有 image2/OCR 宿主端口**；Windows 原生视频 worker 的 localhost 18088 不受影响。

canary Web 绑定 `127.0.0.1:18196:18084`，使用旧图片的独立恢复副本。访客签名沿用原配置；图片、Agent、OpenAI 和 GPU 的配置清空，并检查实际容器配置确实为空。此阶段不创建 OCR worker或下载模型；能力状态应按实际 unavailable 显示。

脚本验证内部 `/health`、本地 Web `/api/v1/health`、`/api/v3/image2/capabilities` 和 BUILD_ID，只记 `CanaryRuntimeReady=true`。**它不会创建 `GateBPassed=true` 或代替原首页浏览器验收**。主代理还需从原 `/` 验文字、路径、遮罩、变换、图层、导出、回迁、撤销、刷新等，检查真实结果与三类模型调用数为零。

```powershell
& $scriptPath -ReleaseId $release -SourceArchive $archive -ExpectedSha $sha -Phase Canary
```

浏览器访问可以使用 SSH local forward 将本机端口转到 Windows localhost 18196。该操作不能绕过已经拒绝的浏览器权限或用独立 `/image2` 通过结果替代原首页验收。

### Cutover

通常必须提供人工根据真实验收结果填写的 JSON 回执。以下示例所有门禁默认 false；不要为了让脚本通过而提前改成 true。image ID / BUILD_ID 从本次 `release-state.json` 对齐；EvidencePaths 指向实际 B 和 canary 浏览器证据。

```json
{
  "ReleaseId": "20261013-b-example",
  "SourceSha256": "<lowercase archive SHA-256>",
  "GateBPassed": false,
  "OriginalPagePassed": false,
  "CanaryPassed": false,
  "GenerationCalls": 0,
  "LlmCalls": 0,
  "VisionCalls": 0,
  "WebImageId": "sha256:<accepted web image>",
  "CoreImageId": "sha256:<accepted core image>",
  "CanaryBuildId": "<actual BUILD_ID>",
  "EvidencePaths": ["<B original-page report>", "<canary report>"]
}
```

正常流程的验收布尔必须是 JSON true；字符串 `"true"`、缺失字段、不同 release/source/image/build 或非零模型计数均拒绝。

用户在 2026-10-13 明确要求 **“先部署生产再测试”**，可改用下列回执。此模式只调整原首页功能验收顺序；必须保存三项验收状态为严格 JSON false，来源为直接用户指令，明确标记部署后测试待完成。未提供 `DeployBeforeUiTesting` 或设为 false 时，继续采用正常严格验收门禁。不能把这项授权当作 UI 已通过。

```json
{
  "ReleaseId": "20261013-b-example",
  "SourceSha256": "<lowercase archive SHA-256>",
  "DeployBeforeUiTesting": true,
  "AuthorizationSource": "user",
  "AuthorizationInstruction": "先部署生产再测试",
  "PostDeploymentTestingRequired": true,
  "GateBPassed": false,
  "OriginalPagePassed": false,
  "CanaryPassed": false,
  "GenerationCalls": 0,
  "LlmCalls": 0,
  "VisionCalls": 0,
  "WebImageId": "sha256:<prepared web image>",
  "CoreImageId": "sha256:<prepared core image>",
  "CanaryBuildId": "<actual runtime BUILD_ID>"
}
```

两种模式均在环境读取、锁和任何变更前检查回执；实际切换仍要求 Prepare 恢复校验、`CanaryRuntimeReady` 运行回执、容器实际配置及 digest 一致、签名访客身份不变、旧服务与 image2 账本没有活跃/未知任务、数字零模型调用。授权不会绕过这些基础运行检查。

部署前后的 `release-state.json` 与脚本输出保存 `Acceptance`，其中包含实际三项验收值、用户授权及 `PostDeploymentTestingRequired`。`CutoverComplete=true` 仅表示生产路由切换成功；部署优先模式下仍须在生产原 `/` 测试全部非 AI 功能并独立记录结果，失败时使用保留的原 Web 回滚。

仅在这个入口恢复已有 provider 配置到新私有文件，沿用同一内部 token和 image2 卷。不运行付费样例。新核心配置失败时恢复原 canary 核心；替换 Web 时保留原停止容器、配置和 digest，只把新 Web 放到原 18194。旧 18191、视频 18082/18084、V3 gateway、原生 worker 和 Cloudflare 路由不修改。

本地 BUILD_ID/路由与四域 API readback 失败时自动恢复旧 Web，仍保留新核心账本、资产和回执。API readback通过后，主代理仍需核对公网原首页布局、最终素材和视频只读入口；本脚本不会宣称完整网页验收成功。

```powershell
& $scriptPath -ReleaseId $release -SourceArchive $archive -ExpectedSha $sha -Phase Cutover -GateReceipt $acceptedReceipt
```

### Rollback

核对本 release 的旧容器 digest 及当前候选 owner，停止并保留新 Web，启动原 Web并核对原 BUILD_ID。不会恢复旧数据库、删除卷、停止 image2 已接受任务、清理幂等记录或自动补跑模型。若生产已被另一个 release 更新，拒绝覆盖。

```powershell
& $scriptPath -ReleaseId $release -SourceArchive $archive -ExpectedSha $sha -Phase Rollback
```

脚本不提供 prune、down -v 或强制清理。部分失败状态、镜像、候选容器和验证卷保留给主代理检查；Prepare 不覆盖同名状态或备份。重试前先读取 receipt 与真实容器状态，不删除账本来“重新开始”。

## 当前证据边界

探查报告位于 wrapper `output/image2-professional-20261013/phase-b/production-inspection/`。独立 Node 静态回归可以验证源码中的门禁顺序、固定网络/端口、secret 输出限制、备份/回滚边界和 PowerShell 词法括号配对；这些不等于 PowerShell AST、Docker 构建或 Windows 实际运行通过。没有 PowerShell时运行检查会明确 skip 其解析和 dry-run 执行用例。

```sh
node node_modules/tsx/dist/cli.mjs --test tests/image2-deployment-script.test.ts
```
# 实际脚本检查补充（2026-10-13）

根代理在 Windows AI 的 PowerShell 中解析同 SHA 的脚本文本，AST 错误为 0；Prepare、Canary、Rollback 的 DryRun 返回 `DeploymentExecuted=false`、`RuntimeConfigRead=false`，Cutover 缺少验收回执时明确拒绝。只复制了临时脚本作解析，没有执行真实发布阶段、读取运行配置或改变容器/数据卷。证据在 `output/image2-professional-20261013/phase-b/deployment-script/windows-parser-dryrun.json`。本机 Node 测试仍明确跳过本机没有 PowerShell 的三个执行项；远端检查单独记录，不混为生产部署。
