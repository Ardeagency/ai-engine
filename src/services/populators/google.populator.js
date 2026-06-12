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
import { listAccessibleCustomers, searchStream, googleGet } from "../../lib/googleads-rest.js";

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
    return ["google_sync_campaigns", "google_sync_youtube", "vera_propose_priority_actions"];
  }

  // google_list_accounts no es subjob del bootstrap: el exchange lo encola
  // directo tras conectar para poblar las cuentas elegibles (selector).
  handles() { return [...super.handles(), "google_list_accounts"]; }

  dispatch(missionType) {
    if (missionType === "google_list_accounts")         return this.listAccounts;
    if (missionType === "google_sync_campaigns")        return this.syncCampaigns;
    if (missionType === "google_sync_youtube")          return this.syncYoutube;
    if (missionType === "vera_propose_priority_actions") return this.finishBootstrap;
    return null;
  }

  /**
   * Expande la jerarquia y guarda las cuentas HOJA elegibles en
   * metadata.available_accounts (sin sincronizar nada). El usuario luego elige
   * cual(es) pertenecen a la marca (selector) — NUNCA jalamos todo el portafolio.
   */
  async listAccounts(job) {
    const { brand_integration_id } = job.payload;
    const integ = await this.getIntegration(brand_integration_id);

    const tops = await listAccessibleCustomers(integ);
    const leaves = new Map(); // id -> { login, manager }
    for (const top of tops) {
      try {
        const clients = await searchStream(integ, top,
          "SELECT customer_client.id, customer_client.descriptive_name, customer_client.currency_code, customer_client.manager FROM customer_client",
          { loginCustomerId: top });
        for (const r of clients) {
          const cc = r.customerClient || {};
          if (cc.manager === false && cc.id && !leaves.has(String(cc.id))) {
            leaves.set(String(cc.id), {
              customer_id:       String(cc.id),
              name:              cc.descriptiveName || String(cc.id),
              currency:          cc.currencyCode || null,
              login_customer_id: String(top),
            });
          }
        }
      } catch (e) {
        console.warn(`google-populator: listAccounts expand ${top}:`, e?.message?.slice(0, 120));
      }
    }
    const available = Array.from(leaves.values());

    const { data: cur } = await supabase
      .from("brand_integrations").select("metadata").eq("id", brand_integration_id).maybeSingle();
    await supabase.from("brand_integrations").update({
      metadata: {
        ...(cur?.metadata || {}),
        available_accounts:         available,
        awaiting_account_selection: available.length > 0,
        accounts_listed_at:         new Date().toISOString(),
      },
    }).eq("id", brand_integration_id);

    return { ok: true, accounts_available: available.length };
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

    // SOLO las cuentas que el usuario eligio para esta marca (selector).
    // NUNCA jalar todo el portafolio accesible (problema de agencia/privacidad).
    const selected  = integ.metadata?.selected_customer_ids || [];
    const available = integ.metadata?.available_accounts || [];
    const loginById = {};
    for (const a of available) loginById[String(a.customer_id)] = a.login_customer_id;

    const stats = {
      selected: selected.length, accounts_with_data: 0,
      campaigns_upserted: 0, skipped: 0, errors: 0,
    };

    // Sin seleccion → no sincronizar nada (espera a que el usuario elija).
    if (!selected.length) {
      return { ok: true, status: "awaiting_account_selection", ...stats };
    }

    for (const customerId of selected) {
      const loginId = loginById[String(customerId)] || customerId;
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

  async syncYoutube(job) {
    const { brand_integration_id, brand_container_id } = job.payload;
    const integ = await this.getIntegration(brand_integration_id);
    const YT = "https://www.googleapis.com/youtube/v3";

    // Canal propio del usuario autorizado
    let ch;
    try {
      ch = await googleGet(integ, `${YT}/channels`, { part: "snippet,contentDetails,statistics", mine: "true" });
    } catch (e) {
      // Sin canal o YouTube Data API no habilitada en el proyecto → skip suave
      console.warn("google-populator: youtube channels skipped:", e?.message?.slice(0, 160));
      return { ok: true, status: "skipped", reason: "no_channel_or_api_disabled" };
    }
    const channel = ch?.items?.[0];
    if (!channel) return { ok: true, status: "no_channel", videos: 0 };

    const uploads = channel.contentDetails?.relatedPlaylists?.uploads;
    const handle  = channel.snippet?.title || null;
    if (!uploads) return { ok: true, channel: handle, videos: 0 };

    // Ids de los videos subidos (playlist de uploads)
    const pl = await googleGet(integ, `${YT}/playlistItems`, { part: "contentDetails", playlistId: uploads, maxResults: 50 });
    const videoIds = (pl?.items || []).map((i) => i.contentDetails?.videoId).filter(Boolean);
    if (!videoIds.length) return { ok: true, channel: handle, videos: 0 };

    // Detalles + estadisticas
    const vres = await googleGet(integ, `${YT}/videos`, { part: "snippet,statistics", id: videoIds.join(",") });
    const items = vres?.items || [];

    // Idempotencia: no re-insertar videos ya presentes
    const ids = items.map((v) => String(v.id));
    const { data: existing } = await supabase
      .from("brand_posts").select("post_id")
      .eq("brand_container_id", brand_container_id).eq("network", "youtube").in("post_id", ids);
    const seen = new Set((existing || []).map((r) => String(r.post_id)));

    const rows = [];
    for (const v of items) {
      if (seen.has(String(v.id))) continue;
      const st = v.statistics || {}, sn = v.snippet || {};
      const likes = Number(st.likeCount || 0), comments = Number(st.commentCount || 0);
      rows.push({
        brand_container_id:  brand_container_id,
        network:             "youtube",
        post_source:         "own",
        profile_handle:      handle,
        author_display_name: handle,
        post_id:             String(v.id),
        content:             `${sn.title || ""}\n\n${sn.description || ""}`.trim(),
        permalink:           `https://youtube.com/watch?v=${v.id}`,
        media_assets:        sn.thumbnails ? [{ type: "image", url: sn.thumbnails.high?.url || sn.thumbnails.default?.url || null }] : null,
        metrics:             { views: Number(st.viewCount || 0), likes, comments },
        hashtags:            (sn.tags || []).slice(0, 30),
        captured_at:         sn.publishedAt || new Date().toISOString(),
        is_competitor:       false,
        ai_analyzed_at:      null,
      });
    }

    let created = 0;
    if (rows.length) {
      const { data: ins, error } = await supabase.from("brand_posts").insert(rows).select("id");
      if (error) console.error("google-populator: youtube insert:", error.message);
      else created = ins.length;
    }
    return { ok: true, channel: handle, videos_pulled: videoIds.length, posts_created: created };
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
