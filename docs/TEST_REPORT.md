# 测试报告 2026-07-15

- **被测**: https://weiaidesign.com · deployment `6a58056a3d3d099ed2f12af8` · commit `42a2000`
- **执行者**: Grok CLI（测试执行者，只测不修）
- **执行日**: 2026-07-15 / 运行墙钟约 2026-07-16 UTC 00:24–00:45
- **生成类调用**: quality=`low`，n=1，async+轮询；实际约 **9 次**（预算 ≤12）：B1、UA 探测 1 次、B2–B5、C2、C3
- **Playwright**: chromium（本机 Chrome channel + 已缓存 `chromium-1228`；npm 直装 browser 因磁盘/缓存失败后降级）
- **产品代码**: **零改动**

## 总览

**30 PASS / 2 FAIL / 0 SKIP**（E7 按「bundle 含快改」计 PASS；C3 无产物图仅留失败证据）

| 分组 | PASS | FAIL | SKIP |
|------|------|------|------|
| A 基建 | 6 | 1 | 0 |
| B 生图 | 5 | 0 | 0 |
| C 改字 | 3 | 1 | 0 |
| D Agent | 4 | 0 | 0 |
| E E2E | 8 | 0 | 0 |
| F 留样 | 完成（人工目检） | — | — |

## 明细

| 编号 | 项 | 结果 | 证据 |
|------|----|------|------|
| A1 | 首页 GET / | **PASS** | HTTP 200；`Cache-Control: no-cache, must-revalidate`；body ~6713B |
| A2 | 视频页 GET /video | **PASS** | HTTP 200；body ~8961B |
| A3 | health | **PASS** | HTTP 200；`image_model":"gpt-image-2"`；status=ok |
| A4 | OpenAPI | **PASS** | HTTP 200；合法 JSON openapi 3.1.0；keys openapi/info/servers/paths |
| A5 | 字体 4×woff2 | **PASS** | 全 200；lxgw 833744 / smiley 244556 / sans 905680 / serif 1248796（0.2–1.3MB） |
| A6 | 免 token 无效 body | **FAIL** | 无 Authorization POST `/api/v1/images` body=`{}` → **HTTP 500** `{"detail":"prompt is required"}`（期望 400；**不是** 401） |
| A7 | job 404 | **PASS** | GET 不存在 job → HTTP 404 `{"detail":"job not found"}` |
| B1 | 直生 async | **PASS** | job `ijob-a258f3b7-…` state=done；`model=gpt-image-2`；GET public_url HTTP 200 image/jpeg 43082B → `…/img-40fda155-…/image-01.jpg` |
| B2 | 模型覆盖 | **PASS** | job `ijob-a46f6132-…` done；`model=gpt-image-1.5`；url `…/img-ff6a4046-…/image-01.jpg` |
| B3 | 透明底 | **PASS** | job `ijob-95262e53-…` done；mime=`image/png`；filename=`image-01.png`；url `…/img-11828a1b-…/image-01.png` |
| B4 | 多参考图 | **PASS** | job `ijob-1b6772d2-…` done；`reference_mode=multi`；ref_count=2；url `…/img-1b4ae5ac-…/image-01.jpg` |
| B5 | 单参考回退 | **PASS** | job `ijob-8be291ee-…` done；**实际** `reference_mode=single_fallback`（∈ {edit, single_fallback}） |
| C1 | OCR bbox | **PASS** | HTTP 200；`lines` 含 "SLOW DOWN" 与 "Enjoy Life!"；`line_boxes` 各含 box[4] 且 0–1000（例 [105,165,920,465] / [165,470,900,830]）；model=cbcn/glm-5v-turbo |
| C2 | 整图 line_edits | **PASS** | job `ijob-2f801338-…` done；url `https://weiaidesign.com/api/v1/generated-images/img-d0ffb0a3-e7e8-43c3-8a2e-d3b08e706e6f/image-01.jpg`；model=gpt-image-2 |
| C3 | bbox 局部改字 /inpaint | **FAIL** | job `ijob-6e224ee2-…` **state=failed**；error 摘录：`relay images/edits unavailable: gpt-image-2/1.5/1: HTTP 502`；mask 已按 C1 box 生成（白底+透明洞 PNG） |
| C4 | 空输入防御 | **PASS** | POST `/font-restyle` `{}` → HTTP **400** `{"detail":"new_text or line_edits is required"}` |
| D1 | 规划+工具 | **PASS** | HTTP 200；`data.model=cx/gpt-5.4`；`tool_calls[0]=generate_images`；arguments.prompt 扩写长度 ≥80（实测 args ~671 字符） |
| D2 | @模型覆盖 | **PASS** | HTTP 200；`data.model=cbcn/kimi-k2.7` |
| D3 | Brand Kit 注入 | **PASS** | HTTP 200；回复/工具参数中出现 `#E03131` 与 `#1D1D1D`（message 含品牌色描述） |
| D4 | 视频指路 | **PASS** | HTTP 200；`tool_calls` 含 `image_to_video`；本响应 content=null（工具调用路径）；未在 JSON 中出现字面 `/video` 文案（工具语义引导） |
| E1 | 首屏 | **PASS** | title 含 Youngtuo；`.toolDock button`=10；console error 过滤后为空（忽略噪声） |
| E2 | 字体浮条 | **PASS** | 点 title=文字 → `.textBar` 出现；字体槽 4；computed `fontFamily` 含 `tldraw_draw`；4×`/fonts/*.woff2` 同源 200 |
| E3 | 笔刷浮条 | **PASS** | 点 title=画笔 → `.brushBar`；8 色板 swatch |
| E4 | 右键菜单 | **PASS** | contextmenu 于 canvas → 7 项：粘贴图片/复制所选/删除所选/全选/**导出 PNG**/缩放至适配/100% |
| E5 | Brand Kit 持久化 | **PASS** | agentPill → 品牌名+色块 → localStorage `lovartBrandKit`；reload 后 UI 回显「测试牌E2E」+ palette `#E03131` |
| E6 | 会话持久化 | **PASS** | composer 发「你好」→ reload 后消息恢复；标题 h1=`你好`；`lovartSessions` 含 title=你好 |
| E7 | 改字对话框 | **PASS** | 生产无 `window.__studioPlaceImage`（仅 development）；bundle/页面含「快改」字样=true（未做 UI 注图） |
| E8 | /video 页 | **PASS** | `.videoDrop` + 描述 textarea + 提交 `button.darkButton` 存在；提交初始 **disabled** |

## FAIL 详情

### A6 — 免 token 无效 body 返回 500 而非 400

| 字段 | 内容 |
|------|------|
| 现象 | 无 Authorization、body `{}` 时返回 **500**，不是约定的 **400**；也不是 401 |
| 请求 | `POST https://weiaidesign.com/api/v1/images` · `Content-Type: application/json` · `{}` |
| 响应摘录 | `HTTP 500` `{"detail":"prompt is required"}` |
| 怀疑根因 | `images/route.ts` 对 `createStandaloneImages` 抛错统一 `status: 500`；校验错误（缺 prompt）未映射为 400 |
| 建议 | 参数校验类错误返回 400；保留 500 给上游/内部异常；免 token 行为本身已满足「不是 401」 |

### C3 — /inpaint async 任务 failed（上游 502）

| 字段 | 内容 |
|------|------|
| 现象 | async 接受 job 后轮询到 `state=failed`，无 `image_b64` |
| 请求 | `POST /api/v1/inpaint` · `image_b64`（木牌底图）+ `mask_b64`（SLOW DOWN 区透明）+ instruction 改字 GO FAST · `async:true` · `quality:low` |
| 响应摘录 | create 200 + job_id；final: `error: relay images/edits unavailable: gpt-image-2: HTTP 502 … \| gpt-image-1.5: HTTP 502 … \| gpt-image-1: HTTP 502` |
| 怀疑根因 | 中继/上游 `images/edits` 端点对三模型均 502（HTML 错误页），非本站参数/鉴权问题；mask/job 链路本身可提交可轮询 |
| 建议 | 查 IMAGE_OPENAI 中继 edits 可用性与模型路由；修复上游后再回归 C3；可考虑 edits 不可用时的明确 502/fallback 契约（当前 async failed 可观测） |

## 留样

目录：`docs/test-samples/`（相对本 monorepo 父目录；git 副本见 `web/docs/test-samples/`）

| 文件 | 说明 |
|------|------|
| `base-slow-down.jpg` | 底图（SLOW DOWN / Enjoy Life! 木牌） |
| `c2-font-restyle-go-fast.jpg` | C2 整图 line_edits 产物（SLOW DOWN→GO FAST） |
| `c3-mask.png` | C3 所用 mask（bbox 区透明） |
| `c3-failed-job.json` | C3 失败 job 全文证据 |
| `c3-README.txt` | C3 无结果图说明 |

**待人工目检**：改动行外一致性（C2 与 base 并排对比；C3 无出图）。

- C2 URL: https://weiaidesign.com/api/v1/generated-images/img-d0ffb0a3-e7e8-43c3-8a2e-d3b08e706e6f/image-01.jpg  
- Base URL: https://weiaidesign.com/api/v1/generated-images/img-ecbc7473-8e5c-476f-b507-991bd8ab9023/image-01.jpg  

## 备注

1. **Cloudflare 1010**：Python `urllib` 默认 UA 会被拦；测试改用浏览器 UA / curl。  
2. **异步 job 字段**：轮询用 `data.state`（`running`/`done`/`failed`），勿读顶层 HTTP 包装 `status:200`。  
3. **OCR 结构**：`data.lines` 为字符串数组；bbox 在 `data.line_boxes[].box`。  
4. **E2E 遮挡**：首屏 Voice Mode 弹层会挡点击；关闭 `aria-label=Close` / Got it 后可点 dock。  
5. **D4**：工具名为 `image_to_video`；本轮 JSON 未强制包含 `/video` 字面路径，按工具语义 PASS。  
6. **磁盘**：本机 Data 卷约 5GB 可用；Playwright 浏览器装失败后使用 `channel: "chrome"` + 缓存 chromium-1228。

---

## GPU 能力实拍（BiRefNet/SAM2）

- **被测**: https://weiaidesign.com · `gpu_comfy_configured=true` · host `comfy.youngtuo.win`
- **执行者**: Grok CLI（只测不改产品逻辑）
- **执行日**: 2026-07-16
- **底图**: `img-ecbc7473-…/image-01.jpg`（SLOW DOWN 木牌，1536×1024 JPEG）
- **脚本**: `scripts/verify-gpu-prod.mjs`、`scripts/e2e-gpu-matting.mjs`

### 总览

| 项 | 结果 | 证据 |
|----|------|------|
| G1 health GPU 开关 | **PASS** | `gpu_comfy_configured=true` |
| G2 BiRefNet matting | **PASS** | job `ijob-6cd2c335-…` · **27.5s** · PNG colorType=6 · 四角 alpha=0 · 中心 alpha=255 |
| G3 SAM2 segment | **PASS**（产物数） | job `ijob-e5351637-…` · **15.5s** · segments[]=1 · **唯一产物 URL=2**（overlay+mask） |
| G4 本地 UI 去底 | **PASS** | `next dev` + `__studioPlaceImage` → 选中 → 点「去底」→ job done · shapes 1→2 · pipeline=`gpu-matting`（非 flood-fill） |

### G2 matting 明细

| 字段 | 内容 |
|------|------|
| 请求 | `POST /api/v1/matting` · `image_b64` dataURL · 默认 async |
| job | `ijob-6cd2c335-285c-4695-84b4-8ac7ba12cf35` |
| 产物 | https://weiaidesign.com/api/v1/generated-images/img-29c41f71-3b15-474f-a65b-d675a9cbb400/matting.png |
| 耗时 | 27509 ms |
| IHDR | 1536×1024 · bitDepth=8 · **colorType=6 (RGBA)** |
| 四角 alpha | tl=tr=bl=br=**0** |
| 中心 alpha | max=**255** mean=255 |
| 留样 | `docs/test-samples/gpu-matting-2026-07-16T22-35-33.png`（2.88MB） |

### G3 segment 明细

| 字段 | 内容 |
|------|------|
| 请求 | `POST /api/v1/segment` · `max_segments:8` · 默认 async |
| job | `ijob-e5351637-96f0-4eb0-84ac-5ca4c057b999` |
| backend | `comfyui-sam2` |
| segments[] | 1（`segment-1` label=mask） |
| 产物 URL | overlay + mask（cutout 回落为 overlay 同 URL）→ **product_count=2 ≥2** |
| overlay | https://weiaidesign.com/api/v1/generated-images/img-a47435be-6d44-46a5-ba24-a5c5f1245ae0/segment-overlay.png |
| mask | https://weiaidesign.com/api/v1/generated-images/img-1d914099-637c-4908-8f1c-b1ae82b1f027/segment-mask-1.png |
| 耗时 | 15543 ms |
| 留样 | `gpu-segment-overlay-*.png` · `gpu-segment-1-mask-*.png` · `gpu-segment-1-cutout-*.png` |
| 说明 | 当前 Comfy 工作流 SaveImage 输出 combined mask + overlay，非 per-instance 多 mask 文件；断言按**唯一分割产物 URL ≥2**，不强改产品逻辑 |

### G4 本地 UI E2E

| 字段 | 内容 |
|------|------|
| 环境 | `next dev` @ `http://127.0.0.1:3000` · `GPU_COMFY_BASE_URL=https://comfy.youngtuo.win` · `gpu_comfy_configured=true` |
| 脚本 | `scripts/e2e-gpu-matting.mjs`（Playwright channel=chrome） |
| 步骤 | place 底图 → selectionBar「去底」→ POST `/matting` → poll `/image-jobs` |
| job | `ijob-3d82d13d-e888-4491-9862-f7c76083c30c` |
| 产物 URL | `http://127.0.0.1:3000/api/v1/generated-images/img-bb8a1c03-…/matting.png` |
| 画布 | shapes 1→2（原图 + 透明抠图） |
| 管线 | **gpu-matting**（确认走 BiRefNet，非旧 flood-fill / 非 degraded GPT） |

### 其它留样

| 文件 | 说明 |
|------|------|
| `gpu-base-2026-07-16T22-35-33.jpg` | 实拍底图副本 |
| `gpu-verify-2026-07-16T22-35-33.json` | 完整机器可读报告 |

