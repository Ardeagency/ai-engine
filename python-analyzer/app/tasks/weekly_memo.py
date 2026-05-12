"""Weekly Strategy Memo renderer — markdown estratégico para director marketing."""
from datetime import datetime


def _arrow(delta):
    if delta is None: return "—"
    if delta > 0: return f"▲ +{delta:.1f}%" if isinstance(delta, float) else f"▲ +{delta}"
    if delta < 0: return f"▼ {delta:.1f}%" if isinstance(delta, float) else f"▼ {delta}"
    return "→ 0%"


def _fmt(num):
    if num is None: return "0"
    n = int(num) if isinstance(num, (int, float)) else 0
    if n >= 1_000_000: return f"{n/1_000_000:.1f}M"
    if n >= 1_000: return f"{n/1_000:.1f}K"
    return str(n)


def _bhs_band(score):
    if score >= 80: return "🟢 Excelente"
    if score >= 65: return "🟡 Saludable"
    if score >= 50: return "🟠 Atención"
    return "🔴 Crítico"


def render_weekly_memo(data: dict, brand_name: str = "Tu Marca") -> str:
    week_start = data.get("week_start", "")
    week_end = data.get("week_end", "")
    bhs_now = data.get("bhs_now") or {}
    bhs_prev = data.get("bhs_prev")
    bhs_change = data.get("bhs_change")
    own_this = data.get("own_performance_this_week") or {}
    own_prev = data.get("own_performance_prev_week") or {}

    md = []
    md.append(f"# 📈 Strategy Memo — {brand_name}")
    md.append(f"*Semana del {week_start} al {week_end}*")
    md.append(f"*Generado {datetime.utcnow().strftime('%Y-%m-%d %H:%M UTC')}*\n")

    # ── EXECUTIVE SUMMARY ─────────────────────────────────────────────────
    bhs_score = float(bhs_now.get("bhs_score", 0) or 0)
    md.append("## 🎯 Resumen ejecutivo de la semana\n")
    md.append(f"**Brand Health Score:** {bhs_score:.1f}/100 ({_bhs_band(bhs_score)})")
    if bhs_prev is not None and bhs_change is not None:
        sign = "▲" if bhs_change > 0 else "▼" if bhs_change < 0 else "→"
        md.append(f"  → {sign} {abs(bhs_change):.1f} pts vs semana anterior ({float(bhs_prev):.1f})")
    md.append("")

    # WoW comparison
    posts_now = own_this.get("posts", 0) or 0
    posts_prev = own_prev.get("posts", 0) or 0
    eng_now = own_this.get("eng_total", 0) or 0
    eng_prev = own_prev.get("eng_total", 0) or 0
    sent_now = float(own_this.get("avg_sent", 0) or 0)
    sent_prev = float(own_prev.get("avg_sent", 0) or 0)

    posts_delta = posts_now - posts_prev
    eng_delta_pct = ((eng_now - eng_prev) / eng_prev * 100) if eng_prev > 0 else None
    sent_delta = sent_now - sent_prev

    md.append("**Performance esta semana vs anterior:**")
    md.append(f"- Posts publicados: {posts_now} ({_arrow(posts_delta)})")
    md.append(f"- Engagement total: {_fmt(eng_now)} ({_arrow(eng_delta_pct)})")
    md.append(f"- Sentiment promedio: {sent_now:+.2f} ({_arrow(sent_delta)})")
    md.append("")

    # ── SHARE OF VOICE ────────────────────────────────────────────────────
    sov = data.get("sov_changes") or []
    md.append("## 📊 Share of Voice (semana actual)\n")
    if not sov:
        md.append("*Sin datos suficientes de competidores esta semana.*")
    else:
        md.append("| Marca | Engagement | WoW |")
        md.append("|---|---|---|")
        for item in sov[:10]:
            self_marker = " 👈 (tú)" if item.get("is_self") else ""
            wow = item.get("wow_change_pct")
            wow_str = f"{'▲' if (wow or 0) > 0 else '▼' if (wow or 0) < 0 else '→'} {abs(wow or 0):.1f}%" if wow is not None else "—"
            md.append(f"| {item.get('brand_name','?')}{self_marker} | {_fmt(item.get('eng_this_week'))} | {wow_str} |")
    md.append("")

    # ── PATRONES PROPIOS GANADORES ────────────────────────────────────────
    own_patterns = data.get("top_own_patterns") or []
    md.append("## 🏆 Patrones propios ganadores esta semana\n")
    if not own_patterns:
        md.append("*Sin posts propios clasificados esta semana.*")
    else:
        md.append("| # | Network | Tono | Tema | Formato | Posts | Avg ER | Win Score |")
        md.append("|---|---|---|---|---|---|---|---|")
        for i, p in enumerate(own_patterns[:5], 1):
            md.append(f"| {i} | {p.get('network')} | {p.get('tone')} | {p.get('topic')} | {p.get('format')} | {p.get('posts_count')} | {float(p.get('avg_engagement_rate') or 0):.4f} | {float(p.get('win_score') or 0):.4f} |")
    md.append("")

    # ── PATRONES COMPETENCIA GANADORES ────────────────────────────────────
    comp_patterns = data.get("top_competitor_patterns") or []
    md.append("## 🥊 Patrones que dominan en competencia esta semana\n")
    if not comp_patterns:
        md.append("*Sin patrones de competencia con suficiente volumen.*")
    else:
        md.append("| # | Network | Tono | Tema | Formato | Marcas | Avg ER | Top |")
        md.append("|---|---|---|---|---|---|---|---|")
        for i, p in enumerate(comp_patterns[:5], 1):
            md.append(f"| {i} | {p.get('network')} | {p.get('tone')} | {p.get('topic')} | {p.get('format')} | {p.get('brands_using')} | {float(p.get('avg_engagement_rate') or 0):.4f} | @{p.get('top_brand','?')} |")
    md.append("")

    # ── VIRAL HITS ─────────────────────────────────────────────────────────
    viral = data.get("viral_hits") or []
    if viral:
        md.append("## 🚀 Viral hits de la semana\n")
        for v in viral[:5]:
            who = "tu marca" if v.get("is_self") else f"@{v.get('profile')}"
            md.append(f"- **{who}** [{v.get('network')}] — viral_score {float(v.get('viral_score',0) or 0):.2f}, velocity {_fmt(v.get('velocity_lph'))}/h")
            content = (v.get("content") or "").strip()
            if content:
                md.append(f"  > {content[:130]}")
        md.append("")

    # ── CRISIS DEL PERIODO ─────────────────────────────────────────────────
    crises = data.get("week_crises") or []
    md.append("## ⚠️ Crisis events de la semana\n")
    if not crises:
        md.append("*Sin crisis registradas.* ✅")
    else:
        for c in crises[:5]:
            sev = c.get("severity", "?").upper()
            md.append(f"- **[{sev}]** score {float(c.get('crisis_score',0) or 0):.3f} ({c.get('triggered_at','?')[:16]})")
            factors = c.get("factors") or {}
            active = [k for k, v in factors.items() if v and (isinstance(v, (int, float)) and v > 0)]
            if active:
                md.append(f"  Factores: {', '.join(active)}")
    md.append("")

    # ── HIPÓTESIS DE CAMPAÑA (recos) ──────────────────────────────────────
    recos = data.get("recommendations") or []
    md.append("## 💡 Hipótesis estratégicas para próxima semana\n")
    if not recos:
        md.append("*Sin oportunidades nuevas detectadas — mantener cadencia.*")
    else:
        for i, r in enumerate(recos[:8], 1):
            lift = float(r.get("expected_lift", 0) or 0)
            md.append(f"### Hipótesis #{i}: {r.get('tone')} × {r.get('topic')} en {r.get('network')}")
            md.append(f"- **Lift esperado:** +{lift:.3f} engagement_rate")
            md.append(f"- **Evidencia competidor:** {r.get('competitor_examples_count')} posts con avg {float(r.get('competitor_avg_engagement',0) or 0):.4f}")
            md.append(f"- **Tipo:** `{r.get('recommendation_type')}` — {r.get('insight','')}")
            md.append(f"- **Acción:** Producir 2-3 piezas piloto en formato `{r.get('format')}` esta semana")
            md.append("")

    # ── DECISIÓN ESTRATÉGICA ──────────────────────────────────────────────
    md.append("## 🎬 Decisión estratégica recomendada\n")
    decisions = []
    if bhs_change is not None and bhs_change < -5:
        decisions.append(f"**BHS bajó {abs(bhs_change):.1f} pts** — investigar causa primaria antes de campañas nuevas")
    if eng_delta_pct is not None and eng_delta_pct < -25:
        decisions.append(f"**Engagement cayó {abs(eng_delta_pct):.1f}% WoW** — auditar calendario y mensaje de la semana")
    if recos:
        top = recos[0]
        decisions.append(f"**Probar:** {top.get('tone')} + {top.get('topic')} en {top.get('network')} (lift +{float(top.get('expected_lift',0) or 0):.3f})")
    if crises:
        decisions.append(f"**Activar playbook PR** — {len(crises)} crisis events detectados esta semana")
    if not own_patterns:
        decisions.append("**Aumentar cadencia** — sin actividad propia esta semana")

    if not decisions:
        decisions.append("Performance estable. Foco: ejecutar las 2 hipótesis principales.")

    for d in decisions[:5]:
        md.append(f"- {d}")
    md.append("")
    md.append("---")
    md.append(f"*Strategy Memo · Powered by AI Smart Content · v1*")

    return "\n".join(md)


def compute_memo_metrics(data: dict) -> dict:
    bhs = data.get("bhs_now") or {}
    own = data.get("own_performance_this_week") or {}
    return {
        "bhs_score": float(bhs.get("bhs_score", 0) or 0),
        "bhs_change": float(data.get("bhs_change") or 0),
        "posts_this_week": own.get("posts", 0),
        "engagement_this_week": own.get("eng_total", 0),
        "recommendations_count": len(data.get("recommendations") or []),
        "viral_hits_count": len(data.get("viral_hits") or []),
        "crises_count": len(data.get("week_crises") or []),
    }
