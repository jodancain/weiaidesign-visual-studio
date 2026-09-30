"use client";

import { useEffect, useState } from "react";
import { Clapperboard, Loader2, Network, Palette } from "lucide-react";

const API_BASE = "/api/v1";

type Audience = "owner" | "showroom" | "accessory";
type Aspect = "16:9" | "9:16" | "1:1";

type Item = {
  id: string;
  title: string;
  state: string;
  audience: string;
  created_at: number;
  updated_at: number;
  shots: number;
  anchors: number;
};

const STATE_ZH: Record<string, string> = {
  drafted: "已起草",
  anchoring: "锚图生成中",
  review: "待审核",
  approved: "已通过",
  generating: "视频生成中",
  done: "完成",
  failed: "失败",
};

const AUDIENCES: Array<{ key: Audience; label: string; hint: string }> = [
  { key: "showroom", label: "展厅 / 门店大屏", hint: "慢旋转、光影、整车与精品同框" },
  { key: "accessory", label: "精品选配", hint: "同机位「原车 vs 装配后」对比" },
  { key: "owner", label: "车主种草", hint: "生活化场景，突出使用与情绪" },
];

export default function OntologyPage() {
  const [brief, setBrief] = useState("");
  const [audience, setAudience] = useState<Audience>("showroom");
  const [aspect, setAspect] = useState<Aspect>("16:9");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [items, setItems] = useState<Item[]>([]);

  async function refresh() {
    try {
      const response = await fetch(`${API_BASE}/ontology`);
      const data = (await response.json()) as { data?: { items?: Item[] } };
      setItems(data.data?.items || []);
    } catch {
      /* list is best-effort */
    }
  }

  useEffect(() => {
    void refresh();
    const timer = setInterval(() => void refresh(), 15000);
    return () => clearInterval(timer);
  }, []);

  async function submit() {
    if (brief.trim().length < 8 || busy) return;
    setBusy(true);
    setError("");
    try {
      const response = await fetch(`${API_BASE}/ontology`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ brief: brief.trim(), audience, aspect_ratio: aspect }),
      });
      const data = (await response.json()) as { detail?: string; data?: { id?: string; review_url?: string } };
      if (!response.ok) throw new Error(data.detail || `HTTP ${response.status}`);
      setBrief("");
      await refresh();
      if (data.data?.id) window.open(`${API_BASE}/ontology/${data.data.id}/review`, "_blank", "noopener");
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(false);
    }
  }

  return (
    <main className="videoPage">
      <header className="videoTop">
        <a className="logoBadge" href="/" title="回到图片工作台">
          <span>Lō</span>
        </a>
        <h1>
          <Network size={18} /> 本体视频法 · C 线
        </h1>
        <a className="videoNavLink" href="/video">
          <Clapperboard size={14} /> 图生视频
        </a>
        <a className="videoNavLink" href="/">
          <Palette size={14} /> 图片工作台
        </a>
      </header>

      <section className="videoComposer">
        <div className="videoStoryHint">
          <p>
            写一段视频需求。AI 先把它拆成<strong>对象 · 属性 · 关系 · 镜头</strong>的小本体，给每个对象和属性值生成<strong>锁定锚图</strong>，
            然后打开一页审核 HTML：你逐张通过 / 驳回 / 重生成，确认镜头起止锚图和字幕，最后一键把每个镜头交给首尾关键帧图生视频。
          </p>
          <em>例：一台深空灰 SU7 停在夜间展厅，车顶装上原厂行李架，镜头绕车半圈，再切到同机位「装前 / 装后」对比</em>
        </div>

        <div className="videoModeTabs" role="tablist" aria-label="受众线">
          {AUDIENCES.map((a) => (
            <button key={a.key} type="button" role="tab" aria-selected={audience === a.key} className={audience === a.key ? "on" : ""} title={a.hint} onClick={() => setAudience(a.key)}>
              {a.label}
            </button>
          ))}
        </div>

        <textarea value={brief} onChange={(event) => setBrief(event.target.value)} placeholder="描述车型、精品配件、场景、想要的镜头与情绪；越具体，本体越准，锚图越省" rows={5} />

        <div className="videoControls">
          <div className="videoAspect">
            {(["16:9", "9:16", "1:1"] as Aspect[]).map((a) => (
              <button key={a} type="button" className={aspect === a ? "on" : ""} onClick={() => setAspect(a)}>
                {a}
              </button>
            ))}
          </div>
          <button type="button" className="darkButton" disabled={busy || brief.trim().length < 8} onClick={() => void submit()}>
            {busy ? <Loader2 size={14} className="spin" /> : <Network size={14} />} {busy ? "起草本体中…" : "生成本体并出锚图"}
          </button>
        </div>
        {error ? <p className="videoError">{error}</p> : null}
        <p className="videoNote">锚图在后台逐张生成（通常几分钟），审核页会自动刷新。每个镜头固定 8 秒，只在两张已通过的锚图之间补间。</p>
      </section>

      <section className="videoJobs">
        {items.length === 0 ? <p className="videoEmpty">还没有本体。</p> : null}
        {items.map((item) => (
          <article key={item.id} className="videoJobCard">
            <div className="videoJobMeta">
              <strong>{item.title || item.id}</strong>
              <span>
                {STATE_ZH[item.state] || item.state} · {item.audience} · 锚图 {item.anchors} · 镜头 {item.shots} · {new Date(item.updated_at).toLocaleString("zh-CN", { hour12: false })}
              </span>
            </div>
            <p className="videoJobState">
              <a className="videoLink" href={`${API_BASE}/ontology/${item.id}/review`} target="_blank" rel="noopener noreferrer">
                打开审核页
              </a>
              <a className="videoLink" href={`${API_BASE}/ontology/${item.id}`} target="_blank" rel="noopener noreferrer">
                JSON
              </a>
            </p>
          </article>
        ))}
      </section>
    </main>
  );
}
