#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""
build_script_preview.py — 视频出片前的 HTML 脚本预览页（人审门禁）。

规则（用户 2026-09-30）：任何视频生成前，先把这份页面发给用户确认；确认后才调 /generate。
页面内容：场景（灰模帧 + 资产来源 + 舞台原点）、人物 / 主体（灰模 + 重绘身份图 + 描述 + 模型 + 姿态）、
分镜（起点 / 终点锚图、机位、时长、运动提示、字幕）、视觉总纲、待确认清单、预计耗时 / 配额。

用法：
  python3 build_script_preview.py <ontology-id> [--base https://weiaidesign.com] [--out DIR]
                                  [--scene-image PATH] [--note "补充说明"] [--asset-source name=来源/许可 ...]
产出 DIR/index.html + 缩放后的图片文件（可整目录 scp 到静态站）。
"""
import argparse
import html
import io
import json
import re
import subprocess
import sys
from pathlib import Path

try:
    from PIL import Image
except ImportError:  # pragma: no cover
    Image = None

UA = "Mozilla/5.0"


def fetch(url: str) -> bytes:
    r = subprocess.run(["curl", "-s", "-L", "-m", "60", "-H", f"user-agent: {UA}", url], capture_output=True)
    if r.returncode != 0 or not r.stdout:
        raise SystemExit(f"fetch failed: {url}")
    return r.stdout


def save_image(data: bytes, out: Path, width: int = 960) -> str:
    out.parent.mkdir(parents=True, exist_ok=True)
    if Image is None:
        out.write_bytes(data)
        return out.name
    im = Image.open(io.BytesIO(data)).convert("RGB")
    if im.width > width:
        im = im.resize((width, round(im.height * width / im.width)))
    out = out.with_suffix(".jpg")
    im.save(out, quality=86)
    return out.name


def esc(v) -> str:
    return html.escape(str(v if v is not None else ""))


def main() -> None:
    ap = argparse.ArgumentParser()
    ap.add_argument("ontology_id")
    ap.add_argument("--base", default="https://weiaidesign.com")
    ap.add_argument("--out", default=None)
    ap.add_argument("--scene-image", default=None, help="场景白模帧（可选，本地文件）")
    ap.add_argument("--note", default="")
    ap.add_argument("--asset-source", action="append", default=[], help="资产名=来源/许可")
    args = ap.parse_args()

    o = json.loads(fetch(f"{args.base}/api/v1/ontology/{args.ontology_id}"))["data"]
    out = Path(args.out or f"script-{o['id']}")
    out.mkdir(parents=True, exist_ok=True)
    sources = dict(kv.split("=", 1) for kv in args.asset_source if "=" in kv)

    anchors = {a["id"]: a for a in o["anchors"]}
    objects = {x["id"]: x for x in o["objects"]}
    b = o.get("blender") or {}
    subjects = b.get("subjects") or ([{"id": "subject", **b["subject"], "position_m": [0, 0]}] if b.get("subject") else [])

    def pic(a, key):
        img = a.get(key)
        if not img:
            return ""
        name = save_image(fetch(img["public_url"]), out / f"{key}-{a['id']}.png")
        return f'<img src="{esc(name)}" alt="">'

    # ---------- 场景
    scene = b.get("scene") or {}
    scene_img = ""
    if args.scene_image and Path(args.scene_image).exists():
        scene_img = f'<img src="{esc(save_image(Path(args.scene_image).read_bytes(), out / "scene.png"))}" alt="">'
    else:
        # fall back to the widest group anchor's greybox
        group = [a for a in o["anchors"] if a.get("greybox") and str((a.get("render") or {}).get("camera", {}).get("look_at", "")) == "group"]
        if group:
            scene_img = pic(group[0], "greybox")
    env_objs = [x for x in o["objects"] if x["type"] == "environment"]
    # look/style frames: environment identity anchors that were generated without a greybox
    looks = [a for a in o["anchors"] if a["kind"] == "identity" and any(x["id"] == a.get("object_id") and x["type"] == "environment" for x in o["objects"]) and a.get("image") and not a.get("greybox")]
    look_html = "".join(f'<figure>{pic(a, "image")}<figcaption><b>{esc(a["label"])}</b> —— 按导演视觉语法编译的基准帧，所有人物与分镜锚图重绘时都以它为第二参考（色彩分布 / 光 / 材质 / 构图层次）</figcaption><details><summary class="muted">基准帧提示词</summary><p class="en muted">{esc(a["prompt"])}</p></details></figure>' for a in looks)
    scene_rows = []
    if scene.get("asset"):
        scene_rows.append(f'<tr><td>场景资产</td><td><code>{esc(scene["asset"]["name"])}</code> · {esc(sources.get(scene["asset"]["name"], "见资产表"))}</td></tr>')
    if scene.get("stage"):
        scene_rows.append(f'<tr><td>舞台原点</td><td>({esc(", ".join(map(str, scene["stage"]["origin_m"])))}) m · 朝向 {esc(scene["stage"]["yaw_deg"])}°</td></tr>')
    scene_rows.append(f'<tr><td>灰模预设</td><td><code>{esc(scene.get("preset", "-"))}</code></td></tr>')
    for x in env_objs:
        scene_rows.append(f'<tr><td>{esc(x["name"])}</td><td>{esc(x["description"])}<br><span class="muted en">{esc(x.get("identity_prompt", ""))}</span></td></tr>')

    # ---------- 人物 / 主体
    cards = []
    for sj in subjects:
        if sj.get("camera_ignore"):
            continue  # stage helpers (floor slabs) are not characters
        obj = objects.get(sj["object_id"], {})
        ident = next((a for a in o["anchors"] if a["kind"] == "identity" and a.get("object_id") == sj["object_id"]), None)
        gb = pic(ident, "greybox") if ident else ""
        im = pic(ident, "image") if ident else ""
        pose = sj.get("pose") or {}
        asset = sj.get("asset", {}).get("name") if sj.get("asset") else f'代理体 {sj.get("proxy", {}).get("shape")} {"×".join(map(str, sj.get("proxy", {}).get("dims_m", [])))} m'
        cards.append(f'''<div class="card">
<h3>{esc(obj.get("name", sj["id"]))} <span class="tag">{esc(sj["id"])}</span></h3>
<p>{esc(obj.get("description", ""))}</p>
<div class="pair">{f'<figure>{gb}<figcaption>Blender 灰模</figcaption></figure>' if gb else ''}{f'<figure>{im}<figcaption>重绘身份图（视频里长这样）</figcaption></figure>' if im else '<figure><div class="ph">身份图尚未生成</div></figure>'}</div>
<table class="kv">
<tr><td>模型</td><td><code>{esc(asset)}</code>{f' · {esc(sources[asset])}' if asset in sources else ''}</td></tr>
<tr><td>尺寸 / 位置</td><td>{esc(f'高 {sj["height_m"]} m' if sj.get("height_m") else f'长 {sj.get("length_m")} m')} · 舞台坐标 ({esc(", ".join(map(str, sj.get("position_m", [0, 0]))))}) · {esc(f'面向 {sj["face"]}' if sj.get("face") else f'转 {sj.get("rotation_deg", 0)}°')}</td></tr>
{f'<tr><td>姿态</td><td><code>{esc(pose.get("clip"))}</code> @ {esc(pose.get("phase"))}</td></tr>' if pose.get("clip") else ''}
<tr><td>外形描述</td><td class="en muted">{esc(obj.get("identity_prompt", ""))}</td></tr>
</table></div>''')

    # ---------- 分镜
    shots = []
    for s in o["shots"]:
        a, e = anchors.get(s["start_anchor"]), anchors.get(s["end_anchor"])
        cam = (a or {}).get("render", {}).get("camera") if a else None
        cam_txt = f'方位 {cam["azimuth_deg"]}° · 仰角 {cam["elevation_deg"]}° · 距离 ×{cam["distance_factor"]} · {cam["focal_mm"]}mm · 看向 {cam["look_at"]}' if cam else "由图像模型描述"
        states = lambda x: ", ".join((x.get("render") or {}).get("states", [])) or "—"
        shots.append(f'''<div class="shot">
<h3>#{s["order"]} {esc(s["title"])} <span class="tag">{s["duration_s"]} 秒</span></h3>
<div class="pair">
<figure>{pic(a, "greybox") if a else ''}{pic(a, "image") if a else ''}<figcaption>起点 · {esc(a["label"] if a else s["start_anchor"])}<br><span class="muted">状态：{esc(states(a) if a else "")}</span></figcaption></figure>
<figure>{pic(e, "greybox") if e else ''}{pic(e, "image") if e else ''}<figcaption>终点 · {esc(e["label"] if e else s["end_anchor"])}<br><span class="muted">状态：{esc(states(e) if e else "")}</span></figcaption></figure>
</div>
<table class="kv">
<tr><td>机位（锁定）</td><td>{esc(cam_txt)}</td></tr>
<tr><td>运动提示</td><td class="en">{esc(s["motion_prompt"])}</td></tr>
<tr><td>字幕 / 台词</td><td>{esc(s.get("caption", "") or "—")} <span class="muted">（{ "来自需求原文" if s.get("caption_source") == "brief" else "AI 补写"}；不烧进画面，成片后可叠）</span></td></tr>
</table></div>''')

    # ---------- 资产表
    asset_rows = "".join(f"<tr><td><code>{esc(k)}</code></td><td>{esc(v)}</td></tr>" for k, v in sources.items())

    n_anchor = len([a for a in o["anchors"] if a.get("greybox") or a.get("image")])
    total_s = sum(s["duration_s"] for s in o["shots"])
    page = f'''<!doctype html><html lang="zh-CN"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><meta name="robots" content="noindex">
<title>脚本预览 · {esc(o["title"])}</title>
<style>
:root{{--fg:#1d1d1f;--muted:#6e6e73;--line:#e5e5ea;--soft:#f5f5f7;--blue:#2F6FED;--orange:#F28C28;--red:#D64545}}
@media(prefers-color-scheme:dark){{:root{{--fg:#f2f2f7;--muted:#9a9aa0;--line:#2c2c2e;--soft:#1c1c1e}}body{{background:#111}}.card,.shot{{background:#161618}}}}
*{{box-sizing:border-box}}body{{margin:0;color:var(--fg);font:15px/1.7 -apple-system,BlinkMacSystemFont,"PingFang SC","Hiragino Sans GB","Microsoft YaHei",sans-serif}}
.wrap{{max-width:1180px;margin:0 auto;padding:28px 18px 90px}}h1{{font-size:24px;margin:0 0 4px}}h2{{font-size:19px;margin:38px 0 12px;padding-top:12px;border-top:1px solid var(--line)}}h3{{font-size:16px;margin:0 0 6px}}
.muted{{color:var(--muted)}}.en{{font-size:13px}}.tag{{display:inline-block;font-size:11px;padding:1px 8px;border-radius:10px;background:var(--soft);color:var(--muted);vertical-align:middle;font-weight:400}}
.banner{{background:#FDEEDC;border-left:4px solid var(--orange);padding:12px 16px;border-radius:8px;margin:14px 0 22px;color:#1d1d1f}}
.callout{{background:var(--soft);border-left:3px solid var(--blue);padding:10px 14px;border-radius:6px;margin:12px 0}}
.grid{{display:grid;grid-template-columns:repeat(2,1fr);gap:14px}}@media(max-width:820px){{.grid{{grid-template-columns:1fr}}}}
.card,.shot{{border:1px solid var(--line);border-radius:12px;padding:14px 16px;background:#fff;margin:0 0 14px}}
.pair{{display:grid;grid-template-columns:1fr 1fr;gap:8px;margin:8px 0}}figure{{margin:0}}figure img{{width:100%;border-radius:8px;display:block;background:#000;margin-bottom:4px}}figcaption{{font-size:12px;color:var(--muted);text-align:center}}
.ph{{aspect-ratio:16/9;border:1px dashed var(--line);border-radius:8px;display:flex;align-items:center;justify-content:center;color:var(--muted);font-size:13px}}
table.kv{{width:100%;border-collapse:collapse;font-size:13.5px;margin-top:6px}}table.kv td{{border-top:1px solid var(--line);padding:5px 8px;vertical-align:top}}table.kv td:first-child{{width:110px;color:var(--muted);white-space:nowrap}}
table.plain{{width:100%;border-collapse:collapse;font-size:14px}}table.plain th,table.plain td{{border:1px solid var(--line);padding:6px 10px;text-align:left;vertical-align:top}}table.plain th{{background:var(--soft)}}
ol.check li{{margin:6px 0}}.scene img{{width:100%;border-radius:10px;display:block;background:#000}}
</style></head><body><div class="wrap">
<h1>脚本预览 · {esc(o["title"])}</h1>
<p class="muted">本体 <code>{esc(o["id"])}</code> · {esc(o["aspect_ratio"])} · {len(o["shots"])} 镜 / 共 {total_s} 秒 · 状态 {esc(o["state"])}</p>
<div class="banner"><b>⏸ 尚未生成视频。</b>这页是出片前的脚本确认：场景、人物、分镜起止画面、机位、运动提示、字幕都在下面。你确认（或改）之后，我才调视频接口。{esc(args.note)}</div>
<div class="callout"><b>需求原文</b><br>{esc(o["brief"])}</div>
<p><b>视觉总纲</b> <span class="en muted">{esc(o.get("style_bible", ""))}</span></p>

<h2>一、场景</h2>
{f'<div class="scene">{look_html}</div>' if look_html else ''}
<div class="scene">{scene_img or '<div class="ph">尚无场景帧</div>'}</div>
<p class="muted" style="font-size:12px;text-align:center">Blender 舞台灰模（机位与几何来源）</p>
<table class="kv">{"".join(scene_rows)}</table>

<h2>二、人物 / 主体（{len(subjects)}）</h2>
<div class="grid">{"".join(cards)}</div>

<h2>三、分镜（{len(o["shots"])}）</h2>
{"".join(shots)}

<h2>四、资产来源</h2>
<table class="plain"><tr><th>资产</th><th>来源 / 许可</th></tr>{asset_rows or '<tr><td colspan="2" class="muted">未登记</td></tr>'}</table>

<h2>五、请你确认</h2>
<ol class="check">
<li>场景对不对：屋顶 / 舞台位置 / 背景里该有什么、不该有什么。</li>
<li>每个人物的外形（发色、服装、道具）与视频里的样子（重绘身份图）是否接受；要改哪一个，改成什么。</li>
<li>分镜起点、终点画面是否成对；机位是否要换角度或推近拉远。</li>
<li>运动提示写的动作顺序与节奏是否是你要的；有没有要加 / 删的动作。</li>
<li>字幕 / 台词内容与顺序；是否需要烧进画面。</li>
<li>时长（每镜 {esc("/".join(str(s["duration_s"]) for s in o["shots"]))} 秒）与画幅 {esc(o["aspect_ratio"])}。</li>
</ol>
<p class="muted">预计：视频每段约 6 分钟；每段消耗约 50 万 ezr 配额。已生成锚图 {n_anchor} 张，改人物 / 场景需重出对应锚图（每张约 1 分钟）。</p>
<p class="muted">审核页（可直接改起止锚图 / 运动提示 / 字幕并保存）：<a href="{esc(args.base)}/api/v1/ontology/{esc(o["id"])}/review" target="_blank">review</a> · 本体 JSON：<a href="{esc(args.base)}/api/v1/ontology/{esc(o["id"])}" target="_blank">json</a></p>
</div></body></html>'''
    (out / "index.html").write_text(page, encoding="utf-8")
    print(out / "index.html")


if __name__ == "__main__":
    main()
