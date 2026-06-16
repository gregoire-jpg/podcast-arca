// Edge Function — étiquette Mondial Relay pour une commande (ADMIN, crée une expédition facturée).
// (Portée depuis netlify/functions/regenerate-mr-label.js.)
// POST { order_id, force? }. Idempotent : si étiquette existe, renvoie l'URL stockée SANS re-facturer.

import { json, preflight } from "../_shared/cors.ts";
import { requireAdmin } from "../_shared/auth.ts";
import { supaEnv } from "../_shared/supa.ts";
import { createLabel } from "../_shared/mr.ts";

Deno.serve(async (req) => {
  const pre = preflight(req);
  if (pre) return pre;
  if (req.method !== "POST") return json(405, { error: "Method not allowed" });
  const unauth = requireAdmin(req);
  if (unauth) return unauth;

  const { url: SUPABASE_URL, key: SUPABASE_KEY } = supaEnv();
  if (!SUPABASE_URL || !SUPABASE_KEY) return json(500, { error: "SUPABASE_* env vars manquantes" });

  let body: any;
  try { body = await req.json(); } catch { return json(400, { error: "Invalid JSON" }); }
  const orderId = parseInt(body.order_id, 10);
  if (!orderId) return json(400, { error: "order_id requis" });

  const resp = await fetch(`${SUPABASE_URL}/rest/v1/arca_orders?id=eq.${orderId}&select=*`, {
    headers: { "apikey": SUPABASE_KEY, "Authorization": "Bearer " + SUPABASE_KEY },
  });
  if (!resp.ok) return json(500, { error: "Erreur lecture Supabase: " + resp.status });
  const rows = await resp.json();
  if (!rows.length) return json(404, { error: "Commande introuvable" });
  const order = rows[0];

  if ((order.livraison || "").toLowerCase().indexOf("mondial") < 0) return json(400, { error: "Cette commande n'est pas en livraison Mondial Relay" });

  const force = body.force === true || body.force === 1 || body.force === "1";
  if (!force && order.mr_expedition && order.mr_label_url) {
    console.log("[regenerate-mr-label] #" + orderId + " étiquette existante → réimpression URL stockée, AUCUNE nouvelle expédition.");
    return json(200, { success: true, mr_expedition: order.mr_expedition, mr_label_url: order.mr_label_url, reused: true });
  }
  if (!order.mr_relay_code) return json(400, { error: "Code point relais manquant sur la commande" });

  const orderData: any = {
    nom: order.nom, email: order.email, telephone: order.telephone, rue: order.rue, complement: order.complement,
    cp: order.cp, ville: order.ville, pays: order.pays, livraison: order.livraison,
    "mr-relay-code": order.mr_relay_code, "mr-relay-info": order.mr_relay_info,
  };
  (order.items || []).forEach((it: any) => { if (it && it.num) orderData["qty-n" + it.num] = String(it.qty || 0); });

  console.log("[regenerate-mr-label] CRÉATION expédition MR FACTURÉE pour #" + orderId + (force ? " (force)" : ""));
  let label: any;
  try { label = await createLabel(orderData); }
  catch (e) { return json(500, { error: "createLabel exception: " + (e as Error).message }); }
  if (!label || label.error) return json(502, { error: (label && label.error) || "Échec création étiquette MR" });

  const labelUrl = label.url_pdf || label.url_a6 || label.url_a4 || label.url_a5 || null;
  const expedition = label.expedition || null;

  const upResp = await fetch(`${SUPABASE_URL}/rest/v1/arca_orders?id=eq.${orderId}`, {
    method: "PATCH",
    headers: { "apikey": SUPABASE_KEY, "Authorization": "Bearer " + SUPABASE_KEY, "Content-Type": "application/json", "Prefer": "return=minimal" },
    body: JSON.stringify({ mr_expedition: expedition, mr_label_url: labelUrl }),
  });
  if (!upResp.ok) return json(500, { error: "createLabel OK mais sauvegarde Supabase KO: " + (await upResp.text()).substring(0, 300) });

  return json(200, { success: true, mr_expedition: expedition, mr_label_url: labelUrl });
});
