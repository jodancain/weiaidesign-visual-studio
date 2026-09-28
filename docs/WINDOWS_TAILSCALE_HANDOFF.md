# Weiai Design Windows + Tailscale 完整交接

更新：2026-09-28 16:00 CST

本文面向接手本项目的另一台 Windows 电脑。先在新机建立独立开发环境，验证通过后再迁移生产。任何时候都不要把真实密钥提交到 Git。

## 1. 当前结论

| 项目 | 当前事实 |
|---|---|
| 主代码仓库 | `https://github.com/jodancain/weiaidesign-visual-studio.git`（private） |
| 当前分支/提交 | `main` / `a0655f4045064b0a851732c5d2e104b18dd818e3` |
| 本机源码目录 | `Ai vedio/web/`；上一级是非 Git 的历史视频栈与运行产物 |
| 现生产主机 | Windows `ai`，Tailscale `100.84.235.123`，SSH 用户 `qrrwi` |
| 现生产容器 | `weiaidesign-web`，Windows 宿主端口 `18191` |
| 正式入口 | `https://weiaidesign.com`、`https://www.weiaidesign.com`、`https://visual.youngtuo.win` |
| 当前故障 | 2026-09-28 实测 SSH 正常，但 Docker Desktop 未运行，`18191` 未监听，公网入口超时 |
| 故障根因 | `com.docker.service` 为 Manual/Stopped；计划任务 `StartDockerDesktopForGeoBuild` 已 Disabled |
| Cloudflare 真正入口 | Mac 上 `byd` named tunnel，把上述域名转到 `http://100.84.235.123:18191` |
| Windows 本机 cloudflared | 是另一个 tunnel，仅服务 `wechat.youngtuo.win/share/* -> localhost:8090`，不是 Weiai Design 入口 |

不要把旧 Windows 上的 `C:\Users\qrrwi\weiaidesign-compose-v2.yml` 当成唯一源码。它是发布配置；代码唯一真源是 GitHub `main`。

## 2. 产品与技术架构

```text
浏览器/手机
  -> Cloudflare DNS + Mac byd tunnel
  -> Tailscale origin: Windows ai:18191
  -> Next.js 16 standalone 容器
       |-- /                 Lovart 风格 tldraw 工作台
       |-- /api/agent-chat   前置规划 + tool calling Agent
       |-- /api/v1/images    异步文生图/参考图生图
       |-- /api/v1/inpaint   mask 局部编辑
       |-- /api/v1/matting   ComfyUI/BiRefNet 抠图代理
       |-- /api/v1/segment   ComfyUI/SAM2 分层代理
       |-- /api/v1/image-videos  视频网关代理
       `-- /api/v1/openapi.json

外部依赖
  -> https://ezr.sh/v1
       图像: gpt-image-2
       图像 fallback: gpt-image-1.5, gpt-image-2.5-flare, gpt-image-2.5-sunburst
       Agent: claude-sonnet-5, gpt-5.5, kimi-k2.7-code
  -> https://api.typesafe.ai/v1/systemone
       Jev: 模型选择和 Brand Kit 合规判断
  -> https://video.youngtuo.win/api/v1
       MoneyPrinterTurbo/视频任务代理
  -> https://comfy.youngtuo.win
       Windows RTX 3070 ComfyUI/BiRefNet/SAM2
```

### Agent 生图链路

1. 前端把最近对话、选中对象、历史成品、Brand Kit、个人设计 Skill、画幅和避免项提交给 `/api/agent-chat`。
2. `mode=plan` 先生成结构化 `DesignPlan`，只返回可见设计决策，不返回隐藏思维过程。
3. Jev 在配置了 `TYPESAFE_API_KEY` 时选择 `gpt-image-2` 或 `seedream-4-5`，并判断 Brand Kit 合规性。
4. `mode=execute` 让 Agent 调用生图、改字、材质迁移、视频、矢量化或导出工具。
5. 图像接口建立异步 job；前端轮询后把结果放进 tldraw 画布。

### 当前已知架构边界

- 个人设计记忆、聊天会话、项目元数据主要存在浏览器 `localStorage`；代码只定义结构，不内置用户私密内容。
- 画布另有 `/api/v1/canvas-snapshots/{projectId}` 服务端快照，但不能代替全部浏览器状态。
- 当前 Windows compose 没有传 `TYPESAFE_API_KEY`，所以 Jev 代码在线上会静默降级。
- 生成图片存在 Docker volume `weiaidesign-data:/data`；换机不会自动迁移该卷。
- 根目录 MoneyPrinterTurbo、NAS storage、Flow/Veo 脚本是视频历史栈；当前视觉工作台主应用是 `web/`。

## 3. 交接包内容

交接 ZIP 根目录应包含：

| 路径 | 用途 |
|---|---|
| `workspace/` | 当前项目完整源码、文档、历史运行脚本与媒体产物 |
| `weiaidesign-visual-studio.bundle` | Git 完整历史，可在 GitHub 不可用时恢复 |
| `private-handoff/PRIVATE_CREDENTIALS.md` | 真实密钥与来源，严禁提交 |
| `private-handoff/weiaidesign.handoff.env` | 新 Windows 可直接改名使用的环境变量 |
| `private-handoff/cloudflare/` | `byd` tunnel 配置、凭据、run token 与 Mac LaunchAgent 备份 |
| `private-handoff/mac-controller-id_ed25519.pub` | 允许当前 Mac SSH 到新 Windows 的公钥；不是私钥 |
| `SHA256SUMS.txt` | 包内关键文件和最终 ZIP 的校验依据 |

构建缓存 `web/node_modules`、`web/.next`、浏览器登录 profile `.runtime` 不进入交接包。它们可重建或含不应复制的会话数据。

## 4. 新 Windows 基础环境

推荐 Windows 11 + WSL2 Ubuntu + Docker Desktop。代码可以放在 `D:\dev\weiaidesign`；若主要在 WSL 开发，则放在 `~/dev/weiaidesign`，不要跨 `/mnt/c` 运行大量 Node 文件操作。

管理员 PowerShell：

```powershell
wsl --install -d Ubuntu
winget install --id Git.Git -e
winget install --id GitHub.cli -e
winget install --id OpenJS.NodeJS.LTS -e
winget install --id Docker.DockerDesktop -e
winget install --id Tailscale.Tailscale -e
winget install --id Cloudflare.cloudflared -e

Add-WindowsCapability -Online -Name OpenSSH.Server~~~~0.0.1.0
Start-Service sshd
Set-Service -Name sshd -StartupType Automatic
if (-not (Get-NetFirewallRule -Name OpenSSH-Server-In-TCP -ErrorAction SilentlyContinue)) {
  New-NetFirewallRule -Name OpenSSH-Server-In-TCP -DisplayName "OpenSSH Server (sshd)" `
    -Enabled True -Direction Inbound -Protocol TCP -Action Allow -LocalPort 22
}
```

Docker Desktop 设置：

1. 开启 `Use the WSL 2 based engine`。
2. `Resources > WSL Integration` 开启 Ubuntu。
3. 开启 `Start Docker Desktop when you sign in`。
4. 运行 `docker version`，必须同时看到 Client 和 Server。

## 5. 加入 Tailscale

新机安装后登录现有 tailnet：

```powershell
tailscale up --hostname weiaidesign-dev
tailscale status
tailscale ip -4
```

不要复制旧机器的 Tailscale state。若使用短期 auth key，应在 Tailscale Admin Console 创建一次性、可撤销、带过期时间的 key；交接包不保存长期 Tailscale auth key。

从当前 Mac 验证：

```bash
tailscale ping weiaidesign-dev
ssh <新Windows用户名>@<新Windows的100.x地址>
```

## 6. 配置 SSH 公钥

在新 Windows 上，把交接包的 `mac-controller-id_ed25519.pub` 内容追加到公钥文件。

如果新 Windows 用户属于 Administrators，管理员 PowerShell：

```powershell
$key = Get-Content .\mac-controller-id_ed25519.pub -Raw
$auth = "C:\ProgramData\ssh\administrators_authorized_keys"
New-Item -ItemType File -Force $auth | Out-Null
Add-Content -Path $auth -Value $key.Trim()
icacls $auth /inheritance:r
icacls $auth /grant "Administrators:F" /grant "SYSTEM:F"
Restart-Service sshd
```

普通用户则写入 `$HOME\.ssh\authorized_keys`，并收紧 ACL。不要复制当前 Mac 的 `id_ed25519` 私钥；每台开发机自行生成自己的出站密钥：

```powershell
ssh-keygen -t ed25519 -a 64 -C "weiaidesign-dev"
```

旧 Windows 当前连接命令仅用于诊断或取回运行数据：

```bash
ssh qrrwi@100.84.235.123
```

## 7. 恢复代码

首选 GitHub：

```powershell
gh auth login
New-Item -ItemType Directory -Force D:\dev | Out-Null
Set-Location D:\dev
git clone https://github.com/jodancain/weiaidesign-visual-studio.git weiaidesign
Set-Location weiaidesign
git checkout main
git pull --ff-only
git rev-parse HEAD
```

无 GitHub 网络时，用 bundle：

```powershell
git clone .\weiaidesign-visual-studio.bundle D:\dev\weiaidesign
Set-Location D:\dev\weiaidesign
git remote set-url origin https://github.com/jodancain/weiaidesign-visual-studio.git
```

接手开发必须新建分支，不直接在 `main` 上试验：

```powershell
git switch -c windows/<任务短名>
npm ci
```

## 8. 配置密钥

从 ZIP 的 `private-handoff/weiaidesign.handoff.env` 复制到仓库根目录 `.env.windows`。该文件包含真实密钥，不可提交：

```powershell
Copy-Item <解压目录>\private-handoff\weiaidesign.handoff.env D:\dev\weiaidesign\.env.windows
```

必须至少存在：

```dotenv
VIDEO_API_TOKEN=...
EZR_API_KEY=...
IMAGE_OPENAI_API_KEY=...
AGENT_LLM_API_KEY=...
TYPESAFE_API_KEY=...
```

开发时可复制为 `.env.local`：

```powershell
Copy-Item .env.windows .env.local
```

`.gitignore` 已忽略 `.env` 和 `.env.*`，但提交前仍必须执行 `git status --short` 和 secrets scan。

## 9. 本地开发

```powershell
Set-Location D:\dev\weiaidesign
npm ci
npm run dev -- --hostname 0.0.0.0 --port 18192
```

访问：

- 本机：`http://127.0.0.1:18192`
- tailnet：`http://<新Windows的100.x地址>:18192`
- 健康：`http://<新Windows的100.x地址>:18192/api/v1/health`

Windows 防火墙仅允许 Tailscale 网段进入开发端口：

```powershell
New-NetFirewallRule -DisplayName "Weiai Dev via Tailscale" -Direction Inbound `
  -Action Allow -Protocol TCP -LocalPort 18192 -RemoteAddress 100.64.0.0/10
```

## 10. Docker 开发环境

仓库提供 `ops/windows/docker-compose.yml`。在仓库根目录运行：

```powershell
docker compose --env-file .env.windows -f ops/windows/docker-compose.yml up -d --build
docker compose --env-file .env.windows -f ops/windows/docker-compose.yml ps
powershell -ExecutionPolicy Bypass -File ops/windows/smoke.ps1 -BaseUrl http://127.0.0.1:18192
```

停止但保留数据：

```powershell
docker compose --env-file .env.windows -f ops/windows/docker-compose.yml down
```

删除 volume 会永久删除该环境生成图片，除非明确要重置，不要加 `-v`。

## 11. 验收清单

### 静态与构建

```powershell
npm ci
npm run build
git status --short
```

`npm run lint` 当前仍指向 `next lint`，Next 16 已不再提供该子命令，不能把它当作有效验收；后续应改成 ESLint CLI。

### API

```powershell
$base = "http://127.0.0.1:18192"
Invoke-RestMethod "$base/api/v1/health"
Invoke-RestMethod "$base/api/v1/openapi.json"
```

必须验证：

1. 无 token 调受保护接口返回 `401`。
2. 正确 token 调 `/api/agent-chat` 的 `mode=plan` 返回 `plan` 和实际 model。
3. `/api/v1/images` 返回 job id，轮询 `/api/v1/image-jobs/{id}` 到 `done`。
4. 生成图片 URL 返回 `200 image/jpeg|png`。
5. 有 GPU 服务时，`/matting` 和 `/segment` 完成真实图片处理。
6. 桌面与 `390x844` 手机视口无横向溢出，画布、对话、工具条可用。
7. 刷新后项目、会话和设计记忆行为符合预期。

## 12. Cloudflare 与生产切换

现正式域名不是由 Windows 上那个 `12f0...` tunnel 提供，而是 Mac 的 `byd` tunnel：

```text
tunnel: byd
id: 69a53399-7ff2-4d29-8ed3-61079d4317ca
config: ~/.cloudflared/byd.yml
weiaidesign.com -> http://100.84.235.123:18191
www.weiaidesign.com -> http://100.84.235.123:18191
visual.youngtuo.win -> http://100.84.235.123:18191
```

推荐迁移方式是保留 Mac `byd` connector，只把这三条 origin 改成新 Windows 的 Tailscale IP。这样不会把 tunnel 密钥扩散到更多主机，也不影响同一 tunnel 上的其他项目。

正式切换前：

1. 新 Windows 用 `18192` 连续通过全部 smoke。
2. 备份 Mac `~/.cloudflared/byd.yml`。
3. 新 Windows 正式容器改用 `18191`，确认 Tailscale origin 200。
4. 只修改上述三个 hostname 的 service IP。
5. `cloudflared tunnel --config ~/.cloudflared/byd.yml ingress validate`。
6. `launchctl kickstart -k gui/501/com.byd.tunnel`。
7. 从公网验证首页、health、OpenAPI、401、Agent、真实生图和手机页面。
8. 通过后再停旧 Windows 容器，至少保留旧 volume 7 天。

回滚只需恢复 `byd.yml` 备份并重启 tunnel，然后重新启动旧 Windows 容器。

交接包也备份了 `byd` tunnel token/credentials，仅用于灾难恢复。不要让新旧两台机器用不同 ingress 配置同时跑同一个 tunnel，否则请求可能随机落到规则不一致的 connector。

## 13. 旧 Windows 恢复命令

当前生产若要临时恢复，必须在 `ai` 的交互桌面启动 Docker Desktop；非交互 SSH 拉起 GUI 稳定性不足。登录后执行：

```powershell
Start-Process "C:\Program Files\Docker\Docker\Docker Desktop.exe"
docker version
Set-Location C:\Users\qrrwi
docker compose --env-file .\weiaidesign.env -f .\weiaidesign-compose-v2.yml up -d --build
docker ps --filter name=weiaidesign-web
Invoke-RestMethod http://127.0.0.1:18191/api/v1/health
```

修复开机自启：

```powershell
Enable-ScheduledTask -TaskName StartDockerDesktopForGeoBuild
Set-Service -Name com.docker.service -StartupType Automatic
```

这只能降低复发概率；仍应在重启后做 Docker API、容器和端口三层 readback。

## 14. 数据迁移

旧机 Docker 恢复后，备份生成图片 volume：

```powershell
docker run --rm -v weiaidesign-data:/from -v ${PWD}:/backup alpine `
  sh -c "cd /from && tar czf /backup/weiaidesign-data.tgz ."
```

在新机恢复：

```powershell
docker volume create weiaidesign-data
docker run --rm -v weiaidesign-data:/to -v ${PWD}:/backup alpine `
  sh -c "cd /to && tar xzf /backup/weiaidesign-data.tgz"
```

浏览器 localStorage 需要在原浏览器导出后另行导入；Docker volume 不包含聊天、项目列表和默认个人设计 Skill。

## 15. 当前 P0/P1 待办

1. **P0**：旧 Windows Docker Desktop 当前停止，正式站不可用。
2. **P0**：新机切生产前迁移 `weiaidesign-data`，否则旧图片链接会丢失。
3. **P0**：给正式 compose 透传 `TYPESAFE_API_KEY`，再验证 Jev readback。
4. **P1**：把浏览器设计记忆/会话做账号级服务端同步；现在只在单浏览器。
5. **P1**：把 `npm run lint` 改成有效的 ESLint CLI。
6. **P1**：Cloudflare `byd` connector 仍是 Mac 单点，长期应拆出 Weiai Design 独立 tunnel 或迁到常开主机。
7. **P1**：GPU `8189` 只是 Windows portproxy；WSL ComfyUI `8188` 未运行时会 reset，必须分别检查监听与真实 `/system_stats`。

## 16. 安全规则

- `PRIVATE_CREDENTIALS.md`、`*.production.env`、`*.token`、Cloudflare credentials JSON 永不提交、永不发公共聊天。
- 新 Windows 接管后轮换 `VIDEO_API_TOKEN`、EZR key 和 Cloudflare tunnel token；旧包随后销毁。
- GitHub 使用 `gh auth login` 或 Windows Credential Manager，不把 PAT 写入文档。
- SSH 只分发公钥，每台机器保留自己的私钥。
- 正式域名、生产 volume 和 Cloudflare 路由变更必须有人确认后执行。
