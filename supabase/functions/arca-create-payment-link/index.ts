// Edge Function — crée un lien de paiement Stripe (ou PayPal) pour une commande existante.
// (Portée depuis netlify/functions/create-payment-link.js.)
// POST { order_id, provider: 'stripe'|'paypal', amount_eur, label } → { url, provider }

import { json, preflight } from "../_shared/cors.ts";
import { createStripePaymentLink, createPaypalOrder } from "../_shared/payments.ts";

Deno.serve(async (req) => {
  const pre = preflight(req);
  if (pre) return pre;
  if (req.method !== "POST") return json(405, { error: "Method not allowed" });

  let body: any;
  try { body = await req.json(); } catch { return json(400, { error: "Invalid JSON" }); }

  const orderId = body.order_id;
  const provider = (body.provider || "stripe").toLowerCase();
  const amount = parseFloat(body.amount_eur);
  const label = body.label || ("Commande ARCA #" + orderId);
  if (!orderId || !amount || amount <= 0) return json(400, { error: "order_id et amount_eur requis" });

  try {
    const url = provider === "paypal"
      ? await createPaypalOrder(amount, label, orderId)
      : await createStripePaymentLink(amount, label, orderId);
    return json(200, { url, provider });
  } catch (e) {
    console.error("[arca-create-payment-link]", e);
    return json(500, { error: (e as Error).message });
  }
});
