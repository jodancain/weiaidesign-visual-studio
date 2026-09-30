#!/usr/bin/env python3
"""Markdown -> self-contained HTML with the SVG figures inlined. Run: uv run --with markdown python3 build_html.py"""
import markdown, pathlib, re
HERE = pathlib.Path(__file__).parent
src = (HERE.parent / "ontology-video-method.md").read_text()
md = markdown.Markdown(extensions=["tables", "fenced_code", "toc"], extension_configs={"toc": {"toc_depth": "2"}})
body = md.convert(src)
# inline figures
def inline(m):
    name = pathlib.Path(m.group(1)).name
    svg = (HERE / name).read_text()
    return f'<figure class="fig">{svg}</figure>'
body = re.sub(r'<p><img alt="[^"]*" src="\./ontology-video-method/([^"]+)"\s*/?></p>', inline, body)
# callouts: blockquotes starting with 📌 / 🎯
body = body.replace('<blockquote>\n<p>📌', '<blockquote class="callout bg">\n<p>📌').replace('<blockquote>\n<p>🎯', '<blockquote class="callout goal">\n<p>🎯')
html = f"""<!doctype html>
<html lang="zh-CN"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>本体视频法：对象、关系、数值与锁定图路线</title>
<meta name="robots" content="noindex">
<style>
:root{{--fg:#1d1d1f;--muted:#6e6e73;--line:#e5e5ea;--accent:#0a66c2;--bg:#fff;--soft:#f5f5f7}}
@media(prefers-color-scheme:dark){{:root{{--fg:#f2f2f7;--muted:#9a9aa0;--line:#2c2c2e;--accent:#6cb4ff;--bg:#111;--soft:#1c1c1e}}}}
*{{box-sizing:border-box}}
body{{margin:0;background:var(--bg);color:var(--fg);font:16px/1.75 -apple-system,BlinkMacSystemFont,"PingFang SC","Hiragino Sans GB","Microsoft YaHei",sans-serif;-webkit-font-smoothing:antialiased}}
.wrap{{max-width:960px;margin:0 auto;padding:32px 20px 80px}}
h1{{font-size:28px;line-height:1.3;margin:0 0 8px}}
h2{{font-size:21px;margin:44px 0 12px;padding-top:12px;border-top:1px solid var(--line)}}
h3{{font-size:17px;margin:26px 0 8px}}
p{{margin:10px 0}}
blockquote{{margin:16px 0;padding:10px 16px;background:var(--soft);border-left:3px solid var(--accent);border-radius:6px;color:var(--muted)}}
blockquote p{{margin:4px 0}}
blockquote.callout{{color:var(--fg)}}
blockquote.callout.bg{{border-left-color:#2F6FED;background:rgba(47,111,237,.08)}}
blockquote.callout.goal{{border-left-color:#F28C28;background:rgba(242,140,40,.10)}}
table{{width:100%;border-collapse:collapse;margin:14px 0;font-size:14.5px;display:block;overflow-x:auto}}
th,td{{border:1px solid var(--line);padding:8px 10px;vertical-align:top;text-align:left}}
th{{background:var(--soft);white-space:nowrap}}
code{{font:13.5px ui-monospace,SFMono-Regular,Menlo,monospace;background:var(--soft);padding:1px 5px;border-radius:4px}}
pre{{background:var(--soft);padding:14px;border-radius:8px;overflow-x:auto}}
hr{{border:0;border-top:1px solid var(--line);margin:32px 0}}
.toc{{background:var(--soft);border-radius:8px;padding:12px 18px;margin:20px 0;font-size:14.5px}}
.toc ul{{margin:0;padding-left:18px}}
figure.fig{{margin:18px 0;padding:6px;background:#fff;border:1px solid var(--line);border-radius:12px}}
figure.fig svg{{width:100%;height:auto}}
a{{color:var(--accent);text-decoration:none}}a:hover{{text-decoration:underline}}
.meta{{color:var(--muted);font-size:13px;margin-top:40px;border-top:1px solid var(--line);padding-top:12px}}
</style></head><body><div class="wrap">
<div class="toc">{md.toc}</div>
{body}
<div class="meta">来源：<code>weiaidesign-visual-studio/docs/ontology-video-method.md</code>，图由 <code>docs/ontology-video-method/build_figures.py</code> 生成 · 内部讨论稿，不含公司原始资料正文，飞书文档标题仅作索引。</div>
</div></body></html>"""
(HERE.parent / "ontology-video-method.html").write_text(html)
print(len(html), "bytes;", body.count('<figure class="fig">'), "figures inlined")
