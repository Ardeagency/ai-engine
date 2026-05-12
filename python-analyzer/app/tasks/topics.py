"""Topics / keywords extraction usando KeyBERT con multilingual MiniLM."""
from keybert import KeyBERT
from sentence_transformers import SentenceTransformer

# MiniLM multilingual: ~470MB, ~50ms por inferencia en CPU
_model = None
_kw = None

def _ensure():
    global _model, _kw
    if _kw is None:
        _model = SentenceTransformer("paraphrase-multilingual-MiniLM-L12-v2")
        _kw = KeyBERT(model=_model)
    return _kw

def extract_topics(text: str, top_n: int = 5) -> list[dict]:
    """
    Devuelve [{kw, score}, ...] — keywords semánticamente más relevantes al contenido.
    Funciona ES/EN/PT (multilingual).
    """
    if not text or len(text.strip()) < 10:
        return []
    kw = _ensure()
    pairs = kw.extract_keywords(
        text[:2000],
        keyphrase_ngram_range=(1, 2),
        stop_words=None,
        use_maxsum=False,
        diversity=0.5,
        top_n=top_n,
    )
    return [{"kw": k, "score": round(float(s), 4)} for k, s in pairs]
