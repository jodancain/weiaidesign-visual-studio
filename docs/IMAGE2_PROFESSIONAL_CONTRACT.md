# 专业编辑 v3 契约（阶段 B 待实施）

2026-10-13，状态：设计已固定／工程尚未进入B验收。阶段A通过后再把本契约接入运行时；本文件不是功能已实现证明。

## Authority

ImageDocumentV3为权威，tldraw是交互代理。图层局部内容尺寸与六参数矩阵分别保存；矩阵唯一决定变换。变换操作以world delta提交，newLocal=inverse(parentWorld)×deltaWorld×oldWorld。透视/网格扭曲单独映射。旧x/y/rotation/w/h只用于兼容投影，不成为第二套可写真值。

## Document / Content

Document: schemaVersion3，id/name/revision/width/height/assetIds/layers/contentAssets/artboards/guides/savedSelections，resolution={dpiX,dpiY,unit:px|mm|in}，workingColor={space:srgb,bitDepth:8,alphaEncoding:straight}，renderVersion=weiai-rg-1，requiredFeatures。

Content descriptor: {id,kind:raster|svg|vector|text|preservedText|tiles,assetId,formatVersion}。源文件与衍生内容均不可变。大矢量/段落/瓦片以验证后的专用JSON资产存储，不塞metadata；批量更改一事务替换内容引用，不逐节点发layer命令。复制默认写时复制。

Layer: id/type/name/parentId/z/visible/locked/opacity/contentId/localBounds/[a,b,c,d,e,f]/blendMode/compositeMode(isolated|passthrough)/clipToLayerId/masks/effects/metadata。类型增加adjustment；effect有稳定id/type/enabled/params顺序列表，逐类型校验，不接受任意shader、脚本和URL。未实现能力不可用，不忽略未知效果。

Mask: id/kind(raster|vector)/contentId/channel(alpha|luminance)/coordinateSpace(layerLocal|document)/matrix/linked/enabled/inverted/density/featherPx。显示蒙版、保存选区、编辑与保护分别建模。保护优先且羽化向有效区内；局部操作外RGBA差异0。字体/内容/所有递归资源引用必须归属同访客并在工程登记。

## Shared renderGraph

prepareRenderGraph(document,resolver,options) → RenderGraph；measureRenderGraph(graph,scope) → Bounds；renderSoftware(engine,graph,request) → Pixels；exportSvg/exportPdf(graph,request) → Artifact。

固定图层次序、累计矩阵、内容、遮罩、混合、效果、字体布局。cache key包括内容/字体/蒙版hash、params、色彩、renderVersion、engineVersion和scope；穿透组包含背景依赖。browser Worker消息包含documentId/revision/frameId，旧帧不覆盖新帧；WASM对象finally释放。GPU预览另外验，软件共同路径是像素基准。

已探查CK0.42.0软件MakeSurface、PathBuilder、ParagraphStyle；PK1.0PathOps。CK必须locateFile自托管wasm，不能依赖wasmBinary参数；PK支持Uint8Array wasmBinary。64×48包级browser/node软件RGBA差异0只证明API单样例，不是工程验收。

## Migration / backwards compatibility

POST /documents/:id/migrate-v3 {sourceRevision,idempotencyKey} → 新文档/原快照/ID映射/回执。显式确认复制，不改旧工程，不执行或恢复未知旧收费任务，重复请求幂等。

位图使用源像素localBounds与T×R×S(layout/source)；SVG保viewBox原点/尺度；文字原布局字形坐标不得重复缩放；组width/height不解释成child缩放。未知字体为preservedText保原裁片/文本/待确认状态。v2历史ID与素材先预分配，逐版本迁移；旧PDF保持72DPI等效物理语义，新工程默认300DPI。

旧renderer与新Skia抗锯齿差异必须验；初始外观代理保真但不能假称全部高级语义可编辑。capabilities/requiredFeatures检查阻止旧客户端静默丢效果。原生工程v3完整往返；SVG/PDF允许明确标识的效果代理；PSD/兼容AI仅已验子集。
