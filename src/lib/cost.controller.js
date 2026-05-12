/**
 * Cost Controller — gestiona créditos por request y límites de herramientas.
 *
 * Por request:
 *   - Registra cuántas tool calls se ejecutaron
 *   - Descuenta créditos de la tabla organization_credits (safe contra race conditions)
 *   - Aplica límites per-round (maxToolsPerRound) y por sesión
 */
import { supabase } from "./supabase.js";

export const TOOL_LIMITS = {
  maxToolsPerRound:   20,
  maxToolIterations:  12,
  maxToolsPerRequest: 60,
};

export class CostController {
  constructor({ organizationId, userId, conversationId }) {
    this.organizationId  = organizationId;
    this.userId          = userId;
    this.conversationId  = conversationId;
    this._toolCallCount  = 0;
    this._creditsDeducted = 0;
    this._startedAt      = Date.now();
  }

  checkToolRoundLimit(count) {
    if (count > TOOL_LIMITS.maxToolsPerRound) {
      throw Object.assign(
        new Error(`Límite de herramientas por ronda alcanzado (máx ${TOOL_LIMITS.maxToolsPerRound})`),
        { isBudgetError: true }
      );
    }
  }

  recordToolCalls(count) {
    this._toolCallCount += count;
    if (this._toolCallCount > TOOL_LIMITS.maxToolsPerRequest) {
      throw Object.assign(
        new Error(`Límite de herramientas por request alcanzado (máx ${TOOL_LIMITS.maxToolsPerRequest})`),
        { isBudgetError: true }
      );
    }
  }

  async deductCredits(creditCost) {
    if (!creditCost || creditCost <= 0) return;

    const { data: credits, error: fetchErr } = await supabase
      .from("organization_credits")
      .select("credits_available")
      .eq("organization_id", this.organizationId)
      .maybeSingle();

    if (fetchErr) {
      console.warn("cost.controller: error fetching credits:", fetchErr.message);
      return;
    }

    if (!credits || credits.credits_available < creditCost) {
      const err = new Error("Créditos insuficientes para ejecutar esta acción.");
      err.statusCode = 402;
      throw err;
    }

    // UPDATE condicional con .gte() para evitar race conditions
    const { data: updated, error: updateErr } = await supabase
      .from("organization_credits")
      .update({
        credits_available: credits.credits_available - creditCost,
        updated_at: new Date().toISOString(),
      })
      .eq("organization_id", this.organizationId)
      .gte("credits_available", creditCost)
      .select("credits_available")
      .maybeSingle();

    if (updateErr) {
      console.warn("cost.controller: error updating credits:", updateErr.message);
      return;
    }

    if (!updated) {
      const err = new Error("Créditos insuficientes (race condition detectada).");
      err.statusCode = 402;
      throw err;
    }

    this._creditsDeducted += creditCost;
  }

  summary() {
    return {
      toolCallCount:    this._toolCallCount,
      creditsDeducted:  this._creditsDeducted,
      durationMs:       Date.now() - this._startedAt,
    };
  }
}
