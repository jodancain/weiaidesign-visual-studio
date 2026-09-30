/* 本体视频法 · C 线（车主 / 展厅 / 精品选配）工作流
 * brief → LLM 生成本体（对象 / 属性 / 链接 / 锚图计划 / 镜头）→ 锚图生成 → 人工审核 HTML → 首尾锚图补间出片
 * 存储：<IMAGE_OUTPUT_DIR>/_ontology/<id>.json；锚图复用 generated-images 目录与公网 URL。
 */
import { randomUUID } from "node:crypto";
import { mkdir, readFile, readdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { Buffer } from "node:buffer";
import { chatJson } from "./llm";
import {
  editImageWithReference,
  generateImage,
  imageOutputDir,
  imageOutputFormat,
  imagePublicUrl,
  type ReferenceImage,
} from "./visual-api";

const env = process.env;

export type Audience = "owner" | "showroom" | "accessory";
export type Aspect = "16:9" | "9:16" | "1:1";
export type OntologyState = "drafted" | "anchoring" | "review" | "approved" | "generating" | "done" | "failed";
export type AnchorStatus = "pending" | "generating" | "generated" | "approved" | "rejected" | "failed";
export type ShotStatus = "proposed" | "approved" | "rejected" | "queued" | "running" | "done" | "failed";

export type OntologyObject = {
  id: string;
  type: "vehicle" | "accessory" | "actor" | "environment" | "prop";
  name: string;
  handle?: string; // short English name used inside model-facing prompts
  description: string;
  identity_prompt: string;
  attributes: Array<{ key: string; label: string; values: Array<{ value: string; label: string; prompt: string }> }>;
  /* actors only: who they are inside, how that reads on the face and body, and which expressions the shots may call */
  psyche?: { temperament: string; attitude_to_threat: string; motivation: string; body_language: string; voice?: string };
  expressions?: Array<{ key: string; label: string; prompt: string }>;
};

/* A visual effect is a first-class thing in the ontology: it has an owner, a shape family, a colour, a verb and a lifetime. */
export type OntologyEffect = {
  id: string;
  owner: string; // object id (actor / environment)
  kind: "projectile" | "aura" | "shield" | "burst" | "bind" | "environment" | "impact";
  label: string;
  colour: string;
  prompt: string; // how it looks
  motion: string; // how it moves / resolves
  duration_s: number; // 0.5..6
};

/* Timed beat inside a shot: who does what, wearing which expression, with which effect. Compiled into motion_prompt. */
export type ShotBeat = {
  t: number; // seconds from shot start
  actor?: string; // object id
  expression?: string; // expression key of that actor
  action: string; // English, one concrete physical action
  effect?: string; // effect id
  camera?: string; // optional camera note for this beat (kept minimal)
};

export type OntologyLink = {
  id: string;
  from: string;
  to: string;
  type: "attached_to" | "part_of" | "located_in" | "holds" | "compares_with" | "shows";
  label: string;
  qty?: number;
  anchor_prompt?: string;
};

export type Anchor = {
  id: string;
  kind: "identity" | "attribute" | "link";
  object_id?: string;
  link_id?: string;
  attribute?: { key: string; value: string };
  label: string;
  prompt: string;
  status: AnchorStatus;
  image?: { image_id: string; filename: string; public_url: string; path: string };
  model?: string;
  error?: string;
  feedback?: string;
  attempts: number;
  /* Blender layer: camera grammar + active states; filled by the LLM when render_backend=blender */
  render?: { camera: { azimuth_deg: number; elevation_deg: number; distance_factor: number; focal_mm: number; look_at: string }; states: string[] };
  greybox?: { image_id: string; filename: string; public_url: string; path: string; camera?: unknown };
  /* other anchors whose finished images are fed as references when restyling this one (identity → group shots, start → end) */
  refs?: string[];
};

export type BlenderSubject = {
  id: string;
  object_id: string;
  asset?: { name: string };
  proxy?: { shape: string; dims_m: number[] };
  up_axis: string;
  forward_axis: string;
  height_m?: number;
  length_m?: number;
  position_m: number[];
  rotation_deg?: number;
  face?: string;
  pose?: { library?: string; clip: string; phase: number };
  tint?: number[];
  elevation_m?: number;
  camera_ignore?: boolean;
};

export type BlenderLayer = {
  enabled: boolean;
  scene: { preset: string; floor_reflective: boolean; asset?: { name: string }; stage?: { origin_m: number[]; yaw_deg: number }; sky?: { name: string }; hide_match?: string };
  /* v1 single subject (kept so stored ontologies still load); v2 uses subjects[] */
  subject?: { object_id: string; asset?: { name: string }; proxy?: { shape: string; dims_m: number[] }; up_axis: string; forward_axis: string; length_m: number; rotation_deg: number };
  subjects: BlenderSubject[];
  states: Array<{ id: string; label: string; ops: Array<Record<string, unknown>> }>;
  worker_job_id?: string;
  error?: string;
};

export type Shot = {
  id: string;
  order: number;
  title: string;
  start_anchor: string;
  end_anchor: string;
  duration_s: number; // 4..12; >8 is sent as a single clip (gateway single_clip)
  motion_prompt: string;
  beats?: ShotBeat[];
  camera_move?: string; // the single dominant camera behaviour for the whole shot
  caption: string;
  caption_source: "brief" | "ai";
  status: ShotStatus;
  video_job_id?: string;
  video_url?: string;
  drive_url?: string;
  archive_error?: string;
  video_model?: string;
  error?: string;
};

export type Ontology = {
  id: string;
  version: 1;
  state: OntologyState;
  created_at: number;
  updated_at: number;
  brief: string;
  audience: Audience;
  aspect_ratio: Aspect;
  title: string;
  summary: string;
  style_bible: string;
  objects: OntologyObject[];
  links: OntologyLink[];
  effects?: OntologyEffect[];
  anchors: Anchor[];
  shots: Shot[];
  review: { decided_at?: number; reviewer?: string; notes?: string };
  llm_model?: string;
  render_backend: "image" | "blender";
  blender?: BlenderLayer;
  progress: { anchors_total: number; anchors_done: number };
  errors: string[];
};

export const BLENDER_WORKER_URL = (env.BLENDER_STORY_WORKER_URL || "").replace(/\/+$/, "");
export const BLENDER_PRESETS = ["showroom_dark", "studio_white", "garage", "outdoor_overcast", "night_rooftop"] as const;
export const BLENDER_LOOK_AT = ["center", "front", "rear", "roof", "wheel_front", "ground"] as const;
export const BLENDER_PART_AT = ["rear-top", "roof-center", "front-bottom", "rear-bottom", "side-left", "side-right", "front-top"] as const;

export async function listBlenderModels(): Promise<Array<{ name: string; bytes: number }>> {
  if (!BLENDER_WORKER_URL) return [];
  try {
    const r = await fetch(`${BLENDER_WORKER_URL}/api/v1/models`, { signal: AbortSignal.timeout(8000) });
    const d = (await r.json()) as { items?: Array<{ name: string; bytes: number }> };
    return d.items || [];
  } catch {
    return [];
  }
}

const LIMITS = {
  objects: 5,
  attributesPerObject: 3,
  valuesPerAttribute: 3,
  links: 6,
  anchors: Number(env.ONTOLOGY_MAX_ANCHORS || "20"),
  shots: Number(env.ONTOLOGY_MAX_SHOTS || "6"),
  shotDuration: 8, // Veo first+last keyframe requirement in current gateway
};

/* ---------- storage ---------- */

const dir = () => join(imageOutputDir, "_ontology");

export function isOntologyId(id: string) {
  return /^onto-[a-f0-9-]{8,}$/.test(id);
}

export async function saveOntology(o: Ontology) {
  o.updated_at = Date.now();
  await mkdir(dir(), { recursive: true });
  await writeFile(join(dir(), `${o.id}.json`), JSON.stringify(o));
  return o;
}

export async function loadOntology(id: string): Promise<Ontology | null> {
  if (!isOntologyId(id)) return null;
  try {
    return JSON.parse(await readFile(join(dir(), `${id}.json`), "utf8")) as Ontology;
  } catch {
    return null;
  }
}

export async function listOntologies(limit = 30) {
  try {
    const files = (await readdir(dir())).filter((f) => f.endsWith(".json"));
    const items = await Promise.all(
      files.map(async (f) => {
        try {
          const o = JSON.parse(await readFile(join(dir(), f), "utf8")) as Ontology;
          return { id: o.id, title: o.title, state: o.state, audience: o.audience, created_at: o.created_at, updated_at: o.updated_at, shots: o.shots.length, anchors: o.anchors.length };
        } catch {
          return null;
        }
      }),
    );
    return items.filter(Boolean).sort((a, b) => Number(b!.updated_at) - Number(a!.updated_at)).slice(0, limit);
  } catch {
    return [];
  }
}

/* ---------- LLM: brief → ontology ---------- */

const AUDIENCE_HINT: Record<Audience, string> = {
  owner: "面向车主的种草短片：温暖、生活化，突出使用场景与情绪价值，不出现工具和警示。",
  showroom: "面向展厅 / 门店大屏：慢旋转、光影炫技、整车与精品同框，科技感，不出现文字。",
  accessory: "面向精品选配：同机位「原车 vs 装配后」对比，突出配件本身的材质与贴合度。",
};

const ONTOLOGY_SYSTEM = `你是「本体视频法」的本体设计师。用户给一段视频需求（C 线：车主 / 展厅 / 精品选配），你要把它拆成一个可被锁定图片驯服的小本体，然后只输出一个 JSON。

核心规则（必须遵守）：
1. 先定对象（objects），再定属性（attributes，每个属性是有限枚举，每个枚举值以后会被锁成一张图），再定链接（links，对象之间的关系，也可以锁一张"装配好的样子"图），最后定镜头（shots）。
2. 镜头 = 从一张锚图运动到另一张锚图。start_anchor 与 end_anchor 必须是 anchors 里存在的不同 id，且属于同一对象、或其中一个是该对象参与的链接锚图；不允许两个不相关对象之间补间。
2b. 需求里出现"绕车 / 环绕 / 转半圈 / 换角度 / 多角度"时，必须给主体对象建一个属性 view_angle（枚举值如 front-3q、side、rear-3q，≤ 3 个），为镜头用到的每个角度值各建一张 attribute 锚图，镜头就是从一个角度锚图运动到另一个角度锚图；不要用一张图表达旋转。
2c. "同机位装前 / 装后对比"：起点用主体的 identity 或某个角度锚图，终点用对应的 link 锚图（装配好的样子），link 锚图 prompt 必须写明 "same camera position and framing as the reference"。
2d. 输出前自检：每个 shot 的 start_anchor / end_anchor 都必须能在 anchors 数组里找到，且两者不同；两个镜头不要使用完全相同的起止锚图对。
3. 锚图数量要省：每个对象 1 张 identity 锚图；attribute 锚图只为镜头真正用到的枚举值生成；link 锚图只为镜头用到的链接生成。anchors 总数 ≤ ${LIMITS.anchors}，shots ≤ ${LIMITS.shots}，objects ≤ ${LIMITS.objects}，每对象属性 ≤ ${LIMITS.attributesPerObject}，每属性枚举值 ≤ ${LIMITS.valuesPerAttribute}，links ≤ ${LIMITS.links}。
4. 所有 *_prompt 用英文写给图像 / 视频模型，具体、可执行；写清主体、视角、光线、背景，末尾统一加 "no text, no watermark, no UI"。identity_prompt 要写出足以在多张图里保持同一性的稳定特征（颜色、造型、材质、比例）。attribute 与 link 的 prompt 要写成"在 identity 基础上只改变 X"的编辑指令，其余保持一致。
5. style_bible 是一句英文视觉总纲（镜头风格、色调、光线、镜头焦段），所有 prompt 默认遵守。
6. motion_prompt 描述从起点锚图到终点锚图之间的运动（相机与主体），英文，${LIMITS.shotDuration} 秒以内可完成，不写文字叠层。
7. caption 是中文字幕，≤ 24 字；能从用户需求原文直接得出的标 caption_source="brief"，你补写的标 "ai"。不编造参数、价格、性能数字。
7b. 人物（type=actor）必须带 psyche（temperament 性格 / attitude_to_threat 面对威胁的态度 / motivation 动机 / body_language 身体语言，各一句英文）和 expressions（2–4 个表情枚举，每个 {key,label 中文,prompt 英文写眉眼嘴的具体状态}）。镜头节拍引用表情 key，锚图 prompt 里也写出该刻的表情。
7c. 特效是一等对象：effects 数组，每条 {id, owner 对象 id, kind ∈ projectile|aura|shield|burst|bind|environment|impact, label 中文, colour 英文颜色, prompt 英文写形态材质光, motion 英文写它怎么运动怎么消散, duration_s}。锚图和节拍只能引用已定义的 effect id，不在 prompt 里临时发明新特效。
7d. 每个镜头给 beats（3–5 拍）：{t 秒, actor 对象 id, expression 表情 key, action 一句具体物理动作, effect 特效 id}，以及 camera_move（整镜唯一的一种相机运动，英文）。motion_prompt 只写一句总述，节拍由服务端编译成时间戳提示。
8. id 用短英文 kebab-case（如 obj-su7、attr、anc-su7-identity、anc-su7-color-red、lnk-rack-on-roof、shot-01）。
9. 只输出 JSON 对象，不要 Markdown、不要解释。

输出格式：
{
  "title": "14 字内标题",
  "summary": "1-2 句中文摘要",
  "style_bible": "English visual bible",
  "objects": [{ "id": "", "type": "vehicle|accessory|actor|environment|prop", "name": "中文名", "handle": "English short name", "description": "中文一句", "identity_prompt": "English",
                "psyche": { "temperament": "English", "attitude_to_threat": "English", "motivation": "English", "body_language": "English" }, "expressions": [{ "key": "", "label": "中文", "prompt": "English face" }],
                "attributes": [{ "key": "", "label": "中文", "values": [{ "value": "", "label": "中文", "prompt": "English edit instruction" }] }] }],
  "links": [{ "id": "", "from": "obj-id", "to": "obj-id", "type": "attached_to|part_of|located_in|holds|compares_with|shows", "label": "中文", "qty": 1, "anchor_prompt": "English (optional)" }],
  "effects": [{ "id": "fx-", "owner": "obj-id", "kind": "projectile|aura|shield|burst|bind|environment|impact", "label": "中文", "colour": "English", "prompt": "English look", "motion": "English motion & dissolve", "duration_s": 2 }],
  "anchors": [{ "id": "", "kind": "identity|attribute|link", "object_id": "obj-id", "link_id": "lnk-id", "attribute": { "key": "", "value": "" }, "label": "中文短标签", "prompt": "English full prompt" }],
  "shots": [{ "id": "shot-01", "order": 1, "title": "中文", "start_anchor": "anc-id", "end_anchor": "anc-id", "duration_s": 8, "camera_move": "English, one movement", "motion_prompt": "English one-line summary",
              "beats": [{ "t": 0, "actor": "obj-id", "expression": "expr-key", "action": "English", "effect": "fx-id" }], "caption": "中文", "caption_source": "brief|ai" }]
}`;

const BLENDER_SYSTEM_EXTRA = (models: string[]) => `
【Blender 层】本次锚图不由图像模型自由画，而是先在 Blender 里按你给的参数搭一个摄影棚渲出白模帧，再重绘材质光影。所以你还要输出 "blender" 字段，并给主体对象的每一张锚图（identity / attribute / link 均可）加 "render" 字段。规则：
- blender.scene.preset ∈ {${BLENDER_PRESETS.join(", ")}}；floor_reflective 布尔。
- blender.subject.object_id = 主体对象 id。若可用模型列表里有匹配的资产文件（${models.length ? models.join(", ") : "无"}），用 asset.name 引用它；否则给 proxy {shape: box|cylinder, dims_m:[长,宽,高]} 用真实尺寸的代理体。up_axis 一般 "Y"，forward_axis 一般 "Z"（glTF 常见）；length_m 填该对象真实长度（米），rotation_deg 0。
- blender.states：可切换的配置状态，每个 {id, label, ops[]}。ops 只能是：{"op":"hide"|"show","match":"<正则匹配部件名>"}、{"op":"add_part","name":"","shape":"box|cylinder","dims_m":[宽(横向),深(纵向),高],"at":"${BLENDER_PART_AT.join("|")}","offset_m":[0,0,0],"color":[r,g,b 0..1],"tilt_deg":0}、{"op":"rotate","match":"","axis":"X|Y|Z","deg":0}。不知道部件名时用 add_part 造代理配件（尾翼 = 在 rear-top 放一块 [1.4,0.28,0.06] 的黑色薄板，tilt_deg -8；行李架 = roof-center 两根 [1.2,0.06,0.06] 横杆）。
- anchor.render.camera：{azimuth_deg 0..360（0=车头正前，35=前 3/4，90=正侧，145=后 3/4，180=正后）, elevation_deg -5..45, distance_factor 0.7..1.6（1.0=主体撑满画面 80%）, focal_mm 24..85, look_at ∈ {${BLENDER_LOOK_AT.join(", ")}}}；anchor.render.states = 该锚图激活的 state id 列表（可空）。
- 「同机位对比」的两张锚图必须用完全相同的 camera，只改 states。"绕车"的角度锚图只改 azimuth_deg。
- 主体不限于车：人物 / 生物用 proxy {shape: "cylinder", dims_m:[0.5,0.5,身高]}，length_m = 0.5；azimuth 0 = 正面朝镜头。同一镜头里的其他角色、怪物、道具、悬浮面板一律用 add_part 代理体放进 states（怪物 = side-left 或 side-right 一根 [1.2,1.2,2.2] 的黑色圆柱，offset_m 可推远；悬浮面板 = 主体旁一块 [0.9,0.03,0.6] 竖薄板，用 offset_m 抬到胸口高度；地面光环 = roof-center 一个 [3.2,3.2,0.04] 圆柱，offset_m 第三项设为 -身高 使其落地）。一个镜头内"某物出现 / 消失 / 被击飞"就是起止锚图激活不同的 state，camera 保持完全相同。
- 场景预设只决定灰模的地面 / 背景 / 打光基调，真正的环境（屋顶、天空裂隙、街道）写在 style_bible 与锚图 prompt 里由重绘补出；夜景选 night_rooftop。
- 多主体：用 "subjects": [{id, object_id, asset|proxy, up_axis, forward_axis, height_m（人物）或 length_m, position_m:[x,y]（舞台米坐标，x 右 y 前）, rotation_deg 或 face:"<另一主体 id>", pose:{library:"<模型列表里的动画库文件>", clip:"<片段名>", phase:0..1}, tint:[r,g,b]}]，代替单个 subject。状态 ops 每条都带 "subject"，新增 {"op":"pose","subject":"","clip":"","phase":0.5}、{"op":"move","subject":"","delta_m":[x,y,z]}，hide/show 不带 match 即整个主体显隐。scene 可带 asset:{name:"<模型列表里的场景文件>"}、stage:{origin_m:[x,y,z],yaw_deg}（场景里作为舞台原点的那一点）、sky:{name}。camera.look_at 可为 "group"（所有可见主体）或某个主体 id。锚图可带 "refs":[其他锚图 id]，重绘时把它们的成图作为参考（身份图 → 群像；起点 → 终点）。
- 有 render 的锚图，其 prompt 只写材质、漆色、光线、环境（重绘用），不要再写机位与构图。
输出格式追加：
"blender": {"scene": {"preset": "", "floor_reflective": true}, "subject": {"object_id": "", "asset": {"name": ""} 或 "proxy": {"shape": "box", "dims_m": [4.9,1.96,1.45]}, "up_axis": "Y", "forward_axis": "Z", "length_m": 4.9, "rotation_deg": 0}, "states": [{"id": "", "label": "中文", "ops": []}]}
anchors 数组元素追加："render": {"camera": {"azimuth_deg": 35, "elevation_deg": 12, "distance_factor": 1.0, "focal_mm": 35, "look_at": "center"}, "states": []}`;

function num(v: unknown, lo: number, hi: number, dflt: number) {
  const n = Number(v);
  return Number.isFinite(n) ? Math.min(hi, Math.max(lo, n)) : dflt;
}

function str(v: unknown, max = 2000) {
  return String(v ?? "").replace(/\s+/g, " ").trim().slice(0, max);
}
function kebab(v: unknown, fallback: string) {
  const s = str(v, 60).toLowerCase().replace(/[^a-z0-9-]+/g, "-").replace(/^-+|-+$/g, "");
  return s || fallback;
}

/* Validate + repair the LLM draft into a well-formed Ontology. Anything unreferenced or invalid is dropped, and drops are logged. */
export function normalizeDraft(raw: Record<string, unknown>, input: { brief: string; audience: Audience; aspect_ratio: Aspect; render_backend?: "image" | "blender"; models?: string[] }): Ontology {
  const errors: string[] = [];
  const wantBlender = input.render_backend === "blender";
  const objectTypes = new Set(["vehicle", "accessory", "actor", "environment", "prop"]);
  const linkTypes = new Set(["attached_to", "part_of", "located_in", "holds", "compares_with", "shows"]);

  const objects: OntologyObject[] = (Array.isArray(raw.objects) ? raw.objects : []).slice(0, LIMITS.objects).map((o, i) => {
    const obj = (o || {}) as Record<string, unknown>;
    const id = kebab(obj.id, `obj-${i + 1}`);
    const attrs = (Array.isArray(obj.attributes) ? obj.attributes : []).slice(0, LIMITS.attributesPerObject).map((a, j) => {
      const at = (a || {}) as Record<string, unknown>;
      return {
        key: kebab(at.key, `attr-${j + 1}`),
        label: str(at.label, 40) || kebab(at.key, `attr-${j + 1}`),
        values: (Array.isArray(at.values) ? at.values : []).slice(0, LIMITS.valuesPerAttribute).map((v, k) => {
          const val = (v || {}) as Record<string, unknown>;
          return { value: kebab(val.value, `v${k + 1}`), label: str(val.label, 40) || kebab(val.value, `v${k + 1}`), prompt: str(val.prompt, 1200) };
        }),
      };
    });
    const ps = (obj.psyche && typeof obj.psyche === "object" ? obj.psyche : null) as Record<string, unknown> | null;
    const psyche = ps ? {
      temperament: str(ps.temperament, 200), attitude_to_threat: str(ps.attitude_to_threat, 200), motivation: str(ps.motivation, 200),
      body_language: str(ps.body_language, 300), ...(str(ps.voice, 120) ? { voice: str(ps.voice, 120) } : {}),
    } : undefined;
    const exprSeen = new Set<string>();
    const expressions = (Array.isArray(obj.expressions) ? obj.expressions : []).slice(0, 8).map((e, k) => {
      const ex = (e || {}) as Record<string, unknown>;
      return { key: kebab(ex.key, `expr-${k + 1}`), label: str(ex.label, 40) || kebab(ex.key, `expr-${k + 1}`), prompt: str(ex.prompt, 300) };
    }).filter((e) => e.prompt && !exprSeen.has(e.key) && exprSeen.add(e.key));
    return {
      id,
      type: (objectTypes.has(String(obj.type)) ? String(obj.type) : "prop") as OntologyObject["type"],
      name: str(obj.name, 60) || id,
      ...(str(obj.handle, 40) ? { handle: str(obj.handle, 40) } : {}),
      description: str(obj.description, 300),
      identity_prompt: str(obj.identity_prompt, 1500),
      attributes: attrs,
      ...(psyche && psyche.temperament ? { psyche } : {}),
      ...(expressions.length ? { expressions } : {}),
    };
  });
  const objectIds = new Set(objects.map((o) => o.id));
  if (!objects.length) throw new Error("model produced no objects");

  const links: OntologyLink[] = [];
  for (const [i, l] of (Array.isArray(raw.links) ? raw.links : []).slice(0, LIMITS.links).entries()) {
    const ln = (l || {}) as Record<string, unknown>;
    const from = kebab(ln.from, "");
    const to = kebab(ln.to, "");
    if (!objectIds.has(from) || !objectIds.has(to)) {
      errors.push(`link ${str(ln.id, 40) || i + 1} dropped: unknown endpoint`);
      continue;
    }
    links.push({
      id: kebab(ln.id, `lnk-${i + 1}`),
      from,
      to,
      type: (linkTypes.has(String(ln.type)) ? String(ln.type) : "shows") as OntologyLink["type"],
      label: str(ln.label, 60) || String(ln.type || "shows"),
      ...(Number.isFinite(Number(ln.qty)) && Number(ln.qty) > 0 ? { qty: Math.round(Number(ln.qty)) } : {}),
      ...(str(ln.anchor_prompt) ? { anchor_prompt: str(ln.anchor_prompt, 1200) } : {}),
    });
  }
  const linkIds = new Set(links.map((l) => l.id));

  const anchors: Anchor[] = [];
  const seen = new Set<string>();
  for (const [i, a] of (Array.isArray(raw.anchors) ? raw.anchors : []).entries()) {
    const an = (a || {}) as Record<string, unknown>;
    const id = kebab(an.id, `anc-${i + 1}`);
    if (seen.has(id)) continue;
    const kind = String(an.kind || "");
    const objectId = kebab(an.object_id, "");
    const linkId = kebab(an.link_id, "");
    if (kind === "identity" || kind === "attribute") {
      if (!objectIds.has(objectId)) {
        errors.push(`anchor ${id} dropped: unknown object`);
        continue;
      }
    } else if (kind === "link") {
      if (!linkIds.has(linkId)) {
        errors.push(`anchor ${id} dropped: unknown link`);
        continue;
      }
    } else {
      errors.push(`anchor ${id} dropped: bad kind`);
      continue;
    }
    const attribute = an.attribute && typeof an.attribute === "object"
      ? { key: kebab((an.attribute as Record<string, unknown>).key, ""), value: kebab((an.attribute as Record<string, unknown>).value, "") }
      : undefined;
    const prompt = str(an.prompt, 1500);
    if (!prompt) {
      errors.push(`anchor ${id} dropped: empty prompt`);
      continue;
    }
    seen.add(id);
    let render: Anchor["render"];
    if (wantBlender && an.render && typeof an.render === "object") {
      const r = an.render as Record<string, unknown>;
      const c = (r.camera && typeof r.camera === "object" ? r.camera : {}) as Record<string, unknown>;
      const lookAt = String(c.look_at || "center");
      render = {
        camera: {
          azimuth_deg: num(c.azimuth_deg, 0, 360, 35),
          elevation_deg: num(c.elevation_deg, -5, 45, 12),
          distance_factor: num(c.distance_factor, 0.7, 1.6, 1.0),
          focal_mm: num(c.focal_mm, 24, 85, 35),
          look_at: /^[a-z0-9:_-]{1,80}$/i.test(lookAt) ? lookAt : "center",
        },
        states: (Array.isArray(r.states) ? r.states : []).map((x) => kebab(x, "")).filter(Boolean),
      };
    }
    const refs = (Array.isArray(an.refs) ? an.refs : []).map((x) => kebab(x, "")).filter(Boolean).slice(0, 6);
    anchors.push({
      id,
      kind: kind as Anchor["kind"],
      ...(objectId ? { object_id: objectId } : {}),
      ...(linkId ? { link_id: linkId } : {}),
      ...(kind === "attribute" && attribute?.key ? { attribute } : {}),
      label: str(an.label, 40) || id,
      prompt,
      status: "pending",
      attempts: 0,
      ...(render ? { render } : {}),
      ...(refs.length ? { refs } : {}),
    });
  }
  // every object must have exactly one identity anchor; synthesize if the model forgot
  for (const o of objects) {
    if (!anchors.some((x) => x.kind === "identity" && x.object_id === o.id)) {
      anchors.push({ id: `anc-${o.id.replace(/^obj-/, "")}-identity`, kind: "identity", object_id: o.id, label: `${o.name} · 身份`, prompt: o.identity_prompt || `${o.name}, ${o.description}. no text, no watermark, no UI`, status: "pending", attempts: 0 });
    }
  }
  // link anchors need a link to a pair of objects; ensure object_id for image reference resolution
  for (const a of anchors) {
    if (a.kind === "link" && !a.object_id) {
      const l = links.find((x) => x.id === a.link_id);
      if (l) a.object_id = l.from;
    }
  }
  const anchorIds = new Set(anchors.map((a) => a.id));

  const shots: Shot[] = [];
  const effectKinds = new Set(["projectile", "aura", "shield", "burst", "bind", "environment", "impact"]);
  const effects: OntologyEffect[] = [];
  for (const [i, e] of (Array.isArray(raw.effects) ? raw.effects : []).slice(0, 12).entries()) {
    const ef = (e || {}) as Record<string, unknown>;
    const id = kebab(ef.id, `fx-${i + 1}`);
    const owner = kebab(ef.owner, "");
    if (!objectIds.has(owner)) { errors.push(`effect ${id} dropped: unknown owner`); continue; }
    if (effects.some((x) => x.id === id)) continue;
    const prompt = str(ef.prompt, 500);
    if (!prompt) { errors.push(`effect ${id} dropped: empty prompt`); continue; }
    effects.push({
      id, owner, kind: (effectKinds.has(String(ef.kind)) ? String(ef.kind) : "burst") as OntologyEffect["kind"],
      label: str(ef.label, 40) || id, colour: str(ef.colour, 60), prompt, motion: str(ef.motion, 400), duration_s: num(ef.duration_s, 0.5, 6, 2),
    });
  }
  const effectIds = new Set(effects.map((x) => x.id));
  const exprOf = (oid: string, key: string) => objects.find((o) => o.id === oid)?.expressions?.find((x) => x.key === key);
  const objName = (oid: string) => { const o = objects.find((x) => x.id === oid); return o?.handle || o?.name || oid; };

  for (const [i, s] of (Array.isArray(raw.shots) ? raw.shots : []).entries()) {
    const sh = (s || {}) as Record<string, unknown>;
    const id = kebab(sh.id, `shot-${String(i + 1).padStart(2, "0")}`);
    const start = kebab(sh.start_anchor, "");
    const end = kebab(sh.end_anchor, "");
    if (!anchorIds.has(start) || !anchorIds.has(end) || start === end) {
      errors.push(`shot ${id} dropped: anchors invalid`);
      continue;
    }
    const sa = anchors.find((x) => x.id === start)!;
    const ea = anchors.find((x) => x.id === end)!;
    const relatedObjects = (a: Anchor) => {
      if (a.kind !== "link") return new Set([a.object_id]);
      const l = links.find((x) => x.id === a.link_id);
      return new Set(l ? [l.from, l.to] : []);
    };
    const so = relatedObjects(sa);
    const eo = relatedObjects(ea);
    if (![...so].some((x) => eo.has(x))) {
      errors.push(`shot ${id} dropped: start/end anchors share no object`);
      continue;
    }
    if (shots.some((x) => x.start_anchor === start && x.end_anchor === end)) {
      errors.push(`shot ${id} dropped: duplicate anchor pair`);
      continue;
    }
    const duration = num(sh.duration_s, 4, 12, LIMITS.shotDuration);
    const beats: ShotBeat[] = [];
    for (const b of (Array.isArray(sh.beats) ? sh.beats : []).slice(0, 8)) {
      const bt = (b || {}) as Record<string, unknown>;
      const actor = kebab(bt.actor, "");
      const action = str(bt.action, 300);
      if (!action) continue;
      const expression = kebab(bt.expression, "");
      const effect = kebab(bt.effect, "");
      if (effect && !effectIds.has(effect)) errors.push(`shot ${id}: beat effect ${effect} unknown; dropped from beat`);
      beats.push({
        t: num(bt.t, 0, 12, 0), ...(objectIds.has(actor) ? { actor } : {}),
        ...(actor && expression && exprOf(actor, expression) ? { expression } : {}),
        action, ...(effect && effectIds.has(effect) ? { effect } : {}), ...(str(bt.camera, 120) ? { camera: str(bt.camera, 120) } : {}),
      });
    }
    beats.sort((a, b) => a.t - b.t);
    const cameraMove = str(sh.camera_move, 200);
    // Beats compile into the model-facing motion prompt: stable subjects first, one camera behaviour, then timestamped beats
    // that quote the actor's expression and the effect's look + motion from the ontology (no adjectives invented here).
    let motion = str(sh.motion_prompt, 1200);
    if (beats.length) {
      const lines = beats.map((b) => {
        const ex = b.actor && b.expression ? exprOf(b.actor, b.expression) : undefined;
        const fx = b.effect ? effects.find((x) => x.id === b.effect) : undefined;
        const who = b.actor ? `${objName(b.actor)}` : "";
        return `[${Math.round(b.t)}s] ${who ? who + ": " : ""}${b.action}${ex ? ` — face: ${ex.prompt}` : ""}${fx ? ` — VFX (${fx.colour}): ${fx.prompt}; ${fx.motion}` : ""}${b.camera ? ` — camera: ${b.camera}` : ""}`;
      });
      const psy = [...new Set(beats.map((b) => b.actor).filter(Boolean))].map((oid) => {
        const o = objects.find((x) => x.id === oid);
        return o?.psyche ? `${o.handle || o.name}: ${o.psyche.attitude_to_threat}; ${o.psyche.body_language}` : "";
      }).filter(Boolean);
      motion = [
        str(sh.motion_prompt, 400),
        cameraMove ? `Camera: ${cameraMove}` : "",
        psy.length ? `Character behaviour — ${psy.join(" | ")}` : "",
        ...lines,
        "Movements have weight and follow-through. No text overlays, subtitles, UI, logos or watermarks.",
      ].filter(Boolean).join("\n");
    }
    shots.push({
      id,
      order: shots.length + 1,
      title: str(sh.title, 40) || id,
      start_anchor: start,
      end_anchor: end,
      duration_s: duration,
      motion_prompt: motion || "Smooth cinematic motion from the first keyframe to the last keyframe. Keep identity, materials and lighting consistent. No text overlays.",
      ...(beats.length ? { beats } : {}),
      ...(cameraMove ? { camera_move: cameraMove } : {}),
      caption: str(sh.caption, 48),
      caption_source: sh.caption_source === "brief" ? "brief" : "ai",
      status: "proposed",
    });
    if (shots.length >= LIMITS.shots) break;
  }
  if (!shots.length) errors.push("model produced no valid shots; review page will let you keep anchors only");

  // prune anchors no shot references (except identity anchors, which are references for everything else)
  const used = new Set(shots.flatMap((s) => [s.start_anchor, s.end_anchor]));
  let keptAnchors = anchors.filter((a) => a.kind === "identity" || used.has(a.id));
  if (keptAnchors.length > LIMITS.anchors) {
    errors.push(`anchors truncated from ${keptAnchors.length} to ${LIMITS.anchors}`);
    keptAnchors = keptAnchors.slice(0, LIMITS.anchors);
  }
  {
    const ids = new Set(keptAnchors.map((a) => a.id));
    for (const a of keptAnchors) if (a.refs) a.refs = a.refs.filter((r) => ids.has(r) && r !== a.id);
  }

  let blender: BlenderLayer | undefined;
  if (wantBlender) {
    const b = (raw.blender && typeof raw.blender === "object" ? raw.blender : {}) as Record<string, unknown>;
    const sc = (b.scene && typeof b.scene === "object" ? b.scene : {}) as Record<string, unknown>;
    const models = new Set(input.models || []);
    const modelName = (v: unknown) => { const n = str(v, 120).replace(/\\/g, "/"); return n && models.has(n) ? n : ""; };
    const axis = (v: unknown, ok: string[], d: string) => (ok.includes(String(v).toUpperCase()) ? String(v).toUpperCase() : d);
    // subjects: v2 list, or the v1 single subject wrapped
    const rawSubjects = Array.isArray(b.subjects) && b.subjects.length ? b.subjects : b.subject && typeof b.subject === "object" ? [{ id: "subject", position_m: [0, 0], ...(b.subject as Record<string, unknown>) }] : [];
    const primary = objects.find((x) => x.type === "vehicle" || x.type === "actor") || objects[0];
    const subjects: BlenderSubject[] = [];
    const subjectIds = new Set<string>();
    for (const [i, rs] of rawSubjects.slice(0, 10).entries()) {
      const sj = (rs || {}) as Record<string, unknown>;
      const sid = kebab(sj.id, `subject-${i + 1}`);
      if (subjectIds.has(sid)) { errors.push(`blender subject ${sid} duplicated; dropped`); continue; }
      const objectId = objectIds.has(kebab(sj.object_id, "")) ? kebab(sj.object_id, "") : primary.id;
      const assetName = modelName((sj.asset as Record<string, unknown> | undefined)?.name);
      if ((sj.asset as Record<string, unknown> | undefined)?.name && !assetName) errors.push(`blender subject ${sid}: asset not on worker; using proxy`);
      const proxyRaw = (sj.proxy && typeof sj.proxy === "object" ? sj.proxy : {}) as Record<string, unknown>;
      const dims = (Array.isArray(proxyRaw.dims_m) ? proxyRaw.dims_m : []).map((v) => num(v, 0.05, 30, 1)).slice(0, 3);
      const pos = (Array.isArray(sj.position_m) ? sj.position_m : [0, 0]).map((v) => num(v, -40, 40, 0)).slice(0, 2);
      const poseRaw = (sj.pose && typeof sj.pose === "object" ? sj.pose : null) as Record<string, unknown> | null;
      const poseLib = poseRaw ? modelName(poseRaw.library) : "";
      const pose = poseRaw && str(poseRaw.clip, 60) ? { ...(poseLib ? { library: poseLib } : {}), clip: str(poseRaw.clip, 60), phase: num(poseRaw.phase, 0, 1, 0) } : undefined;
      if (poseRaw && poseRaw.library && !poseLib) errors.push(`blender subject ${sid}: pose library not on worker; pose ignored`);
      const tint = Array.isArray(sj.tint) && sj.tint.length === 3 ? sj.tint.map((v) => num(v, 0, 1, 0.5)) : undefined;
      subjects.push({
        id: sid, object_id: objectId,
        ...(assetName ? { asset: { name: assetName } } : { proxy: { shape: proxyRaw.shape === "cylinder" ? "cylinder" : "box", dims_m: dims.length === 3 ? dims : [0.5, 0.5, 1.75] } }),
        up_axis: axis(sj.up_axis, ["X", "Y", "Z"], "Y"),
        forward_axis: axis(sj.forward_axis, ["X", "-X", "Y", "-Y", "Z", "-Z"], "Z"),
        ...(sj.height_m !== undefined ? { height_m: num(sj.height_m, 0.05, 30, 1.75) } : { length_m: num(sj.length_m, 0.05, 30, dims[0] || 1.75) }),
        position_m: pos.length === 2 ? pos : [0, 0],
        ...(typeof sj.face === "string" && sj.face ? { face: kebab(sj.face, "") } : { rotation_deg: num(sj.rotation_deg, -360, 360, 0) }),
        ...(pose && poseLib ? { pose } : {}),
        ...(tint ? { tint } : {}),
        ...(sj.elevation_m !== undefined ? { elevation_m: num(sj.elevation_m, -10, 10, 0) } : {}),
        ...(sj.camera_ignore === true ? { camera_ignore: true } : {}),
      });
      subjectIds.add(sid);
    }
    if (!subjects.length) {
      subjects.push({ id: "subject", object_id: primary.id, proxy: { shape: "cylinder", dims_m: [0.5, 0.5, 1.75] }, up_axis: "Y", forward_axis: "Z", height_m: 1.75, position_m: [0, 0], rotation_deg: 0 });
      errors.push("blender: no subjects given; one proxy subject synthesized");
    }
    for (const sj of subjects) if (sj.face && !subjectIds.has(sj.face)) { delete sj.face; sj.rotation_deg = 0; }
    const subjectObjectIds = new Set(subjects.map((x) => x.object_id));
    const stateIds = new Set<string>();
    const states: BlenderLayer["states"] = [];
    for (const [i, st] of (Array.isArray(b.states) ? b.states : []).slice(0, 24).entries()) {
      const so = (st || {}) as Record<string, unknown>;
      const sid = kebab(so.id, `state-${i + 1}`);
      if (stateIds.has(sid)) continue;
      const ops: Array<Record<string, unknown>> = [];
      for (const op of (Array.isArray(so.ops) ? so.ops : []).slice(0, 16)) {
        const oo = (op || {}) as Record<string, unknown>;
        const kind = String(oo.op || "");
        const target = kebab(oo.subject, "");
        const subj = subjectIds.has(target) ? { subject: target } : subjects.length === 1 ? { subject: subjects[0].id } : null;
        if (!subj) { errors.push(`state ${sid}: op ${kind} needs a known subject`); continue; }
        if (kind === "hide" || kind === "show") {
          const match = str(oo.match, 120);
          if (match) { try { new RegExp(match); } catch { errors.push(`state ${sid}: bad regex dropped`); continue; } }
          ops.push({ op: kind, ...subj, ...(match ? { match } : {}) });
        } else if (kind === "add_part") {
          const d = (Array.isArray(oo.dims_m) ? oo.dims_m : []).map((v) => num(v, 0.01, 6, 0.3)).slice(0, 3);
          const at = String(oo.at || "roof-center");
          const emission = Array.isArray(oo.emission) && oo.emission.length === 3 ? oo.emission.map((v) => num(v, 0, 1, 0.5)) : undefined;
          ops.push({
            op: "add_part", ...subj, name: kebab(oo.name, sid), shape: oo.shape === "cylinder" ? "cylinder" : "box",
            dims_m: d.length === 3 ? d : [1.0, 0.3, 0.1], at: (BLENDER_PART_AT as readonly string[]).includes(at) ? at : "roof-center",
            offset_m: (Array.isArray(oo.offset_m) ? oo.offset_m : [0, 0, 0]).map((v) => num(v, -4, 4, 0)).slice(0, 3),
            color: (Array.isArray(oo.color) ? oo.color : [0.05, 0.05, 0.05]).map((v) => num(v, 0, 1, 0.05)).slice(0, 3),
            tilt_deg: num(oo.tilt_deg, -90, 90, 0), snap: oo.snap !== false, ...(emission ? { emission } : {}),
          });
        } else if (kind === "rotate") {
          const match = str(oo.match, 120);
          if (match) { try { new RegExp(match); } catch { continue; } }
          ops.push({ op: "rotate", ...subj, ...(match ? { match, axis: axis(oo.axis, ["X", "Y", "Z"], "Z") } : {}), deg: num(oo.deg, -180, 180, 0) });
        } else if (kind === "pose") {
          const clip = str(oo.clip, 60);
          const lib = modelName(oo.library);
          if (clip) ops.push({ op: "pose", ...subj, clip, phase: num(oo.phase, 0, 1, 0), ...(lib ? { library: lib } : {}) });
        } else if (kind === "move") {
          const d = (Array.isArray(oo.delta_m) ? oo.delta_m : [0, 0, 0]).map((v) => num(v, -20, 20, 0)).slice(0, 3);
          ops.push({ op: "move", ...subj, delta_m: d.length === 3 ? d : [0, 0, 0] });
        }
      }
      if (!ops.length) { errors.push(`state ${sid} dropped: no valid ops`); continue; }
      stateIds.add(sid);
      states.push({ id: sid, label: str(so.label, 40) || sid, ops });
    }
    // anchors: keep render only for anchors about a subject object (or a link between them); validate look_at and states
    for (const a of anchors) {
      if (!a.render) continue;
      const related = (a.object_id && subjectObjectIds.has(a.object_id)) || (a.kind === "link" && links.some((l) => l.id === a.link_id && (subjectObjectIds.has(l.from) || subjectObjectIds.has(l.to))));
      if (!related) { delete a.render; continue; }
      a.render.states = a.render.states.filter((sid) => stateIds.has(sid));
      const [lookSubject, lookPart] = a.render.camera.look_at.split(":");
      const legacy = (BLENDER_LOOK_AT as readonly string[]).includes(a.render.camera.look_at);
      if (!(a.render.camera.look_at === "group" || legacy || (subjectIds.has(lookSubject) && (!lookPart || ["center", "front", "rear", "roof", "ground", "head", "chest"].includes(lookPart))))) {
        a.render.camera.look_at = subjects.length === 1 ? "center" : "group";
      }
    }
    const preset = String(sc.preset || "showroom_dark");
    const stageRaw = (sc.stage && typeof sc.stage === "object" ? sc.stage : null) as Record<string, unknown> | null;
    const sceneAsset = modelName((sc.asset as Record<string, unknown> | undefined)?.name);
    const skyAsset = modelName((sc.sky as Record<string, unknown> | undefined)?.name);
    let hideMatch = str(sc.hide_match, 120);
    if (hideMatch) { try { new RegExp(hideMatch); } catch { hideMatch = ""; } }
    blender = {
      enabled: true,
      scene: {
        preset: (BLENDER_PRESETS as readonly string[]).includes(preset) ? preset : "showroom_dark",
        floor_reflective: sc.floor_reflective !== false,
        ...(sceneAsset ? { asset: { name: sceneAsset } } : {}),
        ...(sceneAsset && stageRaw ? { stage: { origin_m: (Array.isArray(stageRaw.origin_m) ? stageRaw.origin_m : [0, 0, 0]).map((v) => num(v, -500, 500, 0)).slice(0, 3), yaw_deg: num(stageRaw.yaw_deg, -360, 360, 0) } } : {}),
        ...(skyAsset ? { sky: { name: skyAsset } } : {}),
        ...(hideMatch ? { hide_match: hideMatch } : {}),
      },
      subjects,
      states,
    };
    if ((sc.asset as Record<string, unknown> | undefined)?.name && !sceneAsset) errors.push("blender scene asset not on worker; using studio preset");
    if (!anchors.some((a) => a.render)) errors.push("blender requested but no anchor carries a render spec; anchors fall back to image generation");
  }

  return {
    id: `onto-${randomUUID()}`,
    version: 1,
    state: "drafted",
    created_at: Date.now(),
    updated_at: Date.now(),
    brief: input.brief,
    audience: input.audience,
    aspect_ratio: input.aspect_ratio,
    title: str(raw.title, 40) || "未命名本体",
    summary: str(raw.summary, 300),
    style_bible: str(raw.style_bible, 600),
    objects,
    links,
    ...(effects.length ? { effects } : {}),
    anchors: keptAnchors,
    shots,
    review: {},
    render_backend: wantBlender ? "blender" : "image",
    ...(blender ? { blender } : {}),
    progress: { anchors_total: keptAnchors.length, anchors_done: 0 },
    errors,
  };
}

export async function draftOntology(input: { brief: string; audience: Audience; aspect_ratio: Aspect; model?: string; render_backend?: "image" | "blender"; draft?: unknown }) {
  const blender = input.render_backend === "blender" && Boolean(BLENDER_WORKER_URL);
  const models = blender ? (await listBlenderModels()).map((m) => m.name) : [];
  if (input.draft && typeof input.draft === "object") {
    // pre-authored ontology (human or another agent): same gates, no LLM
    const o = normalizeDraft(input.draft as Record<string, unknown>, { ...input, render_backend: blender ? "blender" : "image", models });
    o.llm_model = "draft";
    return o;
  }
  const user = `视频需求：\n${input.brief}\n\n受众线：${input.audience}（${AUDIENCE_HINT[input.audience]}）\n画幅：${input.aspect_ratio}${blender ? `\n渲染后端：blender（可用模型文件：${models.join(", ") || "无"}）` : ""}`;
  const { value, model, fallbacks } = await chatJson({ system: blender ? ONTOLOGY_SYSTEM + BLENDER_SYSTEM_EXTRA(models) : ONTOLOGY_SYSTEM, user, preferredModel: input.model, timeoutMs: 150000 });
  const o = normalizeDraft(value, { ...input, render_backend: blender ? "blender" : "image", models });
  if (input.render_backend === "blender" && !BLENDER_WORKER_URL) o.errors.unshift("render_backend=blender requested but BLENDER_STORY_WORKER_URL is not configured; used image backend");
  o.llm_model = model;
  if (fallbacks.length) o.errors.unshift(`llm fallback before ${model}: ${fallbacks.join(" | ").slice(0, 400)}`);
  return o;
}

/* ---------- anchor image generation (async, sequential, progress persisted) ---------- */

const running = new Set<string>();

function anchorPrompt(o: Ontology, a: Anchor) {
  const obj = a.object_id ? o.objects.find((x) => x.id === a.object_id) : undefined;
  const parts = [o.style_bible, a.prompt];
  if (a.kind !== "identity" && obj?.identity_prompt) parts.push(`Keep the same subject as the reference: ${obj.identity_prompt}`);
  if (a.feedback) parts.push(`Reviewer feedback to apply: ${a.feedback}`);
  parts.push("no text, no watermark, no UI");
  return parts.filter(Boolean).join("\n");
}

const GREYBOX_RESTYLE = "Restyle the reference 3D layout render into the visual style described below. CRITICAL: keep the exact camera angle, framing, and the position, footprint and height of every volume from the reference; do not zoom, crop, move or re-centre anything. Grey proxy volumes are stand-ins: replace each with the subject, character, creature, prop or floating panel described, occupying exactly that spot and size. Rebuild materials, lighting and the surrounding environment as described.";

/* One Blender run renders every target anchor that carries a render spec; results are stored as anchor.greybox. */
async function renderGreyboxes(o: Ontology, targets: Anchor[], request: Request) {
  const b = o.blender;
  if (!b?.enabled || !BLENDER_WORKER_URL) return;
  const withRender = targets.filter((a) => a.render);
  if (!withRender.length) return;
  const [w, h] = o.aspect_ratio === "9:16" ? [720, 1280] : o.aspect_ratio === "1:1" ? [1024, 1024] : [1280, 720];
  const subjects = b.subjects?.length ? b.subjects : b.subject ? [{ id: "subject", object_id: b.subject.object_id, asset: b.subject.asset, proxy: b.subject.proxy, up_axis: b.subject.up_axis, forward_axis: b.subject.forward_axis, length_m: b.subject.length_m, rotation_deg: b.subject.rotation_deg, position_m: [0, 0] } as BlenderSubject] : [];
  const spec = {
    scene: {
      preset: b.scene.preset, floor_reflective: b.scene.floor_reflective,
      ...(b.scene.asset ? { asset: { path: b.scene.asset.name } } : {}),
      ...(b.scene.stage ? { stage: b.scene.stage } : {}),
      ...(b.scene.sky ? { sky: { path: b.scene.sky.name } } : {}),
      ...(b.scene.hide_match ? { hide_match: b.scene.hide_match } : {}),
    },
    subjects: subjects.map((sj) => ({
      id: sj.id,
      ...(sj.asset ? { asset: { path: sj.asset.name } } : { proxy: sj.proxy }),
      up_axis: sj.up_axis, forward_axis: sj.forward_axis,
      ...(sj.height_m ? { height_m: sj.height_m } : { length_m: sj.length_m }),
      position_m: sj.position_m, ...(sj.face ? { face: sj.face } : { rotation_deg: sj.rotation_deg || 0 }),
      ...(sj.pose ? { pose: { ...sj.pose, ...(sj.pose.library ? { library: sj.pose.library } : {}) } } : {}),
      ...(sj.tint ? { tint: sj.tint } : {}),
      ...(sj.elevation_m !== undefined ? { elevation_m: sj.elevation_m } : {}),
      ...(sj.camera_ignore ? { camera_ignore: true } : {}),
    })),
    states: b.states.map((st) => ({ id: st.id, ops: st.ops })),
    anchors: withRender.map((a) => ({ id: a.id, camera: a.render!.camera, states: a.render!.states })),
    resolution: [w, h], engine: "BLENDER_EEVEE", samples: 24, job_ref: o.id,
  };
  const submit = await fetch(`${BLENDER_WORKER_URL}/api/v1/ontology-render`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(spec), signal: AbortSignal.timeout(20000) });
  const submitText = await submit.text();
  if (!submit.ok) throw new Error(`blender worker ${submit.status}: ${submitText.slice(0, 300)}`);
  const jobId = String((JSON.parse(submitText) as { job_id?: string }).job_id || "");
  b.worker_job_id = jobId;
  await saveOntology(o);
  const deadline = Date.now() + Math.max(300, 120 + 90 * withRender.length) * 1000;
  let last: Record<string, unknown> = {};
  while (Date.now() < deadline) {
    await new Promise((r) => setTimeout(r, 3000));
    const poll = await fetch(`${BLENDER_WORKER_URL}/api/v1/ontology-render/${encodeURIComponent(jobId)}`, { signal: AbortSignal.timeout(60000) });
    last = (await poll.json()) as Record<string, unknown>;
    if (last.state === "complete" || last.state === "failed") break;
  }
  if (last.state !== "complete") throw new Error(`blender render ${String(last.state || "timeout")}: ${String(last.error || "")}`.slice(0, 300));
  const images = (last.images || {}) as Record<string, { image_b64?: string; camera?: unknown }>;
  for (const a of withRender) {
    const img = images[a.id];
    if (!img?.image_b64) { a.error = "greybox missing from worker result"; continue; }
    const imageId = `img-${randomUUID()}`;
    const filename = `greybox-${a.id}.png`;
    const outPath = join(imageOutputDir, imageId, filename);
    await mkdir(join(imageOutputDir, imageId), { recursive: true });
    await writeFile(outPath, Buffer.from(img.image_b64, "base64"));
    a.greybox = { image_id: imageId, filename, public_url: imagePublicUrl(request, imageId, filename), path: outPath, camera: img.camera };
  }
  await saveOntology(o);
}

async function referenceImagesFor(o: Ontology, a: Anchor): Promise<ReferenceImage[]> {
  const objectIds = new Set<string>();
  if (a.object_id) objectIds.add(a.object_id);
  if (a.kind === "link") {
    const l = o.links.find((x) => x.id === a.link_id);
    if (l) {
      objectIds.add(l.from);
      objectIds.add(l.to);
    }
  }
  const refs: ReferenceImage[] = [];
  for (const oid of objectIds) {
    const identity = o.anchors.find((x) => x.kind === "identity" && x.object_id === oid && x.image && (x.status === "generated" || x.status === "approved"));
    if (!identity?.image) continue;
    try {
      refs.push({ buffer: await readFile(identity.image.path), mimeType: identity.image.filename.endsWith(".png") ? "image/png" : "image/jpeg", filename: identity.image.filename });
    } catch {
      /* missing file: fall through to pure generation */
    }
  }
  return refs.slice(0, 6);
}

export function startAnchorJob(o: Ontology, request: Request, only?: string[]) {
  if (running.has(o.id)) return false;
  running.add(o.id);
  const targets = o.anchors.filter((a) => (only ? only.includes(a.id) : a.status === "pending" || a.status === "failed"));
  // identity first so later anchors can reference them
  const referenced = new Set(o.anchors.flatMap((a) => a.refs || []));
  // identities without refs (e.g. a look/style frame) first, then identities that reference them, then anchors others depend on
  const rank = (a: Anchor) => (a.kind === "identity" ? ((a.refs || []).length ? 1 : 0) : referenced.has(a.id) && !(a.refs || []).some((r) => referenced.has(r) && r !== a.id) ? 2 : (a.refs || []).length ? 4 : 3);
  targets.sort((a, b) => rank(a) - rank(b));
  void (async () => {
    try {
      o.state = "anchoring";
      for (const t of targets) {
        t.status = "generating";
        t.error = undefined;
        await saveOntology(o);
      }
      if (o.blender?.enabled) {
        try {
          await renderGreyboxes(o, targets, request);
          o.blender.error = undefined;
        } catch (error) {
          o.blender.error = error instanceof Error ? error.message : String(error);
          o.errors.push(`blender: ${o.blender.error}; anchors fall back to image generation`);
          await saveOntology(o);
        }
      }
      for (const t of targets) {
        const anchor = o.anchors.find((x) => x.id === t.id)!;
        anchor.attempts += 1;
        const imageId = `img-${randomUUID()}`;
        const filename = `anchor-${anchor.id}.${imageOutputFormat === "png" ? "png" : "jpg"}`;
        const outPath = join(imageOutputDir, imageId, filename);
        try {
          let result: { model: string };
          if (anchor.greybox) {
            // greybox first (geometry / framing), then the subject's already-restyled identity for materials
            const refs: ReferenceImage[] = [{ buffer: await readFile(anchor.greybox.path), mimeType: "image/png", filename: anchor.greybox.filename }];
            const refNotes: string[] = [];
            for (const rid of anchor.refs || []) {
              const r = o.anchors.find((x) => x.id === rid && x.image && (x.status === "generated" || x.status === "approved"));
              if (!r?.image) continue;
              try {
                refs.push({ buffer: await readFile(r.image.path), mimeType: r.image.filename.endsWith(".png") ? "image/png" : "image/jpeg", filename: r.image.filename });
                refNotes.push(`reference ${refs.length}: ${r.label}`);
              } catch { /* missing file */ }
            }
            if (anchor.kind !== "identity" && refs.length < 3) refs.push(...(await referenceImagesFor(o, anchor)).slice(0, 2));
            const prompt = [GREYBOX_RESTYLE, o.style_bible, anchor.prompt,
              refs.length > 1 ? `References after the first show the finished look to match (${refNotes.join("; ") || "identity images"}): a look/style frame sets palette, light, texture and grade; character references fix wardrobe, hair and face — match them exactly.` : "",
              anchor.feedback ? `Reviewer feedback to apply: ${anchor.feedback}` : "", "no text, no watermark, no UI"].filter(Boolean).join("\n");
            result = await editImageWithReference(prompt, o.aspect_ratio, outPath, refs, "medium");
          } else {
            const refs = anchor.kind === "identity" ? [] : await referenceImagesFor(o, anchor);
            const prompt = anchorPrompt(o, anchor);
            result = refs.length
              ? await editImageWithReference(prompt, o.aspect_ratio, outPath, refs)
              : await generateImage(prompt, o.aspect_ratio, outPath);
          }
          anchor.image = { image_id: imageId, filename, public_url: imagePublicUrl(request, imageId, filename), path: outPath };
          anchor.model = result.model;
          anchor.status = "generated";
        } catch (error) {
          anchor.status = "failed";
          anchor.error = error instanceof Error ? error.message : String(error);
        }
        o.progress.anchors_done = o.anchors.filter((x) => ["generated", "approved", "rejected"].includes(x.status)).length;
        await saveOntology(o);
      }
      o.state = "review";
      await saveOntology(o);
    } catch (error) {
      o.errors.push(error instanceof Error ? error.message : String(error));
      o.state = "review";
      await saveOntology(o);
    } finally {
      running.delete(o.id);
    }
  })();
  return true;
}

/* ---------- review decisions ---------- */

export function applyReview(o: Ontology, body: Record<string, unknown>) {
  const anchorDecisions = (body.anchors || {}) as Record<string, unknown>;
  for (const [id, decision] of Object.entries(anchorDecisions)) {
    const a = o.anchors.find((x) => x.id === id);
    if (!a) continue;
    const d = decision && typeof decision === "object" ? (decision as Record<string, unknown>) : { status: decision };
    if (d.status === "approved" && a.image) a.status = "approved";
    else if (d.status === "rejected") a.status = "rejected";
    else if (d.status === "pending") a.status = "pending";
    if (typeof d.feedback === "string") a.feedback = str(d.feedback, 400);
  }
  const shotDecisions = (body.shots || {}) as Record<string, unknown>;
  for (const [id, decision] of Object.entries(shotDecisions)) {
    const s = o.shots.find((x) => x.id === id);
    if (!s) continue;
    const d = decision && typeof decision === "object" ? (decision as Record<string, unknown>) : { status: decision };
    if (d.status === "approved" || d.status === "rejected" || d.status === "proposed") s.status = d.status;
    if (typeof d.caption === "string") s.caption = str(d.caption, 48);
    if (typeof d.motion_prompt === "string" && d.motion_prompt.trim()) s.motion_prompt = str(d.motion_prompt, 800);
    const start = typeof d.start_anchor === "string" ? kebab(d.start_anchor, "") : s.start_anchor;
    const end = typeof d.end_anchor === "string" ? kebab(d.end_anchor, "") : s.end_anchor;
    if ((start !== s.start_anchor || end !== s.end_anchor) && start !== end && o.anchors.some((a) => a.id === start) && o.anchors.some((a) => a.id === end)) {
      s.start_anchor = start;
      s.end_anchor = end;
      if (["queued", "running", "done", "failed"].includes(s.status)) {
        s.status = "approved";
        s.video_job_id = undefined;
        s.video_url = undefined;
        s.error = undefined;
      }
    }
  }
  if (typeof body.notes === "string") o.review.notes = str(body.notes, 2000);
  if (typeof body.reviewer === "string") o.review.reviewer = str(body.reviewer, 80);
  o.review.decided_at = Date.now();
  const ready = readyShots(o);
  if (o.state === "review" && ready.length && ready.length === o.shots.filter((s) => s.status === "approved").length) o.state = "approved";
  return o;
}

export function readyShots(o: Ontology) {
  return o.shots.filter((s) => {
    if (s.status !== "approved") return false;
    const a = o.anchors.find((x) => x.id === s.start_anchor);
    const b = o.anchors.find((x) => x.id === s.end_anchor);
    return a?.status === "approved" && a.image && b?.status === "approved" && b.image;
  });
}

/* ---------- video: approved shot → gateway first/last keyframe job ---------- */

async function fileToDataUrl(path: string, filename: string) {
  const buf = await readFile(path);
  const mime = filename.endsWith(".png") ? "image/png" : "image/jpeg";
  return `data:${mime};base64,${buf.toString("base64")}`;
}

export async function submitShotVideos(o: Ontology, shotIds?: string[]) {
  const baseUrl = (env.VIDEO_API_PROXY_BASE_URL || "").replace(/\/+$/, "");
  if (!baseUrl) throw new Error("VIDEO_API_PROXY_BASE_URL is not configured");
  const token = env.VIDEO_API_PROXY_TOKEN || env.VIDEO_API_TOKEN || "";
  const targets = readyShots(o).filter((s) => !shotIds || shotIds.includes(s.id)).filter((s) => !["queued", "running", "done"].includes(s.status) || (shotIds && shotIds.includes(s.id)));
  if (!targets.length) throw new Error("no approved shots with two approved anchors");
  o.state = "generating";
  for (const s of targets) {
    const a = o.anchors.find((x) => x.id === s.start_anchor)!;
    const b = o.anchors.find((x) => x.id === s.end_anchor)!;
    try {
      const response = await fetch(`${baseUrl}/image-videos`, {
        method: "POST",
        headers: { "content-type": "application/json", ...(token ? { authorization: `Bearer ${token}` } : {}) },
        body: JSON.stringify({
          video_subject: `${o.title} · ${s.title}`,
          video_aspect: o.aspect_ratio,
          duration: s.duration_s,
          single_clip: true,
          first_image_b64: await fileToDataUrl(a.image!.path, a.image!.filename),
          last_image_b64: await fileToDataUrl(b.image!.path, b.image!.filename),
          video_prompt: `${o.style_bible}\n${s.motion_prompt}\nAnimate from the first keyframe to the last keyframe. Preserve identity, materials and lighting. No text overlays, subtitles, UI, logos or watermarks.`,
          subtitle_enabled: false,
          ontology_id: o.id,
          shot_id: s.id,
        }),
      });
      const text = await response.text();
      let data: Record<string, unknown> = {};
      try {
        data = JSON.parse(text) as Record<string, unknown>;
      } catch {
        /* keep raw */
      }
      const inner = (data.data && typeof data.data === "object" ? data.data : data) as Record<string, unknown>;
      const jobId = String(inner.job_id || inner.task_id || "");
      if (!response.ok || !jobId) throw new Error(`gateway ${response.status}: ${text.slice(0, 200)}`);
      s.video_job_id = jobId;
      s.status = "queued";
      s.error = undefined;
    } catch (error) {
      s.status = "failed";
      s.error = error instanceof Error ? error.message : String(error);
    }
  }
  await saveOntology(o);
  return targets;
}

/* Sync shot statuses from the gateway; called by GET when anything is queued/running. */
export async function refreshShotVideos(o: Ontology) {
  const baseUrl = (env.VIDEO_API_PROXY_BASE_URL || "").replace(/\/+$/, "");
  const token = env.VIDEO_API_PROXY_TOKEN || env.VIDEO_API_TOKEN || "";
  const pending = o.shots.filter((s) => s.video_job_id && (s.status === "queued" || s.status === "running"));
  if (!baseUrl || !pending.length) return false;
  let changed = false;
  for (const s of pending) {
    try {
      const response = await fetch(`${baseUrl}/image-videos/${encodeURIComponent(s.video_job_id!)}`, {
        headers: token ? { authorization: `Bearer ${token}` } : {},
      });
      const data = (await response.json()) as { data?: Record<string, unknown> };
      const d = data.data || {};
      const state = String(d.state || "");
      const drive = d.drive_video as { public_url?: string; webContentLink?: string; webViewLink?: string } | undefined;
      // Drive download/view links are not playable in <video> (MEDIA_ERR_SRC_NOT_SUPPORTED); they
      // only go to drive_url. Prefer the gateway-served copy, then the provider URL.
      const url = (d.storage_video as { public_url?: string } | undefined)?.public_url
        || (d.result_video_url as string | undefined)
        || (d.public_url as string | undefined)
        || (d.video_url as string | undefined);
      if (drive?.webViewLink || drive?.webContentLink || drive?.public_url) s.drive_url = String(drive.webViewLink || drive.webContentLink || drive.public_url);
      if (d.archive_error) s.archive_error = String(d.archive_error);
      if (d.video_model) s.video_model = String(d.video_model);
      if (url) {
        s.status = "done";
        s.video_url = String(url);
        changed = true;
      } else if (state === "failed" || state === "error") {
        s.status = "failed";
        s.error = String(d.error || "生成失败");
        changed = true;
      } else if (state && s.status !== "running") {
        s.status = "running";
        changed = true;
      }
    } catch {
      /* transient; try next poll */
    }
  }
  if (o.shots.length && o.shots.every((s) => s.status === "done" || s.status === "rejected")) o.state = "done";
  if (changed) await saveOntology(o);
  return changed;
}

/* ---------- standalone review HTML ---------- */

function esc(v: unknown) {
  return String(v ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c] as string));
}

function linkGraphSvg(o: Ontology) {
  const W = 860;
  const n = o.objects.length;
  const H = n <= 3 ? 260 : 340;
  const cx = W / 2;
  const cy = H / 2;
  const r = Math.min(W, H) / 2 - 70;
  const pos = new Map<string, { x: number; y: number }>();
  o.objects.forEach((obj, i) => {
    const ang = (-Math.PI / 2) + (i * 2 * Math.PI) / Math.max(1, n);
    pos.set(obj.id, { x: cx + (n === 1 ? 0 : r * Math.cos(ang)), y: cy + (n === 1 ? 0 : r * Math.sin(ang)) });
  });
  const color: Record<string, string> = { vehicle: "#2F6FED", accessory: "#F28C28", actor: "#7A5AF8", environment: "#2E9E6B", prop: "#8E8E93" };
  const lines = o.links.map((l) => {
    const a = pos.get(l.from)!;
    const b = pos.get(l.to)!;
    const mx = (a.x + b.x) / 2;
    const my = (a.y + b.y) / 2;
    const anchored = o.anchors.some((x) => x.kind === "link" && x.link_id === l.id);
    return `<line x1="${a.x}" y1="${a.y}" x2="${b.x}" y2="${b.y}" stroke="${anchored ? "#2E9E6B" : "#8E8E93"}" stroke-width="1.8" ${anchored ? "" : 'stroke-dasharray="5 4"'} marker-end="url(#ar)"/>
<rect x="${mx - 58}" y="${my - 11}" width="116" height="22" rx="11" fill="#fff" stroke="#e5e5ea"/>
<text x="${mx}" y="${my + 4}" text-anchor="middle" font-size="11" fill="#1d1d1f">${esc(l.label)}${l.qty ? ` ×${l.qty}` : ""}</text>`;
  });
  const nodes = o.objects.map((obj) => {
    const p = pos.get(obj.id)!;
    const identity = o.anchors.find((x) => x.kind === "identity" && x.object_id === obj.id);
    const img = identity?.image ? `<clipPath id="c-${esc(obj.id)}"><circle cx="${p.x}" cy="${p.y - 6}" r="30"/></clipPath><image href="${esc(identity.image.public_url)}" x="${p.x - 30}" y="${p.y - 36}" width="60" height="60" preserveAspectRatio="xMidYMid slice" clip-path="url(#c-${esc(obj.id)})"/>` : "";
    return `<circle cx="${p.x}" cy="${p.y - 6}" r="32" fill="${color[obj.type] || "#8E8E93"}" fill-opacity="0.15" stroke="${color[obj.type] || "#8E8E93"}" stroke-width="2"/>${img}
<text x="${p.x}" y="${p.y + 44}" text-anchor="middle" font-size="12" font-weight="700" fill="#1d1d1f">${esc(obj.name)}</text>
<text x="${p.x}" y="${p.y + 59}" text-anchor="middle" font-size="10" fill="#6e6e73">${esc(obj.type)} · ${obj.attributes.length} 属性</text>`;
  });
  return `<svg viewBox="0 0 ${W} ${H}" width="100%" style="max-width:${W}px;display:block;margin:0 auto;font-family:inherit"><defs><marker id="ar" viewBox="0 0 10 10" refX="9" refY="5" markerWidth="7" markerHeight="7" orient="auto"><path d="M0 0L10 5L0 10z" fill="#8E8E93"/></marker></defs>${lines.join("")}${nodes.join("")}</svg>`;
}

export function renderReviewHtml(o: Ontology, apiBase: string) {
  const anchorById = new Map(o.anchors.map((a) => [a.id, a]));
  const objName = (id?: string) => o.objects.find((x) => x.id === id)?.name || id || "";
  const statusZh: Record<string, string> = { pending: "待生成", generating: "生成中", generated: "待审", approved: "已通过", rejected: "已驳回", failed: "失败", proposed: "待审", queued: "已排队", running: "生成中", done: "完成", drafted: "已起草", anchoring: "锚图生成中", review: "待审核" };

  const anchorCard = (a: Anchor) => `
<div class="anchor ${esc(a.status)}" data-anchor="${esc(a.id)}">
  <div class="thumb">${a.image ? `<img src="${esc(a.image.public_url)}" alt="${esc(a.label)}" loading="lazy">` : `<div class="ph">${a.status === "generating" ? "生成中…" : a.status === "failed" ? "失败" : "待生成"}</div>`}${a.greybox ? `<img class="gb" src="${esc(a.greybox.public_url)}" alt="greybox" title="Blender 白模帧" loading="lazy">` : ""}</div>
  ${a.render ? `<div class="cam">📐 az ${a.render.camera.azimuth_deg}° · el ${a.render.camera.elevation_deg}° · ×${a.render.camera.distance_factor} · ${a.render.camera.focal_mm}mm · ${esc(a.render.camera.look_at)}${a.render.states.length ? ` · 状态 ${esc(a.render.states.join(", "))}` : ""}</div>` : ""}
  <div class="ainfo">
    <div class="alabel"><b>${esc(a.label)}</b> <span class="tag ${esc(a.kind)}">${a.kind === "identity" ? "身份" : a.kind === "attribute" ? `属性 ${esc(a.attribute?.key || "")}=${esc(a.attribute?.value || "")}` : "链接"}</span> <span class="st">${esc(statusZh[a.status] || a.status)}</span></div>
    <details><summary>prompt / 模型 ${a.model ? `· ${esc(a.model)}` : ""} ${a.attempts ? `· 第 ${a.attempts} 次` : ""}</summary><pre>${esc(a.prompt)}</pre>${a.error ? `<pre class="err">${esc(a.error)}</pre>` : ""}</details>
    <div class="acts">
      <button class="ok" data-act="approve" ${a.image ? "" : "disabled"}>✓ 通过</button>
      <button class="no" data-act="reject">✗ 驳回</button>
      <input class="fb" placeholder="重生成意见（可选）" value="${esc(a.feedback || "")}">
      <button class="re" data-act="regen">↻ 重生成</button>
    </div>
  </div>
</div>`;

  const objectSections = o.objects.map((obj) => {
    const mine = o.anchors.filter((a) => a.object_id === obj.id && a.kind !== "link");
    return `<section class="obj">
<h3>${esc(obj.name)} <span class="tag ${esc(obj.type)}">${esc(obj.type)}</span></h3>
<p class="muted">${esc(obj.description)}</p>
<table class="attrs"><thead><tr><th>属性</th><th>枚举值（每个值以后是一张锁定图）</th></tr></thead><tbody>
${obj.attributes.map((at) => `<tr><td><b>${esc(at.label)}</b><br><code>${esc(at.key)}</code></td><td>${at.values.map((v) => `<span class="pill ${o.anchors.some((a) => a.kind === "attribute" && a.object_id === obj.id && a.attribute?.key === at.key && a.attribute?.value === v.value) ? "anchored" : ""}">${esc(v.label)}</span>`).join(" ")}</td></tr>`).join("")}
</tbody></table>
<div class="grid">${mine.map(anchorCard).join("")}</div>
</section>`;
  }).join("");

  const linkAnchors = o.anchors.filter((a) => a.kind === "link");
  const linkSection = `<section>
<h2>二、关系（链接）</h2>
<p class="muted">实线 = 该关系锁了一张"装配好的样子"锚图；虚线 = 只在本体里，不单独出图。</p>
${linkGraphSvg(o)}
<table class="attrs"><thead><tr><th>链接</th><th>从</th><th>到</th><th>类型</th><th>数量</th></tr></thead><tbody>
${o.links.map((l) => `<tr><td><b>${esc(l.label)}</b><br><code>${esc(l.id)}</code></td><td>${esc(objName(l.from))}</td><td>${esc(objName(l.to))}</td><td><code>${esc(l.type)}</code></td><td>${l.qty ?? "—"}</td></tr>`).join("") || `<tr><td colspan="5" class="muted">本体没有链接</td></tr>`}
</tbody></table>
${linkAnchors.length ? `<div class="grid">${linkAnchors.map(anchorCard).join("")}</div>` : ""}
</section>`;

  const shotCard = (s: Shot) => {
    const a = anchorById.get(s.start_anchor);
    const b = anchorById.get(s.end_anchor);
    const th = (x?: Anchor) => x?.image ? `<img src="${esc(x.image.public_url)}" alt="">` : `<div class="ph">${esc(x?.label || "?")}</div>`;
    const opts = (cur: string) => o.anchors.filter((x) => x.image).map((x) => `<option value="${esc(x.id)}" ${x.id === cur ? "selected" : ""}>${esc(x.label)}</option>`).join("");
    return `<div class="shot ${esc(s.status)}" data-shot="${esc(s.id)}">
  <div class="shead"><b>#${s.order} ${esc(s.title)}</b> <span class="st">${esc(statusZh[s.status] || s.status)}</span> <span class="muted">${s.duration_s}s</span></div>
  <div class="frames"><div class="fr">${th(a)}<select class="sa">${opts(s.start_anchor)}</select></div><div class="arrow">→ 补间 →</div><div class="fr">${th(b)}<select class="ea">${opts(s.end_anchor)}</select></div></div>
  <label>字幕 <span class="tag ${s.caption_source}">${s.caption_source === "brief" ? "来自需求原文" : "AI 补写"}</span><input class="cap" value="${esc(s.caption)}" maxlength="48"></label>
  <label>运动提示 <textarea class="mp" rows="2">${esc(s.motion_prompt)}</textarea></label>
  ${s.beats?.length ? `<div class="muted" style="font-size:12px;margin:4px 0">${s.camera_move ? `📷 ${esc(s.camera_move)}<br>` : ""}${s.beats.map((b) => `[${Math.round(b.t)}s] ${b.actor ? esc(objName(b.actor)) + " " : ""}${b.expression ? `〔${esc(b.expression)}〕 ` : ""}${esc(b.action)}${b.effect ? ` ✦${esc(b.effect)}` : ""}`).join("<br>")}</div>` : ""}
  ${s.video_url ? `<video src="${esc(s.video_url)}" controls playsinline></video><span class="muted" style="font-size:12px"><a href="${esc(s.video_url)}" target="_blank">打开视频</a>${s.drive_url ? ` · <a href="${esc(s.drive_url)}" target="_blank">Drive</a>` : ""}${s.video_model ? ` · ${esc(s.video_model)}` : ""}${s.archive_error ? ` · <b style="color:#b45309">未归档</b>（${esc(s.archive_error.slice(0, 80))}）` : ""}</span>` : ""}
  ${s.error ? `<pre class="err">${esc(s.error)}</pre>` : ""}
  <div class="acts"><button class="ok" data-act="approve">✓ 通过</button><button class="no" data-act="reject">✗ 驳回</button>${s.video_job_id ? `<code>job ${esc(s.video_job_id)}</code>` : ""}</div>
</div>`;
  };

  const errorsBlock = o.errors.length ? `<details class="errs"><summary>规范化 / 运行日志（${o.errors.length}）</summary><pre>${esc(o.errors.join("\n"))}</pre></details>` : "";

  return `<!doctype html><html lang="zh-CN"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><meta name="robots" content="noindex">
<title>审核 · ${esc(o.title)}</title>
<style>
:root{--fg:#1d1d1f;--muted:#6e6e73;--line:#e5e5ea;--soft:#f5f5f7;--ok:#2E9E6B;--no:#D64545;--blue:#2F6FED;--orange:#F28C28;--purple:#7A5AF8;--gray:#8E8E93}
*{box-sizing:border-box}body{margin:0;color:var(--fg);background:#fff;font:15px/1.6 -apple-system,BlinkMacSystemFont,"PingFang SC","Hiragino Sans GB","Microsoft YaHei",sans-serif}
.wrap{max-width:960px;margin:0 auto;padding:24px 18px 120px}
h1{font-size:24px;margin:0 0 4px}h2{font-size:19px;margin:36px 0 10px;padding-top:10px;border-top:1px solid var(--line)}h3{font-size:16px;margin:22px 0 4px}
.muted{color:var(--muted)}.callout{background:var(--soft);border-left:3px solid var(--blue);padding:10px 14px;border-radius:6px;margin:12px 0}
.tag{display:inline-block;font-size:11px;padding:1px 8px;border-radius:10px;background:var(--soft);color:var(--muted);vertical-align:middle}
.tag.vehicle{color:var(--blue)}.tag.accessory{color:var(--orange)}.tag.actor{color:var(--purple)}.tag.environment{color:var(--ok)}.tag.identity{color:var(--blue)}.tag.attribute{color:var(--orange)}.tag.link{color:var(--ok)}.tag.brief{color:var(--ok)}.tag.ai{color:var(--orange)}
.st{font-size:12px;color:var(--muted)}
table.attrs{width:100%;border-collapse:collapse;font-size:13.5px;margin:8px 0}table.attrs th,table.attrs td{border:1px solid var(--line);padding:6px 8px;text-align:left;vertical-align:top}table.attrs th{background:var(--soft)}
.pill{display:inline-block;padding:2px 9px;border:1px dashed var(--line);border-radius:12px;font-size:12px;margin:2px 2px}.pill.anchored{border-style:solid;border-color:var(--ok);color:var(--ok)}
.grid{display:grid;grid-template-columns:repeat(auto-fill,minmax(280px,1fr));gap:12px;margin:10px 0}
.anchor{border:1px solid var(--line);border-radius:10px;overflow:hidden;background:#fff}.anchor.approved{border-color:var(--ok);box-shadow:0 0 0 2px rgba(46,158,107,.18)}.anchor.rejected{border-color:var(--no);opacity:.75}.anchor.generating{border-style:dashed}
.thumb{aspect-ratio:${o.aspect_ratio === "9:16" ? "9/16" : o.aspect_ratio === "1:1" ? "1/1" : "16/9"};background:var(--soft);display:flex;align-items:center;justify-content:center;max-height:360px}.thumb{position:relative}.thumb img{width:100%;height:100%;object-fit:contain}.thumb img.gb{position:absolute;right:6px;bottom:6px;width:34%;height:auto;border:2px solid #fff;border-radius:6px;box-shadow:0 2px 8px rgba(0,0,0,.35)}.ph{color:var(--muted);font-size:13px}.cam{font-size:11px;color:var(--muted);padding:4px 10px 0;font-family:ui-monospace,Menlo,monospace}
.ainfo{padding:8px 10px}.alabel{font-size:13.5px}details{font-size:12px;color:var(--muted);margin:4px 0}pre{white-space:pre-wrap;word-break:break-word;background:var(--soft);padding:6px 8px;border-radius:6px;font-size:11.5px;margin:4px 0}pre.err{color:var(--no)}
.acts{display:flex;gap:6px;flex-wrap:wrap;align-items:center;margin-top:6px}button{font:inherit;font-size:12.5px;padding:4px 10px;border-radius:7px;border:1px solid var(--line);background:#fff;cursor:pointer}button.ok{border-color:var(--ok);color:var(--ok)}button.no{border-color:var(--no);color:var(--no)}button.re{color:var(--blue)}button:disabled{opacity:.4;cursor:not-allowed}
input.fb{flex:1;min-width:120px;font:inherit;font-size:12px;padding:4px 8px;border:1px solid var(--line);border-radius:7px}
.shot{border:1px solid var(--line);border-radius:10px;padding:10px 12px;margin:10px 0;background:#fff}.shot.approved{border-color:var(--ok)}.shot.rejected{border-color:var(--no);opacity:.75}.shot.done{border-color:var(--purple)}
.frames{display:grid;grid-template-columns:1fr auto 1fr;gap:8px;align-items:center;margin:8px 0}.fr img,.fr .ph{width:100%;aspect-ratio:${o.aspect_ratio === "9:16" ? "9/16" : o.aspect_ratio === "1:1" ? "1/1" : "16/9"};object-fit:cover;border-radius:6px;background:var(--soft);display:flex;align-items:center;justify-content:center}.fr small{display:block;text-align:center;color:var(--muted);font-size:11.5px;margin-top:2px}.fr select{display:block;width:100%;margin-top:4px;font:inherit;font-size:12px;padding:3px 6px;border:1px solid var(--line);border-radius:6px;background:#fff;color:var(--fg)}.arrow{color:var(--muted);font-size:12px;white-space:nowrap}
label{display:block;font-size:12.5px;color:var(--muted);margin:6px 0}input.cap,textarea.mp{display:block;width:100%;font:inherit;font-size:13px;padding:5px 8px;border:1px solid var(--line);border-radius:7px;margin-top:2px;color:var(--fg)}
video{width:100%;max-height:420px;background:#000;border-radius:8px;margin:8px 0 2px}
.bar{position:fixed;left:0;right:0;bottom:0;background:rgba(255,255,255,.96);backdrop-filter:blur(8px);border-top:1px solid var(--line);padding:10px 18px;display:flex;gap:10px;align-items:center;flex-wrap:wrap;justify-content:center}
.bar button{font-size:14px;padding:8px 16px}.bar .primary{background:var(--blue);color:#fff;border-color:var(--blue)}.bar .gen{background:var(--purple);color:#fff;border-color:var(--purple)}#msg{font-size:12.5px;color:var(--muted);flex-basis:100%;text-align:center}
.errs{margin-top:30px}
@media(prefers-color-scheme:dark){:root{--fg:#f2f2f7;--muted:#9a9aa0;--line:#2c2c2e;--soft:#1c1c1e}body,.anchor,.shot,button,input,textarea{background:#111;color:var(--fg)}.bar{background:rgba(17,17,17,.95)}}
</style></head><body><div class="wrap">
<h1>${esc(o.title)} <span class="tag">${esc(statusZh[o.state] || o.state)}</span></h1>
<p class="muted">${esc(o.summary)}</p>
<div class="callout"><b>需求原文</b><br>${esc(o.brief)}<br><span class="muted">受众线 ${esc(o.audience)} · 画幅 ${esc(o.aspect_ratio)} · 模型 ${esc(o.llm_model || "")} · 渲染后端 ${o.render_backend === "blender" ? "Blender 白模 + 重绘" : "图像模型"} · 锚图 ${o.progress.anchors_done}/${o.progress.anchors_total}</span></div>
<div class="callout" style="border-left-color:var(--orange)"><b>怎么审</b>：① 每张锚图看「像不像同一个东西、有没有多余文字、构图能不能当关键帧」——通过或驳回，驳回可填意见后重生成；② 关系表核对对象之间的连接是否符合需求；③ 每个镜头看起止锚图是否成对（下拉框可直接换锚图，保存后生效）、字幕是否属实（AI 补写的字幕请改成可核实的表述）；④ 全部通过后点「开始生成」，视频回来会显示在镜头卡片里。</div>
${o.style_bible ? `<p class="muted"><b>视觉总纲</b>：${esc(o.style_bible)}</p>` : ""}

${o.blender ? `<section class="blender"><h2>〇、Blender 层（摄影棚 · 主体 · 状态）</h2>
<table class="attrs"><tbody>
<tr><td><b>摄影棚预设</b></td><td><code>${esc(o.blender.scene.preset)}</code> · 反光地面 ${o.blender.scene.floor_reflective ? "开" : "关"}</td></tr>
${o.blender.scene.asset ? `<tr><td><b>场景资产</b></td><td><code>${esc(o.blender.scene.asset.name)}</code>${o.blender.scene.stage ? ` · 舞台原点 ${esc(o.blender.scene.stage.origin_m.join(", "))} m · 朝向 ${o.blender.scene.stage.yaw_deg}°` : ""}${o.blender.scene.sky ? ` · 天空 <code>${esc(o.blender.scene.sky.name)}</code>` : ""}</td></tr>` : ""}
${(o.blender.subjects?.length ? o.blender.subjects : o.blender.subject ? [{ id: "subject", ...o.blender.subject, position_m: [0, 0] } as BlenderSubject] : []).map((sj) => `<tr><td><b>主体 <code>${esc(sj.id)}</code></b></td><td>${esc(objName(sj.object_id))} · ${sj.asset ? `资产 <code>${esc(sj.asset.name)}</code>` : `代理体 <code>${esc(sj.proxy?.shape || "box")} ${esc((sj.proxy?.dims_m || []).join("×"))} m</code>`} · ${sj.height_m ? `高 ${sj.height_m} m` : `长 ${sj.length_m} m`} · 位置 (${esc(sj.position_m.join(", "))}) · ${sj.face ? `面向 ${esc(sj.face)}` : `转 ${sj.rotation_deg || 0}°`}${sj.pose ? ` · 姿态 <code>${esc(sj.pose.clip)}</code>@${sj.pose.phase}` : ""}${sj.tint ? ` · 着色` : ""}</td></tr>`).join("")}
<tr><td><b>状态</b></td><td>${o.blender.states.map((st) => `<div><code>${esc(st.id)}</code> ${esc(st.label)}：${st.ops.map((op) => `<span class="pill anchored">${esc(String(op.op))}${op.subject ? ` ${esc(String(op.subject))}` : ""}${op.match ? ` /${esc(String(op.match))}/` : ""}${op.clip ? ` ${esc(String(op.clip))}@${esc(String(op.phase))}` : ""}${op.delta_m ? ` Δ${esc((op.delta_m as number[]).join(","))}` : ""}${op.name ? ` ${esc(String(op.name))}@${esc(String(op.at))} ${esc((op.dims_m as number[] || []).join("×"))}m` : ""}</span>`).join(" ")}</div>`).join("") || `<span class="muted">无</span>`}</td></tr>
<tr><td><b>worker</b></td><td>${o.blender.worker_job_id ? `<code>${esc(o.blender.worker_job_id)}</code>` : "未渲染"}${o.blender.error ? `<pre class="err">${esc(o.blender.error)}</pre>` : ""}</td></tr>
</tbody></table>
<p class="muted">白模帧显示在每张锚图右下角小图；锚图 = 白模帧 + GPT-image 参考重绘。机位参数（📐）是 LLM 从有界语法里选的，不是自由坐标。</p></section>` : ""}
<h2>一、对象与属性锚图</h2>
${objectSections}
${linkSection}
${o.effects?.length ? `<h2>二·五、特效（一等对象）</h2><table class="attrs"><tbody>${o.effects.map((f) => `<tr><td><code>${esc(f.id)}</code></td><td><b>${esc(f.label)}</b> · ${esc(f.kind)} · ${esc(f.colour)} · ${f.duration_s}s · 属 ${esc(objName(f.owner))}<br><span class="muted">${esc(f.prompt)}<br>${esc(f.motion)}</span></td></tr>`).join("")}</tbody></table>` : ""}
<h2>三、镜头（起点锚图 → 终点锚图）</h2>
${o.shots.map(shotCard).join("") || `<p class="muted">模型没有给出合法镜头。你可以先审锚图，再在 shots.json 里手工补镜头。</p>`}
<h2>四、审核备注</h2>
<textarea id="notes" rows="3" style="width:100%;font:inherit;font-size:13px;padding:6px 8px;border:1px solid var(--line);border-radius:7px">${esc(o.review.notes || "")}</textarea>
${errorsBlock}
<p class="muted" style="margin-top:20px">本体 JSON：<a href="${esc(apiBase)}/ontology/${esc(o.id)}" target="_blank">${esc(o.id)}</a> · 页面为服务端渲染，操作后自动刷新。</p>
</div>
<div class="bar">
  <button id="save" class="primary">保存审核</button>
  <button id="genAll" class="re">生成待生成锚图</button>
  <button id="approveAll" class="ok">全部通过（已生成的锚图与镜头）</button>
  <button id="gen" class="gen">开始生成视频</button>
  <span id="msg"></span>
</div>
<script>
(function(){
  var API=${JSON.stringify(apiBase)}, ID=${JSON.stringify(o.id)};
  var anchors={}, shots={};
  var msg=document.getElementById('msg');
  function say(t){msg.textContent=t;}
  function q(sel,root){return Array.prototype.slice.call((root||document).querySelectorAll(sel));}
  async function patch(body){
    q('.shot').forEach(function(el){var id=el.dataset.shot; shots[id]=Object.assign(shots[id]||{}, {caption:el.querySelector('.cap').value, motion_prompt:el.querySelector('.mp').value, start_anchor:el.querySelector('.sa').value, end_anchor:el.querySelector('.ea').value});});
    var r=await fetch(API+'/ontology/'+ID,{method:'PATCH',headers:{'content-type':'application/json'},body:JSON.stringify(Object.assign({anchors:anchors,shots:shots,notes:document.getElementById('notes').value},body||{}))});
    if(!r.ok){say('保存失败 '+r.status);return null;}
    return r.json();
  }
  q('.anchor').forEach(function(card){
    var id=card.dataset.anchor;
    q('button',card).forEach(function(b){b.addEventListener('click',async function(){
      var act=b.dataset.act, fb=card.querySelector('.fb').value;
      if(act==='approve'){anchors[id]={status:'approved'};card.className='anchor approved';}
      if(act==='reject'){anchors[id]={status:'rejected',feedback:fb};card.className='anchor rejected';}
      if(act==='regen'){
        say('提交重生成 '+id+' …');
        await patch({anchors:Object.assign({},anchors,{[id]:{status:'pending',feedback:fb}})});
        var r=await fetch(API+'/ontology/'+ID+'/anchors',{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({anchor_ids:[id]})});
        say(r.ok?'已开始重生成，页面将自动刷新':'重生成失败 '+r.status);
        setTimeout(function(){location.reload();},1500);
      }
    });});
  });
  q('.shot').forEach(function(card){
    var id=card.dataset.shot;
    q('button',card).forEach(function(b){b.addEventListener('click',function(){
      if(b.dataset.act==='approve'){shots[id]={status:'approved'};card.className='shot approved';}
      if(b.dataset.act==='reject'){shots[id]={status:'rejected'};card.className='shot rejected';}
    });});
  });
  document.getElementById('save').onclick=async function(){say('保存中…');var d=await patch();if(d){say('已保存，状态：'+(d.data&&d.data.state||''));setTimeout(function(){location.reload();},600);}};
  document.getElementById('approveAll').onclick=function(){
    q('.anchor').forEach(function(c){if(c.querySelector('img')){anchors[c.dataset.anchor]={status:'approved'};c.className='anchor approved';}});
    q('.shot').forEach(function(c){shots[c.dataset.shot]={status:'approved'};c.className='shot approved';});
    say('已标记全部通过，请点「保存审核」');
  };
  document.getElementById('genAll').onclick=async function(){say('提交锚图生成…');var r=await fetch(API+'/ontology/'+ID+'/anchors',{method:'POST',headers:{'content-type':'application/json'},body:'{}'});say(r.ok?'锚图生成中，页面会自动刷新':'提交失败 '+r.status);};
  document.getElementById('gen').onclick=async function(){
    say('保存并提交视频生成…');
    var d=await patch(); if(!d) return;
    var r=await fetch(API+'/ontology/'+ID+'/generate',{method:'POST',headers:{'content-type':'application/json'},body:'{}'});
    var j=await r.json().catch(function(){return {};});
    say(r.ok?('已提交 '+((j.data&&j.data.submitted)||0)+' 个镜头，视频完成后显示在镜头卡片里'):'提交失败：'+(j.detail||r.status));
    setTimeout(function(){location.reload();},1500);
  };
  var busy=${JSON.stringify(o.state === "anchoring" || o.state === "generating" || o.anchors.some((a) => a.status === "generating") || o.shots.some((s) => s.status === "queued" || s.status === "running"))};
  if(busy){say('后台任务进行中，15 秒后自动刷新');setTimeout(function(){location.reload();},15000);}
})();
</script></body></html>`;
}
