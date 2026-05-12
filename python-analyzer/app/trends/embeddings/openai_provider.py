"""OpenAI text-embedding-3-small (Fase 4).

API: POST https://api.openai.com/v1/embeddings
Pricing: $0.020 per 1M tokens (≈$0.00002 per 1k tokens). Costo trivial.
Memoria: feedback_embeddings_sancionados — OK para background.
credit_kind: 'embedding_call'.
"""
from __future__ import annotations
import logging
import os

import httpx

OPENAI_API_KEY = os.environ.get("OPENAI_API_KEY", "")
OPENAI_EMBEDDINGS_URL = "https://api.openai.com/v1/embeddings"

log = logging.getLogger(__name__)

# $0.020 / 1M tokens ≈ $2e-8 per token. Aproximamos por chars/4.
COST_USD_PER_1K_TOKENS = 0.00002


def _estimate_tokens(texts: list[str]) -> int:
    return max(1, sum(max(1, len(t) // 4) for t in texts))


class OpenAIEmbeddingProvider:
    model = "text-embedding-3-small"
    dim = 1536

    def __init__(self, model: str | None = None) -> None:
        if model:
            self.model = model
        self._last_cost_usd = 0.0
        self._last_tokens = 0

    @property
    def last_cost_usd(self) -> float:
        return self._last_cost_usd

    async def embed_async(self, text: str) -> list[float]:
        out = await self.embed_batch_async([text])
        return out[0] if out else []

    async def embed_batch_async(self, texts: list[str]) -> list[list[float]]:
        if not texts:
            return []
        if not OPENAI_API_KEY:
            log.warning("OPENAI_API_KEY not set — returning zero vectors")
            return [[0.0] * self.dim for _ in texts]

        # OpenAI accepts up to 2048 inputs per call. Trimemos y batcheamos.
        BATCH = 256
        results: list[list[float]] = []
        total_tokens = 0
        for i in range(0, len(texts), BATCH):
            chunk = [t[:8000] for t in texts[i:i + BATCH]]
            payload = {"model": self.model, "input": chunk}
            headers = {"Authorization": f"Bearer {OPENAI_API_KEY}",
                       "Content-Type": "application/json"}
            async with httpx.AsyncClient(timeout=30) as cli:
                r = await cli.post(OPENAI_EMBEDDINGS_URL,
                                    json=payload, headers=headers)
            if r.status_code != 200:
                log.warning("openai embeddings failed status=%d body=%s",
                            r.status_code, r.text[:200])
                results.extend([[0.0] * self.dim for _ in chunk])
                continue
            data = r.json()
            results.extend([d["embedding"] for d in data.get("data", [])])
            usage = data.get("usage") or {}
            total_tokens += int(usage.get("total_tokens") or _estimate_tokens(chunk))

        self._last_tokens = total_tokens
        self._last_cost_usd = (total_tokens / 1000.0) * COST_USD_PER_1K_TOKENS
        return results

    def embed(self, text: str) -> list[float]:
        import asyncio
        return asyncio.run(self.embed_async(text))

    def embed_batch(self, texts: list[str]) -> list[list[float]]:
        import asyncio
        return asyncio.run(self.embed_batch_async(texts))
