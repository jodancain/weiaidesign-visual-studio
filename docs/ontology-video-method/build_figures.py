#!/usr/bin/env python3
"""Generate the SVG figures for ontology-video-method. Deterministic, no deps."""
from pathlib import Path
import html

OUT = Path(__file__).parent
W = 960
FONT = "-apple-system,BlinkMacSystemFont,'PingFang SC','Hiragino Sans GB','Microsoft YaHei',sans-serif"
C = dict(blue="#2F6FED", orange="#F28C28", green="#2E9E6B", purple="#7A5AF8", red="#D64545", gray="#8E8E93",
         ink="#1d1d1f", line="#C7C7CC", bg="#FFFFFF",
         blue_l="#E8F0FE", orange_l="#FDEEDC", green_l="#E3F4EC", purple_l="#EEE9FE", red_l="#FBE5E5", gray_l="#F2F2F7")


class SVG:
    def __init__(self, h, title):
        self.h = h
        self.parts = [f'<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 {W} {h}" width="100%" role="img" aria-label="{html.escape(title)}" '
                      f'style="font-family:{FONT};max-width:{W}px;display:block;margin:0 auto">',
                      '<defs><marker id="arr" viewBox="0 0 10 10" refX="9" refY="5" markerWidth="8" markerHeight="8" orient="auto-start-reverse">'
                      '<path d="M0 0L10 5L0 10z" fill="#6e6e73"/></marker>'
                      '<marker id="arrb" viewBox="0 0 10 10" refX="9" refY="5" markerWidth="8" markerHeight="8" orient="auto-start-reverse">'
                      f'<path d="M0 0L10 5L0 10z" fill="{C["blue"]}"/></marker></defs>',
                      f'<rect width="{W}" height="{h}" fill="{C["bg"]}" rx="12"/>']
        self.title = title

    def box(self, x, y, w, h, fill, stroke, lines, size=14, bold_first=True, rx=10, color=None, dash=None):
        d = f' stroke-dasharray="{dash}"' if dash else ""
        self.parts.append(f'<rect x="{x}" y="{y}" width="{w}" height="{h}" rx="{rx}" fill="{fill}" stroke="{stroke}" stroke-width="1.5"{d}/>')
        if isinstance(lines, str):
            lines = [lines]
        n = len(lines)
        lh = size * 1.45
        y0 = y + h / 2 - (n - 1) * lh / 2 + size * 0.35
        for i, t in enumerate(lines):
            wgt = "700" if (i == 0 and bold_first) else "400"
            sz = size if i == 0 else size - 1
            col = color or C["ink"]
            self.parts.append(f'<text x="{x + w / 2}" y="{y0 + i * lh:.1f}" text-anchor="middle" font-size="{sz}" font-weight="{wgt}" fill="{col}">{html.escape(t)}</text>')

    def text(self, x, y, t, size=13, anchor="start", color=None, weight="400", italic=False):
        st = ' font-style="italic"' if italic else ""
        self.parts.append(f'<text x="{x}" y="{y}" text-anchor="{anchor}" font-size="{size}" font-weight="{weight}" fill="{color or C["ink"]}"{st}>{html.escape(t)}</text>')

    def arrow(self, x1, y1, x2, y2, color="#6e6e73", label=None, dash=None, width=1.6, marker="arr", lx=None, ly=None):
        d = f' stroke-dasharray="{dash}"' if dash else ""
        self.parts.append(f'<line x1="{x1}" y1="{y1}" x2="{x2}" y2="{y2}" stroke="{color}" stroke-width="{width}" marker-end="url(#{marker})"{d}/>')
        if label:
            mx = lx if lx is not None else (x1 + x2) / 2
            my = ly if ly is not None else (y1 + y2) / 2 - 6
            self.text(mx, my, label, size=12, anchor="middle", color="#6e6e73")

    def path(self, d, color="#6e6e73", dash=None, width=1.6, marker="arr"):
        dd = f' stroke-dasharray="{dash}"' if dash else ""
        m = f' marker-end="url(#{marker})"' if marker else ""
        self.parts.append(f'<path d="{d}" fill="none" stroke="{color}" stroke-width="{width}"{dd}{m}/>')

    def caption(self, t):
        self.text(W / 2, self.h - 14, t, size=12, anchor="middle", color="#8E8E93")

    def save(self, name):
        self.parts.append("</svg>")
        (OUT / name).write_text("\n".join(self.parts), encoding="utf-8")
        print("wrote", name)


# ---------------------------------------------------------------- fig 01 需求汇聚
def fig01():
    s = SVG(420, "图1 飞书已有需求汇聚到一个方法，再分发到三条业务线")
    srcs = [("BRD 第10条", "多模态作业指导内容生成", C["blue"]),
            ("9/11 技术支持日会", "三维数模远程支持方案", C["blue"]),
            ("9/20 门店场景纪要", "客休区 3D 屏 · 接受示意精度", C["orange"]),
            ("9/14 车品 3D 预览", "精品 / 选装 / 改装预览", C["orange"]),
            ("培训需求清单 133 条", "图片或视频 · 等样车", C["green"]),
            ("功能清单 V1.0", "3D 数模来源是卡点", C["red"])]
    for i, (a, b, col) in enumerate(srcs):
        y = 30 + i * 60
        s.box(30, y, 250, 46, C["gray_l"], col, [a, b], size=13)
        s.path(f"M280 {y + 23} C 330 {y + 23}, 340 210, 390 210", color=col, marker=None, width=1.4)
    s.box(390, 150, 200, 120, C["purple_l"], C["purple"], ["本体视频法", "一个本体", "一套证据链", "换镜头模板出片"], size=16)
    outs = [("A 维修指导 / 远程协同", "技师 · 二线专家", C["blue"]),
            ("B 培训课程", "新技师 · 培训部", C["green"]),
            ("C 车主 / 展厅 / 精品选配", "车主 · 销售", C["orange"])]
    for i, (a, b, col) in enumerate(outs):
        y = 90 + i * 90
        s.arrow(590, 210, 660, y + 25, color=col)
        s.box(660, y, 270, 50, C["gray_l"], col, [a, b], size=14)
    s.text(660, 370, "TIS · 维修终端 · 飞书 · 门店屏 · APP 商城", size=12, color="#6e6e73")
    s.caption("图 1 · 六条已有需求汇聚为一个方法，向三条业务线分发；数模来源卡点由锁定图路线绕开")
    s.save("fig-01-demand-convergence.svg")


# ---------------------------------------------------------------- fig 02 四层架构
def fig02():
    s = SVG(500, "图2 本体视频法四层框架")
    layers = [
        ("叙事层", "镜头 Shot · 段落 Sequence · 旁白 Narration · 字幕 Caption", C["purple"], C["purple_l"], "AI", "只在这一层创建实例（填有界槽位）"),
        ("动作层", "步骤 Step · 动作 Action · 工具 Tool · 警示 Warning · 证据片段 Evidence", C["orange"], C["orange_l"], "人 + AI 起草", "来自 SOP / 维修方案，步骤必须挂证据"),
        ("场景层", "车辆 · 系统 · 总成 · 零件 Part · 连接 Connection · 人物 Actor · 锚图 AnchorImage", C["blue"], C["blue_l"], "人审锚图", "对象 / 链接 / 属性值各挂锁定图"),
        ("治理层", "资料底本 · 证据指纹 · 维护人 · 技术复核 / 业务签认状态 · 版本适用", C["gray"], C["gray_l"], "复核人签认", "原样复用 M9 六步法字段，不另起一套"),
    ]
    for i, (name, items, col, fl, who, note) in enumerate(layers):
        y = 30 + i * 92
        s.box(30, y, 110, 70, col, col, name, size=16, color="#fff")
        s.box(150, y, 500, 70, fl, col, [items], size=13, bold_first=False)
        s.box(670, y + 8, 120, 26, "#fff", col, who, size=12, color=col, rx=13)
        s.text(670, y + 58, note, size=12, color="#6e6e73")
    s.text(85, 30 + 4 * 92 - 4, "↑ 上三层是本体内容，最底层是治理字段", size=11, anchor="start", color="#6e6e73")
    s.box(150, 425, 500, 36, "#fff", C["line"], "输出：mp4 + srt + evidence-manifest.json + shots.json", size=13, bold_first=False, dash="4 3")
    s.arrow(400, 30 + 3 * 92 + 70, 400, 425, color="#6e6e73")
    s.caption("图 2 · AI 的写权限只到叙事层；动作层由人与 AI 共同起草，场景层与治理层完全由人把关")
    s.save("fig-02-four-layers.svg")


# ---------------------------------------------------------------- fig 03 对象-链接图
def fig03():
    s = SVG(560, "图3 对象类型与链接类型")
    fills = {C["blue"]: C["blue_l"], C["orange"]: C["orange_l"], C["purple"]: C["purple_l"], C["green"]: C["green_l"]}
    N = {}
    def node(k, x, y, t, col, w=140, h=48):
        N[k] = (x, y, w, h); s.box(x, y, w, h, fills[col], col, t, size=13)
    # row 1: anchor images
    node("img_actor", 40, 40, "锚图 · 人物姿态×表情", C["green"], w=180)
    node("img_part", 560, 40, "锚图 · 零件角度×状态", C["green"], w=180)
    node("img_link", 770, 40, "锚图 · 装配好的样子", C["green"], w=170)
    # row 2: scene objects
    node("actor", 60, 170, "人物 Actor", C["blue"])
    node("veh", 250, 170, "车辆 Vehicle", C["blue"])
    node("asm", 420, 170, "总成 Assembly", C["blue"])
    node("part", 590, 170, "零件 Part（BMS）", C["blue"], w=150)
    node("conn", 790, 170, "连接 Connection", C["blue"], w=130)
    node("cover", 440, 300, "零件 Part（盖板）", C["blue"], w=160)
    # row 3: procedure + narrative
    node("shot", 250, 440, "镜头 Shot", C["purple"])
    node("step", 440, 440, "步骤 Step", C["orange"], w=160)
    node("ev", 770, 440, "证据片段 Evidence", C["orange"], w=150)

    def right(k): x, y, w, h = N[k]; return x + w, y + h / 2
    def left(k): x, y, w, h = N[k]; return x, y + h / 2
    def top(k): x, y, w, h = N[k]; return x + w / 2, y
    def bottom(k): x, y, w, h = N[k]; return x + w / 2, y + h

    def A(p1, p2, label, col="#6e6e73", dash=None, lx=None, ly=None):
        s.arrow(*p1, *p2, color=col, label=label, dash=dash, lx=lx, ly=ly)

    A(left("asm"), right("veh"), "part_of")
    A(left("part"), right("asm"), "part_of")
    A(right("part"), left("conn"), "fastened_by", lx=765, ly=186)
    s.text(765, 214, "qty=4", size=11, anchor="middle", color="#6e6e73")
    A((600, 300), (640, 218), "blocks_removal_of", col=C["red"], lx=700, ly=268)
    A(top("part"), bottom("img_part"), "anchor", col=C["green"], lx=690, ly=135)
    A(top("conn"), bottom("img_link"), "anchor", col=C["green"], dash="4 3", lx=880, ly=135)
    A(top("actor"), bottom("img_actor"), "anchor", col=C["green"], dash="4 3", lx=160, ly=135)
    A(right("step"), left("ev"), "supported_by", col=C["orange"])
    A((560, 440), (560, 348), "acts_on", lx=595, ly=400)
    A(right("shot"), left("step"), "renders")
    s.path("M 130 218 L 130 400 L 480 400 L 480 440", color="#6e6e73")
    s.text(300, 394, "performs", size=12, anchor="middle", color="#6e6e73")
    s.text(700, 330, "链接也是一等对象：", size=12, color="#6e6e73", weight="700")
    s.text(700, 348, "有方向、基数、自带属性（qty / torque），", size=12, color="#6e6e73")
    s.text(700, 366, "并且可以挂自己的锚图（虚线）。", size=12, color="#6e6e73")
    s.text(700, 392, "红色 = 拆序依赖，决定镜头先后。", size=12, color=C["red"])
    s.caption("图 3 · 蓝 = 场景对象，橙 = 动作与证据，紫 = 叙事，绿 = 锁定图；对象、链接实例、属性取值都可以钉一张图")
    s.save("fig-03-object-links.svg")


# ---------------------------------------------------------------- fig 04 数值三档
def fig04():
    s = SVG(330, "图4 属性值分三档")
    cols = [("① 事实属性", "手册 / BOM / 数模，带证据", ["零件包围盒", "连接数量 qty", "扭矩 torque", "适用版本"], "AI 不可写", C["blue"], C["blue_l"]),
            ("② 派生属性", "函数按事实属性算出", ["相机位置", "爆炸位移上限", "关键帧时间", "取景边距"], "AI 不可写", C["gray"], C["gray_l"]),
            ("③ 决策属性", "创建实例时填，值域有界", ["framing ∈ {wide, medium, close}", "duration_s ∈ [2, 12]", "explode_ratio ∈ [0, 1]", "target ∈ 已存在的 Part"], "AI 只填这一档", C["purple"], C["purple_l"])]
    for i, (h, sub, items, who, col, fl) in enumerate(cols):
        x = 30 + i * 305
        s.box(x, 30, 285, 40, col, col, h, size=15, color="#fff")
        s.box(x, 70, 285, 190, fl, col, [""] + [""] * 0, size=1, bold_first=False)
        s.text(x + 142, 95, sub, size=12, anchor="middle", color="#6e6e73")
        for j, it in enumerate(items):
            s.text(x + 24, 125 + j * 26, "•  " + it, size=13)
        s.box(x + 60, 270, 165, 32, "#fff", col, who, size=13, color=col)
    s.arrow(315, 150, 335, 150, color="#6e6e73", label="→ 算", lx=325, ly=140)
    s.arrow(620, 150, 640, 150, color="#6e6e93", label="→ 约束", lx=630, ly=140)
    s.caption("图 4 · “AI 只填数值”的准确含义：AI 执行“创建 Shot”动作，参数就是第③档；越界或引用不存在对象则整个动作失败")
    s.save("fig-04-three-tiers.svg")


# ---------------------------------------------------------------- fig 05 链接三种投影
def fig05():
    s = SVG(400, "图5 链接的三种画面投影")
    panels = [("同框", "空间 / 结构类链接", "part_of · connects_to · fastened_by", C["blue"], C["blue_l"]),
              ("先后", "时序 / 依赖类链接", "blocks_removal_of · step_precedes", C["orange"], C["orange_l"]),
              ("脚注", "引用 / 证据类链接", "supported_by · applies_to", C["green"], C["green_l"])]
    for i, (h, sub, ex, col, fl) in enumerate(panels):
        x = 30 + i * 305
        s.box(x, 30, 285, 36, col, col, h, size=16, color="#fff")
        s.text(x + 142, 88, sub, size=13, anchor="middle", weight="700")
        s.text(x + 142, 108, ex, size=12, anchor="middle", color="#6e6e73")
        # frame
        s.parts.append(f'<rect x="{x + 20}" y="125" width="245" height="150" rx="8" fill="{fl}" stroke="{col}" stroke-width="1.5"/>')
        if i == 0:
            s.parts.append(f'<rect x="{x + 45}" y="150" width="190" height="100" rx="6" fill="#fff" stroke="{col}" stroke-opacity="0.35" stroke-dasharray="4 3"/>')
            s.text(x + 140, 168, "父总成（半透明参照）", size=11, anchor="middle", color="#6e6e73")
            s.parts.append(f'<rect x="{x + 95}" y="185" width="90" height="50" rx="4" fill="{col}" fill-opacity="0.85"/>')
            s.text(x + 140, 214, "BMS-01", size=12, anchor="middle", color="#fff", weight="700")
            for (bx, by) in [(x + 100, 190), (x + 178, 190), (x + 100, 228), (x + 178, 228)]:
                s.parts.append(f'<circle cx="{bx}" cy="{by}" r="4" fill="{C["orange"]}"/>')
            s.text(x + 232, 200, "×4", size=13, weight="700", color=C["orange"])
        elif i == 1:
            for k, (lab, c2) in enumerate([("① 盖板", C["gray"]), ("② BMS", col)]):
                bx = x + 40 + k * 120
                s.box(bx, 165, 90, 60, "#fff", c2, lab, size=13)
            s.arrow(x + 130, 195, x + 160, 195, color=col)
            s.text(x + 142, 250, "盖板 blocks_removal_of BMS ⇒ 顺序由依赖推出", size=11, anchor="middle", color="#6e6e73")
        else:
            s.parts.append(f'<rect x="{x + 40}" y="145" width="205" height="85" rx="6" fill="#fff" stroke="{col}" stroke-opacity="0.35"/>')
            s.text(x + 142, 190, "拆下 BMS 前先断开高压", size=13, anchor="middle")
            s.parts.append(f'<rect x="{x + 150}" y="240" width="95" height="22" rx="4" fill="{col}"/>')
            s.text(x + 197, 256, "E05 · p.312", size=11, anchor="middle", color="#fff", weight="700")
            s.text(x + 40, 258, "仅适用 M9 纯电版", size=11, color="#6e6e73")
        s.text(x + 142, 300, ["另一端自动进画面，紧固件高亮", "镜头顺序不由 AI 排", "角标 / 页码 / 版本水印"][i], size=12, anchor="middle", color=col, weight="700")
    s.caption("图 5 · 同一条链接不需要新对象类型，只决定它被渲染成哪种画面语法；链接属性（qty=4）直接变成画面元素")
    s.save("fig-05-link-projections.svg")


# ---------------------------------------------------------------- fig 06 一个镜头串起来
def fig06():
    s = SVG(300, "图6 AI 填四个参数，本体沿链接展开")
    s.box(30, 40, 230, 120, C["purple_l"], C["purple"], ["AI 创建 Shot", "target = BMS-01", "framing = close", "action = remove", "duration = 4s"], size=13)
    s.arrow(260, 100, 320, 100, color=C["purple"], label="本体展开")
    rows = [("BMS-01 —fastened_by→ Bolt ×4", "同框高亮 + “×4”", C["blue"]),
            ("Cover-02 —blocks_removal_of→ BMS-01", "前插“拆盖板”镜头，之后盖板变半透明", C["orange"]),
            ("BMS-01 —part_of→ 电池包", "半透明位置参照", C["blue"]),
            ("Step —supported_by→ E05", "字幕角标 “E05 p.312”", C["green"])]
    for i, (a, b, col) in enumerate(rows):
        y = 40 + i * 32
        s.parts.append(f'<rect x="320" y="{y}" width="300" height="26" rx="5" fill="{C["gray_l"]}" stroke="{col}"/>')
        s.text(330, y + 18, a, size=12)
        s.arrow(620, y + 13, 650, y + 13, color=col)
        s.text(658, y + 18, b, size=12, color=col, weight="700")
    s.box(320, 190, 610, 60, "#fff", C["line"], ["产物：起点锚图“装好” → 终点锚图“取下” · 4 秒补间 · 字幕 E05 · manifest 记录镜头→步骤→证据→页码"], size=12, bold_first=False, dash="4 3")
    s.arrow(470, 168, 470, 190, color="#6e6e73")
    s.caption("图 6 · AI 只填了四个参数；其余画面元素全由链接推出，可回放、可改槽重生成")
    s.save("fig-06-one-shot.svg")


# ---------------------------------------------------------------- fig 07 三条路线矩阵
def fig07():
    s = SVG(450, "图7 三条渲染路线对比")
    dims = ["对象同一性", "关系几何真值", "属性可校验", "改槽不改模", "任意视角", "补间可信度", "前置成本", "复用现有链路"]
    routes = [("3D 白模", C["gray"]), ("锁定图本体（本方案）", C["purple"]), ("自由生成", C["red"])]
    vals = [["✔", "✔", "程序校验", "✔", "✔", "确定", "建模", "需渲染器"],
            ["✔", "关键帧 ✔", "人审一次", "✔", "锚过的角度", "短补间稳", "生图+审图", "✔ 直接复用"],
            ["✘", "✘", "每次人眼", "✘", "✔ 但不可信", "差", "无", "✔"]]
    good = {"✔", "✔ 直接复用", "程序校验", "确定", "无", "人审一次", "关键帧 ✔", "短补间稳"}
    x0, y0, cw, rh = 30, 30, 165, 40
    for i, d in enumerate(dims):
        y = y0 + 70 + i * rh
        s.parts.append(f'<rect x="{x0}" y="{y - 26}" width="900" height="{rh}" fill="{C["gray_l"] if i % 2 == 0 else "#fff"}"/>')
    s.text(x0 + 100, y0 + 26, "维度", size=13, anchor="middle", weight="700")
    for j, (r, col) in enumerate(routes):
        s.box(x0 + 200 + j * 245, y0, 235, 38, col, col, r, size=14, color="#fff")
    for i, d in enumerate(dims):
        y = y0 + 70 + i * rh
        s.text(x0 + 12, y, d, size=13, weight="700")
        for j in range(3):
            v = vals[j][i]
            col = C["green"] if v in good or v.startswith("✔") and "不可信" not in v else (C["red"] if v.startswith("✘") or v in ("差", "每次人眼") else C["orange"])
            s.text(x0 + 200 + j * 245 + 117, y, v, size=13, anchor="middle", color=col, weight="700")
    s.caption("图 7 · 锁定图本体把“连续可算”换成“离散锚定 + 短补间”，丢任意视角，换不建模与直接复用现有链路")
    s.save("fig-07-route-matrix.svg")


# ---------------------------------------------------------------- fig 08 锁定图本体（属性值 = 图）
def fig08():
    s = SVG(490, "图8 锁定图本体：对象、属性取值、链接实例各挂一张图")
    s.box(30, 40, 170, 90, C["blue_l"], C["blue"], ["对象：技师 Actor", "身份锚图 ×1", "（正面标准像）"], size=13)
    s.text(240, 60, "属性取值 = 图（值域有限 ⇒ 图有限）", size=13, weight="700")
    angles = ["front", "side", "rear-3q"]
    states = ["idle", "holding wrench", "alert"]
    for i, a in enumerate(angles):
        s.text(300 + i * 90 + 35, 88, f"angle={a}", size=11, anchor="middle", color="#6e6e73")
    for j, st in enumerate(states):
        s.text(292, 120 + j * 62 + 30, f"state={st}", size=11, anchor="end", color="#6e6e73")
        for i in range(3):
            x = 300 + i * 90; y = 100 + j * 62
            s.parts.append(f'<rect x="{x}" y="{y}" width="70" height="50" rx="5" fill="#fff" stroke="{C["blue"]}"/>')
            s.parts.append(f'<circle cx="{x + 35}" cy="{y + 18}" r="8" fill="{C["blue"]}" fill-opacity="0.6"/>')
            s.parts.append(f'<rect x="{x + 22}" y="{y + 28}" width="26" height="16" rx="3" fill="{C["blue"]}" fill-opacity="0.35"/>')
            s.text(x + 35, y + 47, "🔒", size=9, anchor="middle")
    s.arrow(200, 85, 290, 85, color=C["blue"], dash="4 3")
    # right column: part + link
    s.box(620, 40, 310, 60, C["green_l"], C["green"], ["零件 BMS-01 的锚图", "installed / loosened / removed × 角度"], size=13)
    s.box(620, 115, 310, 60, C["green_l"], C["green"], ["链接实例 BMS —fastened_by→ Bolt×4", "锁一张“装配好的样子”⇒ 几何真值钉死"], size=13)
    s.box(620, 190, 310, 60, C["orange_l"], C["orange"], ["车内件锚图来源：维修手册图例", "锚图 ID = 手册页码 ⇒ 与证据链同一件事"], size=13)
    # bottom: interpolation
    s.text(30, 320, "视频 = 锚图之间的短补间（复用现有首尾关键帧图生视频链路）", size=13, weight="700")
    kf = ["装好", "松开", "取下"]
    for i, k in enumerate(kf):
        x = 60 + i * 300
        s.parts.append(f'<rect x="{x}" y="340" width="90" height="60" rx="6" fill="#fff" stroke="{C["green"]}" stroke-width="2"/>')
        s.text(x + 45, 375, k, size=13, anchor="middle", weight="700")
        s.text(x + 45, 415, "锁定锚图 🔒", size=11, anchor="middle", color="#6e6e73")
        if i < 2:
            s.arrow(x + 96, 370, x + 294, 370, color=C["purple"], label="补间 ≤ 4s", lx=x + 195, ly=362, marker="arrb")
    s.text(480, 440, "AI 只选起点锚图、终点锚图和时长；视频模型只补两张锁定图之间的运动", size=12, anchor="middle", color=C["purple"], weight="700")
    s.caption("图 8 · 导演台缩成一个选图器：AI 只挑起点锚图、终点锚图和时长；相机坐标、爆炸比例被“两张图之间补间”替代")
    s.save("fig-08-anchor-images.svg")


# ---------------------------------------------------------------- fig 09 关键帧密度
def fig09():
    s = SVG(260, "图9 关键帧密度决定可信度")
    for row, (title, n, col, note) in enumerate([("两张锚图", 2, C["red"], "8 秒补间：螺栓数量中途可能变、零件形状漂移"),
                                                  ("三张以上锚图", 4, C["green"], "每段 ≤ 3 秒：幻觉空间小，关系几何在每个关键帧被重新钉住")]):
        y = 50 + row * 95
        s.text(30, y + 8, title, size=14, weight="700", color=col)
        x0, x1 = 180, 780
        s.parts.append(f'<line x1="{x0}" y1="{y}" x2="{x1}" y2="{y}" stroke="{C["line"]}" stroke-width="6"/>')
        for i in range(n):
            x = x0 + (x1 - x0) * i / (n - 1)
            s.parts.append(f'<rect x="{x - 14}" y="{y - 14}" width="28" height="28" rx="5" fill="#fff" stroke="{col}" stroke-width="2"/>')
            s.text(x, y + 5, "🔒", size=12, anchor="middle")
        for i in range(n - 1):
            xa = x0 + (x1 - x0) * i / (n - 1); xb = x0 + (x1 - x0) * (i + 1) / (n - 1)
            s.parts.append(f'<rect x="{xa + 18}" y="{y - 5}" width="{xb - xa - 36}" height="10" rx="5" fill="{col}" fill-opacity="{0.25 if row == 0 else 0.5}"/>')
        s.text(x1 + 30, y + 5, "共 8s", size=12, color="#6e6e73")
        s.text(180, y + 42, note, size=12, color="#6e6e73")
    s.caption("图 9 · 同样 8 秒动作：拆成“装好 / 松开 / 取下 / 放置”四张锚图，补间越短，模型越难出错")
    s.save("fig-09-keyframe-density.svg")


# ---------------------------------------------------------------- fig 10 出片流程
def fig10():
    s = SVG(360, "图10 一次出片的流程与门禁")
    steps = [("① 输入", "结构化 SOP\n+ 车型变体\n+ 观众", C["gray"]),
             ("② 本体检索", "零件名→Part.id\n拉连接与拆序\n缺失登记缺口", C["blue"]),
             ("③ AI 填槽", "输出 Shot 列表\nSchema 校验\n未知 ID 整包拒绝", C["purple"]),
             ("④ 展开", "按依赖补前置镜头\n解析起止锚图\n+ 时长", C["blue"]),
             ("⑤ 生成", "首尾关键帧\n图生视频\n无锚图标 unanchored", C["green"]),
             ("⑥ 合成", "字幕 · 步骤号\n警示 · 证据脚注\n无证据句不发声", C["green"]),
             ("⑦ 产物", "mp4 + srt\nevidence-manifest\nshots.json", C["gray"]),
             ("⑧ 验收", "技术复核\n业务签认\n双状态字段", C["orange"])]
    fills = {C["gray"]: C["gray_l"], C["blue"]: C["blue_l"], C["purple"]: C["purple_l"], C["green"]: C["green_l"], C["orange"]: C["orange_l"]}
    for i, (h, body, col) in enumerate(steps):
        x = 20 + i * 117
        s.box(x, 40, 105, 34, col, col, h, size=13, color="#fff")
        s.box(x, 74, 105, 96, fills[col], col, body.split("\n"), size=11, bold_first=False)
        if i < 7:
            s.arrow(x + 105, 122, x + 117, 122, color="#6e6e73", width=1.2)
    # gates
    gates = [(2, "门禁 1：值域 / ID 校验"), (4, "门禁 2：无锚图需人确认"), (5, "门禁 3：无证据不发声"), (7, "门禁 4：两位复核人签认")]
    for k, (i, g) in enumerate(gates):
        x = 20 + i * 117 + 52
        s.parts.append(f'<path d="M{x} 178 L{x + 9} 190 L{x} 202 L{x - 9} 190 Z" fill="{C["red"]}"/>')
        s.text(x, 225 + (k % 2) * 18, g, size=11, anchor="middle", color=C["red"], weight="700")
    s.path("M 137 300 L 137 285 L 840 285 L 840 300", color=C["orange"], dash="4 3", marker=None)
    s.text(490, 315, "验收不通过 → 改槽位（换锚图 / 换镜头）重生成该段，其他段不动；本体与证据链不变", size=12, anchor="middle", color=C["orange"])
    s.caption("图 10 · 四道门禁全是确定性检查或人签认，AI 只在第③步有写权限")
    s.save("fig-10-pipeline.svg")


# ---------------------------------------------------------------- fig 11 路线图
def fig11():
    s = SVG(300, "图11 分阶段路线图")
    phases = [("P0 · 2 周", "最小 Demo", ["1 个 5 步拆装小节", "10–15 张锚图", "30 秒片 + 证据清单", "改一张锚图重生成"], C["purple"]),
              ("P1 · 1–2 月", "A 线试点", ["1 个车型系统的锚图库", "接 SOP 结构化输入", "技术支持日会验收", "对照 BRD#10 立项"], C["blue"]),
              ("P2 · 3–6 月", "B/C 线复用", ["培训清单里“图片或视频”条目", "门店 3D 屏 / 精品选配片", "锚图库进本体平台永久复用"], C["green"]),
              ("P3 · 6 月后", "按需补 3D", ["需要绕零件自由转的镜头", "原厂数模到位只换 mesh", "本体与证据链不变"], C["gray"])]
    fills = {C["gray"]: C["gray_l"], C["blue"]: C["blue_l"], C["purple"]: C["purple_l"], C["green"]: C["green_l"]}
    s.parts.append(f'<line x1="40" y1="60" x2="920" y2="60" stroke="{C["line"]}" stroke-width="4"/>')
    for i, (t, h, items, col) in enumerate(phases):
        x = 40 + i * 225
        s.parts.append(f'<circle cx="{x + 100}" cy="60" r="9" fill="{col}"/>')
        s.text(x + 100, 40, t, size=13, anchor="middle", weight="700", color=col)
        s.box(x, 85, 200, 34, col, col, h, size=14, color="#fff")
        s.box(x, 119, 200, 120, fills[col], col, items, size=12, bold_first=False)
    s.caption("图 11 · 先用 Demo 证方法，再沿三条业务线复用同一本体；3D 是最后按需补的，不是前置条件")
    s.save("fig-11-roadmap.svg")


# ---------------------------------------------------------------- fig 12 Blender 层是本体的一部分
def fig12():
    s = SVG(560, "图12 Blender 层：把“怎么建好场景”写进本体，AI 只填枚举与比例")
    s.text(30, 32, "本体 JSON 里新增一层 blender（与对象 / 链接 / 锚图并列），四个字段组全部有界：", size=13, color="#6e6e73")
    groups = [
        ("场景预设 scene", ["preset ∈ {showroom_dark, studio_white,", "garage, outdoor_overcast}", "floor_reflective ∈ {true, false}"], C["gray"], C["gray_l"]),
        ("主体归一化 subject", ["asset ∈ 模型库 或 proxy 盒 / 圆柱", "up_axis / forward_axis（文件轴）", "length_m 真实长度 · rotation_deg 转台角"], C["blue"], C["blue_l"]),
        ("状态 = 有界操作 states", ["hide / show（名字正则）", "add_part（at ∈ 7 个位置枚举 · 吸附表面）", "rotate（轴 · 角度 · 枢轴）· translate"], C["orange"], C["orange_l"]),
        ("机位语法 anchor.render", ["azimuth_deg · elevation_deg", "distance_factor（按包围球自动配框）", "focal_mm · look_at ∈ {center, front, …}"], C["purple"], C["purple_l"]),
    ]
    for i, (name, items, col, fl) in enumerate(groups):
        x = 30 + i * 232
        s.box(x, 50, 214, 34, col, col, name, size=13, color="#fff")
        s.box(x, 84, 214, 96, fl, col, items, size=11, bold_first=False)
    s.text(30, 208, "LLM 起草 → 服务端 normalizeDraft 夹紧：未知预设 / 资产 / 位置枚举丢弃，数值 clamp 到区间，非主体锚图不带机位", size=12, color="#6e6e73")
    # pipeline row
    steps = [("本体 Blender 层", "数值 + 枚举", C["purple"]),
             ("render_ontology.py", "bpy 通用脚本 · 无主体特定代码", C["blue"]),
             ("灰模 PNG", "同机位逐像素一致", C["gray"]),
             ("GPT-image 重绘", "灰模第一参考 · 身份图第二参考", C["orange"]),
             ("锚图 → 人审 → 补间", "与 image 后端同一条路", C["green"])]
    fills = {C["gray"]: C["gray_l"], C["blue"]: C["blue_l"], C["purple"]: C["purple_l"], C["green"]: C["green_l"], C["orange"]: C["orange_l"]}
    for i, (a, b, col) in enumerate(steps):
        x = 30 + i * 186
        s.box(x, 240, 160, 58, fills[col], col, [a, b], size=12)
        if i < len(steps) - 1:
            s.arrow(x + 160, 269, x + 186, 269, color=col)
    s.text(30, 325, "Windows ai · blender-story worker（FastAPI :18087）· Blender 5.2 headless · POST /api/v1/ontology-render", size=11, color="#6e6e73")
    # why row: comparison with route 3
    s.box(30, 350, 440, 150, C["green_l"], C["green"], ["③ 3D 白模重绘（车库截图）", "机位靠人在车库里摆好再截", "状态靠车库 UI 勾选", "换主体（M9 / 机油瓶 / 人形）要重摆重接"], size=13)
    s.box(490, 350, 440, 150, C["purple_l"], C["purple"], ["④ 本体 + Blender 层", "机位 = 5 个有界数字，写在锚图上", "状态 = 有界操作列表，写在本体里", "换主体只换 subject 字段；没有 GLB 用 proxy 先定机位"], size=13)
    s.arrow(470, 425, 490, 425, color=C["purple"], label="“怎么建好 Blender”进本体", lx=480, ly=345)
    s.caption("图 12 · 场景预设 / 主体归一化 / 状态操作 / 机位语法四组有界字段构成 Blender 层；程序把数值变成灰模，重绘与出片走同一条链")
    s.save("fig-12-blender-layer.svg")


if __name__ == "__main__":
    for f in (fig01, fig02, fig03, fig04, fig05, fig06, fig07, fig08, fig09, fig10, fig11, fig12):
        f()
