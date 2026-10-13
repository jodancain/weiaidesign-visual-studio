# 开发源码索引

仓库根目录为 Web 工程，后台源码位于 `runtime/source/`。`runtime/restore.py` 从选定提交恢复原来的 `web/`、`gateway/`、`workers/` 并列目录。下表按实际源码组织，进行中的编辑器阶段不表示完整产品验收。

| 功能 | Web 源码 | 后台与运行源码 |
|---|---|---|
| 原首页无限画布与图片 Agent | `app/page.tsx`、`app/api/agent-chat/` | `app/api/v1/_lib/visual-api.ts`、`services/image2/agent.mjs` |
| 本体视频法、锚图、审核与分镜 | `app/ontology/`、`app/api/v1/ontology/`、`app/api/v1/_lib/ontology.ts` | `runtime/source/gateway/node-gateway.mjs`、Blender worker；方法与示例见 `ontology-video-method.md` |
| Studio v3 场景、导演台、动画与剪辑 | `components/studio/`、`lib/studio/`、`app/api/v3/` | `runtime/source/gateway/studio/`、`runtime/source/workers/blender-story/` |
| Three / Remotion 代码视频 | `lib/studio/code-scene/`、导演台与序列时间线 | `runtime/source/workers/code-video/`、网关 `code-jobs.mjs` / `code-schema.mjs` |
| DLSS 5 / NR 增强与原版对比 | `StudioWorkspace.tsx`、`StudioPipeline.tsx`、`VideoVersions.tsx` | `runtime/source/workers/code-video/enhance.mjs`、`worker.mjs`、网关 `code-jobs.mjs`；见 `DLSS5_NR.md` |
| Opus 后期特效与版本来源 | Studio 版本选择与特效界面 | 网关 `effects-*.mjs`、worker `effects*.mjs`、FFmpeg 合成器 |
| 图片 2.0 原界面接入、草稿与恢复 | `components/image2/`、`lib/image2/`、原首页 | `services/image2/`、独立 SQLite 与不可变资产 |
| 字体、SVG、mask、像素加工与导出 | 字体／元素／消除／矢量／导出原按钮 | `services/image2/processors.mjs`、`exports.mjs`、`svg-normalize.mjs`、字体与许可证 |
| 图片专业编辑分阶段升级 | `IMAGE2_PROFESSIONAL_PLAN.md`、`IMAGE2_PROFESSIONAL_CONTRACT.md` | `services/image2/core/`、v3 文档与迁移源码属于进行中的开发，阶段门槛以合同为准 |
| 专用图片模型与 CPU OCR | 图片任务与 Agent 的操作分流 | `services/image2/vision-worker/`、模型来源清单；权重单独配置 |
| 归档、代理、部署与恢复 | `ops/windows/`、Image2 Compose / Dockerfile | `runtime/source/nas-storage/`、`relay-proxy/`、`docker-compose.studio.yml`、SHA 清单和恢复工具 |

## 源码核验

```sh
npm ci
npm ci --prefix services/image2
npm run test:image2
npm run test:image2:client
npm run test:studio
npm run lint
npm run build
npm run typecheck
python3 runtime/restore.py --verify-only
```

恢复后的完整源码目录还可以运行网关和 worker 测试。Windows GPU NR、原生 Blender、真实专用模型、生产发布与用户素材效果分别验收；单元测试和源码同步不会执行这些流程。实际环境文件、数据库、模型权重、生成影片、内部验收记录和运行日志不进入公开源码仓库。
