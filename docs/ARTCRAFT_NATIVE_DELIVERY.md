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

2026-10-14 本地 macOS 已通过 全部 13 个引擎的真实跨任务闭环，并在最终 runtime 上统一复跑 13/13 通过。10 个适用引擎的中文渲染均有相同最终二进制 SHA 的实际字形及重开证据。完整 macOS arm64 包已通过真实二进制、固定源码、字体和许可证校验后组装；不以协议 mock 替代原生引擎通过。

原首页已实测素材打开、PNG/SVG 真实导出、候选接受、导出快照回画布、刷新恢复、原生历史恢复、工程包下载/上传后继续编辑。SVG 真实路径导出为 256×192；旧导出缺失的尺寸从同一不可变文件验证补读，回画布成为 SVG 图层并保留路径身份。已从原版本按钮实际撤销/重做，再在原图层弹窗修改单路径填色，验证 CSS 继承、无描边、描边宽度与另一条路径保持一致；版本日期按保存时间显示。全工程包另经过跨访客迁移、继续编辑和历史恢复，解码 RGBA 差异为 0。

原聊天区使用固定测试 LLM 回执及真实 PhotoCraft 完成三轮能力发现、编辑和导出；接受后原生工程升到版本 4，刷新后保持已接受，未重复执行。测试 fixture 已关闭，全程没有真实远端模型调用；此记录不代表自然语言模型效果验收。

2026-10-14 的 [完整图片 CI](https://github.com/jodancain/weiaidesign-visual-studio/actions/runs/38565144237) 对应源码 `cde5cc387afdbf1d7a4c034d4bc622694fa4ccca`：服务回归 362 项通过、1 项需要真实原生包的测试在普通 CI 中显式跳过；该原生测试在独立 PhotoCraft 矩阵中实际通过。客户端 117 项、Python 6 项、界面 4 项、真实 BFF/服务浏览器流程 1 项通过，typecheck、lint 和 Next.js 生产构建通过。lint 有 4 个既有警告、0 错误。

真实浏览器回迁使用 13,711,397 字节 ZIP，导入接口返回 HTTP 200；浏览器从选取文件到收到完整响应耗时 7,348 ms，服务端处理耗时 1,904 ms。导入前后均为 76 图层、版本 27，文字字体引用与实际渲染均验收通过，PNG、SVG、PDF、ZIP 四类导出完成。此前测试在异步导入完成前就用默认 5 秒窗口检查工程数量，本次实测显示文件编码、传输和服务响应的完整链路超过该窗口。测试现在等待实际导入响应，再检查工程数量、字体与画布；没有通过跳过错误或放宽最终内容断言掩盖失败。[该次浏览器证据](https://github.com/jodancain/weiaidesign-visual-studio/actions/runs/38565144237/artifacts/11895940095) 包含回执、请求摘要与截图，按工作流保留 7 天。

原首页选中已改单路径颜色的 SVG 后，聊天附件也通过文档、图层与版本引用最终外观。网页实际下载到 160×80 PNG，左侧 RGBA 为 `240,195,60,255`、右侧为 `18,58,188,255`，与画布同版本一致；历史原始 SVG 仍保持不可变。此操作未调用图片或视觉模型。

2026-10-14 的 [完整 Linux 原生矩阵](https://github.com/jodancain/weiaidesign-visual-studio/actions/runs/38561817904) 对应源码 `f1456bd70417a25ad8b78979d3c7b25152b7b297`：13/13 引擎实际编辑、导出和独立任务重开通过，适用的 10 个文字引擎通过中文实测，随后完整包组装成功。PhotoCraft 的真实 HTTP、重启、Agent 协议和全工程包跨访客回迁测试单独通过；SoundCraft 的非静音 PCM 与 GridCraft 的单元格值重开后一致。普通图片 CI 的更新源码为上文的 `cde5cc3`，此处保留原生构建的实际来源，不把新提交号追认成已测试的原生构建。

[完整 Linux x64 构建包](https://github.com/jodancain/weiaidesign-visual-studio/actions/runs/38561817904/artifacts/11895107002) 名为 `craft-native-complete-linux`，包含保留可执行权限的 `artcraft-complete-linux.tar.gz`、13 个二进制的清单及许可证。GitHub artifact ZIP 大小为 510,863,373 字节，其 SHA-256 为 `58a5d78f9ca86ee76844a8bda5b7d90c4a4fe4bc86602fce81cb27561dbeeda5`；这是 artifact 外层 ZIP 的摘要，不能当作内层 tar.gz 的摘要。工作流保留至 2026-10-28，下载后还须核对每个二进制和清单。

已下载的内层 `artcraft-complete-linux.tar.gz` 为 512,742,646 字节，SHA-256 为 `2b3f7753d2a6eb4d0b80d2eb1bb105fd53c1862b6bdfcdacee31c7aa8b9a1a36`。下载后再次逐个核验 13 个 ELF 二进制的字节数、SHA-256 与可执行权限，均符合包内清单；没有在 macOS 上执行 Linux 二进制。

Ubuntu runner 已真实通过独立网络命名空间、零 capabilities、宿主相邻文件不可读和受限 AppArmor 子进程检查。此记录证明 CI runner 和已固定构建包的结果；本轮完成源码、测试和 GitHub 推送，尚未切换生产。目标 DockerDesktop 生产容器仍需完成完整镜像、依赖和 Bubblewrap 隔离验证，再经原首页验收；只更新 Web 不能启用原生引擎。


## 中文能力边界

字体打包、真实文本编辑和原生渲染分别验收。`craft-cjk.integration.mjs` 使用 PhotoCraft、VectorCraft 逐字渲染“中、文、测、试、□”，检查实际像素轮廓彼此不同、非空；VectorCraft 导出的 SVG 为路径且不依赖整图位图或外部字体。删除初次任务目录后，再重开中文原生工程并比较解码 RGBA。macOS 与上述 Linux 矩阵分别完成实测。Film、Light、Effect、Design、Fig、Word、Deck、CAD 的五个中文/方框字形区分及原生重开检查也在两平台通过；Light 验证的是导出水印，不能当作持久文字对象。Design、Word 的 PDF 另经 Poppler 渲染与文字提取验证。CAD PDF 中文使用轮廓，可渲染但不是可搜索文字。Word DOCX 和 Deck PPTX 保存中文 XML，但没有嵌入字体部件，不据此声称独立 Office 文件在任意设备字体一致。

PDFCraft 固定版本的 `page_add_text` 只提供 Helvetica、Times、Courier，并明确仅接受 WinAnsi 西欧字符；新增中文文字会被上游拒绝。读取已有中文 PDF、在其他设计引擎完成中文排版后导出 PDF，与 PDFCraft 的新增文字能力分开记录。现有 Image2 文字层和 PDF 导出不因此降级，但不标称 PDFCraft 原生中文新增已接通。
