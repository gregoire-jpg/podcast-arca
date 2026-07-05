// Edge Function — mail d'annulation au client + notif interne (ADMIN).
// (Portée depuis netlify/functions/send-cancellation.js.)
// POST { order_id, reason? } ; exige x-admin-password (fail-closed).

import { json, preflight } from "../_shared/cors.ts";
import { requireAdmin } from "../_shared/auth.ts";
import { arcaEnv } from "../_shared/env.ts";
import { supaEnv } from "../_shared/supa.ts";

function esc(s: any) {
  return String(s == null ? "" : s).replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
}

Deno.serve(async (req) => {
  const pre = preflight(req);
  if (pre) return pre;
  if (req.method !== "POST") return json(405, { error: "Method not allowed" });

  const unauth = requireAdmin(req);
  if (unauth) return unauth;

  const { url: SUPABASE_URL, key: SUPABASE_KEY } = supaEnv();
  const BREVO_KEY = arcaEnv("BREVO_API_KEY");
  const FROM_EMAIL = arcaEnv("ORDER_EMAIL_FROM");
  if (!SUPABASE_URL || !SUPABASE_KEY) return json(500, { error: "SUPABASE_* env vars manquantes" });
  if (!BREVO_KEY || !FROM_EMAIL) return json(500, { error: "BREVO_API_KEY ou ORDER_EMAIL_FROM manquant" });

  let body: any;
  try { body = await req.json(); } catch { return json(400, { error: "Invalid JSON" }); }
  const orderId = parseInt(body.order_id, 10);
  if (!orderId) return json(400, { error: "order_id requis" });
  const reason = (body.reason || "").trim();

  const r = await fetch(`${SUPABASE_URL}/rest/v1/arca_orders?id=eq.${orderId}&select=*`, {
    headers: { "apikey": SUPABASE_KEY, "Authorization": "Bearer " + SUPABASE_KEY },
  });
  if (!r.ok) return json(500, { error: "Erreur lecture Supabase" });
  const rows = await r.json();
  if (!rows.length) return json(404, { error: "Commande introuvable" });
  const o = rows[0];
  if (!o.email) return json(400, { error: "Pas d'email client" });

  const clientPayload = {
    sender: { name: "ARCA Revue & Librairie", email: FROM_EMAIL },
    to: [{ email: o.email, name: o.nom || "" }],
    replyTo: { email: "antoine@arca-librairie.com", name: "ARCA" },
    subject: "Annulation de votre commande ARCA n°" + o.id,
    htmlContent: buildHtml(o, reason), textContent: buildText(o, reason),
  };
  const resp = await fetch("https://api.brevo.com/v3/smtp/email", {
    method: "POST",
    headers: { "accept": "application/json", "api-key": BREVO_KEY, "Content-Type": "application/json" },
    body: JSON.stringify(clientPayload),
  });
  if (!resp.ok) {
    console.error("[send-cancellation] Brevo client error:", resp.status, (await resp.text()).substring(0, 300));
    return json(502, { error: "Brevo HTTP " + resp.status });
  }

  const TO_INTERNAL = (arcaEnv("ORDER_EMAIL_TO") || "").split(",").map((s) => s.trim()).filter(Boolean);
  if (TO_INTERNAL.length > 0) {
    const internalPayload = {
      sender: { name: "ARCA Commandes", email: FROM_EMAIL },
      to: TO_INTERNAL.map((e) => ({ email: e })),
      replyTo: { email: o.email, name: o.nom || "" },
      subject: "✗ ANNULÉE · Commande ARCA #" + o.id + " · " + (o.nom || ""),
      htmlContent: buildInternalHtml(o, reason), textContent: buildInternalText(o, reason),
    };
    const r2 = await fetch("https://api.brevo.com/v3/smtp/email", {
      method: "POST",
      headers: { "accept": "application/json", "api-key": BREVO_KEY, "Content-Type": "application/json" },
      body: JSON.stringify(internalPayload),
    });
    if (!r2.ok) console.error("[send-cancellation] Brevo interne error:", r2.status, (await r2.text()).substring(0, 300));
  }

  return json(200, { success: true });
});

function buildInternalHtml(o: any, reason: string) {
  const itemsRows = (o.items || []).map((it: any) =>
    `<tr><td style="padding:4px 8px;font:13px Arial;color:#444;">${esc(it.title)} × ${it.qty}</td><td style="padding:4px 8px;font:13px Arial;color:#444;text-align:right;">${it.qty * it.price} €</td></tr>`
  ).join("");
  return `<!DOCTYPE html><html lang="fr"><body style="font-family:Arial,sans-serif;background:#f5f5f5;margin:0;padding:20px;">
<div style="max-width:560px;margin:0 auto;background:#fff;border-radius:6px;overflow:hidden;border-top:4px solid #9d1018;">
  <div style="padding:18px 22px;background:#fde4e6;">
    <p style="margin:0;font:bold 11px Arial;letter-spacing:1.5px;text-transform:uppercase;color:#9d1018;">✗ Commande annulée</p>
    <p style="margin:4px 0 0;font:bold 17px Georgia;color:#2d3461;">#${o.id} · ${esc(o.nom || "")}</p>
  </div>
  <div style="padding:20px 22px;">
    <p style="margin:0 0 14px;font:13px/1.5 Arial;color:#444;">
      <strong>Email :</strong> <a href="mailto:${esc(o.email || "")}">${esc(o.email || "")}</a><br>
      <strong>Téléphone :</strong> ${esc(o.telephone || "—")}<br>
      <strong>Pays :</strong> ${esc(o.pays || "—")} · <strong>Livraison :</strong> ${esc(o.livraison || "—")}<br>
      <strong>Paiement :</strong> ${esc(o.paiement || "—")} ${o.paye ? '<span style="color:#3a8a4a;font-weight:bold;">(payé)</span>' : '<span style="color:#8a5a10;font-weight:bold;">(non payé)</span>'}
    </p>
    ${reason ? `<p style="margin:0 0 14px;padding:10px 14px;background:#faf8f5;border-left:3px solid #c8a060;font:13px/1.5 Arial;color:#555;"><strong style="color:#2d3461;">Motif :</strong> ${esc(reason)}</p>` : ""}
    <table width="100%" style="border-top:1px solid #eee;border-bottom:1px solid #eee;margin:12px 0;">${itemsRows}</table>
    <p style="margin:10px 0 0;font:bold 14px Arial;color:#2d3461;text-align:right;">Total : ${o.total_eur || "—"} €</p>
    ${o.paye ? `<p style="margin:14px 0 0;padding:10px;background:#fff8e1;font:13px Arial;color:#8a5a10;border-radius:4px;">⚠ La commande était <strong>payée</strong>. Pense au remboursement.</p>` : ""}
  </div>
</div></body></html>`;
}
function buildInternalText(o: any, reason: string) {
  const items = (o.items || []).map((it: any) => `  ${it.title} × ${it.qty} = ${it.qty * it.price} €`).join("\n");
  return `✗ COMMANDE ANNULÉE
Commande #${o.id} — ${o.nom || ""}

Email : ${o.email || "—"}
Téléphone : ${o.telephone || "—"}
Pays : ${o.pays || "—"}
Livraison : ${o.livraison || "—"}
Paiement : ${o.paiement || "—"} ${o.paye ? "(payé)" : "(non payé)"}
${reason ? "\nMotif : " + reason + "\n" : ""}
${items}

Total : ${o.total_eur || "—"} €
${o.paye ? "\n⚠ La commande était payée. Pense au remboursement." : ""}`;
}

function buildHtml(o: any, reason: string) {
  const reasonBlock = reason ? `
  <tr><td style="padding:0 40px 18px;">
    <table width="100%" cellpadding="0" cellspacing="0" style="background:#faf8f5;border-left:3px solid #c8a060;border-radius:0 4px 4px 0;">
      <tr><td style="padding:14px 18px;font:14px/1.6 Georgia;color:#555;">
        <strong style="color:#2d3461;">Motif&nbsp;:</strong> ${esc(reason)}
      </td></tr>
    </table>
  </td></tr>` : "";
  return `<!DOCTYPE html><html lang="fr"><head><meta charset="UTF-8"><meta name="viewport" content="width=device-width, initial-scale=1.0"><title>Annulation commande ARCA</title></head>
<body style="margin:0;padding:0;background:#f0ede8;font-family:Georgia,serif;">
<table width="100%" cellpadding="0" cellspacing="0" border="0" style="background:#f0ede8;"><tr><td align="center" style="padding:30px 16px;">
<table width="600" cellpadding="0" cellspacing="0" border="0" style="max-width:600px;width:100%;background:#fff;border-radius:4px;overflow:hidden;box-shadow:0 2px 16px rgba(0,0,0,.10);">
  <tr><td style="background:#2d3461;padding:38px 40px;text-align:center;">
    <p style="margin:0 0 8px;font-family:Arial,sans-serif;font-size:11px;letter-spacing:5px;text-transform:uppercase;color:#c8a060;">Revue &amp; Librairie</p>
    <h1 style="margin:0;font:42px/1 Georgia;letter-spacing:10px;text-transform:uppercase;color:#fff;font-weight:normal;">ARCA</h1>
  </td></tr>
  <tr><td style="padding:36px 40px 18px;">
    <p style="margin:0 0 16px;font:15px/1.75 Georgia;color:#2d3461;">Bonjour ${esc(o.nom || "")},</p>
    <p style="margin:0 0 14px;font:15px/1.75 Georgia;color:#444;">Nous vous informons que votre commande <strong style="color:#2d3461;">n°${o.id}</strong>${o.total_eur ? " (" + o.total_eur + "&nbsp;€)" : ""} a été <strong>annulée</strong>.</p>
  </td></tr>
  ${reasonBlock}
  <tr><td style="padding:0 40px 28px;">
    <p style="margin:0 0 12px;font:14.5px/1.7 Georgia;color:#444;">Si vous avez déjà été débité, le remboursement sera effectué sous quelques jours.</p>
    <p style="margin:0;font:14.5px/1.7 Georgia;color:#444;">Si cette annulation vous surprend ou s'il s'agit d'une erreur, n'hésitez pas à nous répondre directement à <a href="mailto:antoine@arca-librairie.com" style="color:#2d3461;">antoine@arca-librairie.com</a>, nous reviendrons vers vous rapidement.</p>
  </td></tr>
  <tr><td style="padding:24px 40px 32px;background:#faf8f5;border-top:1px solid #e2ddd8;">
    <p style="margin:0 0 2px;font:italic 14.5px Georgia;color:#2d3461;">Bien à vous,</p>
    <p style="margin:0;font:bold 15px Georgia;color:#2d3461;">Antoine de Lophem</p>
    <p style="margin:0;font:13px Georgia;color:#777;">ARCA Revue &amp; Librairie</p>
  </td></tr>
</table></td></tr></table></body></html>`;
}
function buildText(o: any, reason: string) {
  return `Bonjour ${o.nom || ""},

Nous vous informons que votre commande ARCA n°${o.id}${o.total_eur ? " (" + o.total_eur + " €)" : ""} a été annulée.
${reason ? "\nMotif : " + reason + "\n" : ""}
Si vous avez déjà été débité, le remboursement sera effectué sous quelques jours.

Si cette annulation vous surprend ou s'il s'agit d'une erreur, contactez-nous : antoine@arca-librairie.com.

Bien à vous,
Antoine de Lophem
ARCA Revue & Librairie`;
}
