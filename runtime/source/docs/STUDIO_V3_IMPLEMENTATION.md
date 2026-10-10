# Studio 3.0 API 与实现契约

更新：2026-10-01。描述当前源码合同，不代表生产已发布。范围是视频页，图片页与原 v1 路由保留。部署、恢复及验收门槛见 [公开运行说明](https://github.com/jodancain/weiaidesign-visual-studio/blob/main/runtime/README.md)。

## 结构与数据

Next 视频工作台 → Next `/api/v3` BFF → Node gateway 的 `gateway/studio/` → SQLite/不可变资产、本地 compositor、独立 Blender worker 或视频提供方。类型源为 `web/lib/studio/types.ts`，`domain.mjs` 做最终校验；项目 `schemaVersion:3`，SQLite `user_version:2`，二者不同。

时间为整数帧，固定 24 fps，区间 `[startFrame,endFrame)`；240 帧等于 10 秒。3D 单位为米、Y-up，四元数按 `[x,y,z,w]`。普通 gateway JSON 成功响应为 `{data:value}`，错误为 `{detail,code?}`；HTML、媒体和 worker 响应不套此 envelope。

项目修改带 `baseRevision`，过期版本返回 409。`commandId` 和任务 `idempotencyKey` 持久去重，同一个 key 不能提交不同输入。用户编辑可 undo/redo，资产/takes/approval 由服务端管理。`viewport` 只记录画布状态，不改变审核哈希；主体卡绑定场景对象、身份图和可选 GLB，相关身份/模型内容参与镜头审核。

页面入口：仅运行时 `STUDIO_V3_DEFAULT=1` 才让 `/video` 默认进入新版；默认 0 保持旧页。`/video/studio` 为新版独立入口，`/video/legacy` 始终保留。真实 AI 成片尚未确认验收，不默认切生产主入口。

## 鉴权与能力

gateway 全部 `/api/v3/*`（含媒体/脚本）要求安装级 VIDEO_API_TOKEN Bearer；当前没有逐用户/租户资源隔离模型。

BFF 从 STUDIO_GATEWAY_URL 或 VIDEO_API_PROXY_BASE_URL 转发，移除末尾 `/api/v1` 或 `/api/v3`；用 VIDEO_API_PROXY_TOKEN，回退 VIDEO_API_TOKEN，作为服务端上游凭据。最长请求 180 秒。

浏览器门禁由 REQUIRE_ACCESS_TOKEN=1 启用；未启用时现有 Next 门禁默认放行，不能以“gateway 有 token”证明站点已受保护。Next `POST /api/v3/session {token}` 校验访问码，建立一小时 HttpOnly、SameSite=Strict 会话，Cookie 路径 `/api/v3`，HTTPS 为 Secure。显式 Authorization 优先；写请求的异站 Origin 被拒。

能力 `{video,llm,model,referenceMode,ffmpeg,blender}` 中，video/llm 只表示配置存在；ffmpeg 检查可执行文件，blender 要求 worker 真实探测通过。配置状态不能代替真实提供方调用与产物验收。

## Gateway API

以下路径均以 `/api/v3` 为前缀。

| 方法与路径 | 输入与返回 |
|---|---|
| GET /capabilities | 能力对象 |
| GET /projects | 项目摘要列表 |
| POST /projects | `{name?,demo?}` → 项目；demo 默认三人五镜、240 帧 |
| GET /projects/:id | 完整项目 |
| PUT /projects/:id | `{baseRevision,project}` → 项目；拒绝伪造 assets/takes/approval |
| POST /projects/:id/commands | `{baseRevision,commandId,ops:SceneOp[]}` → 原子校验保存的项目 |
| POST /projects/:id/history | `{baseRevision,direction:'undo'|'redo'}` → 项目 |
| POST /projects/:id/ai | `{baseRevision,prompt,sceneId?,selectionIds,selectedNodeIds?,partSelection?,frame,mode:'static'|'dynamic',scope:'scene'|'storyboard'}` → `{project,message,ops}` |
| POST /projects/:id/assets | `{name,kind,mime,base64,parentId?,source?,metadata?}` → `{asset,project}`；kind=image/video/audio/model/bake |
| GET / HEAD /assets/:id/content | 媒体字节，单段 Range、ETag；非法 Range 返回 416 |
| GET /projects/:id/review | `{html,shots:[{shotId,hash}]}` |
| GET /projects/:id/script | 独立 HTML（嵌入引用图）；`?format=json` 返回 review 数据 |
| POST /projects/:id/shots/:shotId/approve | `{hash}` → 项目；仅接受当前内容哈希 |
| POST /projects/:id/shots/:shotId/generate | `{idempotencyKey,approvalHash}` → StudioJob；要求当前审核与首参考图 |
| POST /projects/:id/previews | `{idempotencyKey,sceneId,bakedAssetId,frameStart,frameEnd,resolution?,landmarks?}` → 本地 Blender StudioJob |
| POST /projects/:id/exports | `{idempotencyKey,sequenceId}` → 本地合成 StudioJob |
| GET /projects/:id/jobs / GET /jobs/:id | 任务列表 / 单个任务 |
| POST /projects/import | `{ontology?,videoJobs?,name?}` → 新项目；不覆盖旧源 |

当前没有项目/资产 DELETE、任务取消或手动 NAS 重试端点。BFF 导出 DELETE 转发函数不等于后端实现删除。

## 编辑与模型部件

AI 只返回类型化 JSON，不能执行 JS/Python/shell。补丁全部校验后原子保存，可撤销。静态支持对象、相机、场景、部件；动态 AI 仅能 track.set 当前帧：保留其他帧、轨道目标/属性/设置，新轨道只含当前帧。动态 AI 不替换基础场景或 storyboard；直接用户编辑可管理完整动作片段。

selectionIds 为 3D 对象，selectedNodeIds 为画布语义/图片引用，不互换。图片最多 4 张、总 8 MiB，仅 PNG/JPEG/WebP，实际以多模态 image parts 发送；图中文字是引用数据。partSelection:[{objectId,partId}] 把 AI 限制在对应部件，不能通过整对象/scene patch 绕过。锁定对象、部件、轨道由服务端保护。

GLB 上传时服务端解析真实 node，覆盖调用方 part metadata：mesh ID 为 gltf-node-N、源指针 /nodes/N、记录最近 mesh 祖先；SceneObject.parts 只能引用已验证节点。part.update 改局部 TRS/color/visible/locked；AnimationTrack.partId 与 bone 互斥，仅 TRS/visible。它是节点部件编辑，不是任意网格分割。

RigProfile.limits 为逐骨骼 rest-relative XYZ Euler min/max，单位弧度；静态FK、动作混合、动画FK和每步受限CCD使用相同限位。限位后的最终姿态烘焙进GLB，worker不重新求解。超出可达范围的IK目标可能无法抵达，界限有效与目标命中是两个独立指标；不能把限位通过写成所有目标都精确命中。

## 审核、任务与生成

任务 kind=generation/preview/export，state=queued/running/complete/failed/uncertain，gateway progress=0…1。任务快照在外部调用前落盘，接受 ID 获得后立即保存。审核 hash 覆盖镜头、场景、动画、引用内容；画布位置不影响，内容变化令审核失效，旧审核不继承。

重启恢复已接受 ID 的轮询；未确认接受的提交中断、或接受后耗尽轮询/下载重试可进入 uncertain，保留接受记录，不自动重提。相同输入处于 queued/running/uncertain 时被保留，同一 key 始终指向原任务；完成后确实需要新 take 才用新 key。failed 不能证明上游没计费。没有自动模型 fallback 或自动重放付费提交。

单镜头 gateway 最长 288 帧/12 秒；原生 Gemini 最长 8 秒，使用离散请求时长后按帧裁剪。OpenAI-compatible 路径只提交首帧，尾帧记录在 ignoredReferences；身份图参与审核不代表它另被视频模型接收。回执记录真实 prompt、引用 hash/role、参数和 requestedModel；实际模型未回报时为 model=unreported、modelReported=false。

输出经 ffprobe 检查可解码和时长，短素材明确失败，不自动拉伸。将 Blender 首帧发送给生成式模型不能保证逐骨轨迹、接触动作或尾帧硬控制；身份、对白、口型、动作与特效必须验收真实成片。

## Worker 与合成

worker 共用原 v1 单渲染队列；STUDIO_WORKER_TOKEN 设置后保护全部 v3 路由。GET /api/v3/capabilities 返回 `{available,blender,ffmpeg,ffprobe,fps:24}`，实际版本探测、缓存 30 秒。

POST /api/v3/render 输入 `{jobRef,inputHash,baked_glb_b64,scene,frameStart,frameEnd,fps:24,resolution:[w,h],landmarks?}`。jobRef 持久去重，inputHash=64位SHA256 hex，另核对实际 payload/GLB hash。GLB自包含且≤200MiB，区间1…2400帧，worker要求每边64…2048偶数。gateway初步分辨率校验更宽，调用方应遵循worker最终边界。

GET /api/v3/render/:jobRef 返回 state/progress（worker=0…100）/error、images:[{frame,url}]、landmarks/landmarkValidation；多帧另有video_url，单帧PNG完成。GET /api/v3/render/:jobRef/assets/:filename 仅服务完成输出。gateway将输出固化为自己的资产。

GLB时间以extras.studio.frameStart为原点；选用extras.studio.cameraId，存在时优先于sidecar且须匹配相机。TRS/FK/IK/混合已逐帧烘焙，不二次求解；灯光、焦距、背景、地面、曝光与显隐来自sidecar。部件以studioPartRoot/studioPartId/studioObjectId定位，父隐藏传给后代。

landmark为`{frame,objectId,bone?,partId?,position?,rotation?}`，也接受quaternion；通过identity子节点helper读取世界矩阵转回Y-up，容差1mm/0.1°，观察值另含visible。重启时未完成本地渲染进入新attempt目录；完成/失败不隐式重跑，此策略不能用于付费提交。

compositor `exportSequence({project,outputPath,resolveAsset,ffmpegPath?,ffprobePath?})` 返回 `{path,frames,fps,duration,width,height}`。resolveAsset接收assetId返回本地绝对路径，无Mac relay依赖。单条连续底视频必须全覆盖，拒绝gap/重叠/短素材；音频与文字可叠加、混音和淡入淡出。输出H.264/AAC、24fps，横1280×720/竖720×1280；文字x/y=0…1中心锚点，fontSize为最终像素。依赖FFmpeg/ffprobe、Python/Pillow和CJK字体。

## 旧导入

读取ontology.data或原对象，兼容videoJobs.url及服务端结果字段。每次新建项目，旧源只读。保留blender.subjects/instances重复object_id的独立实例，Z-up[x,y,z]→Y-up[x,z,-y]，不再次叠加stage.origin；greybox.camera实际数值转为机位。旧模型、身高归一化、姿态、状态、环境保留为待重建记录，当前代理不代表外观复原。

媒体只复制PUBLIC_BASE_URL/IMAGE_PUBLIC_BASE_URL允许的origin，不跟随跳转、不读取旧本地路径；不因失败扩大范围。复制成功时绑定首尾、身份和旧take；失败的原引用/警告保留为画布文本。实测6实例/9机位/240帧及源hash不变，但真实旧媒体复制因未允许域/HTTP502未通过。
