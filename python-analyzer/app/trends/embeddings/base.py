"""Protocol abstracto para embedding providers.

Implementaciones intercambiables (Fase 4):
  - OpenAIEmbeddingProvider (text-embedding-3-small)
  - LocalEmbeddingProvider (sentence-transformers en Hetzner)
"""
from __future__ import annotations
from typing import Protocol


class EmbeddingProvider(Protocol):
    def embed(self, text: str) -> list[float]: ...
    def embed_batch(self, texts: list[str]) -> list[list[float]]: ...
