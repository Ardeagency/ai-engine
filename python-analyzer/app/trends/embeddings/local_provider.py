"""Local sentence-transformers (Fase 4 — placeholder).

Fallback gratuito si OpenAI no está disponible.
"""
from __future__ import annotations


class LocalEmbeddingProvider:
    model = "sentence-transformers/paraphrase-multilingual-MiniLM-L12-v2"

    def embed(self, text: str) -> list[float]:
        raise NotImplementedError("LocalEmbeddingProvider pendiente — Fase 4")

    def embed_batch(self, texts: list[str]) -> list[list[float]]:
        raise NotImplementedError("LocalEmbeddingProvider pendiente — Fase 4")
