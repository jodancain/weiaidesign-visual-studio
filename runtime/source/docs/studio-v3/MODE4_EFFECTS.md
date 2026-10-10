# 模式 4：Opus 5.5 特效员

模式 4 在已有模式 3（Three / Remotion）成片及其后期版本上合成特效，保留源视频。它使用 Opus 规划受限效果数据，再由 Canvas2D 和 FFmpeg 逐帧执行。它不是 Adobe After Effects 的自动化接口，不生成新的故事底片，也不自动调用 DLSS / NR。

## 用户路径

在视频工作台打开包含模式 3 成片的工程，选择“模式 4 · Opus 特效员”。公开示例先复制为自己的工程。选定具体版本，描述所需效果，点击“制作特效版”。计划及合成均为持久任务，后台衔接不依赖页面打开；界面可查看中文进度、效果层说明、取消及安全恢复。

完成后提供特效版和原版／特效版同步对比。原版始终保留；只有明确选择“使用此版本”才修改当前引用。默认不新增旁白，复制原 AAC 音轨及时间轴。

## API 与不可变输入

- `POST /api/v3/projects/:id/effects-plans`：`baseRevision, sourceAssetId, sourceHash, prompt, idempotencyKey`。默认后台自动衔接；内部持久化 autoRender 意图。Opus 接收最多六张真实源帧及只读镜头上下文，返回 EffectsProgram。
- `POST /api/v3/projects/:id/effects-renders`：`baseRevision, planJobId, planHash, sourceAssetId, sourceHash, idempotencyKey`。同一计划只创建一个合成任务，前端恢复与后台同时提交也去重。
- 任务查询、取消与重试沿用 v3 jobs 接口。模型受理未知不会自动重复提交；不合法计划最多修复两次。安全重试合成使用同一 job ID 及 PNG 检查点，不重调模型。

模型输出只能包含已定义的 JSON 参数，不接受表达式、代码、滤镜字符串、路径、网址或插件。精确源身份由真实已完成任务与服务端复制记录证明，上传者提供的 metadata 不能授权来源。SQLite schema 4 增加 asset_origins，不改旧工程、素材和任务记录。

## 效果及实际边界

支持光晕、粒子、雨、雾、环形脉冲、光迹和暗角；使用绝对整数帧、位置与透明度关键帧和固定种子。最多32个图层、1024个粒子／雾团预算。空效果、未知字段、非有限数值及越界帧拒绝执行。

首版按画面坐标叠层，不具备自动追踪、抠像或基于深度的遮挡。源 MP4 已烧录字幕时保护底部至少16%加8像素，保护边上方24像素渐隐。特效输出保留字幕内容，但重新编码不保证底片像素逐点相同。其他位置的既有文字需要在效果描述中避让。

选中的 DLSS 版直接作为输入，不替换回旧 clean 片。输出固定源帧数、24fps、尺寸与时长；单画面 effects 和宽度翻倍 comparison 分别保存。工作台和公开播放器以明确来源区分 Opus 特效、DLSS 和两个原始导出器。
