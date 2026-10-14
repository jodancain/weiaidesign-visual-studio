# 拼装 ArtCraft 原生引擎部署包

`scripts/assemble-craft-bundle.mjs` 把已下载的原生构建产物拼成一个完整目录。它不下载、不编译、不运行任何引擎，也不修改生产服务。输入必须覆盖当前 `services/image2/craft-engines.lock.json` 中的全部 13 个引擎。

## 环境和输入

- 拼装机：Linux 或 macOS，Node.js 22，以及 `/usr/bin/python3`。Python 仅用于最后一步固定的系统原子重命名调用，不安装库、不访问网络。
- 输入：一个或多个包含 `manifest.json`、对应 `*-cli` 和 `licenses/` 的目录。GitHub 每个引擎 artifact 的解压根目录就是一个输入；已拼好的完整 `bin/` 也可以作为单个输入。
- 输出：父目录已经存在，目标目录必须不存在。输入和输出不得重叠。
- 所有输入的 `platform` 和 `arch` 必须一致。可以在 macOS 上拼装 Linux 文件，但这不等于在 macOS 上验证了 Linux 引擎。

当前支持拼装 Linux/macOS 的 x64、arm64 产物。Windows 和未定义的目标三元组会明确拒绝。不要混用不同 source lock 或不同平台的 artifact。

## 从 GitHub 下载并拼装

先选择一次 `ArtCraft native engines` 工作流的实际 run，确认它以 `engine=all` 和所需平台执行，并逐项核对 13 个引擎的原生检查结果。以下命令使用 Linux artifact 名称；macOS 改为 `craft-native-macos-*`。每次使用一个新的下载目录，避免混入其他 run 的产物。

```bash
RUN_ID=实际的工作流运行编号
gh run view "$RUN_ID" --repo jodancain/weiaidesign-visual-studio
gh run download "$RUN_ID" \
  --repo jodancain/weiaidesign-visual-studio \
  --pattern 'craft-native-linux-*' \
  --dir ./output/craft-download-run
```

不要使用 `--merge` 把 13 份 `manifest.json` 直接覆盖到同一个目录。原生验收证据的 artifact 名称是 `craft-native-evidence-…`，与二进制包分开保存；拼装工具不会把日志当作引擎文件。

在仓库 `web/` 根目录执行：

```bash
node scripts/assemble-craft-bundle.mjs \
  --input ./output/craft-download-run/craft-native-linux-photocraft \
  --input ./output/craft-download-run/craft-native-linux-vectorcraft \
  --input ./output/craft-download-run/craft-native-linux-filmcraft \
  --input ./output/craft-download-run/craft-native-linux-lightcraft \
  --input ./output/craft-download-run/craft-native-linux-pdfcraft \
  --input ./output/craft-download-run/craft-native-linux-effectcraft \
  --input ./output/craft-download-run/craft-native-linux-designcraft \
  --input ./output/craft-download-run/craft-native-linux-figcraft \
  --input ./output/craft-download-run/craft-native-linux-wordcraft \
  --input ./output/craft-download-run/craft-native-linux-soundcraft \
  --input ./output/craft-download-run/craft-native-linux-deckcraft \
  --input ./output/craft-download-run/craft-native-linux-cadcraft \
  --input ./output/craft-download-run/craft-native-linux-gridcraft \
  --output ./output/craft-linux-complete
```

完整成功后输出 JSON，包含实际 `binDirectory`、平台、架构及 13 个引擎 ID。产物结构为：

```text
craft-linux-complete/
  assembly.json
  bin/
    manifest.json
    photocraft-cli
    …其余 12 个引擎…
    licenses/
      craft-fonts/
      photocraft/
      …其余引擎的许可证和构建来源…
```

部署配置使用打印出的 **`binDirectory`**，即上述 `craft-linux-complete/bin`；它的根目录才包含运行时所需的 `manifest.json`。`assembly.json` 记录源锁 hash、输入 manifest hash、合并后的许可证文件 hash，以及“仅文件校验、未运行原生引擎”的验证范围。它不包含拼装机的输入绝对路径。

## 校验与失败行为

工具要求 13 个锁定引擎各出现一次，并检查 `sourceCommit`、二进制文件名、实际字节数和 SHA-256。构建元数据还需匹配当前源锁 hash、固定 Rust 版本、package/features、平台三元组、字体来源及 Cargo.lock。每个引擎必须附带 BUILD/SOURCE/依赖记录和许可证；共享字体 provenance 与 manifest 会验证校验值。

符号链接、特殊文件、路径穿越、不安全路径、未列入 manifest 的根目录文件、大小写冲突、缺失或重复引擎、混平台/架构、被修改的二进制都直接失败。公共许可证同名文件只有在实际字节完全相同时才能合并；不同内容不会择一保留或覆盖。输入在读取期间发生变化也会失败。

工作文件先写入输出同级的临时目录。所有文件通过后，Linux 使用 `renameat2(RENAME_NOREPLACE)`，macOS 使用 `renamex_np(RENAME_EXCL)` 一次发布完整目录。现有文件、空目录、非空目录及并发出现的目标均不能被覆盖。系统 Python 或所需系统调用不可用时明确失败，不退回可覆盖目标的普通 rename。正常异常会清理临时目录；进程被强制终止可能留下 `.目标名.assembling-*`，确认进程已结束后可删除该残留，不能把它当成已发布部署包。

## 独立验收门槛

1. **源码与拼装测试**：运行 `node --test services/image2/tests/craft-bundle-assembly.test.mjs`，或既有 `npm test --prefix services/image2`。夹具使用 13 份小型非原生字节及真实 source lock 元数据，验证校验、拒绝和原子发布；这些测试不构成任何引擎的原生验收。
2. **目标平台原生验收**：保留该次 CI 每个引擎的真实创建、编辑、checkpoint 重开、预览/导出和适用的中文、网点测试结果。文件 hash 通过不能证明可执行文件实现了这些能力；manifest 自身也不是供应链签名。
3. **生产验收**：在实际 Linux 主机/最终容器中验证动态库、沙箱、能力接口、访客隔离和原首页闭环，再依授权部署。拼装完成不会自动部署，也不能替代生产验收。具体部署边界见 [原生部署说明](ARTCRAFT_NATIVE_DEPLOYMENT.md)。
