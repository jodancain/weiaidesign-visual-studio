# ArtCraft 原生能力接入与验收

本次在原首页的“项目与导出 → 专业工具”弹窗中接入 13 个 ArtCraft 原生引擎。画布、顶部栏、底部工具栏和右侧聊天布局保持原样。原有图片 CPU 操作和保细节描摹继续使用图片操作注册表。

上游公开应用与源代码入口：[ArtCraft Apps](https://getartcraft.com/apps)。这些应用的成熟度与可执行范围以固定版本的实际 CLI 为准，不代表与 Adobe 桌面软件逐项等价。

## 能力范围

| 引擎 | 主要领域 | 原生工程或交换格式 |
|---|---|---|
| PhotoCraft | 图层图片、选区、调整和滤镜 | PCraft、PNG |
| VectorCraft | 路径、绘图、描摹 | VectorCraft、SVG |
| FilmCraft | 素材、序列、剪辑 | FCProj、MP4 |
| LightCraft | 照片目录与显影 | 原生目录检查点、PNG |
| PdfCraft | PDF 页面、文字和图片 | PDF |
| EffectCraft | 合成与特效 | ECProj、MP4 |
| DesignCraft | 版面设计 | DesignCraft、PDF |
| FigCraft | 界面与节点设计 | FigCraft、PNG/SVG |
| WordCraft | 文字文档 | DOCX、PDF |
| SoundCraft | 音轨与混音 | SCraft、WAV |
| DeckCraft | 幻灯片 | DeckCraft、PPTX |
| CADCraft | CAD 图元 | DXF、PDF |
| GridCraft | 单元格与公式 | 工作簿检查点、XLSX |

表格描述接入目标格式；具体通过情况由后文真实测试记录确认。界面根据已安装二进制返回的能力状态启用功能，缺少引擎或隔离器会显示不可用。

所有已开放工具和命令均来自真实 MCP `tools/list` 和引擎命令目录。普通操作显示实际 JSON Schema 表单；仅提供参数说明的上游命令在高级操作中保留其原始说明与 JSON 参数输入。没有编造缺失的参数 Schema。

桌面点击、任意脚本、网络发布、账户、宿主系统操作和未配置模型的命令不开放给托管任务。传统算法降噪与依赖模型的降噪分别识别，失败不会切换到生成模型。

## 原界面与 AI 链路

```text
原首页菜单 / 原聊天区
    → 图片工程访客身份与素材归属
    → 原生工程 / 统一任务账本
    → 固定二进制 + 实际工具目录 + 参数校验
    → 独立任务目录 + 文件 / 网络隔离
    → 原生检查点、预览与真实格式输出
    → 候选审查与版本检查
    → 接受到原生工程；图片输出可作为导出快照放回原画布
```

AI 沿用现有工具调用协议与最多六轮循环：先通过 `craft_capabilities` 查实际能力、参数和工程，再提交受控原生任务。工具参数中的文件由 `{assetId}` 和 `{outputName}` 解析，不能直接传宿主路径或外网 URL。多步骤引用可以使用已完成步骤的结构化结果。

AI 的原生编辑只写持久任务分支。聊天卡片显示原生回执、预览、下载与对应版本；接受整个候选时，图片工程和原生工程的冲突检查与晋升在同一个数据库事务内完成。操作、重试、接受使用冻结请求与幂等键。

原生任务独立保存工作区检查点，包含所需素材与路径迁移信息。上游 CLI 的进程内撤销不能代替跨任务历史，因此另用持久版本恢复候选处理跨任务撤销。

## 矢量质量边界

原有“保细节”像素描摹保留，输出真实 SVG 路径，按既有像素验收执行。VectorCraft 的平滑描摹作为可编辑描摹模式，不能据其预览清晰度宣称像素完全一致。

VectorCraft 固定版本的 `ai_native` 使用 `vectorcraft_format::save_with` 产生自身 JSON，再由 PDF writer 嵌入名为 `vectorcraft-editing.vectorcraft` 的附件；此路径没有写出 Adobe Illustrator 的 `AIPrivateData` 编辑数据。托管出口因此去掉 `ai` 格式，并拒绝 `.ai` 输出名、格式别名与打开 AI 后的隐式原址保存。仍可导入用户已有 AI 文件；对外提供实际 PDF、SVG 与原生工程包，不用 PDF 容器冒充 Illustrator 工程。

2026-10-14 原生描摹专项：256×192 合成图包含 108 个小点、一个细孔和 140 像素的一像素细线。导出有 111 个真实路径、112 个闭合子路径，无整图位图嵌入；重合成保留 111 个连通区域、一个孔洞、108 个点中心及全部细线采样点。仍有 335 个二值遮罩像素差异、6,807 个 RGBA 通道差异，平均绝对通道误差约 2.2576。因此明确不替换像素保真描摹。

## 可复跑验收

构建与部署见 [原生构建和部署说明](ARTCRAFT_NATIVE_DEPLOYMENT.md)，接口见 [服务接口](ARTCRAFT_SERVICE_API.md)。固定源码、工具链与构建选项在 `services/image2/craft-engines.lock.json` 和构建清单中记录。

```sh
npm run test:image2
npm run test:image2:client
npm run typecheck
npm run lint
npm run build

# 真实原生引擎测试，必须提供构建包；不会用 mock 替代。
IMAGE2_CRAFT_BIN_DIR=/absolute/native/bin node services/image2/tests/craft-native.integration.mjs
IMAGE2_CRAFT_BIN_DIR=/absolute/native/bin node services/image2/tests/craft-vector.integration.mjs
IMAGE2_CRAFT_REAL_BIN_DIR=/absolute/native/bin node --test services/image2/tests/craft-service-native.test.mjs
```

真实引擎验收包括：实际编辑、格式结构检查、保存不可变检查点、删除首个任务工作目录、在独立任务内重开，再比较解码像素、音频 PCM 或单元格值。MP4 使用独立 ffprobe/ffmpeg 检查尺寸、时长和完整解码。

服务验收另测真实 HTTP、重启、访客隔离、重复提交、丢失响应、取消、候选接受、原生与图片分支冲突回滚。Agent 协议测试使用可控 LLM 回执和真实原生处理器；这证明工具协议与持久状态闭环，不能冒充真实远端模型的自然语言任务成功率。

## 当前交付记录

2026-10-14 本地 macOS 已通过 PhotoCraft、VectorCraft、FilmCraft、LightCraft、PdfCraft、EffectCraft、DesignCraft、FigCraft、WordCraft、SoundCraft、DeckCraft 的真实跨任务闭环。CADCraft 与 GridCraft 继续构建及真实验证；本记录不会以协议 mock 替代原生引擎通过。

原首页已实测素材打开、PNG/SVG 真实导出、候选接受、导出快照回画布、刷新恢复、原生历史恢复、工程包下载/上传后继续编辑。SVG 真实路径导出为 256×192；旧导出缺失的尺寸从同一不可变文件验证补读，回画布成为 SVG 图层并保留路径身份。全工程包另经过跨访客迁移、继续编辑和历史恢复，解码 RGBA 差异为 0。

原聊天区使用固定测试 LLM 回执及真实 PhotoCraft 完成三轮能力发现、编辑和导出；接受后原生工程升到版本 4，刷新后保持已接受，未重复执行。测试 fixture 已关闭，全程没有真实远端模型调用；此记录不代表自然语言模型效果验收。

服务回归当前 355 项通过，另 1 项真实原生门控测试单独运行通过；客户端 114 项通过。typecheck、lint 和 Next.js 生产构建通过。构建时检出了聊天正则在压缩输出中的反引号转义问题，修复后再次完成真实生产构建。

Ubuntu CI 已真实通过独立网络命名空间、零 capabilities、宿主相邻文件不可读和受限 AppArmor 子进程检查。完整 Linux 引擎矩阵仍是独立验收。代码推送、原生二进制分发、Linux 验收与正式生产部署分别记录；本地通过不代表线上已启用。


## 中文能力边界

字体打包、真实文本编辑和原生渲染分别验收。`craft-cjk.integration.mjs` 使用 VectorCraft 逐字渲染“中、文、测、试、□”，检查实际像素轮廓彼此不同、非空，导出的 SVG 为路径且不依赖整图位图或外部字体；再删除初次任务目录，重开中文原生工程并比较解码 RGBA。当前 macOS 二进制已按固定 craft-fonts 来源构建，结果仍不能代替 Linux 验收。Film、Light、Effect、Design、Fig、Word 的五个中文/方框字形区分及原生重开检查已通过；Design、Word 的 PDF 另经 Poppler 渲染与文字提取验证。Word 的 DOCX 保存中文文本，但没有嵌入字体部件，不据此声称独立 DOCX 在任意设备字体一致。

PDFCraft 固定版本的 `page_add_text` 只提供 Helvetica、Times、Courier，并明确仅接受 WinAnsi 西欧字符；新增中文文字会被上游拒绝。读取已有中文 PDF、在其他设计引擎完成中文排版后导出 PDF，与 PDFCraft 的新增文字能力分开记录。现有 Image2 文字层和 PDF 导出不因此降级，但不标称 PDFCraft 原生中文新增已接通。
