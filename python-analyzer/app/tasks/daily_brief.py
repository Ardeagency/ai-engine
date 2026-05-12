"""Daily Brief renderer v2 — incluye Brand Health Score, Crisis, Viral Predictions."""
from datetime import datetime



def _h(handle):
    """Strip leading @ to avoid @@redbull when template adds @."""
    if not handle: return "?"
    return str(handle).lstrip("@") or "?"


def _pct_delta(today, baseline):
    if baseline is None or baseline == 0:
        return "—"
    delta = ((today or 0) - baseline) / baseline * 100
    arrow = "▲" if delta > 0 else "▼" if delta < 0 else "→"
    return f"{arrow} {abs(delta):.1f}%"


def _format_engagement(num):
    if num is None: return "0"
    if num >= 1_000_000: return f"{num/1_000_000:.1f}M"
    if num >= 1_000: return f"{num/1_000:.1f}K"
    return str(int(num))


def _emoji_for_lift(lift):
    if lift > 5: return "🚀"
    if lift > 1: return "🔥"
    if lift > 0.3: return "📈"
    return "💡"


def _bhs_band(score):
    if score >= 80: return "🟢 Excelente"
    if score >= 65: return "🟡 Saludable"
    if score >= 50: return "🟠 Requiere atención"
    return "🔴 Crítico"


def _crisis_emoji(severity):
    return {"critical": "🚨", "high": "⚠️", "medium": "🟡", "low": "✅"}.get(severity, "✅")


def _viral_emoji(score):
    if score >= 0.7: return "🚀"
    if score >= 0.5: return "🔥"
    return "📈"


def render_brief_markdown(data: dict, brand_name: str = "Tu Marca") -> str:
    date = data.get("date", "")
    own = data.get("own_performance", {})
    today_perf = own.get("today") or {}
    baseline = own.get("baseline_30d") or {}
    bhs = data.get("brand_health") or {}
    crisis = data.get("crisis") or {}

    md = []
    md.append(f"# 📊 Daily Brief — {brand_name}")
    md.append(f"*{date}*\n")

    # ── BRAND HEALTH SCORE (header destacado) ──────────────────────────────
    bhs_score = float(bhs.get("bhs_score", 0) or 0)
    bhs_band = _bhs_band(bhs_score)
    md.append(f"## 💯 Brand Health Score: **{bhs_score:.1f} / 100** — {bhs_band}\n")
    if bhs.get("rank_in_category") and bhs.get("category_size", 0) > 1:
        md.append(f"*Ranking en categoría: **#{bhs['rank_in_category']} de {bhs['category_size']}***\n")
    components = bhs.get("components") or {}
    if components:
        md.append("**Desglose:**")
        comp_order = [("sentiment", "Sentimiento"), ("velocity", "Velocidad engagement"),
                      ("sov", "Share of Voice"), ("growth", "Crecimiento audiencia"),
                      ("diversity", "Diversidad de contenido"), ("crisis", "Estabilidad (anti-crisis)")]
        for key, label in comp_order:
            c = components.get(key) or {}
            score = float(c.get("score", 0) or 0)
            weight = float(c.get("weight", 0) or 0) * 100
            bar_len = int(score / 5)  # 0..20
            bar = "█" * bar_len + "░" * (20 - bar_len)
            md.append(f"- {label}: `{bar}` {score:.1f}/100 (peso {weight:.0f}%)")
        md.append("")

    # ── CRISIS RISK ────────────────────────────────────────────────────────
    severity = crisis.get("severity", "low")
    crisis_score_val = float(crisis.get("crisis_score", 0) or 0)
    md.append(f"## {_crisis_emoji(severity)} Crisis Risk: **{severity.upper()}** (score: {crisis_score_val:.3f})\n")
    if severity != "low":
        factors = crisis.get("factors") or {}
        md.append("**Factores activos:**")
        if factors.get("high_risk_posts_24h", 0) > 0:
            md.append(f"- {factors['high_risk_posts_24h']} posts marcados HIGH risk en últimas 24h")
        if factors.get("hate_signals_12h", 0) > 0:
            md.append(f"- {factors['hate_signals_12h']} señales de odio detectadas (12h)")
        if factors.get("viral_negative_24h", 0) > 0:
            md.append(f"- {factors['viral_negative_24h']} posts NEG con alcance >10K (24h)")
        if factors.get("audience_backlash_48h", 0) > 0:
            md.append(f"- {factors['audience_backlash_48h']} casos de backlash audiencia (post POS, comments NEG)")
        if (factors.get("comment_neg_ratio_6h", 0) or 0) > 0.3:
            md.append(f"- Ratio NEG comments 6h: {factors['comment_neg_ratio_6h']:.1%}")
        md.append("")
    else:
        md.append("*Sin señales críticas detectadas.*\n")

    # ── EXECUTIVE SUMMARY ──────────────────────────────────────────────────
    md.append("## ⚡ Resumen ejecutivo del día\n")
    posts_today = today_perf.get("posts_count", 0)
    eng_today = today_perf.get("engagement_total", 0)
    eng_rate_today = float(today_perf.get("avg_engagement_rate", 0) or 0)
    eng_rate_baseline = float(baseline.get("baseline_engagement_rate", 0) or 0)
    sent_today = float(today_perf.get("avg_sentiment", 0) or 0)
    sent_baseline = float(baseline.get("baseline_sentiment", 0) or 0)

    md.append(f"- **Posts publicados hoy:** {posts_today}")
    md.append(f"- **Engagement total:** {_format_engagement(eng_today)}")
    md.append(f"- **Engagement rate:** {eng_rate_today:.4f} ({_pct_delta(eng_rate_today, eng_rate_baseline)} vs avg 30d)")
    md.append(f"- **Sentiment promedio:** {sent_today:+.2f} ({_pct_delta(sent_today, sent_baseline)} vs avg 30d)")
    md.append("")

    # ── VIRAL PREDICTIONS (NUEVO) ──────────────────────────────────────────
    viral_preds = data.get("top_viral_predictions") or []
    _viral_post_ids = {v.get("post_id") for v in viral_preds if v.get("post_id")}
    if viral_preds:
        md.append("## 🚀 Posts en trayectoria viral (últimas 24h)\n")
        for v in viral_preds[:5]:
            score = float(v.get("viral_score", 0) or 0)
            action = v.get("action", "monitor")
            emoji = _viral_emoji(score)
            md.append(f"{emoji} **viral_score: {score:.2f}** | acción: `{action}` | velocity: {_format_engagement(v.get('velocity_lph', 0))}/h")
            content = (v.get("content") or "").strip()
            if content:
                md.append(f"   > {content[:130]}")
            md.append("")

    # ── TOP POSTS PROPIOS ──────────────────────────────────────────────────
    top_posts = data.get("top_own_posts", []) or []
    md.append("## 🏆 Top posts propios hoy\n")
    if not top_posts:
        md.append("*Sin publicaciones propias hoy.* — Considera publicar al menos 1 contenido para mantener cadencia.")
    else:
        for i, p in enumerate(top_posts[:3], 1):
            md.append(f"**{i}.** [{p.get('network')}] @{_h(p.get('profile'))} — {_format_engagement(p.get('engagement'))} engagement")
            md.append(f"   *Tono:* {p.get('tone')} | *Tema:* {p.get('topic')} | *Formato:* {p.get('format')}")
            content = p.get("content", "").strip()
            if content:
                md.append(f"   > {content[:150]}")
            if p.get("risk_level") and p["risk_level"] != "low":
                md.append(f"   ⚠️ **Risk:** {p['risk_level']}")
            md.append("")
    md.append("")

    # ── OPORTUNIDADES (CROSS-BRAND RECOS) ─────────────────────────────────
    recos = data.get("recommendations", []) or []
    md.append("## 🎯 Oportunidades detectadas (combinaciones ganadoras de competencia)\n")
    if not recos:
        md.append("*No hay oportunidades nuevas — tu marca cubre lo principal.*")
    else:
        for i, r in enumerate(recos[:5], 1):
            lift = float(r.get("expected_lift", 0) or 0)
            emoji = _emoji_for_lift(lift)
            md.append(f"**{emoji} {i}. [{r.get('network')}] {r.get('tone')} + {r.get('topic')} + {r.get('format')}**")
            md.append(f"   - Tipo: `{r.get('recommendation_type')}` · Lift esperado: **+{lift:.3f}** engagement_rate")
            md.append(f"   - Competidores: {r.get('competitor_examples_count')} posts, avg {float(r.get('competitor_avg_engagement',0) or 0):.4f}")
            md.append(f"   - Tu actual: {float(r.get('my_avg_engagement',0) or 0):.4f}")
            md.append(f"   - 💡 *{r.get('insight','')}*")
            md.append("")
    md.append("")

    # ── COMPETENCIA HOY ────────────────────────────────────────────────────
    comp = [c for c in (data.get("competitor_activity") or []) if c.get("post_id") not in _viral_post_ids]
    md.append("## 🥊 Lo que hicieron competidores hoy\n")
    if not comp:
        md.append("*Sin actividad relevante de competidores hoy.*")
    else:
        for c in comp[:5]:
            md.append(f"- **@{_h(c.get('profile'))}** [{c.get('network')}] — {_format_engagement(c.get('engagement'))}")
            md.append(f"  *Tono:* {c.get('tone')} | *Tema:* {c.get('topic')}")
            content = c.get("content", "").strip()
            if content:
                md.append(f"  > {content[:120]}")
        if len(comp) > 5:
            md.append(f"  *... y {len(comp)-5} posts más de competencia*")
    md.append("")

    # ── RIESGOS POR POST ───────────────────────────────────────────────────
    risks = data.get("risks", []) or []
    md.append("## ⚠️ Posts con risk detectado (24-48h)\n")
    if not risks:
        md.append("*Sin posts con risk alto/medio.* ✅")
    else:
        for r in risks[:5]:
            md.append(f"- **[{r.get('risk_level','?').upper()}]** [{r.get('network')}] @{_h(r.get('profile'))}")
            content = r.get("content", "").strip()
            if content:
                md.append(f"  > {content[:120]}")
            flags = r.get("flags") or []
            if flags:
                md.append(f"  *Flags:* {', '.join(flags)}")
    md.append("")

    # ── COMENTARIOS NEGATIVOS ──────────────────────────────────────────────
    neg = data.get("negative_comments", []) or []
    md.append("## 💬 Comentarios negativos sin responder (últimas 48h)\n")
    if not neg:
        md.append("*No hay comentarios negativos críticos pendientes.* ✅")
    else:
        for c in neg[:5]:
            md.append(f"- **@{_h(c.get('author'))}** ({float(c.get('sentiment_score') or 0):+.2f}, {c.get('emotion','others')})")
            md.append(f"  > {(c.get('content') or '')[:140]}")
    md.append("")

    # ── COMMUNICATION PATTERNS (vulnerabilidades + fortalezas) ────────────
    comm = data.get("communication_patterns") or {}
    own_vulns = comm.get("own_vulnerabilities") or []
    own_strengths = comm.get("own_strengths") or []
    comp_vulns = comm.get("competitor_vulnerabilities") or []
    period_days = comm.get("period_days", 30)

    md.append(f"## 🧠 Patrones comunicacionales (últimos {period_days}d)\n")

    md.append("### ⚠️ Vulnerabilidades en tu propia comunicación")
    if not own_vulns:
        md.append("*Sin patrones vulnerables detectados sobre el umbral.* ✅\n")
    else:
        for v in own_vulns[:5]:
            sev_emoji = {"critical":"🚨","high":"⛔","medium":"⚠️","low":"🟡"}.get(v.get("severity","medium"),"⚠️")
            md.append(f"- {sev_emoji} **{v['name']}** — {float(v['pct'])*100:.1f}% de tus posts (umbral {float(v['threshold'])*100:.0f}%)")
            md.append(f"  *{v['posts_affected']}/{v['posts_analyzed']} posts afectados*")
        md.append("")

    md.append("### ✅ Fortalezas comunicacionales activas")
    if not own_strengths:
        md.append("*Aún no destacan fortalezas medibles. Considera reforzar storytelling/comunidad.*\n")
    else:
        for s in own_strengths[:5]:
            md.append(f"- 💪 **{s['name']}** — {float(s['pct'])*100:.1f}% de posts ({s['posts_affected']}/{s['posts_analyzed']})")
        md.append("")

    md.append("### 🎯 Vulnerabilidades detectadas en competencia (oportunidades)")
    if not comp_vulns:
        md.append("*Sin patrones flagged en competencia este período.*\n")
    else:
        by_comp = {}
        for cv in comp_vulns[:15]:
            by_comp.setdefault(cv["competitor"], []).append(cv)
        for handle, items in by_comp.items():
            md.append(f"- **{handle}**:")
            for it in items[:3]:
                sev = {"critical":"🚨","high":"⛔","medium":"⚠️","low":"🟡"}.get(it.get("severity","medium"),"⚠️")
                md.append(f"  - {sev} {it['name']}: **{float(it['pct'])*100:.1f}%** ({it['posts_affected']}/{it['posts_analyzed']} posts)")
        md.append("")
    md.append("")

    # ── TENDENCIAS EMERGENTES ─────────────────────────────────────────────
    trends = data.get("emerging_combos", []) or []
    md.append("## 🌊 Tendencias emergentes en tu categoría\n")
    if not trends:
        md.append("*Sin combinaciones emergentes detectadas con suficiente volumen.*")
    else:
        for t in trends[:5]:
            md.append(f"- **[{t.get('network')}]** `{t.get('tone')} × {t.get('topic')} × {t.get('format')}`")
            md.append(f"  - Marcas usándolo: {t.get('brands_using')} | Avg engagement categoría: {float(t.get('category_avg_engagement',0) or 0):.4f}")
            md.append(f"  - Top performer: @{_h(t.get('top_brand'))}")
    md.append("")

    # ── ACCIONES SUGERIDAS ─────────────────────────────────────────────────
    md.append("## 🚀 Acciones sugeridas hoy/mañana\n")
    actions = []
    # Crisis primero
    if severity in ("critical", "high"):
        actions.append(f"🚨 **CRISIS {severity.upper()}** — activar playbook PR de inmediato")
    elif severity == "medium":
        actions.append(f"⚠️ **Crisis MEDIUM** — investigar factores antes que escale")
    # Viral
    if viral_preds:
        boost_count = sum(1 for v in viral_preds if v.get("action") == "boost_paid")
        if boost_count:
            actions.append(f"💰 **Boost paid en {boost_count} post(s)** con viral_score ≥ 0.70 y sentiment positivo")
    # Top reco
    if recos:
        top_reco = recos[0]
        actions.append(f"🎯 **Probar piloto:** {top_reco.get('tone')} + {top_reco.get('topic')} en {top_reco.get('network')} — lift esperado +{float(top_reco.get('expected_lift',0) or 0):.3f}")
    # Comments NEG
    if neg and len(neg) >= 3:
        actions.append(f"💬 **Responder {len(neg)} comentarios negativos** — riesgo de quedar mudo")
    # Risks
    if risks:
        actions.append(f"⚠️ **Revisar {len(risks)} posts con risk** — considerar ajuste de mensaje")
    # No posts
    if posts_today == 0:
        actions.append("📅 **Publicar al menos 1 contenido** — sin actividad propia hoy")
    # BHS bajo
    if bhs_score < 50:
        weak = sorted(components.items(), key=lambda x: float(x[1].get("score", 100) or 100))[:2]
        weak_names = ", ".join(k for k, _ in weak)
        actions.append(f"💯 **BHS bajo ({bhs_score:.0f}/100)** — focar en mejorar: {weak_names}")
    # Engagement caída
    if eng_rate_today < eng_rate_baseline * 0.7 and eng_rate_baseline > 0:
        actions.append(f"📉 **Investigar caída engagement** ({_pct_delta(eng_rate_today, eng_rate_baseline)} vs baseline)")

    if not actions:
        md.append("*Performance dentro del baseline. Mantener cadencia y monitorear.*")
    else:
        for a in actions:
            md.append(f"- {a}")
    md.append("")

    md.append("---")
    md.append(f"*Brief generado automáticamente · Powered by AI Smart Content · {datetime.utcnow().strftime('%Y-%m-%d %H:%M UTC')}*")

    return "\n".join(md)


def compute_metrics_summary(data: dict) -> dict:
    own = (data.get("own_performance") or {}).get("today") or {}
    baseline = (data.get("own_performance") or {}).get("baseline_30d") or {}
    bhs = data.get("brand_health") or {}
    crisis = data.get("crisis") or {}

    return {
        "bhs_score": float(bhs.get("bhs_score", 0) or 0),
        "rank_in_category": bhs.get("rank_in_category"),
        "crisis_severity": crisis.get("severity", "low"),
        "crisis_score": float(crisis.get("crisis_score", 0) or 0),
        "posts_count": own.get("posts_count", 0),
        "engagement_total": own.get("engagement_total", 0),
        "avg_engagement_rate": float(own.get("avg_engagement_rate", 0) or 0),
        "avg_sentiment": float(own.get("avg_sentiment", 0) or 0),
        "baseline_engagement_rate": float(baseline.get("baseline_engagement_rate", 0) or 0),
        "baseline_sentiment": float(baseline.get("baseline_sentiment", 0) or 0),
        "recommendations_count": len(data.get("recommendations") or []),
        "viral_predictions_count": len(data.get("top_viral_predictions") or []),
        "risks_count": len(data.get("risks") or []),
        "negative_comments_count": len(data.get("negative_comments") or []),
        "competitor_activity_count": len(data.get("competitor_activity") or []),
    }
