# blender-story worker · 本体渲染部分（快照）

`workers/blender-story/` 不在 git 里（跑在 Windows `ai` 上，`D:\story-worker\`），这里存两份用于回溯的快照：

- `render_ontology.py` — 通用 bpy 脚本：读本体 Blender 层 spec（场景预设 / 主体归一化 / 状态操作 / 每锚图机位），出灰模 PNG。无主体特定代码。
- `app.py` — FastAPI worker（v0.2.0）：`GET /api/v1/models`、`POST /api/v1/ontology-render`、`GET /api/v1/ontology-render/{job_id}`；原有 story 渲染接口保留。

web 侧对应 `app/api/v1/_lib/ontology.ts` 的 `BlenderLayer` 类型、`BLENDER_SYSTEM_EXTRA` 提示词和 `renderGreyboxes()`。环境变量 `BLENDER_STORY_WORKER_URL`（生产 `http://host.docker.internal:18087`）。
