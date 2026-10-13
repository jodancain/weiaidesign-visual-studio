# 专业编辑 v3 契约（阶段 B 实施与验收）

2026-10-13：v3账本、复制迁移、共享软件渲染、CPU任务与原弹窗适配已实现；服务与纯客户端验收通过，原首页实际交互仍待工具可访问的正常页面。用户已授权完成B后将A+B一起部署，尚未切换生产。

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

## 当前能力与灰度

原首页主布局不变。默认工程保留现有生成/聊天链路；在版本弹窗显式复制为精确编辑工程，或从空画布创建300DPI精确编辑工程。professionalSource允许重新打开原工程；复制不改变旧工程和历史，不迁移未知任务。

精确编辑工程支持六参数矩阵、8种混合、隔离组与受限穿透组、剪贴、位图/矢量蒙版、链接/坐标/密度/羽化/反相、保存选区、画板与参考线管理。纸底与参考线是工作区参考，不进入导出像素。普通CPU操作通过不可变内容COW提交；存在显示蒙版/效果/剪贴的像素操作明确拒绝隐式烘焙。精确编辑工程的专用模型、生成与后台Agent当前不可用；原工程链路保持。

GET render-resource携带revision/layerId/role，返回RGBA base64或真实路径，role按实际图层/蒙版引用校验。实际字体通过注册字体的字形路径渲染，SVG通过安全外观代理。浏览器Worker与Node共享相同核心和资源。

PNG保当前外观；SVG/PDF现含共同渲染的位图外观代理，原路径/字体保在原生工程包。PSD/高级文字/透视/扭曲/瓦片/调整层和路径编辑不计入B。Node和VM测试不计为原首页/生产验收；4K压力测试未达到完整专业计划的交互目标。
