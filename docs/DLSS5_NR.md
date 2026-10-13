# DLSS 5 / NR 功能源码

Studio 的增强功能采用社区 DLSS Video Player 的 NR Feature 18 链路。源视频作为不可变输入，生成独立增强版与并排比较，不覆盖原版；代码视频可先增强无字幕画面，再使用原剪辑、字幕与音轨合成。

## 本项目实现

| 层 | 源码 | 作用 |
|---|---|---|
| 页面 | `components/studio/StudioWorkspace.tsx`、`StudioPipeline.tsx`、`VideoVersions.tsx` | 提交增强、展示后台进度、播放／对比／使用版本 |
| 网关 | `runtime/source/gateway/studio/code-jobs.mjs`、`code-routes.mjs` | 冻结来源和参数、持久化任务、校验 worker 身份及 NR／媒体回执 |
| Worker | `runtime/source/workers/code-video/worker.mjs` | 鉴权、幂等、桌面／GPU等待、取消与恢复 |
| 增强执行 | `runtime/source/workers/code-video/enhance.mjs` | 固定程序／DLL SHA、调用 NR、读取新 Feature 18 日志、规范24fps、保留原音轨并生成比较视频 |
| 外部依赖 | `runtime/source/tools/dlss5/` | 固定第三方源提交与运行包版本、校验操作者自备的依赖文件 |

固定参数为 `nr / natural / 1 pass / processing-scale 100`，不启用插帧或超分。结果须具有实际新执行日志，且输出帧数、尺寸、源身份与回执匹配。配置了程序路径或收到可播放视频本身不代表 NR 已执行。

## 依赖与运行

先按 `runtime/README.md` 恢复完整源码，再按 `tools/dlss5/README.md` 准备 Windows x64、交互桌面、可用GPU／驱动、完整对应运行包和 FFmpeg／ffprobe。将 `STUDIO_NR_EXE` 配置为操作者准备的转换器路径。依赖检查工具不执行程序、不下载、不部署。

上游源码固定在 [dlss5-video-player-v0.27.0](https://github.com/2600th/dlss5-video-player/tree/9752b5667284f23c21ead46f14abc971ecba48c6)。转换器 C++ 是该第三方项目的一部分；本项目提供上述集成、调度及结果验证源码。SDK、实验DLL和运行包受各自条款约束，不作为本项目开发源码重复发布。源代码重编通常产生不同程序SHA，不能直接替换固定的已验运行包。

## 检查范围

从恢复后的项目根运行：

```sh
node tools/dlss5/verify-runtime.mjs --lock-only
node tools/dlss5/verify-runtime.mjs --package-dir /path/to/operator-supplied-package
node --test gateway/studio/code-tasks.test.mjs workers/code-video/worker.test.mjs
npm run test:studio --prefix web
```

本地契约测试验证来源冻结、固定参数、Feature 18 证据、回执和版本行为。实际Windows桌面／GPU处理、驱动兼容性和最终画面效果需要独立核验；本次源码更新不启动这类运行任务。
