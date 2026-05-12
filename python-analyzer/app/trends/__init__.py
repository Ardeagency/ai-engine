"""Trends Engine — pipeline de descubrimiento de oportunidades de mercado.

Estructura del pipeline (5 etapas):
  1. query_generator — compone queries dinámicas desde data de la marca
  2. collectors      — ejecuta queries contra APIs externas (con cache)
  3. normalizer      — filtros duros sin IA (frescura, volumen, prohibidas, geo)
  4. scorer          — ranking semántico con embeddings (sin LLM generativo)
  5. brief_generator — única llamada LLM (VERA) que produce briefs accionables

Punto de entrada: orchestrator.run_cycle(brand_container_id).

Ref: trends-engine-blueprint.
"""
