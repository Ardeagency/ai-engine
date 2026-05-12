/**
 * facebook.populator.js
 *
 * Populator de Meta (Facebook Pages + Instagram + Marketing API).
 * Cubre la simbiosis de campañas y audiencias:
 *
 *   facebook_initial_bootstrap
 *     ├─ facebook_sync_ad_accounts       → metadata.ad_accounts
 *     ├─ facebook_sync_campaigns         → campaigns table (con métricas)
 *     ├─ facebook_sync_custom_audiences  → audience_segments table
 *     └─ vera_link_segments_to_personas  → AI: linkear segments huérfanos
 *
 * NOTA: el sync de pages/posts/insights ORGÁNICO sigue viviendo en
 * `api-brand-sync-meta.js` (Netlify function disparada manualmente o por
 * webhook). El populator sólo cubre Marketing API (paid).
 */
import { BasePopulator } from "./base.populator.js";
import { supabase } from "../../lib/supabase.js";

const META_GRAPH_VERSION = process.env.META_GRAPH_VERSION || "v22.0";
const APP_SECRET = () => process.env.META_APP_SECRET || "";
// appsecret_proof se incluye SOLO si el secret del ai-engine matchea el del
// app que generó el token. Por defecto: skip — Meta no lo requiere si la
// config del app no tiene "Require App Secret". Si la org lo necesita, set
// META_REQUIRE_APPSECRET_PROOF=true en .env.
const REQUIRE_APPSECRET_PROOF = String(process.env.META_REQUIRE_APPSECRET_PROOF || "").toLowerCase() === "true";

// ── Helper Meta Graph ──────────────────────────────────────────────────────

async function metaFetch(path, token, params = {}) {
  const url = new URL(`https://graph.facebook.com/${META_GRAPH_VERSION}${path}`);
  url.searchParams.set("access_token", token);
  if (REQUIRE_APPSECRET_PROOF && APP_SECRET()) {
    const crypto = await import("node:crypto");
    const proof = crypto.createHmac("sha256", APP_SECRET()).update(token).digest("hex");
    url.searchParams.set("appsecret_proof", proof);
  }
  for (const [k, v] of Object.entries(params)) {
    if (v != null) url.searchParams.set(k, String(v));
  }
  const res = await fetch(url.toString());
  const json = await res.json().catch(() => ({}));
  if (!res.ok || json?.error) {
    const msg = json?.error?.message || JSON.stringify(json?.error || json).slice(0, 300);
    const err = new Error(`Meta Graph ${res.status}: ${msg}`);
    err.metaCode = json?.error?.code;
    err.metaSubcode = json?.error?.error_subcode;
    throw err;
  }
  return json;
}

async function metaFetchPaged(path, token, params = {}, maxPages = 20) {
  const items = [];
  let next = null;
  let pages = 0;
  let firstResp = await metaFetch(path, token, params);
  items.push(...(firstResp.data || []));
  next = firstResp.paging?.next || null;
  pages = 1;
  while (next && pages < maxPages) {
    const res = await fetch(next);
    const json = await res.json().catch(() => ({}));
    if (!res.ok || json?.error) break;
    items.push(...(json.data || []));
    next = json.paging?.next || null;
    pages++;
  }
  return { items, pages, truncated: !!next };
}

// ── Populator ──────────────────────────────────────────────────────────────

export class FacebookPopulator extends BasePopulator {
  constructor() { super("facebook"); }

  subjobSequence() {
    return [
      "facebook_sync_ad_accounts",
      "facebook_sync_campaigns",
      "facebook_sync_custom_audiences",
      "vera_link_segments_to_personas",
    ];
  }

  dispatch(missionType) {
    const map = {
      facebook_sync_ad_accounts:       this.syncAdAccounts,
      facebook_sync_campaigns:         this.syncCampaigns,
      facebook_sync_custom_audiences:  this.syncCustomAudiences,
      vera_link_segments_to_personas:  this.linkSegmentsToPersonas,
    };
    return map[missionType] || null;
  }

  async bootstrap(job) {
    const { brand_integration_id, brand_container_id } = job.payload || {};
    if (!brand_integration_id) throw new Error("Missing brand_integration_id");
    if (!brand_container_id)   throw new Error("Missing brand_container_id");

    await supabase
      .from("brand_integrations")
      .update({ bootstrap_status: "running", bootstrap_started_at: new Date().toISOString() })
      .eq("id", brand_integration_id);

    return this.enqueueSubjobs(job, { spacingMs: 20_000 });
  }

  // ── 1. Ad accounts (FILTRADO por business de pages concedidas) ──────────
  // CRÍTICO: /me/adaccounts devuelve TODAS las cuentas que el user puede ver
  // (incluyendo otras marcas que el user maneja como agency). Solo debemos
  // sincronizar las cuentas que pertenecen al MISMO business que la(s) page(s)
  // que el usuario explícitamente conectó.

  async syncAdAccounts(job) {
    const { brand_integration_id } = job.payload;
    const integ = await this.getIntegration(brand_integration_id);

    const grantedPages = Array.isArray(integ.metadata?.pages) ? integ.metadata.pages : [];
    if (grantedPages.length === 0) {
      // Sin pages concedidas, no hay scope para inferir qué cuentas son legítimas
      // → no sincronizar nada (privacy by default).
      const newMeta = {
        ...(integ.metadata || {}),
        ad_accounts: [],
        ad_accounts_synced_at: new Date().toISOString(),
        ad_accounts_filter_note: "no_granted_pages_in_metadata",
      };
      await supabase.from("brand_integrations")
        .update({ metadata: newMeta, last_sync_at: new Date().toISOString() })
        .eq("id", brand_integration_id);
      return { ok: true, ad_accounts_count: 0, status: "no_granted_pages" };
    }

    // Resolver business owner de cada page concedida
    const grantedBusinessIds = new Set();
    const pageToBusiness = {};
    for (const page of grantedPages) {
      try {
        const resp = await metaFetch(`/${page.id}`, integ.access_token, {
          fields: "id,name,business{id,name}"
        });
        if (resp?.business?.id) {
          grantedBusinessIds.add(resp.business.id);
          pageToBusiness[page.id] = resp.business;
        } else {
          // Page sin business (personal/standalone) → no tiene ad accounts asociadas
          pageToBusiness[page.id] = null;
        }
      } catch (e) {
        console.warn(`facebook-populator: page ${page.id} business lookup failed:`, e?.message);
      }
    }

    // Para cada business concedido: traer sus owned_ad_accounts + client_ad_accounts
    const allowedAccounts = []; // [{id, account_id, name, currency, ..., business, source}]
    const seenAccountIds = new Set();

    for (const businessId of grantedBusinessIds) {
      for (const relType of ["owned_ad_accounts", "client_ad_accounts"]) {
        try {
          const { items } = await metaFetchPaged(
            `/${businessId}/${relType}`, integ.access_token,
            { fields: "id,account_id,name,currency,account_status,timezone_name", limit: 50 },
            3
          );
          for (const acct of items) {
            if (seenAccountIds.has(acct.id)) continue;
            seenAccountIds.add(acct.id);
            allowedAccounts.push({
              id:             acct.id,
              account_id:     acct.account_id,
              name:           acct.name,
              currency:       acct.currency,
              account_status: acct.account_status,
              timezone_name:  acct.timezone_name,
              business:       { id: businessId, source: relType },
            });
          }
        } catch (e) {
          console.warn(`facebook-populator: business ${businessId} ${relType} failed:`, e?.message);
        }
      }
    }

    const newMeta = {
      ...(integ.metadata || {}),
      ad_accounts: allowedAccounts,
      ad_accounts_synced_at: new Date().toISOString(),
      granted_business_ids:   Array.from(grantedBusinessIds),
      ad_accounts_filter_note: `filtered_by_business_of_${grantedPages.length}_granted_pages`,
    };

    await supabase
      .from("brand_integrations")
      .update({ metadata: newMeta, last_sync_at: new Date().toISOString() })
      .eq("id", brand_integration_id);

    return {
      ok: true,
      ad_accounts_count:    allowedAccounts.length,
      granted_pages:        grantedPages.length,
      granted_businesses:   grantedBusinessIds.size,
    };
  }

  // ── 2. Campaigns (todas las cuentas de ads, paginado) ───────────────────

  async syncCampaigns(job) {
    const { brand_integration_id } = job.payload;
    const integ = await this.getIntegration(brand_integration_id);
    const adAccounts = integ.metadata?.ad_accounts || [];

    if (adAccounts.length === 0) {
      return { ok: true, status: "no_ad_accounts", note: "Ejecuta facebook_sync_ad_accounts primero" };
    }

    const stats = { campaigns_pulled: 0, campaigns_upserted: 0, errors: 0 };

    for (const acct of adAccounts) {
      try {
        // Trae campaigns con insights last_30d (un solo call con field expansion)
        const fields = [
          "id", "name", "status", "objective", "daily_budget", "lifetime_budget",
          "budget_remaining", "start_time", "stop_time", "configured_status", "effective_status",
          "buying_type", "bid_strategy",
          // Inline insights (cost-effective). Si la cuenta no tiene insights el campo viene vacío.
          "insights.date_preset(last_30d){impressions,reach,clicks,spend,ctr,cpc,cpm,actions}",
        ].join(",");

        const { items: camps } = await metaFetchPaged(
          `/${acct.id}/campaigns`, integ.access_token,
          { fields, limit: 100 }, 10
        );
        stats.campaigns_pulled += camps.length;

        for (const c of camps) {
          try {
            const insights = c.insights?.data?.[0] || {};
            const conversions = (insights.actions || [])
              .filter(a => a.action_type && /purchase|complete_registration|lead/i.test(a.action_type))
              .reduce((sum, a) => sum + (Number(a.value) || 0), 0);

            const dailyBudget = c.daily_budget != null ? Number(c.daily_budget) / 100 : null;
            const lifetimeBudget = c.lifetime_budget != null ? Number(c.lifetime_budget) / 100 : null;

            await this.upsertCanonicalCampaign({
              normalized: {
                external_id:         c.id,
                external_name:       c.name,
                external_account_id: acct.account_id,
                status:              c.effective_status || c.status,
                platform_objective:  c.objective,
                budget_daily:        dailyBudget,
                budget_total:        lifetimeBudget,
                budget_currency:     acct.currency || null,
                starts_at:           c.start_time || null,
                ends_at:             c.stop_time || null,
                cached: {
                  impressions:  Number(insights.impressions) || null,
                  clicks:       Number(insights.clicks) || null,
                  spend:        Number(insights.spend) || null,
                  ctr:          Number(insights.ctr) || null,
                  conversions:  conversions || null,
                },
                metadata: {
                  buying_type:        c.buying_type || null,
                  bid_strategy:       c.bid_strategy || null,
                  configured_status:  c.configured_status || null,
                  ad_account_name:    acct.name || null,
                  ad_account_id:      acct.account_id || null,
                  business_name:      acct.business?.name || null,
                },
              },
              integration: integ,
            });
            stats.campaigns_upserted++;
          } catch (e) {
            stats.errors++;
            console.error(`facebook-populator: campaign ${c.id} failed:`, e?.message);
          }
        }
      } catch (e) {
        stats.errors++;
        console.error(`facebook-populator: ad account ${acct.id} campaigns fetch failed:`, e?.message);
      }
    }

    return { ok: true, ...stats, ad_accounts_processed: adAccounts.length };
  }

  // ── 3. Custom Audiences ─────────────────────────────────────────────────

  async syncCustomAudiences(job) {
    const { brand_integration_id } = job.payload;
    const integ = await this.getIntegration(brand_integration_id);
    const adAccounts = integ.metadata?.ad_accounts || [];

    if (adAccounts.length === 0) {
      return { ok: true, status: "no_ad_accounts" };
    }

    const stats = { audiences_pulled: 0, audiences_upserted: 0, persona_linked: 0, errors: 0 };

    for (const acct of adAccounts) {
      try {
        const fields = [
          "id", "name", "subtype", "approximate_count_lower_bound", "approximate_count_upper_bound",
          "delivery_status", "operation_status", "rule", "data_source", "description",
          "time_created", "time_updated",
        ].join(",");

        const { items: auds } = await metaFetchPaged(
          `/${acct.id}/customaudiences`, integ.access_token,
          { fields, limit: 100 }, 10
        );
        stats.audiences_pulled += auds.length;

        for (const a of auds) {
          try {
            const lower = Number(a.approximate_count_lower_bound) || null;
            const upper = Number(a.approximate_count_upper_bound) || null;
            const estimated = lower && upper ? Math.round((lower + upper) / 2) : (upper || lower || null);

            const { persona_linked } = await this.upsertCanonicalAudienceSegment({
              normalized: {
                external_id:        a.id,
                external_name:      a.name,
                external_type:      a.subtype || null,
                status:             a.delivery_status?.code === 200 ? "active" : (a.operation_status?.description || "unknown"),
                size_lower_bound:   lower,
                size_upper_bound:   upper,
                estimated_size:     estimated,
                custom_params: {
                  rule:        a.rule || null,
                  data_source: a.data_source || null,
                  description: a.description || null,
                  ad_account_id: acct.account_id || null,
                  time_created: a.time_created ? new Date(Number(a.time_created) * 1000).toISOString() : null,
                  time_updated: a.time_updated ? new Date(Number(a.time_updated) * 1000).toISOString() : null,
                },
              },
              integration: integ,
            });
            stats.audiences_upserted++;
            if (persona_linked) stats.persona_linked++;
          } catch (e) {
            stats.errors++;
            console.error(`facebook-populator: audience ${a.id} failed:`, e?.message);
          }
        }
      } catch (e) {
        stats.errors++;
        console.error(`facebook-populator: ad account ${acct.id} audiences fetch failed:`, e?.message);
      }
    }

    return { ok: true, ...stats };
  }

  // ── 4. AI: linkear segments huérfanos a personas ────────────────────────

  async linkSegmentsToPersonas(job) {
    const { brand_container_id, brand_integration_id } = job.payload;

    const { data: orphans } = await supabase
      .from("audience_segments")
      .select("id, external_audience_name, external_audience_type, age_range, genders, interests, behaviors, locations, custom_params")
      .eq("brand_container_id", brand_container_id)
      .is("persona_id", null);

    if (!orphans || orphans.length === 0) {
      // Marca bootstrap completed (este es el último subjob)
      await supabase
        .from("brand_integrations")
        .update({ bootstrap_status: "completed", bootstrap_completed_at: new Date().toISOString() })
        .eq("id", brand_integration_id);
      return { ok: true, status: "no_orphans" };
    }

    const { data: personas } = await supabase
      .from("audience_personas")
      .select("id, name, description, awareness_level, datos_demograficos, datos_psicograficos, dolores, deseos, gatillos_compra")
      .eq("brand_container_id", brand_container_id);

    if (!personas || personas.length === 0) {
      // No hay personas conceptuales todavía → encolar síntesis (futuro: vera_synthesize_persona_from_segments)
      await supabase
        .from("brand_integrations")
        .update({ bootstrap_status: "completed", bootstrap_completed_at: new Date().toISOString() })
        .eq("id", brand_integration_id);
      return { ok: true, status: "no_personas_to_link", orphans: orphans.length };
    }

    // Llamada AI para sugerir mapeo segment → persona
    const prompt = JSON.stringify({
      personas: personas.map(p => ({
        id: p.id, name: p.name,
        description: (p.description || "").slice(0, 300),
        awareness: p.awareness_level,
        demograficos: p.datos_demograficos?.slice(0, 5) || [],
        dolores: p.dolores?.slice(0, 5) || [],
      })),
      segments: orphans.slice(0, 30).map(s => ({
        id: s.id,
        name: s.external_audience_name,
        type: s.external_audience_type,
        age_range: s.age_range,
        genders: s.genders,
        interests: Array.isArray(s.interests) ? s.interests.slice(0, 10) : null,
      })),
    }, null, 2);

    const sys = `Eres un marketing analyst. Dado un set de personas conceptuales y un set de segments reales (Meta Custom Audiences), asigna cada segment a la persona conceptual que MEJOR matchee, basándote en demografía, intereses y nombre del segment. Si ninguna persona matchea con confianza alta, devuelve persona_id=null. Output ESTRICTAMENTE JSON: {"links":[{"segment_id":"...","persona_id":"..."|null,"confidence":0.0-1.0,"reason":"..."}]}.`;

    let mapping;
    try {
      const apiKey = process.env.ANTHROPIC_API_KEY;
      const res = await fetch("https://api.anthropic.com/v1/messages", {
        method: "POST",
        headers: { "x-api-key": apiKey, "anthropic-version": "2023-06-01", "content-type": "application/json" },
        body: JSON.stringify({
          model: "claude-haiku-4-5-20251001",
          max_tokens: 2048,
          system: sys,
          messages: [{ role: "user", content: prompt }],
        }),
      });
      const json = await res.json();
      const text = (json?.content?.[0]?.text || "").replace(/^```json?/i, "").replace(/```$/g, "").trim();
      mapping = JSON.parse(text);
    } catch (e) {
      // No fallar el bootstrap por esto — los segments simplemente quedan sin persona linked
      console.warn("vera_link_segments_to_personas: AI failed:", e?.message);
      mapping = { links: [] };
    }

    let linked = 0;
    for (const link of (mapping.links || [])) {
      if (!link.persona_id || !link.segment_id) continue;
      if ((link.confidence || 0) < 0.6) continue;
      const { error } = await supabase
        .from("audience_segments")
        .update({ persona_id: link.persona_id, updated_at: new Date().toISOString() })
        .eq("id", link.segment_id);
      if (!error) linked++;
    }

    // Marcar bootstrap completed
    await supabase
      .from("brand_integrations")
      .update({ bootstrap_status: "completed", bootstrap_completed_at: new Date().toISOString() })
      .eq("id", brand_integration_id);

    return { ok: true, orphans_processed: orphans.length, linked, ai_attempts: mapping.links?.length || 0 };
  }
}
