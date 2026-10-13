# DLSS 5 / 社区 NR 依赖

Studio 的增强入口调用社区 DLSS Video Player 的 NR Feature 18 链路。自研集成在 `workers/code-video/enhance.mjs`、`worker.mjs` 和 `gateway/studio/code-jobs.mjs`：它绑定源视频与运行库哈希，验证实际 Feature 18 创建/evaluate 日志，保留原音轨，并产出增强版与同步并排比较。前端入口与后台源码都已包含在仓库。

这是社区 NR 实验集成。现有执行记录不等于 NVIDIA 官方 DLSS 5 对 RTX 3070 的支持声明，也不承诺每个素材画质更好。固定参数为 `nr / natural / 1 pass / processing scale 100%`，不启用帧生成或 Super Resolution。回执中的 `verifiedNeuralFrames` 保持 `null`；输出帧数不被当作逐帧 NR 验证数。

## 精确依赖版本

`dependency-lock.json` 固定以下已核对的上游来源：

- [源码仓库](https://github.com/2600th/dlss5-video-player)，MIT 源码。
- [固定源码提交](https://github.com/2600th/dlss5-video-player/tree/9752b5667284f23c21ead46f14abc971ecba48c6)：`9752b5667284f23c21ead46f14abc971ecba48c6`。
- [Release](https://github.com/2600th/dlss5-video-player/releases/tag/dlss5-video-player-v0.27.0)，tag 为 `dlss5-video-player-v0.27.0`。
- 完整 ZIP：`dlss5-video-player-v0.27.0-win64.zip`，395738623 字节，SHA-256 `a371e15cf5f935942534430a0ac1f453725a38ec2fb38aa81de7493836ca7677`。

上游已有完整 C++/CMake 转换器与播放器源码；研究 checkout 没有本项目修改，故不重复纳入本项目源码树。需要检查或构建上游时，可 clone 后 checkout 上述提交，并遵循该提交的 `docs/BUILDING.md`。源码构建需要 Windows x64、MSVC/Visual Studio C++ workload、Windows SDK、CMake，以及上游固定的 NVIDIA DLSS SDK；这些外部依赖不在本项目包内。

NR 实际执行还需要可用的 Windows 交互桌面、GPU/驱动、完整匹配的实验运行包、FFmpeg/ffprobe。core 包没有实验 NR 运行库。SDK、第三方 DLL、模型/运行资源保持外部依赖：上游 `THIRD_PARTY.md` 将源码许可与 NVIDIA/实验二进制条款分开，并说明组合运行包的再分发权限仍未解决。

## 只读校验

从恢复后的项目根执行：

```sh
node tools/dlss5/verify-runtime.mjs --lock-only
node tools/dlss5/verify-runtime.mjs --package-dir /path/to/operator-provided-package
```

在未恢复的仓库中，也可执行 `node runtime/source/tools/dlss5/verify-runtime.mjs --lock-only`。工具按自身位置找到 sibling worker 源码，不依赖当前工作目录。

`--lock-only` 验证依赖锁的版本、URL、完整 ZIP 摘要、参数和文件名，并将 exe/DLL SHA 与 `enhance.mjs` 的实际常量及 CLI 参数核对。`--package-dir` 额外检查操作人员提供的目录中 `dlss5-convert.exe` 和 `neural-runtime/nvngx_dlssnr.dll` 的 SHA。匹配返回 0；缺失、不符或不可读返回非零和小型 JSON 结果。

校验不执行二进制、下载文件、启动服务或部署。它验证当前适配器要求的两项文件身份；完整运行包的其他组件仍须按上游 lock/说明准备，实际 GPU 执行和影片质量需单独验收。

上游源代码重新编译的 exe SHA 可能不同于已验发行包。不能直接修改 SHA 常量让任意新包通过；替换版本需另外核对来源、运行配置、Feature 18 回执、音轨/时轴和视觉结果，再同步 worker 与 gateway 的版本绑定。
