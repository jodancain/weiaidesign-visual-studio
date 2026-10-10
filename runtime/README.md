# Studio 后台源码快照与恢复

本仓库继续以原 `web/` 内容为 Git 根。`runtime/source/` 保存原项目根下的网关、渲染 worker、可选存储/代理服务、配置模板和配套运维源码；`manifest.json` 记录每个快照文件的 SHA-256、字节数和权限。无需移动现有 Git 根或改变现有生产部署。

代码渲染 worker 会从 sibling `web/package.json` 加载 Three、Remotion、Playwright 等依赖，并引用 `web/lib/studio` 和 `gateway/studio`。使用下面的恢复工具还原原目录关系后再运行它们。

## 从已提交版本恢复

```sh
git clone https://github.com/jodancain/weiaidesign-visual-studio.git studio-source
python3 studio-source/runtime/restore.py --verify-only --revision HEAD
python3 studio-source/runtime/restore.py --output ./studio-project --revision HEAD
cd studio-project
npm ci --prefix web
```

仓库当前为公开源码；内部验收记录、个人工作区规则和私网配置未纳入。`--revision` 可使用提交 SHA、分支或 tag，工具会报告实际解析出的提交 SHA。目标必须不存在或为空，非空目录会被拒绝。恢复结构：

```text
studio-project/
  web/                 # 所选提交中除 runtime/ 以外的仓库文件
  gateway/             # Studio v3 Node 网关与旧 v1 网关源码
  workers/             # code-video、Blender、local-i2v worker 源码
  scripts/             # 快照内的运维工具
  docs/                # 快照内的后台说明
  docker-compose.studio.yml
  .studio-restore-receipt.json
```

其他快照目录按原相对路径恢复。工具只读取 `git archive` 的已提交内容，不复制当前未提交的修改，也不复制 `.git`、真实 `.env`、`node_modules`、`.next`、`output` 或缓存。凭据为空的 `.env.example` 等模板可以恢复。`runtime/` 的包装工具和清单不再写入恢复后的 `web/`。

写入前会检查所有路径、文件类型、清单覆盖范围、字节数与 SHA-256；只接受普通文件和目录，拒绝软链接、硬链接和目录穿越。完成后再次读取后台文件并核对清单，保存小型恢复回执。`--verify-only` 完成同样的归档验证而不创建输出目录。

## 运行依赖与检查

Studio 网关需要 Node **22.13 或更新版本**，使用 `node:sqlite`。代码 worker 的 JS 依赖由恢复后的 `web/package-lock.json` 和 `npm ci --prefix web` 提供。媒体合成需要可执行 FFmpeg、ffprobe（H.264/AAC），Python 3、Pillow 和可用中文字体。effects 像素回归额外需要 NumPy；真实 Canvas2D 测试需要 Chrome，可通过 `STUDIO_CHROME_BIN` 指定程序路径，无 GPU 环境可使用 `STUDIO_CHROME_GL=swangle`。

Blender worker 需要 FastAPI、Pydantic、Uvicorn，测试需要 httpx；实际渲染另需本机 Blender 和 FFmpeg。旧 NAS 存储服务使用 Python `cgi`，请为该可选服务使用 Python **3.11**。Python 环境可按需要配置：

```sh
python3.11 -m venv .venv
. .venv/bin/activate
python -m pip install -r workers/local-i2v/requirements.txt Pillow numpy
```

从恢复后的项目根运行现有测试：

```sh
node --test gateway/studio/*.test.mjs
node --test workers/code-video/*.test.mjs
python -m unittest discover -s workers/blender-story -p 'studio_*_test.py' -v
python -m unittest discover -s nas-storage -p 'test_*.py' -v
```

测试使用独立临时数据和合成素材。请在独立环境执行，不加载生产 `.env` 或把活动数据库/归档凭据传给测试。可另运行 `npm run test:studio --prefix web`、`npm run typecheck --prefix web` 和 `npm run build --prefix web` 验证所选提交的前端。

`docker-compose.studio.yml` 提供独立 Node+Next 评估包装，需要操作人员配置 `STUDIO_RUNTIME_ENV_FILE`；Blender/code worker 仍是独立进程。旧 root Compose 还依赖外部 MoneyPrinterTurbo checkout。恢复工具不会启动服务、部署、切换生产路由或调用模型供应商。快照内历史 `ops` 和文档中的验收记录只说明当时流程，不构成本次部署或真实成片质量验收。

模型 API 凭据、实际服务端环境文件、活动 SQLite/WAL 与素材、模型权重、下载的 Blender 场景和生成影片不在源码包内。实际生成仍需自行配置供应商和模型资源；Blender v3 的独立服务可使用提交的 GLB，旧场景库模式则需准备对应场景资源。`gateway/studio/README.md` 和 `workers/blender-story/studio_README.md` 说明运行与任务持久化边界。

## 更新后台快照

后台仍在原项目的 `gateway/`、`workers/` 等目录开发。同步 GitHub 时更新 `runtime/source/<原根相对路径>`，重新计算 `manifest.json` 的 `files`（`sha256`、`bytes`、整数 `mode`），并更新 `createdAt`。清单必须完整覆盖快照，不能只添加文件而不更新清单。需要包装改动时记录 `packagingAdjustments`，为对应文件保留 `sourceSha256`，区分原源码与打包后的内容。

`gateway/.dockerignore` 补充了 schema、registry 与 baseline JSON 白名单，它们必须进入 Docker 构建上下文。公开副本还将个人用户名和私网地址改为通用示例，移除内部验收记录；这些调整都记录在清单中，原项目文件保留。运维脚本里的 `studio-user`、本机磁盘目录和 loopback 地址均是待配置的示例，不是生产参数。核心网关与渲染逻辑保持原样。

提交后再次运行 `--verify-only --revision <提交SHA>`，并向全新空目录恢复，执行上述必要检查。恢复或源码推送不代表生产部署，也不替代外部模型、GPU、媒体质量与公网访问验收。
