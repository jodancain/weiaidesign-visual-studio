# 图片工作台 2.0 部署与恢复

本次提供构建与部署文件。默认页面仍是原版，2.0 在 `/image2`；无需修改 DNS 或 Cloudflare 隧道。本地验证不代表生产镜像已经构建或线上模型已经验收。

## 部署准备

1. 保存现有 Web 镜像标签和私有配置，检查实际 Docker 网络名。复制 `services/image2/.env.example` 到部署主机私有文件；设置独立服务/OCR 令牌、现有 Web 网络和持久卷名。不要从旧示例猜生产网络。
2. 构建独立图片服务和 OCR 工作者：

```sh
docker compose --env-file /private/image2.env -f services/image2/compose.yml build
```

3. 明确下载并验证 OCR 权重。准备目录由部署人员创建，未准备不能假报 OCR 可用。下例在准备容器中显式下载到挂载目录；启动服务不会下载权重：

```sh
mkdir -p /private/image2-models
docker run --rm --user 0 -v /private/image2-models:/models \
  weiai-image2-ocr:2.0.0 \
  python download_models.py --output /models/ocr
```

`IMAGE2_OCR_MODELS_DIR` 设置为 `/private/image2-models/ocr`。可先在离线准备机器执行同一脚本，再传输全目录及 manifest；每个文件在启动时重新校验。目录需可由 UID 65534 读取。服务仅挂只读模型目录。

4. `compose.yml` 只定义 image2 和 image2-ocr，不重新创建已有视频/GPU服务。它们不发布 host ports；Web 使用现有网络内的 image2:18088，OCR 使用独立 internal 网络。

```sh
docker compose --env-file /private/image2.env -f services/image2/compose.yml up -d
```

5. 给现有 Web 私有环境添加 `IMAGE2_API_URL=http://image2:18088` 与同一 `IMAGE2_API_TOKEN`，保留 `STUDIO_VISITOR_SECRET`。按既有方式构建 Web 并显式安排灰度上线。不要改默认入口。

## 上线后的验收

验 `/image2` 的签名访客、跨工程访问拒绝、实际字体字节、PNG/SVG/PDF/工程包下载和 Range。先执行 CPU 操作和已准备的 OCR，不提交未知旧任务。

ComfyUI 目录存在只说明节点菜单存在：另行验 BiRefNet、SAM 2.1，以及 2×/4× 输出实际尺寸/透明通道。生成/Agent 付费验收需按获准素材和预算明确执行；超时或回执未知先读原任务，不换幂等键补跑。

分别关闭网页、刷新、重启服务，检查同任务 ID、输入关系和最终资产不变；对明确接受的 Comfy 任务只查询原 `prompt_id`。候选接受检查与主工程并行编辑的冲突。

## 备份与恢复

持久状态在独立 `image2-data` 命名卷：`image2.sqlite`、WAL 和 `assets/`。备份前暂停新写入并停止图片服务，再复制整个卷；不要在运行中只复制 SQLite 主文件。字体/遮罩同样在 assets 内，不可单独遗漏。

```sh
docker compose --env-file /private/image2.env -f services/image2/compose.yml stop image2
```

在离线备份窗口保存完整卷及对应镜像/源码版本，随后重新启动 `image2`。恢复到新的命名卷并核验素材 hash、版本、字体和未知任务状态。不要对生产卷执行 `down -v`。

服务重启会恢复已知阶段，未知接受请求进入 `uncertain`。系统不保证知道供应商是否收费；核对外部回执后，用户可以明确决定发起新的生成。

## 回滚

保留原入口。回滚 Web 镜像/移除灰度链接，停止 image2 即可；保留图片命名卷和私有配置以便恢复。不要把 2.0 数据硬塞回旧画布项目。显式导入保存原快照/旧 ID 映射，缺失素材保留缺失记录，不重新生成。

Cloudflare 1033 是入口隧道连接问题，与图片超分处理分开排查。此部署未更改入口隧道，不能把图片服务上线当作隧道故障已经解决。
