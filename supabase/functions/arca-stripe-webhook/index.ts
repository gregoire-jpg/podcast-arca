// Edge Function — webhook Stripe (fiabilise l'email même si le client ferme l'onglet).
// (Portée depuis netlify/functions/stripe-webhook.js — crypto Node → Web Crypto.)
// POST signé HMAC par Stripe sur "checkout.session.completed".
//
// ⚠ CUTOVER : reconfigurer l'URL du webhook dans le Dashboard Stripe vers
//   https://<ref>.supabase.co/functions/v1/arca-stripe-webhook  (events: checkout.session.completed)

import { arcaEnv } from "../_shared/env.ts";
import { supaEnv } from "../_shared/supa.ts";

function esc(s: any) { return String(s || "").replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;"); }

// Vérifie la signature Stripe (HMAC-SHA256 sur "<timestamp>.<rawBody>") via Web Crypto.
async function verifyStripeSignature(payload: string, sigHeader: string, secret: string): Promise<boolean> {
  const parts: any = {};
  sigHeader.split(",").forEach((part) => {
    const [k, v] = part.split("=");
    if (k === "t") parts.timestamp = v;
    if (k === "v1") (parts.signatures = parts.signatures || []).push(v);
  });
  if (!parts.timestamp || !parts.signatures) return false;
  const age = Math.abs(Date.now() / 1000 - parseInt(parts.timestamp, 10));
  if (age > 300) return false; // anti-replay 5 min
  const signedPayload = parts.timestamp + "." + payload;
  const key = await crypto.subtle.importKey("raw", new TextEncoder().encode(secret), { name: "HMAC", hash: "SHA-256" }, false, ["sign"]);
  const sigBuf = await crypto.subtle.sign("HMAC", key, new TextEncoder().encode(signedPayload));
  const expected = [...new Uint8Array(sigBuf)].map((b) => b.toString(16).padStart(2, "0")).join("");
  return parts.signatures.some((s: string) => timingSafeEqualHex(s, expected));
}
function timingSafeEqualHex(a: string, b: string): boolean {
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return diff === 0;
}

async function notifyOrderPaid(order: any, session: any) {
  const BREVO_KEY = arcaEnv("BREVO_API_KEY");
  const TO_RAW = (arcaEnv("ORDER_EMAIL_TO") || "").split(",").map((s) => s.trim()).filter(Boolean);
  const FROM_EMAIL = arcaEnv("ORDER_EMAIL_FROM");
  if (!BREVO_KEY || !TO_RAW.length || !FROM_EMAIL || !order) return;
  const amount = ((session.amount_total || 0) / 100).toFixed(2);
  const subject = `✅ PAYÉ · Commande ARCA #${order.id} · ${amount} € · ${order.nom || ""}`;
  const html = `<!DOCTYPE html><html><body style="font-family:Arial,sans-serif;background:#f5f5f5;padding:20px">
<div style="max-width:560px;margin:0 auto;background:#fff;border-radius:6px;border-top:4px solid #2a7a2a;padding:22px">
  <p style="margin:0 0 6px;font:bold 11px Arial;letter-spacing:1.5px;text-transform:uppercase;color:#2a7a2a">✅ Paiement Stripe reçu</p>
  <p style="margin:0 0 14px;font:bold 18px Georgia;color:#2d3461">Commande #${order.id} marquée payée — ${amount} €</p>
  <p style="margin:0 0 6px"><strong>Client</strong> : ${esc(order.nom || "")}</p>
  <p style="margin:0 0 6px"><strong>Email</strong> : ${esc(order.email || "")}</p>
  <p style="margin:0 0 6px"><strong>Livraison</strong> : ${esc(order.livraison || "")}</p>
  <p style="margin:14px 0 0;font-size:11px;font-family:'Courier New',monospace;color:#888">Session : ${esc(session.id)}</p>
</div></body></html>`;
  await fetch("https://api.brevo.com/v3/smtp/email", {
    method: "POST",
    headers: { "accept": "application/json", "api-key": BREVO_KEY, "Content-Type": "application/json" },
    body: JSON.stringify({ sender: { name: "ARCA Commandes", email: FROM_EMAIL }, to: TO_RAW.map((e) => ({ email: e })), subject, htmlContent: html }),
  }).catch((e) => console.error("[notifyOrderPaid] Brevo error:", e.message));
}

async function markOrderPaid(orderId: any, session: any) {
  const { url: SB_URL, key: SB_KEY } = supaEnv();
  if (!SB_URL || !SB_KEY) { console.error("[markOrderPaid] SUPABASE_* manquant"); return; }
  try {
    const resp = await fetch(`${SB_URL}/rest/v1/arca_orders?id=eq.${encodeURIComponent(orderId)}`, {
      method: "PATCH",
      headers: { "apikey": SB_KEY, "Authorization": "Bearer " + SB_KEY, "Content-Type": "application/json", "Prefer": "return=representation" },
      body: JSON.stringify({ paye: true, paid_at: new Date().toISOString(), stripe_session_id: session.id, paiement: "Stripe (Payment Link admin)" }),
    });
    if (!resp.ok) { console.error("[markOrderPaid] Supabase PATCH KO:", resp.status, (await resp.text()).substring(0, 300)); return; }
    const rows = await resp.json();
    const order = Array.isArray(rows) ? rows[0] : rows;
    console.log("[markOrderPaid] OK order #" + orderId + " (" + (order && order.nom) + ")");
    await notifyOrderPaid(order, session);
  } catch (e) {
    console.error("[markOrderPaid] erreur:", (e as Error).message);
  }
}

async function notifyExternalStripePayment(session: any) {
  const BREVO_KEY = arcaEnv("BREVO_API_KEY");
  const TO_RAW = (arcaEnv("EXTERNAL_PAYMENT_TO") || arcaEnv("ORDER_EMAIL_TO") || "").split(",").map((s) => s.trim()).filter(Boolean);
  const FROM_EMAIL = arcaEnv("ORDER_EMAIL_FROM");
  if (!BREVO_KEY || !TO_RAW.length || !FROM_EMAIL) { console.warn("[Stripe webhook external] Brevo non configuré"); return; }
  const amount = ((session.amount_total || 0) / 100).toFixed(2);
  const currency = (session.currency || "eur").toUpperCase();
  const email = (session.customer_details && session.customer_details.email) || "—";
  const name = (session.customer_details && session.customer_details.name) || "—";
  const subject = `💳 Paiement Stripe HORS TUNNEL · ${amount} ${currency} · ${name}`;
  const html = `<!DOCTYPE html><html><body style="font-family:Arial,sans-serif;background:#f5f5f5;margin:0;padding:20px;">
<div style="max-width:560px;margin:0 auto;background:#fff;border-radius:6px;overflow:hidden;border-top:4px solid #c8a060;">
  <div style="padding:18px 22px;background:#fffbf2;">
    <p style="margin:0;font:bold 11px Arial;letter-spacing:1.5px;text-transform:uppercase;color:#c8a060;">💳 Paiement Stripe — hors tunnel ARCA</p>
    <p style="margin:4px 0 0;font:bold 17px Georgia;color:#2d3461;">${amount} ${currency}</p>
  </div>
  <div style="padding:20px 22px;font:13px/1.5 Arial;color:#444;">
    <p style="margin:0 0 14px;">Un paiement a été reçu sur Stripe <strong>sans passer par le tunnel ARCA</strong>.</p>
    <p style="margin:0 0 6px;"><strong>Client</strong> : ${esc(name)}</p>
    <p style="margin:0 0 6px;"><strong>Email</strong> : <a href="mailto:${esc(email)}">${esc(email)}</a></p>
    <p style="margin:14px 0 0;font-size:11px;font-family:'Courier New',monospace;color:#888;">Session : ${esc(session.id)}</p>
    <p style="margin:14px 0 0;text-align:center;">
      <a href="https://dashboard.stripe.com/payments/${esc(session.id)}" style="display:inline-block;padding:10px 20px;background:#635bff;color:#fff;text-decoration:none;border-radius:4px;font-size:12px;font-weight:bold;">Voir dans Stripe Dashboard →</a>
    </p>
  </div>
</div></body></html>`;
  const text = `PAIEMENT STRIPE HORS TUNNEL ARCA\n\nMontant: ${amount} ${currency}\nClient: ${name}\nEmail: ${email}\nSession: ${session.id}\n\nSi ce paiement correspond à une commande, crée-la manuellement dans l'admin et marque-la « payée ».`;
  const payload: any = { sender: { name: "ARCA Commandes", email: FROM_EMAIL }, to: TO_RAW.map((e) => ({ email: e })), subject, htmlContent: html, textContent: text };
  if (email && email !== "—") payload.replyTo = { email, name: name === "—" ? "" : name };
  const resp = await fetch("https://api.brevo.com/v3/smtp/email", {
    method: "POST",
    headers: { "accept": "application/json", "api-key": BREVO_KEY, "Content-Type": "application/json" },
    body: JSON.stringify(payload),
  });
  if (!resp.ok) console.error("[Stripe webhook external] Brevo KO:", resp.status, (await resp.text()).substring(0, 200));
  else console.log("[Stripe webhook external] Notification envoyée pour", session.id);
}

Deno.serve(async (req) => {
  if (req.method !== "POST") return new Response("Method not allowed", { status: 405 });

  const WEBHOOK_SECRET = arcaEnv("STRIPE_WEBHOOK_SECRET");
  const STRIPE_KEY = arcaEnv("STRIPE_SECRET_KEY");
  if (!STRIPE_KEY || !WEBHOOK_SECRET) { console.error("[Stripe webhook] env vars manquantes"); return new Response("Config error", { status: 500 }); }

  // Corps BRUT requis pour la signature
  const rawBody = await req.text();
  const sigHeader = req.headers.get("stripe-signature") || req.headers.get("Stripe-Signature");
  if (!sigHeader) return new Response("Missing signature", { status: 400 });
  if (!(await verifyStripeSignature(rawBody, sigHeader, WEBHOOK_SECRET))) {
    console.error("[Stripe webhook] signature invalide");
    return new Response("Invalid signature", { status: 400 });
  }

  let evt: any;
  try { evt = JSON.parse(rawBody); } catch { return new Response("Bad payload", { status: 400 }); }

  if (evt.type !== "checkout.session.completed") {
    console.log("[Stripe webhook] event ignoré :", evt.type);
    return new Response("Ignored", { status: 200 });
  }

  const session = evt.data && evt.data.object;
  if (!session || !session.id) return new Response("No session", { status: 200 });
  if (session.payment_status !== "paid") {
    console.log("[Stripe webhook] session non payée :", session.id, session.payment_status);
    return new Response("Not paid", { status: 200 });
  }

  const meta = session.metadata || {};
  const orderData = Object.assign({}, meta, {
    "paypal-order-id": session.id,
    "paypal-status": "PAID — Stripe — " + ((session.customer_details && session.customer_details.email) || ""),
  });

  // Payment Link admin (commande déjà en BDD)
  if (meta.order_id && (meta.source === "admin_manual" || !meta.nom)) {
    console.log("[Stripe webhook] Payment Link admin pour order_id=" + meta.order_id);
    await markOrderPaid(meta.order_id, session);
    return new Response("Order marked as paid", { status: 200 });
  }

  // Paiement hors tunnel
  if (!meta.nom) {
    console.log("[Stripe webhook] paiement HORS tunnel ARCA :", session.id);
    await notifyExternalStripePayment(session);
    return new Response("External payment notified", { status: 200 });
  }

  // Tunnel normal → arca-order-submit (idempotence via stripe_session_id)
  try {
    const submissionUrl = arcaEnv("FUNCTIONS_BASE") + "/arca-order-submit";
    const fnResp = await fetch(submissionUrl, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ form_name: "commande-arca", data: orderData }),
    });
    if (!fnResp.ok) console.error("[Stripe webhook] arca-order-submit KO :", fnResp.status, (await fnResp.text()).substring(0, 300));
    else console.log("[Stripe webhook] arca-order-submit OK pour", session.id);
  } catch (e) {
    // On renvoie 200 quand même : un 500 ferait retry Stripe → duplication.
    console.error("[Stripe webhook] erreur appel arca-order-submit :", (e as Error).message);
  }

  return new Response("OK", { status: 200 });
});
