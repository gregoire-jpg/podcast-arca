// Edge Function — renvoie le mail de confirmation pour une commande existante (ADMIN).
// (Portée depuis netlify/functions/send-confirmation.js.)
// POST { order_id } → reconstruit le payload et rejoue arca-order-submit avec
// _no_persist=true (pas de doublon BDD). Exige x-admin-password (fail-closed), et le
// transmet à arca-order-submit pour que les flags privilégiés soient honorés.

import { json, preflight } from "../_shared/cors.ts";
import { requireAdmin } from "../_shared/auth.ts";
import { arcaEnv } from "../_shared/env.ts";
import { supaEnv } from "../_shared/supa.ts";

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
  const o = rows[0];

  const data = formDataFromOrder(o);

  let r: Response;
  try {
    r = await fetch(arcaEnv("FUNCTIONS_BASE") + "/arca-order-submit", {
      method: "POST",
      headers: { "Content-Type": "application/json", "x-admin-password": arcaEnv("ADMIN_PASSWORD") },
      body: JSON.stringify({ form_name: "commande-arca", data, _no_persist: true, _order_id: orderId }),
    });
  } catch (e) {
    return json(502, { error: "Appel arca-order-submit échoué: " + (e as Error).message });
  }
  const text = await r.text();
  if (!r.ok) {
    console.error("[send-confirmation] arca-order-submit KO:", r.status, text.substring(0, 300));
    return json(502, { error: "arca-order-submit HTTP " + r.status, body: text.substring(0, 200) });
  }
  return json(200, { success: true, message: "Mail envoyé" });
});

function formDataFromOrder(o: any) {
  const d: any = {
    nom: o.nom || "", email: o.email || "", telephone: o.telephone || "",
    rue: o.rue || "", complement: o.complement || "", cp: o.cp || "", ville: o.ville || "", pays: o.pays || "",
    livraison: o.livraison || "", "mr-relay-code": o.mr_relay_code || "", "mr-relay-info": o.mr_relay_info || "",
    paiement: o.paiement || "",
    "paypal-order-id": o.stripe_session_id || o.paypal_order_id || "",
    "paypal-status": o.paye ? ("PAID — " + (o.paiement || "")) : "",
  };
  for (let i = 1; i <= 9; i++) d["qty-n" + i] = "0";
  (o.items || []).forEach((it: any) => { if (it && it.num) d["qty-n" + it.num] = String(it.qty || 0); });

  const parts: string[] = [];
  (o.items || []).forEach((it: any) => { parts.push(`${it.title} × ${it.qty} = ${it.qty * it.price} €`); });
  const sousTotal = (o.items || []).reduce((s: number, it: any) => s + it.qty * it.price, 0);
  parts.push("Sous-total revues: " + sousTotal + " €");
  if (o.pack_discount_eur && o.pack_discount_eur > 0) parts.push("Pack complet -" + o.pack_discount_eur + " €");
  if (o.discount_eur && o.discount_eur > 0) parts.push("Remise panier -" + o.discount_eur + " €");
  if (o.shipping_discount_eur && o.shipping_discount_eur > 0) parts.push("Remise port -" + o.shipping_discount_eur + " €");
  if (o.discount_note) parts.push("Motif remise: " + o.discount_note);
  parts.push("Port: " + (o.port_eur || 0) + " €");
  parts.push("TOTAL: " + (o.total_eur != null ? o.total_eur : sousTotal) + " €");
  d["commande-details"] = parts.join(" | ");
  d["_discount_eur"] = o.discount_eur || 0;
  d["_shipping_discount_eur"] = o.shipping_discount_eur || 0;
  d["_discount_note"] = o.discount_note || "";
  d["_custom_items"] = (o.items || []).filter((it: any) => it && !it.num);
  return d;
}
