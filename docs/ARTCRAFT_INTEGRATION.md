# ArtCraft 能力接入审计与实施边界

审计日期：2026-10-14。范围：[官方 13 应用目录](https://getartcraft.com/apps)、各官方仓库的 README、Cargo 配置、许可文件、CLI/Web 入口，以及 PhotoCraft／VectorCraft 的引擎和自动化协议。

## 当前状态

- 本项目继续保留原首页的画布、工具栏、聊天区、配色和布局；新增能力通过已有菜单、弹窗和结果卡片进入。
- 本轮已实现本地统一 Agent 控制、10 项非 AI 调色／3 项滤镜和原色像素边界描摹；原首页已执行算法并验证零模型调用。精确工程开放 14 项 CPU 操作与 17 类文档命令，使用原 Agent 协议、分支、候选和任务账本。详细验收与未完成项见 `ARTCRAFT_CONTROL_DELIVERY.md`；未部署或推送本轮改动。
- **13 套 ArtCraft 应用目前均未接通本项目。** 本次只读了公开源码和协议，没有下载、编译、运行这些应用，没有修改生产环境，没有做它们的文件往返或性能验收。
- 默认先推进图像、矢量、PDF 与排版，再分阶段推进其余能力。完整产品目录是长期接入范围；不宣称本项目已经具备 13 套应用的全部功能，也不宣称等同 Photoshop、Illustrator 或其他目标软件。
- 官方应用存在 CLI、MCP 和 Web 构建入口，不等于它们已有统一、稳定的 Web SDK；“AI 可以控制”还需要本项目的工具适配、权限、任务账本、版本提交和输出验收。

## 固定源码审计基线

以下 SHA 来自本次 `git ls-remote ... refs/heads/main` 回读。它们是本次研究的固定来源，不代表选定的发布版本，也不代表已构建。接入时还需核对该提交的依赖锁文件、构建产物和测试。各仓库仍在持续更新。

| 应用 | 固定 SHA／官方源码 | 已核对的入口与可复用部分 | 官方阶段与主要边界 |
|---|---|---|---|
| PhotoCraft | [`706638b2842a330cfc5c305c7860d0b7c9921960`](https://github.com/storytold/photocraft/tree/706638b2842a330cfc5c305c7860d0b7c9921960) | `photocraft-cli` 的 run、batch、serve、MCP；`engine`、`algo`、`compose`、`psd` 等 Rust crates；完整 Web App | early alpha；PSD、文字、性能和平台稳定性仍有缺口，不是已验证的 Photoshop 专业替代品。[自评](https://github.com/storytold/photocraft/blob/706638b2842a330cfc5c305c7860d0b7c9921960/docs/target-app-parity.md) |
| VectorCraft | [`a06717777828867557d759c674283304f63c04ae`](https://github.com/storytold/vectorcraft/tree/a06717777828867557d759c674283304f63c04ae) | CLI run／commands；MCP headless／remote；`engine`、`pathops`、`trace`、`svg`、`pdf`；完整 Web App | alpha；日常路径编辑已有实现，类型深度、效果、格式和专业流程仍需逐项验证，不能把菜单覆盖率当 Illustrator 行为一致性。[自评](https://github.com/storytold/vectorcraft/blob/a06717777828867557d759c674283304f63c04ae/docs/target-app-parity.md) |
| FilmCraft | [`cee1feb185e675a108f78067f71ad86a640ace3d`](https://github.com/storytold/filmcraft/tree/cee1feb185e675a108f78067f71ad86a640ace3d) | CLI commands／run／MCP；时间线、剪辑、合成、编解码引擎；Web App 源码 | alpha；`.prproj`、插件宿主、真实素材兼容和大素材性能仍有边界；不能替换现有视频生产链。[README](https://github.com/storytold/filmcraft/blob/cee1feb185e675a108f78067f71ad86a640ace3d/README.md) |
| LightCraft | [`a4b53b28cc52b68d9f5bdca09fa5666cdad5ad5f`](https://github.com/storytold/lightcraft/tree/a4b53b28cc52b68d9f5bdca09fa5666cdad5ad5f) | CLI／MCP、照片目录、RAW 解码与 develop／pipeline；Web App | alpha；相机 RAW、色彩、镜头数据库和 XMP 交换覆盖不足。照片目录是有状态资料库，需独立项目隔离。[路线图](https://github.com/storytold/lightcraft/blob/a4b53b28cc52b68d9f5bdca09fa5666cdad5ad5f/ROADMAP.md) |
| PdfCraft | [`c1a41cc5c7c2460fb60af880af69ee28a0c71bd5`](https://github.com/storytold/pdfcraft/tree/c1a41cc5c7c2460fb60af880af69ee28a0c71bd5) | CLI inspect／render／run／batch／MCP；PDF 组织、注释、编辑等 crates；Web App；CLI 默认启用 mcp feature | alpha；既有 PDF 的 CJK／RTL 编辑、Office 转换、渲染保真仍有缺口；不能因有 PDF 读写就宣称所有 PDF 可无损编辑。[路线图](https://github.com/storytold/pdfcraft/blob/c1a41cc5c7c2460fb60af880af69ee28a0c71bd5/ROADMAP.md) |
| EffectCraft | [`549e9d825132986d6167c1432cd3328efcbb0278`](https://github.com/storytold/effectcraft/tree/549e9d825132986d6167c1432cd3328efcbb0278) | CLI commands／run／MCP；合成、关键帧、效果、表达式引擎；Web App | alpha；`.aep` 导入、真实素材保真、预览性能和稳定性不足。先作为隔离效果任务，不接管现有视频工程。[路线图](https://github.com/storytold/effectcraft/blob/549e9d825132986d6167c1432cd3328efcbb0278/ROADMAP.md) |
| DesignCraft | [`43a46c04bf8cd8c8a48a347f6deaa9613223aa54`](https://github.com/storytold/designcraft/tree/43a46c04bf8cd8c8a48a347f6deaa9613223aa54) | CLI run／commands／MCP；文档、排版、文字、PDF／IDML；Web App | pre-alpha；Primary Text Frame 自动加页仍有核心流程问题；INDD、IDML 实件和排版保真待补。可先验证受控模板排版。[路线图](https://github.com/storytold/designcraft/blob/43a46c04bf8cd8c8a48a347f6deaa9613223aa54/ROADMAP.md) |
| FigCraft | [`bcedfeba1079829fd96c3b38077cfcc76e03bb09`](https://github.com/storytold/figcraft/tree/bcedfeba1079829fd96c3b38077cfcc76e03bb09) | CLI commands／run／MCP；布局、组件、原型、文档引擎；Web App | alpha；`.fig` 读写为 best effort／实验性，实件和多人流程仍需验证。不能把内部组件模型直接当成本项目协作能力。[路线图](https://github.com/storytold/figcraft/blob/bcedfeba1079829fd96c3b38077cfcc76e03bb09/ROADMAP.md) |
| WordCraft | [`04f6f53b8a4d8140c7bb62f949b0a6099a473da1`](https://github.com/storytold/wordcraft/tree/04f6f53b8a4d8140c7bb62f949b0a6099a473da1) | CLI run／MCP；文档、分页、DOCX、渲染与 PDF；Web App | alpha；真实 DOCX 往返、图表／SmartArt 保留、分页和打印未达到替代 Word 的程度。[README](https://github.com/storytold/wordcraft/blob/04f6f53b8a4d8140c7bb62f949b0a6099a473da1/README.md) |
| SoundCraft | [`c0cb99340891d306e216582db465f3594b89dc1d`](https://github.com/storytold/soundcraft/tree/c0cb99340891d306e216582db465f3594b89dc1d) | CLI run／script／MCP；音频编辑、DSP、混音、bounce；Web App | pre-alpha；设备／缓冲配置、MIDI 录制和 AAF／OMF 交换是核心缺口。先做离线处理，实时录制另验。[README](https://github.com/storytold/soundcraft/blob/c0cb99340891d306e216582db465f3594b89dc1d/README.md) |
| DeckCraft | [`457406a7a5b62425e915926c8ccb0984e61a198c`](https://github.com/storytold/deckcraft/tree/457406a7a5b62425e915926c8ccb0984e61a198c) | CLI render／commands／run／MCP；幻灯片、PPTX、动画和 PDF；Web App | alpha；PPTX 实件往返、字体、图表、动画和展示深度需验收。不能把可导出 PPTX 等同 PowerPoint 保真。[路线图](https://github.com/storytold/deckcraft/blob/457406a7a5b62425e915926c8ccb0984e61a198c/ROADMAP.md) |
| CADCraft | [`e707ab4d7cc10102e550ad4c5bcecef1084a9baa`](https://github.com/storytold/cadcraft/tree/e707ab4d7cc10102e550ad4c5bcecef1084a9baa) | CLI info／convert／run／commands／MCP；2D 几何、DXF／DWG、约束；Web App | pre-alpha；路线图明确 4 个核心流程未通过，DWG 保存会丢弃未建模内容且未在 AutoCAD 核验。先限新建 2D／DXF／SVG，原 DWG 不覆盖。[路线图](https://github.com/storytold/cadcraft/blob/e707ab4d7cc10102e550ad4c5bcecef1084a9baa/ROADMAP.md) |
| GridCraft | [`84acf6293b1dc1fc09837524e035d674eb4d6741`](https://github.com/storytold/gridcraft/tree/84acf6293b1dc1fc09837524e035d674eb4d6741) | CLI eval／cat／run／commands／MCP；单元格、公式、计算、XLSX、图表；Web App | alpha；XLSX 保真、大表性能、图表／透视表、旧 XLS 与脚本语言等仍有差距。计算正确性要用实件单独核对。[README](https://github.com/storytold/gridcraft/blob/84acf6293b1dc1fc09837524e035d674eb4d6741/README.md) |

通用源码定位：每个仓库均核对了 `apps/<name>-cli/src/main.rs`、`apps/<name>-web/Cargo.toml`、根 `Cargo.toml`、`LICENSE-MIT` 和 `LICENSE-APACHE`。PhotoCraft CLI 的实际实现拆在 `apps/photocraft-cli/src/lib.rs`。这些是“代码入口存在”的证据；本次没有把每条命令运行一遍。

官网状态可能滞后：FilmCraft 官网平台列表尚未列 Web，但所查源码有 `apps/filmcraft-web`；PhotoCraft 官网的 PSD 字节往返描述与较新的 README 已不同。以固定版本的实现、限制和实测为准。官网的速度、覆盖率及路线图中的工时是上游自述，不作为本项目性能或交付承诺。

## PhotoCraft：优先复用 headless 引擎

[引擎源码](https://github.com/storytold/photocraft/blob/706638b2842a330cfc5c305c7860d0b7c9921960/crates/engine/src/lib.rs) 将文档、历史、命令注册集中到 `Session::execute`，UI、CLI、远程控制和 MCP 共用。可先验证图层、选区、调色、滤镜和格式处理；[`photocraft-algo`](https://github.com/storytold/photocraft/blob/706638b2842a330cfc5c305c7860d0b7c9921960/crates/algo/src/lib.rs) 已将滤镜、选区覆盖和瓦片读写分开。

[CLI 源码](https://github.com/storytold/photocraft/blob/706638b2842a330cfc5c305c7860d0b7c9921960/apps/photocraft-cli/src/lib.rs) 有两条适合内部服务的路径：

```text
# 一次性任务：参数由服务端根据白名单构造，禁止拼接模型提供的 shell。
photocraft-cli run <input> --cmd <approved-command> --params <validated-json> --out <output>

# 多步任务：不传 --port 时走 stdio JSONL，保留一个 headless session。
photocraft-cli serve --automation-read-root <job-input-dir> --automation-write-root <job-output-dir>
```

`serve` 提供 `engine.execute`、`engine.commands`、`doc.open/new/save/inspect/render`、`jobs.list/cancel` 等方法；也有 `photocraft-cli mcp`。建议先用内部 stdio 进程桥，不新增公网端口，不依赖桌面窗口持续绘制。此为拟接入方式，尚未运行。

[控制协议](https://github.com/storytold/photocraft/blob/706638b2842a330cfc5c305c7860d0b7c9921960/docs/control-protocol.md) 明确了几个适配条件：

- 桌面控制是 loopback JSONL，首帧需要认证；不同于公网 HTTP API。
- timeout 可能表示“未执行”，也可能表示“已开始但没有回执”。后者必须先查文档／任务状态，不能自动重投修改。
- 部分命令仍忽略未知参数；本项目必须在调用前校验完整参数，不能把上游 `execute` 原样暴露给模型。
- 文件读写受授权目录限制，打开／保存还会返回损失或缺失警告；这些警告必须保留给工程版本和结果卡片。

PSD 分两层验收：独立 `photocraft-psd` 解析后回写原始块，与经过文档模型编辑、重写图层和合成图，是不同承诺。上游 README 明确后者不保证字节相同；本项目不得用解析器测试替代编辑后 PSD 保真验收。[PSD 说明](https://github.com/storytold/photocraft/blob/706638b2842a330cfc5c305c7860d0b7c9921960/README.md#psd-without-compromise)

## VectorCraft：路径与描摹可独立评估

[引擎源码](https://github.com/storytold/vectorcraft/blob/a06717777828867557d759c674283304f63c04ae/crates/engine/src/lib.rs) 同样通过 `Session::execute` 执行带 JSON 参数的命令，并记录可重放的历史。`pathops`、`trace`、`svg`、`pdf` 是独立 crate 候选；需要明确文档／颜色／字体的转换契约，不能只替换渲染图片。

[MCP 文档](https://github.com/storytold/vectorcraft/blob/a06717777828867557d759c674283304f63c04ae/docs/mcp.md) 确认有独立的 headless 引擎和 CPU 渲染器：

```text
vectorcraft-cli mcp --headless --automation-read-root <job-input-dir> --automation-write-root <job-output-dir>
```

必须明确模式。默认 `vectorcraft-cli mcp` 会先尝试桌面连接，再回退 headless；本项目不可依赖这一隐式行为。headless 不提供桌面专属 `inspect_ui`、`type_text`、`open_panel` 和窗口截图。其[桌面 TCP 控制通道](https://github.com/storytold/vectorcraft/blob/a06717777828867557d759c674283304f63c04ae/docs/control-protocol.md) 仅监听回环地址，但没有认证；不能转发到公网，也不作为多访客共同桌面会话。

[`vectorcraft-trace`](https://github.com/storytold/vectorcraft/blob/a06717777828867557d759c674283304f63c04ae/crates/trace/src/lib.rs) 是传统描摹引擎：原色量化、连通区域、共享边界、亚像素定位、曲线拟合；也有细线中心线、颜色层叠等策略。它仍会依参数降色、去噪、平滑；“保网点”必须显式关闭会删小区域的处理，并检查尺寸缩放。上游有 64 MP 工作上限和大图缩小路径，适配器应返回实际处理尺寸，不允许静默把缩小结果称作原始细节。

上游[描摹质量测试说明](https://github.com/storytold/vectorcraft/blob/a06717777828867557d759c674283304f63c04ae/docs/image-trace-quality.md) 提供可参考的指标：颜色差异、边缘偏移、丢失边界、孔洞、细线宽度、路径／锚点数和缝隙。这些测试是上游自建合成图测试；不能当成本项目用户网点图片已经通过，也不能据此宣称优于 Illustrator。

## WASM 与引擎嵌入的区别

13 套仓库都有 Web app crate；PhotoCraft／VectorCraft 所查 Web 入口启动的是 `eframe::WebRunner` 和整套 egui 界面，并处理浏览器文件打开／下载。本次未找到能够直接替换本项目画布、保持原 UI 的稳定 JS `execute` SDK。

可选路线：

1. **优先内部 headless 桥**：固定 CLI 版本，每个工程／任务隔离进程和目录，由 Node 图片服务负责校验、排队、存档与资产回传。先验证少量命令，不加载整套上游 UI。
2. **再提取 Rust crate／WASM facade**：对高频路径、描摹等建立窄的类型化接口，暴露明确输入和输出。需要自行处理内存、字体、颜色、错误和版本兼容；不能直接假定原生 crates 全部适于浏览器主线程。
3. **完整 Web App 只作对照**：独立测试上游实现时可使用；不能用 iframe 换掉原工作台，冒充“界面不变的接入”。

上游网站部分构建说明仍写 Rust 1.90；本次 PhotoCraft／VectorCraft 根 Cargo 已声明 Rust 1.95。实际构建必须按固定提交的工具链和 lockfile，不沿用营销页的最低版本。

## 本项目统一 Agent 控制契约

```text
原按钮／原聊天
  → 本项目操作注册表（operationId、参数 schema、能力状态）
  → 权限与 baseRevision 校验、幂等账本
  → 本地算法／专用模型／生成模型／已验收的 Craft adapter
  → 资产与原生工程保存、像素／路径检查
  → 原结果卡片或直接应用＋撤销
  → 同一文档版本供画布、聊天、历史和下载引用
```

这是接入设计，不表示上述 Craft adapter 已实现。

### 可用工具白名单

- 模型只获得已配置、已运行验收的 `operationId`；按钮与 Agent 走相同实现。不能仅因上游列出某命令，就将它标为可用。
- 每个工具记录引擎／源码版本、输入类型、参数 schema、输出格式、是否改文档、资源预算、超时语义、可撤销性和真实能力状态。
- `execute`／`run_command` 是适配器内部实现，不能成为模型可任意透传的万能工具。禁止模型传 shell、任意路径、环境配置、插件安装或未授权网络调用。
- 首批候选只覆盖确定性读写和编辑：尺寸／裁切／变换、调色／滤镜、局部擦除、图层与文字、路径／布尔、描摹、PDF 组织和受控模板排版。每项通过实测后再开放。
- 工程资产由服务端解析为任务目录内的输入；输出先成为不可变资产，再用文档命令提交。失败、未知回执和取消均保存状态，不切换到生成模型“补做”。
- 当前正在开发的本地算法能力与未来 Craft 能力分别标识处理器。非 AI 操作必须能证明生成／聊天／视觉模型调用为零；“Agent 发起算法”不等于图片生成。
- 多步修改在分支执行；最终接受检查主文档版本。网络断线不能重复收费提交；同样不能重复已开始的非幂等原生编辑。

## 原生工程、像素与向量往返验收

| 验收项 | 必须保存和检查的证据 |
|---|---|
| 原界面接入 | 从原首页菜单／弹窗／聊天执行；升级前后布局截图；不能用上游独立页面或 `/image2` 结果替代 |
| 原生工程 | 原文件 immutable；工作副本保存对应 `.pcraft`／`.vectorcraft` 等原生格式、引擎版本、输入关系与输出 hash；重新打开后检查对象、字体、遮罩和层序 |
| 编辑模型映射 | 本项目层 ID 与上游对象 ID 显式映射；不支持的对象保留原始块或裁片并标记，不悄悄栅格化；导入／导出警告进入工程记录 |
| 局部像素 | 在同一解码／色彩基准下，编辑区外 RGBA 差异为零；保护区优先、羽化向内；覆盖旋转、裁切、重叠遮罩 |
| 中文／字体 | 连续改字、字距、字号、颜色不生成图片；使用实际字体资产；刷新／切换／重开不丢字体、不截字；未知字体保留原像素与待确认状态 |
| SVG／Logo | 路径、填色、描边、变换、孔洞与裁切关系保留；生成或调色背景不改 Logo；用语义和重渲染比较，不只比较 SVG 字符串 |
| 描摹 | 固定原图尺寸、阈值、颜色、去噪和容差；统计小点／细孔／连通性、边缘偏移、线宽和路径数；不得用嵌入位图假装矢量，不默认先 AI 平涂或超分 |
| PSD／PDF／办公格式 | 分开记录可打开、可编辑、可重新打开及在目标软件中的保真；解析器块往返不等于编辑往返；SVG/PDF 可明确包含位图裁片 |
| 尺寸与性能 | 输出真实宽高、处理尺寸、峰值内存、排队和执行耗时；4K、大图、很多小路径和中文排版独立样例；上游性能宣传不能替代测量 |
| Agent 与恢复 | 相同命令从按钮和聊天产生相同结果；重复提交、丢回执、取消、进程重启与版本冲突有实测；最终资产及引用一致 |
| 访客隔离 | 每个访客只能读取自身文档／任务／资产；原生文件引用不能越过任务目录；相邻工程和并发进程不共享会话状态 |

对每个应用单独建立能力清单和格式样例库。适配器级单测通过、CLI 可启动、原首页通过和生产上线是不同验收状态。

## 分阶段接入顺序

1. **本地基础控制**：完成现有图片模块的统一操作、算法调色／滤镜与原色描摹；保持原 UI，补齐操作回执和零模型调用证据。
2. **图像／矢量双引擎试点**：固定 PhotoCraft、VectorCraft 版本，在隔离开发环境验证小白名单；比较原生文件、像素和路径；达到收益再接入原按钮。
3. **PDF／排版与文档输出**：PdfCraft 页面组织优先；DesignCraft 受控模板作为实验；再评估 WordCraft、DeckCraft、GridCraft。中文与常用格式往返先通过，再扩大输入范围。
4. **界面设计与照片目录**：FigCraft、LightCraft 单独模型适配；协作、素材目录、RAW 和未知字体状态不能直接套用图片位图层。
5. **视频／音频／动效／CAD**：FilmCraft、EffectCraft、SoundCraft、CADCraft 走各自任务和工程格式；先离线处理与新建输出，已有视频生产链和原工程保留，独立验收后再接入。

这组顺序是当前默认实施建议，不是时间承诺。每阶段都可提供 AI 控制已验收工具；未接入的功能应报告能力不可用，不制造成功结果。

## 许可与发布

13 个仓库的 Cargo 配置和许可文件均为 `MIT OR Apache-2.0`。接入发布时选择适用许可、保留版权和许可文本；字体、图标、样例图片及其他 bundled assets 按各仓库 `ATTRIBUTION.md`／`ASSETS.md` 分别处理。

软件许可不覆盖 ArtCraft 商标。PhotoCraft 等仓库的 [`LICENSE-brand.txt`](https://github.com/storytold/photocraft/blob/706638b2842a330cfc5c305c7860d0b7c9921960/docs/brand/LICENSE-brand.txt) 对品牌另有限制；本项目复用引擎继续使用自己的名称、Logo 和原 UI，不复制 ArtCraft 品牌标识或宣称其官方背书。这里只记录源码许可事实，最终分发包还需要核对实际携带的第三方素材。

## 审计限制与待办

- 已核验：官方 13 仓库、固定 main SHA、两种许可文件、CLI 和 Web 构建入口；重点读过 PhotoCraft／VectorCraft 引擎、控制协议、MCP、描摹和质量限制。
- 未核验：13 应用的二进制完整性／本机启动、全部命令真实行为、浏览器与桌面一致性、用户样例质量、4K 性能、中文字体覆盖、格式实件往返和本项目生产接入。
- 下一步：先挑选可量化的小操作；准备固定引擎二进制／crate 构建与 schema 适配；建立候选输出和能力验收记录；通过后才开放给 Agent 与原按钮。
- 本次一次 Jev 批量证据辅助判断出现多项低置信度，已由主审计按源码人工复核；未将模型判断当运行验收，也未重复请求追求高分。
