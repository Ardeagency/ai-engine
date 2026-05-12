"""Creator Brief Generator — convierte una recommendation en brief operativo.

Inputs: brand_id + recommendation (network, tone, topic, format)
Output: brief markdown listo para creator/diseñador con:
  - Contexto y "por qué"
  - Audience target (de brand_container)
  - Mensaje core (3 ángulos generados con templates)
  - Especificaciones técnicas por formato
  - Sound trending si aplica (de category_pattern)
  - CTA sugerida según topic
  - Deadline + entrega esperada
"""
from datetime import datetime, timedelta


# ── Especificaciones técnicas por formato ────────────────────────────────────
FORMAT_SPECS = {
    "short_video": {
        "ratio": "9:16 vertical",
        "duration": "15-30 segundos óptimo (max 60s)",
        "first_3s": "Hook visual + audio fuerte",
        "captions": "Sí, siempre — 80% ven sin sonido al inicio",
        "cta_overlay": "Última 3s, formato texto grande",
    },
    "long_video": {
        "ratio": "16:9 horizontal",
        "duration": "2-10 minutos según retention histórica",
        "first_15s": "Setup + promesa de valor",
        "captions": "Subtítulos + thumbnail con texto claro",
        "cta_overlay": "Mid-roll + end-card",
    },
    "reel_baile": {
        "ratio": "9:16 vertical",
        "duration": "15-30 segundos",
        "first_3s": "Movimiento o sound trending",
        "audio": "Usar sound trending (ver sección abajo)",
        "captions": "Texto sobreimpreso con sentido del humor",
    },
    "carrusel_imgs": {
        "slides": "5-10 slides óptimo",
        "first_slide": "Hook visual + headline impactante",
        "last_slide": "CTA + handle",
        "ratio": "1:1 cuadrado o 4:5 vertical",
        "consistency": "Tipografía + paleta consistente entre slides",
    },
    "single_image": {
        "ratio": "1:1 cuadrado o 4:5 vertical (IG)",
        "composition": "Regla de tercios + foco central claro",
        "caption": "Hook primera línea, CTA al final",
        "hashtags": "5-15 relevantes, no spammy",
    },
    "tutorial_steps": {
        "structure": "Numerar pasos claramente (1., 2., 3.)",
        "format": "Carrusel IG o video corto",
        "first_slide": "Headline 'Cómo X en N pasos'",
        "captions": "Cada paso 1 frase max",
    },
    "meme": {
        "format": "Imagen + texto overlay",
        "tone": "Humor + relevancia cultural inmediata",
        "duration_relevance": "Memes mueren rápido — publish ASAP",
    },
    "story_temporal": {
        "duration": "Cada slide 5-7s",
        "stickers": "Polls / Q&A / countdown para engagement",
        "ratio": "9:16 vertical",
    },
}

# ── Mensaje core: 3 ángulos por combinación tone × topic ────────────────────
MESSAGE_TEMPLATES = {
    # Templates por (tone, topic) — fallback general si no hay match exacto
    ("optimista", "datos_curiosos"): [
        "Comparte un dato sorprendente del producto/categoría que abra la mente del usuario al futuro",
        "Conecta una innovación reciente con cómo cambiará la vida del consumidor",
        "Cuenta el 'sabías que' con tono de descubrimiento esperanzador",
    ],
    ("alegre", "lifestyle"): [
        "Mostrar una escena cotidiana donde el producto es protagonista del momento feliz",
        "UGC-style: persona real disfrutando situación universal con el producto",
        "Día perfecto en 30s con el producto como hilo conductor",
    ],
    ("confrontacional", "comparison"): [
        "Comparar tu valor único vs práctica de la categoría sin nombrar competencia",
        "Mostrar 'lo que NO somos' como statement de valores",
        "Postura clara contra status quo (sin ataque personal)",
    ],
    ("humorístico", "comedia_pranks"): [
        "Setup → giro inesperado relacionado con el producto",
        "Auto-burla de marca (humilde) genera engagement masivo",
        "Reaccionar a meme cultural de momento manteniendo voz de marca",
    ],
    ("aspiracional", "lifestyle"): [
        "Mostrar el 'tú futuro' que el producto habilita — sin ser pretencioso",
        "Conectar con valores aspiracionales del target (libertad, éxito, etc.)",
        "Un día en la vida ideal con tu producto como facilitador",
    ],
    ("urgente", "promo_oferta"): [
        "Headline grande con scarcity real (tiempo o cantidad)",
        "Beneficio principal en primera línea + CTA clarísimo",
        "FOMO sin caer en presión — 'esto se acaba pronto'",
    ],
    ("educativo", "tutorial"): [
        "1 problema concreto → solución en N pasos numerados",
        "Tip valioso + producto como herramienta natural",
        "'Lo que ojalá hubiera sabido antes' del experto al principiante",
    ],
    ("casual", "ugc_repost"): [
        "Repost auténtico del fan/atleta/usuario con crédito visible",
        "Mensaje breve agregando contexto cálido",
        "Comunidad-first: 'mira lo que está haciendo nuestra gente'",
    ],
    ("motivacional", "deportes_extremos"): [
        "Atleta + momento de hazaña + frase corta inspiradora",
        "Reto superado con tu marca como combustible/equipo",
        "Voice-over inspiracional + cinematic visuals",
    ],
}


def _msg_templates(tone: str, topic: str) -> list[str]:
    """Devuelve 3 ángulos. Match exacto, fallback por tone, finalmente genérico."""
    exact = MESSAGE_TEMPLATES.get((tone, topic))
    if exact:
        return exact
    # Fallback por tone
    for (t, _), msgs in MESSAGE_TEMPLATES.items():
        if t == tone:
            return msgs
    return [
        f"Mensaje principal con tono {tone} sobre {topic.replace('_', ' ')}",
        f"Variante con énfasis en beneficio emocional vinculado a {topic.replace('_', ' ')}",
        f"Variante story-driven enfatizando experiencia del usuario con {tone}",
    ]


def _cta_for_topic(topic: str) -> str:
    return {
        "promo_oferta": "Aprovecha + link/swipe-up",
        "producto_launch": "Pre-order / Sé el primero",
        "tutorial": "Guarda este post + comparte si te sirvió",
        "datos_curiosos": "¿Sabías esto? Cuéntanos en comentarios",
        "behind_scenes": "¿Quieres ver más? Dale follow",
        "comunidad_fans": "Etiqueta a quien debe ver esto",
        "evento_live": "Únete / RSVP / Mira en vivo",
        "comparison": "¿Cuál prefieres? Vota en comentarios",
        "testimonial": "Tu turno — cuéntanos tu experiencia",
        "ugc_repost": "Mencionarnos para repostear tu contenido",
        "partnership": "Descubre más en perfil de @colaborador",
        "lifestyle": "¿Cómo vives tu mood hoy? Cuéntanos",
        "deportes_extremos": "Etiqueta a quien lo intentaría",
        "comedia_pranks": "Reacciona si te sacó risa",
        "informativo": "¿Quieres saber más? Comenta '+'",
        "call_to_action": "Toma acción ya",
    }.get(topic, "Engagement: comenta tu opinión")


def _audience_hint(brand_data: dict) -> str:
    """Extrae audience hint de brand_container.verbal_dna o defaults."""
    if not brand_data:
        return "Audiencia general — definir segmento target específico"
    # Intentar leer verbal_dna o info brand
    ddd = brand_data.get("verbal_dna") or {}
    if ddd:
        target = ddd.get("audiencia") or ddd.get("audience") or ddd.get("target")
        if target:
            return target if isinstance(target, str) else ", ".join(target) if isinstance(target, list) else "—"
    nicho = brand_data.get("nicho_core")
    pais = brand_data.get("mercado_objetivo")
    if nicho or pais:
        parts = []
        if nicho: parts.append(f"Nicho: {nicho}")
        if pais: parts.append(f"Mercado: {pais if isinstance(pais, str) else ', '.join(pais)}")
        return " | ".join(parts)
    return "Audiencia general — refinar en próxima iteración"


def render_creator_brief(reco: dict, brand_data: dict, brand_name: str = "Tu Marca") -> str:
    """
    reco: dict con tone, topic, format, network, expected_lift, insight, etc.
    brand_data: dict con verbal_dna, nicho_core, mercado_objetivo, etc.
    """
    tone = reco.get("tone", "casual")
    topic = reco.get("topic", "informativo")
    fmt = reco.get("format", "single_image")
    network = reco.get("network", "instagram")
    lift = float(reco.get("expected_lift", 0) or 0)
    insight = reco.get("insight", "")
    competitor_avg = float(reco.get("competitor_avg_engagement", 0) or 0)
    examples_count = reco.get("competitor_examples_count", 0)

    specs = FORMAT_SPECS.get(fmt, FORMAT_SPECS["single_image"])
    angles = _msg_templates(tone, topic)
    cta = _cta_for_topic(topic)
    audience = _audience_hint(brand_data)
    deadline = (datetime.utcnow() + timedelta(days=2)).strftime("%Y-%m-%d (%A)")

    md = []
    md.append(f"# 🎬 Creator Brief — {brand_name}")
    md.append(f"*Generado {datetime.utcnow().strftime('%Y-%m-%d %H:%M UTC')}*\n")

    # ── ¿POR QUÉ? ─────────────────────────────────────────────────────────
    md.append("## 🎯 Por qué este brief\n")
    md.append(f"**Combinación detectada como ganadora en tu categoría que NO usas:**")
    md.append(f"- Tono: **{tone}**")
    md.append(f"- Tema: **{topic.replace('_', ' ')}**")
    md.append(f"- Formato: **{fmt.replace('_', ' ')}**")
    md.append(f"- Red: **{network}**")
    md.append(f"- Evidencia: {examples_count} posts de competencia, engagement promedio {competitor_avg:.4f}")
    md.append(f"- Lift esperado: **+{lift:.3f} engagement_rate**")
    md.append(f"- *Insight:* {insight}\n")

    # ── AUDIENCIA ─────────────────────────────────────────────────────────
    md.append("## 👥 Audiencia objetivo\n")
    md.append(audience)
    md.append("")

    # ── 3 ÁNGULOS DE MENSAJE ──────────────────────────────────────────────
    md.append("## 💬 3 ángulos de mensaje (elegir 1, A/B testear si vale)\n")
    for i, a in enumerate(angles, 1):
        md.append(f"**Ángulo {i}:** {a}")
        md.append("")

    # ── ESPECIFICACIONES TÉCNICAS ────────────────────────────────────────
    md.append(f"## ⚙️ Specs técnicas — formato: `{fmt}`\n")
    for k, v in specs.items():
        md.append(f"- **{k.replace('_', ' ').title()}:** {v}")
    md.append("")

    # ── SOUND/MUSIC TRENDING (si aplica) ─────────────────────────────────
    if fmt in ("reel_baile", "short_video") and network in ("tiktok", "instagram"):
        md.append("## 🎵 Music / sound\n")
        md.append("- Buscar sound trending del mes en categoría (energía, lifestyle, deportes según topic)")
        md.append("- Si no hay obvio: usar sound de competidor top-performer")
        md.append("- TikTok: nunca silencio + nunca audio original si hay trend usable")
        md.append("")

    # ── CTA ───────────────────────────────────────────────────────────────
    md.append("## 📣 CTA sugerida\n")
    md.append(f"**{cta}**\n")

    # ── HASHTAGS BASE ─────────────────────────────────────────────────────
    md.append("## #️⃣ Hashtags base (refinar)\n")
    nicho = (brand_data or {}).get("nicho_core") or "marca"
    md.append(f"- 3-5 hashtags de marca: `#{brand_name.lower().replace(' ', '')}`")
    md.append(f"- 3-5 hashtags de nicho: `#{nicho.lower() if isinstance(nicho, str) else 'marca'}`")
    md.append(f"- 2-3 hashtags trending del momento (revisar trends del día)")
    md.append(f"- Ejemplos por topic: `#{topic.replace('_', '')}`")
    md.append("")

    # ── DELIVERABLES ──────────────────────────────────────────────────────
    md.append("## 📦 Entregables\n")
    if fmt in ("short_video", "reel_baile", "long_video"):
        md.append("- [ ] Video master (formato red) en MP4 H.264")
        md.append("- [ ] Versión vertical 9:16 si principal es horizontal (siempre tener ambas)")
        md.append("- [ ] Thumbnail/cover si video largo")
        md.append("- [ ] Subtítulos burnt-in en español")
        md.append("- [ ] Caption sugerida + 3 variantes")
    elif fmt == "carrusel_imgs":
        md.append("- [ ] 5-10 slides en formato 1:1 o 4:5")
        md.append("- [ ] Versión .PNG y .JPG")
        md.append("- [ ] Caption + 3 variantes")
    elif fmt == "single_image":
        md.append("- [ ] Imagen master (formato red)")
        md.append("- [ ] Versión variantes A/B (2-3)")
        md.append("- [ ] Caption + 3 variantes")
    else:
        md.append("- [ ] Asset principal según formato")
        md.append("- [ ] Caption + 3 variantes")
    md.append("")

    # ── DEADLINE ──────────────────────────────────────────────────────────
    md.append(f"## 📅 Deadline\n")
    md.append(f"**Entrega esperada:** {deadline} (48h)")
    md.append(f"**Publicación target:** dentro de los siguientes 5 días\n")

    # ── KPIs A MEDIR ──────────────────────────────────────────────────────
    md.append("## 📊 KPIs a medir post-publicación\n")
    md.append(f"- Engagement rate vs baseline marca (target: ≥ {(competitor_avg * 0.8):.4f})")
    md.append("- Velocity primer 2h (likes/h)")
    md.append("- Sentiment de comments primeras 24h")
    md.append("- Saves + shares ratio (indicador de valor real)")
    md.append("")

    md.append("---")
    md.append(f"*Brief generado · AI Smart Content · v1*")

    return "\n".join(md)
