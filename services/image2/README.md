# 图片工作台 2.0

独立 Node 22 服务，前端灰度入口为 `/image2`。保留 Next.js/tldraw 与原图片入口；图片工程、素材、任务、对话和 Agent 分支使用独立 SQLite WAL 数据库，不复用视频工程数据库。

## 本机启动

从 Web 仓库根目录安装前端与图片服务依赖：

```sh
npm ci
npm ci --prefix services/image2
```

在私有环境文件中设置以下变量，两个进程使用同一内部令牌。令牌至少 24 字符，不放进浏览器环境或提交 Git。`STUDIO_VISITOR_SECRET` 沿用 Web 现有配置，保持稳定，否则签名访客会重新分配。

```dotenv
# 图片服务
IMAGE2_API_TOKEN=<独立内部令牌>
IMAGE2_DATA_DIR=/private/image2-data
PORT=18088
HOSTNAME=127.0.0.1
# Web
IMAGE2_API_URL=http://127.0.0.1:18088
IMAGE2_API_TOKEN=<同一内部令牌>
STUDIO_VISITOR_SECRET=<沿用Web访客签名密钥>
```

分别运行 `npm start --prefix services/image2` 和 `npm run dev`，打开 `http://localhost:3000/image2`。数据库和不可变素材保存在 `IMAGE2_DATA_DIR`。不要把临时目录当作长期存储。

CPU 功能和字体可直接使用。OCR/GPU/生成/聊天未配置时，会分别显示不可用或保守降级状态；不会自动转成整图重绘。Web 缺少图片服务配置时返回 503，不回退旧网关。

## 编辑与保真

- `ImageDocument` 是权威状态；tldraw 仅投影图层树。坐标是工程像素，组内坐标相对父组。
- 文字绑定实际字体文件。内置 Noto Sans CJK SC Regular 采用 SIL OFL 1.1；来源、字节长度及 SHA 见 `fonts/SOURCE.json`。未知字体保留原文字裁片和识别元数据，先清底，再由用户确认字体，随后改字走编辑命令。
- 简单背景清底为 CPU 算法；复杂背景必须明确选择传统修补或局部补画。清底资产成为独立背景层，移动文字不会拖走背景。
- 模板排版提供中文海报、Logo 展示、服装印花三类确定性版式；复制现有素材与实际字体到原画布右侧，全部仍可逐层编辑，不提交生成模型。
- SVG 原文件不可变；路径属性覆盖另存。文字/Logo 不送去整图超分。像素放大默认只增加素材分辨率，保持图层布局；明确 `resizeLayout:true` 才改布局尺寸。
- 编辑/保护遮罩均按原素材解码像素对齐。有效区为编辑区减保护区，保护优先，羽化向有效区内部收缩。服务端合成输出 PNG；保护区外按 RGBA 原像素保留。
- 生成和自动分层先进入持久候选分支，用户接受才写主工程；算法操作默认直接应用且可撤销。Agent 分支内算法操作同样不会提前写主工程。
- 自动分层按 OCR、对象区域、重叠消歧、原像素切片、残余层、重合成校验执行。缺少 OCR/SAM 时仍可输出完整残余/连通区草稿，并在结果中记录降级。隐藏背景和原始字体不被猜成已确认结果。
- 字体候选最多三份实际字体，按 fontkit 字形边界、字符覆盖和 OCR 区域进行尺寸/比例拟合。`geometryFit` 仅是几何接近程度，不是原字体识别置信度；原字体继续标记 unknown，原文字裁片不变，转换仍需手动确认。

编组采用同父级连续相邻层，保留遮挡次序；拆组保留世界位置。当前 tldraw 无隔离组透明度渲染，UI 不提供组合透明度修改，非 1 透明度的组不可直接拆组。PDF 对这类组保留其合成像素，SVG/工程保留原始树。PSD 往返、跨设备账号、多人协作和视频改造不在本版范围。

## 操作与专用模型

按钮和 Agent 调用同一 `processors.mjs` 注册表。Agent 只负责解释语义和编排：

| 类型 | 处理器 |
|---|---|
| CPU 算法 | resize/crop/pad/rotate/flip/recolor/erase/color_key/trace/fill/repair/prepare_text/refine_mask；真实文字、路径、排版命令与导出 |
| 专用模型 | PP-OCRv5 server CPU OCR；现有 ComfyUI 的 BiRefNet/SAM 2.1/Real-ESRGAN |
| 生成模型 | generate/inpaint，沿用 OpenAI 兼容图片接口 |

`trace` 的保网点/线稿模式使用细节参数，不默认平涂、不删除小路径、不加额外描边或模糊。彩色模式独立。CPU `resize` 是插值，`super_resolution` 是 Real-ESRGAN；AI 高清重绘是明确的生成操作。专用超分分别请求 `RealESRGAN_x2plus.pth`/`RealESRGAN_x4plus.pth`，实际输出宽高不匹配即失败。

OCR 在内部工作者运行，无公网端口。版本/下载/离线校验说明见 [vision-worker/README.md](vision-worker/README.md)。ComfyUI 继续使用 `GPU_COMFY_BASE_URL`/`GPU_COMFY_TOKEN`；不另启公网 GPU 服务。`capabilities` 区分配置、节点目录存在、OCR 实际加载状态，节点目录通过不等于推理验收。

Agent 沿用 `AGENT_LLM_*` 与图片中转 `IMAGE_OPENAI_*` 配置、OpenAI 兼容 `tool_calls` 协议；最多 6 轮、24 个工具、4 次生成。明确 4xx 拒绝可走配置中的下一模型；超时、5xx 或残缺接受回执标记 `uncertain`，停止自动重投。

## 持久化与恢复

编辑携带 `baseRevision`/`commandId`，同一命令串行确认。浏览器 IndexedDB 保存未提交命令和完整冻结的 operation/chat/export 请求体及幂等键。丢响应后重用原体原键，禁止换键重投。版本冲突保留草稿。

服务保存阶段输入、输出素材、处理器版本、输入角色/hash、模型回执、Comfy `prompt_id` 及 LLM 工具循环位置。已知 Comfy 回执在重启后仅轮询；接受状态未知的收费请求不重新 POST。取消阻止后续步骤，但保留已有回执与产物。取消/失败的 CPU 任务可显式重试；未知生成不能自动重试。

分支接受进行三方版本检查：无冲突修改可重放，冲突返回 409 并保留分支。导出冻结提交时版本及其历史，不会混入后来修改。原生 ZIP 包含文档/历史/图层/原素材/遮罩/实际字体/来源关系，导入重新分配工程与素材身份，不导入可执行旧任务。SVG 可含位图裁片，PDF 是真实 PDF，不伪装 `.ai`。

任务记录排队毫秒、执行毫秒、总耗时、生成/视觉/LLM 提交数和错误。计数代表提交尝试，不是供应商最终扣费金额；单个样本的耗时不能作为生产提速百分比。

## 接口

内部前缀 `/api/v3/image2`，Web BFF 使用独立服务地址/令牌，转发签名访客身份。外部浏览器不得自带访客 ID。

| 接口 | 方法/职责 |
|---|---|
| capabilities | GET 能力与实际就绪状态 |
| documents、documents/:id | POST 创建 / GET 列表或权威状态 |
| documents/:id/commands、history、revisions | POST 编辑/撤销/重做，GET 历史 |
| assets、assets/default-font、assets/:id/content | POST 素材/内置字体，GET/HEAD 字节、Range/ETag |
| operations、jobs/:id、cancel、retry | POST 操作，GET 状态，POST 取消或显式重试 |
| conversations、conversations/:id/messages、runs/:id | 持久聊天与后台多步任务 |
| documents/:id/branches、accept | GET 候选分支，POST 接受 |
| imports/legacy、imports/project、exports | 显式迁移/重新导入/冻结导出 |

请求/响应契约与源码方法见 [CONTRACT.md](CONTRACT.md)。资产、任务、分支、对话都验证访客归属；缺配置不开放旧服务兜底。上传请求上限 96 MiB；处理上限 4000 万像素，自动分层上限 1600 万像素。SVG 禁止执行内容及外部资源。

原生工程 ZIP 最多 64 MiB，解压内容最多 128 MiB、2000 个文件、单文件 64 MiB；导出遵守同一上限，确保输出包能够重新导入。超过上限明确失败，需拆分工程。

## 测试与部署

```sh
npm run test:image2
npm run test:image2:client
npm run test:image2:browser
npm run typecheck
npm run build
```

服务测试、真实浏览器和真实 OCR 是不同证据。浏览器测试禁止外部付费模型，使用独立临时数据库和实际字体/图片字节；OCR smoke 则明确运行真实 CPU 权重。Docker 与生产操作见 [../../docs/IMAGE2_DEPLOYMENT.md](../../docs/IMAGE2_DEPLOYMENT.md)。四阶段实施/验收范围见 [../../docs/IMAGE2_2.0.md](../../docs/IMAGE2_2.0.md)。
