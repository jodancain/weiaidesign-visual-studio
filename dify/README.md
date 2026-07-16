# Visual Studio Dify 排布包

把 weiaidesign.com 视觉工作台排布进 Dify 的两个可导入应用。**定位（全局原则）**：Dify 只是原型/运维驾驶舱层——产品逻辑与真相源在本仓库代码和 https://weiaidesign.com ；有价值的 Dify 流程应回植到代码，而不是在 Dify 里继续长。

## 实例

- Geo 项目已部署的共用 Dify：`http://100.84.235.123:18150`（Tailscale 内网，Windows `ai` 主机 Docker Desktop，代码 `C:\Users\qrrwi\dify\docker`）
- 首次使用：打开 `/install` 建管理员（geo 项目 README 同款步骤）

## 应用

| 文件 | 模式 | 功能 |
|---|---|---|
| `00-visual-studio-console.yml` | chatflow | 驾驶舱对话：健康解读 / 生图试玩（async 提交，回 job id 对话式查询）/ 任务进度查询 / 设计咨询 |
| `01-visual-smoke-workflow.yml` | workflow | 一键冒烟：health → 低画质生图 → 两轮轮询 → LLM 汇总 PASS/FAIL（替代手写 curl） |

## 导入步骤

1. Dify 工作室 → 创建应用 → 导入 DSL → 逐个上传两个 yml
2. **模型供应商**：设置 → 模型供应商 → OpenAI-API-compatible → Base URL `https://router.yundongyl.cn/v1` + API Key（见项目凭证管理，勿入库）→ 添加模型 `cx/gpt-5.4`（chat）
3. 导入的节点默认写着 `openai / gpt-4o` 占位——把每个 LLM/分类器节点的模型换成 `cx/gpt-5.4`（或在"系统模型设置"里设默认后重选）
4. 环境变量 `VISUAL_BASE_URL` 已内置 `https://weiaidesign.com/api/v1`（免 token）；如切换入口在应用编排页右上"环境变量"改

## 已知约束

- weiaidesign 的生图是异步任务（Cloudflare 100s 限制），所以 chatflow 用"提交→回 job id→对话查询"，smoke 用固定两轮 sleep+查询（低画质一般 30-60s 内完成；没完成会提示 PENDING+job id）
- Dify code 节点无网络，仅用于 sleep/解析
- DSL 按 Dify 0.15/1.x 的 0.1.5 schema 手写（参照 `ai/geobuild/dify/` 包格式）；若导入报 schema 错，按 yml 里的节点结构在 UI 手工重建，图很小（console 12 节点 / smoke 9 节点）
- **GPU 抠图/分割不进 Dify 编排**：专业抠图（BiRefNet）与语义分割（SAM2）由 weiaidesign 服务端代理：
  - `POST https://weiaidesign.com/api/v1/matting`
  - `POST https://weiaidesign.com/api/v1/segment`
  - 再轮询 `GET /api/v1/image-jobs/{job_id}`
  - ComfyUI 固定入口 `https://comfy.youngtuo.win` 仅服务端使用（`GPU_COMFY_BASE_URL`），**不要**在 Dify 里直连 ComfyUI
- smoke/health 可观察 `gpu_comfy_configured` / `gpu_comfy_base_url_host` 字段判断 GPU 能力是否在线；大图处理逻辑仍在产品代码
