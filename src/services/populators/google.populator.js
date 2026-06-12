/**
 * google.populator.js — Consumer de Google Ads (multi-tenant).
 *
 * Bootstrap del cliente conectado por OAuth (scope adwords):
 *   listAccessibleCustomers → por cada cuenta NO-manager, GAQL de campanas +
 *   metricas (ultimos 30d) → base.upsertCanonicalCampaign (tabla canonica
 *   `campaigns`, misma que usa Meta).
 *
 * El token de 1h y el Developer Token los maneja googleads-rest.
 * Keywords/optimizacion (write gateado por "actualizar") es fase posterior;
 * aqui el foco es traer la data para que Vera analice y proponga.
 */
import { BasePopulator } from "./base.populator.js";
import { supabase } from "../../lib/supabase.js";
import { listAccessibleCustomers, searchStream } from "../../lib/googleads-rest.js";

const CAMPAIGN_GAQL = `
  SELECT
    customer.currency_code,
    campaign.id, campaign.name, campaign.status,
    campaign.advertising_channel_type,
    campaign.start_date, campaign.end_date,
    campaign_budget.amount_micros,
    metrics.impressions, metrics.clicks, metrics.cost_micros,
    metrics.conversions, metrics.ctr, metrics.average_cpc
  FROM campaign
  WHERE segments.date DURING LAST_30_DAYS
`.trim();

export class GooglePopulator extends BasePopulator {
  constructor() { super("google"); }

  subjobSequence() {
    return ["google_sync_campaigns", "vera_propose_priority_actions"];
  }

  dispatch(missionType) {
    if (missionType === "google_sync_campaigns")        return this.syncCampaigns;
    if (missionType === "vera_propose_priority_actions") return this.finishBootstrap;
    return null;
  }

  async bootstrap(job) {
    const { brand_integration_id, brand_container_id } = job.payload || {};
    if (!brand_integration_id) throw new Error("Missing brand_integration_id");
    if (!brand_container_id)   throw new Error("Missing brand_container_id");

    const { data: cur } = await supabase
      .from("brand_integrations").select("metadata").eq("id", brand_integration_id).maybeSingle();

    await supabase
      .from("brand_integrations")
      .update({
        bootstrap_status:     "running",
        bootstrap_started_at: new Date().toISOString(),
        metadata:             { ...(cur?.metadata || {}), populator_status: "running" },
      })
      .eq("id", brand_integration_id);

    return this.enqueueSubjobs(job);
  }

  async syncCampaigns(job) {
    const { brand_integration_id } = job.payload;
    const integ = await this.getIntegration(brand_integration_id);

    const tops = await listAccessibleCustomers(integ);
    const stats = {
      top_level: tops.length, leaf_accounts: 0, accounts_with_data: 0,
      campaigns_upserted: 0, skipped: 0, errors: 0,
    };

    // Expandir jerarquia MCC: listAccessibleCustomers solo da los top-level
    // (suelen ser MCCs). Por cada uno, customer_client revela las cuentas hoja
    // no-manager (las que tienen campanas). Al consultar una hoja, el
    // login-customer-id debe ser su MCC de nivel superior.
    const leaves = new Map(); // leafCustomerId -> loginCustomerId (MCC top)
    for (const top of tops) {
      try {
        const clients = await searchStream(integ, top,
          "SELECT customer_client.id, customer_client.manager FROM customer_client",
          { loginCustomerId: top });
        for (const r of clients) {
          const cc = r.customerClient || {};
          if (cc.manager === false && cc.id && !leaves.has(String(cc.id))) {
            leaves.set(String(cc.id), top);
          }
        }
      } catch (e) {
        stats.skipped++;
        console.warn(`google-populator: cannot expand ${top}:`, e?.message?.slice(0, 140));
      }
    }
    stats.leaf_accounts = leaves.size;

    for (const [customerId, loginId] of leaves) {
      let rows = [];
      try {
        rows = await searchStream(integ, customerId, CAMPAIGN_GAQL, { loginCustomerId: loginId });
      } catch (e) {
        stats.skipped++;
        console.warn(`google-populator: campaigns ${customerId} skipped:`, e?.message?.slice(0, 140));
        continue;
      }
      if (!rows.length) continue;
      stats.accounts_with_data++;

      for (const row of rows) {
        try {
          const c   = row.campaign || {};
          const bud = row.campaignBudget || {};
          const m   = row.metrics || {};
          const cust = row.customer || {};
          const costMicros = Number(m.costMicros || 0);

          const normalized = {
            external_id:        String(c.id),
            external_name:      c.name || String(c.id),
            external_account_id: customerId,
            status:             mapGoogleStatus(c.status),
            platform_objective: c.advertisingChannelType || null,
            starts_at:          c.startDate || null,
            ends_at:            c.endDate || null,
            budget_daily:       bud.amountMicros != null ? Number(bud.amountMicros) / 1e6 : null,
            budget_currency:    cust.currencyCode || null,
            cached: {
              impressions: m.impressions != null ? Number(m.impressions) : null,
              clicks:      m.clicks != null ? Number(m.clicks) : null,
              spend:       costMicros ? costMicros / 1e6 : null,
              conversions: m.conversions != null ? Number(m.conversions) : null,
              ctr:         m.ctr != null ? Number(m.ctr) : null,
            },
            metadata: {
              google_channel_type: c.advertisingChannelType || null,
              google_customer_id:  customerId,
              average_cpc_micros:  m.averageCpc != null ? Number(m.averageCpc) : null,
              metrics_window:      "LAST_30_DAYS",
            },
          };

          await this.upsertCanonicalCampaign({ normalized, integration: integ });
          stats.campaigns_upserted++;
        } catch (e) {
          stats.errors++;
          console.error(`google-populator: campaign ${row?.campaign?.id} failed:`, e?.message);
        }
      }
    }

    await supabase
      .from("brand_integrations")
      .update({ last_sync_at: new Date().toISOString() })
      .eq("id", brand_integration_id);

    return { ok: true, ...stats };
  }

  async finishBootstrap(job) {
    const { brand_integration_id, brand_container_id } = job.payload;
    if (!brand_integration_id) throw new Error("Missing brand_integration_id");

    const { count } = await supabase
      .from("campaigns")
      .select("*", { count: "exact", head: true })
      .eq("brand_container_id", brand_container_id)
      .eq("platform", "google_ads");

    const { data: cur } = await supabase
      .from("brand_integrations").select("metadata").eq("id", brand_integration_id).maybeSingle();

    await supabase
      .from("brand_integrations")
      .update({
        bootstrap_status:       "completed",
        bootstrap_completed_at: new Date().toISOString(),
        metadata:               { ...(cur?.metadata || {}), populator_status: "completed" },
      })
      .eq("id", brand_integration_id);

    return { ok: true, status: "bootstrap_completed", campaigns_indexed: count || 0 };
  }
}

// Google: ENABLED/PAUSED/REMOVED → status canonico que entiende base.mapCampaignStatus
function mapGoogleStatus(s) {
  const v = String(s || "").toUpperCase();
  if (v === "ENABLED") return "active";
  if (v === "PAUSED")  return "paused";
  if (v === "REMOVED") return "archived";
  return "draft";
}
