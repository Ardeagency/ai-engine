/**
 * Content Lexicon — diccionarios para análisis sin LLM.
 *
 * Cada lexicon mapea categoría → keywords (incluye español e inglés).
 * Las claves son las que se persisten en brand_content_analysis (deben coincidir
 * con los CHECK constraints o las opciones aceptadas por la UI).
 */

// ── Tonos ────────────────────────────────────────────────────────────────────
export const TONE_LEXICON = {
  inspirador:    ["sueño", "soñar", "lograr", "creer", "alcanzar", "imposible", "transformar", "valiente", "atrevete", "atrévete", "inspire", "dream", "achieve", "believe", "transform"],
  educativo:     ["aprende", "aprender", "tutorial", "guía", "guia", "cómo", "como", "tips", "consejo", "consejos", "paso", "pasos", "explicar", "guide", "how to", "lesson"],
  entretenimiento: ["jaja", "jeje", "lol", "diversión", "diversion", "broma", "humor", "risa", "fun", "funny", "joke", "haha"],
  urgencia:      ["ahora", "ya", "última", "ultima", "termina", "rápido", "rapido", "no te lo pierdas", "limitado", "pocas", "agotando", "hurry", "limited", "last chance", "now", "today only", "ending"],
  comunidad:     ["nosotros", "juntos", "familia", "amigos", "compartir", "compartimos", "we", "together", "family", "share", "us", "community"],
  aspiracional:  ["lujo", "exclusivo", "exclusiva", "premium", "alta gama", "elegante", "elite", "luxury", "exclusive", "high-end", "elite"],
  emocional:     ["amor", "corazón", "corazon", "siento", "querida", "querido", "love", "heart", "feel", "miss", "extraño"],
  informativo:   ["dato", "datos", "estadística", "estadistica", "estudio", "investigación", "investigacion", "porcentaje", "data", "statistic", "research", "study", "report"],
};

// ── Emociones (keywords + emojis con peso) ──────────────────────────────────
export const EMOTION_LEXICON = {
  alegría:    { keywords: ["feliz", "felicidad", "alegría", "alegria", "happy", "joy", "celebrar"], emojis: ["😀", "😃", "😄", "😁", "🤣", "😂", "😊", "🎉", "🥳", "✨"] },
  orgullo:    { keywords: ["orgulloso", "orgullosa", "logramos", "logros", "proud", "achievement", "champion"], emojis: ["🏆", "👏", "💪", "🦁", "🥇"] },
  nostalgia:  { keywords: ["recuerdo", "recordar", "antes", "throwback", "tbt", "memory", "nostalgia"], emojis: ["📸", "💭", "📷"] },
  emoción:    { keywords: ["emocionado", "emocionada", "increíble", "increible", "wow", "excited", "amazing", "incredible"], emojis: ["🤩", "😍", "⭐", "💫", "🌟"] },
  confianza:  { keywords: ["confianza", "garantizado", "garantizada", "seguro", "trust", "guaranteed", "reliable"], emojis: ["✅", "🛡️", "👌"] },
  curiosidad: { keywords: ["sabías", "sabias", "curioso", "curiosa", "did you know", "curious", "wonder"], emojis: ["🤔", "❓", "💡"] },
  pertenencia: { keywords: ["pertenecer", "comunidad", "tribu", "belong", "community", "tribe"], emojis: ["🤝", "🫂", "🤗"] },
  motivación: { keywords: ["vamos", "tu puedes", "tú puedes", "you can", "motivación", "motivacion", "let's go", "go for it"], emojis: ["🚀", "🔥", "⚡", "💯"] },
};

// ── Pilares narrativos ───────────────────────────────────────────────────────
export const PILLAR_LEXICON = {
  Producto:           ["producto", "lanzamiento", "lanzar", "lanzamos", "nuevo", "nueva", "disponible", "edición", "edicion", "stock", "product", "launch", "available", "drop", "release"],
  Comunidad:          ["nosotros", "juntos", "familia", "comunidad", "tribu", "amigos", "we", "together", "community", "tribe", "us"],
  Lifestyle:          ["estilo de vida", "rutina", "día a día", "dia a dia", "outfit", "lifestyle", "routine", "daily"],
  "Behind the Scenes": ["detrás de", "detras de", "behind the scenes", "bts", "proceso", "making of", "tras bambalinas"],
  Colaboración:       ["colaboración", "colaboracion", "collab", " x ", "feat.", "partner", "collaboration", "partnership"],
  "Logro deportivo":  ["ganamos", "récord", "record", "campeón", "campeona", "podio", "win", "victory", "champion"],
  Sostenibilidad:    ["sostenible", "sostenibilidad", "eco", "verde", "reciclado", "sustainable", "green", "recycled", "eco-friendly"],
  "Historia de marca": ["historia", "fundamos", "origen", "1985", "1990", "founded", "story", "heritage", "legacy"],
  Entretenimiento:   ["humor", "diversion", "diversión", "entretenido", "entertainment", "fun"],
  Educación:         ["aprende", "tutorial", "tip", "tips", "lesson", "learn", "guide"],
};

// ── Sentiment lexicon (para sentiment jsonb, no lo usa brand_content_analysis pero útil para brand_posts.sentiment) ──
export const POSITIVE_WORDS = new Set([
  "increíble", "increible", "excelente", "fantástico", "fantastico", "amor", "encanta", "perfecto", "espectacular",
  "amazing", "excellent", "fantastic", "love", "perfect", "incredible", "awesome", "great", "best", "wonderful",
  "happy", "feliz", "genial", "maravilloso", "exitoso",
]);
export const NEGATIVE_WORDS = new Set([
  "horrible", "terrible", "pésimo", "pesimo", "malo", "decepcionante", "lento", "caro", "feo",
  "awful", "terrible", "bad", "worst", "disappointing", "slow", "expensive", "ugly", "broken", "useless",
]);

// ── Stopwords (multi-idioma, compartido con persistTrendTopics) ──────────────
export const STOPWORDS = new Set([
  "para","como","este","esta","esto","pero","también","tambien","desde","hasta","sobre",
  "entre","cada","todo","toda","todos","todas","cuando","donde","porque","aunque",
  "una","unas","unos","con","sin","del","los","las","que","los","les","sus","sus","con","por",
  "muy","mas","más","ser","son","por","nos","les","una","tan","sólo","solo","aun","aún","ese","esa",
  "what","that","this","with","from","have","will","your","more","they","their","than","then",
  "there","which","about","after","would","could","should","these","those","been","were","into",
  "just","only","very","some","also","such","when","where","because","while","through",
  "the","and","for","you","not","but","are","was","has","had","its","our","out","get",
]);

// ── CTA implícito (verbos imperativos) ───────────────────────────────────────
export const CTA_PATTERNS = [
  { regex: /\b(compra|comprar|adquiere|adquiri[sr])\b/i,        label: "comprar" },
  { regex: /\b(descubre|conoce|explora)\b/i,                     label: "descubrir" },
  { regex: /\b(reserva|agenda|book|reservar)\b/i,                label: "reservar" },
  { regex: /\b(suscribe|sigue|síguenos|sigueme|follow)\b/i,      label: "seguir" },
  { regex: /\b(compart[ei]|share|tag|etiqueta)\b/i,              label: "compartir" },
  { regex: /\b(comenta|comentanos|deja tu comentario|comment)\b/i, label: "comentar" },
  { regex: /\b(visita|visit|entra a)\b/i,                        label: "visitar" },
  { regex: /\b(descarga|download)\b/i,                           label: "descargar" },
  { regex: /\b(prueba|try|test)\b/i,                             label: "probar" },
  { regex: /\b(participa|join|unete|únete|inscríbete|inscribete)\b/i, label: "participar" },
];
