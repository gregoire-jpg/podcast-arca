// Edge Function — crée une session Stripe Checkout (carte/Bancontact).
// (Portée depuis netlify/functions/create-stripe-session.js — logique identique.)
// POST données de commande → { url, id }. success_url → arca-finalize-stripe-order.

import { json, preflight, corsHeaders } from "../_shared/cors.ts";
import { arcaEnv } from "../_shared/env.ts";

// Catalogue (titre + prix unitaire en centimes)
const CATALOG: Record<number, { title: string; price: number }> = {
  1: { title: "Revue ARCA n°1", price: 2000 },
  2: { title: "Revue ARCA n°2", price: 2000 },
  3: { title: "Revue ARCA n°3", price: 2000 },
  4: { title: "Revue ARCA n°4", price: 2000 },
  5: { title: "Revue ARCA n°5", price: 2000 },
  6: { title: "Revue ARCA n°6", price: 2000 },
  7: { title: "Revue ARCA n°7", price: 2000 },
  8: { title: "Revue ARCA n°8 (souscription)", price: 1500 },
  9: { title: "Recueil de prières", price: 2000 },
};
const PROMO_DEADLINE = new Date("2026-05-25T22:00:00Z");

Deno.serve(async (req) => {
  const pre = preflight(req);
  if (pre) return pre;

  try {
    const STRIPE_KEY = arcaEnv("STRIPE_SECRET_KEY");
    if (!STRIPE_KEY) return new Response("STRIPE_SECRET_KEY non configurée", { status: 500, headers: corsHeaders });

    const SUCCESS_URL = arcaEnv("FUNCTIONS_BASE") + "/arca-finalize-stripe-order?session_id={CHECKOUT_SESSION_ID}";
    const CANCEL_URL = (arcaEnv("SITE_BASE") || "https://arca-revue.com") + "/arca-revue/?cancelled=stripe";

    const d: any = await req.json().catch(() => ({}));

    const params = new URLSearchParams();
    params.append("mode", "payment");
    params.append("success_url", SUCCESS_URL);
    params.append("cancel_url", CANCEL_URL);
    params.append("locale", "fr");
    params.append("payment_method_types[]", "card");
    params.append("payment_method_types[]", "bancontact");
    if (d.email) params.append("customer_email", d.email);

    let packComplet = true;
    for (let i = 1; i <= 9; i++) {
      if (parseInt(d["qty-n" + i] || "0", 10) < 1) { packComplet = false; break; }
    }

    let idx = 0;
    const isPromoActive = new Date() < PROMO_DEADLINE;
    const PACK_DISCOUNT_EUR = 40;

    if (packComplet) {
      let brutTotal = 0;
      for (let i = 1; i <= 9; i++) {
        const q = parseInt(d["qty-n" + i] || "0", 10);
        const cat = CATALOG[i];
        const unitAmount = (i === 8 && !isPromoActive) ? 2000 : cat.price;
        brutTotal += q * unitAmount;
      }
      const packTotalCents = brutTotal - PACK_DISCOUNT_EUR * 100;
      params.append(`line_items[${idx}][price_data][currency]`, "eur");
      params.append(`line_items[${idx}][price_data][product_data][name]`, "Pack complet ARCA — 8 numéros + recueil de prières");
      params.append(`line_items[${idx}][price_data][unit_amount]`, String(packTotalCents));
      params.append(`line_items[${idx}][quantity]`, "1");
      idx++;
    } else {
      for (let i = 1; i <= 9; i++) {
        const q = parseInt(d["qty-n" + i] || "0", 10);
        if (q <= 0) continue;
        const cat = CATALOG[i];
        const unitAmount = (i === 8 && !isPromoActive) ? 2000 : cat.price;
        params.append(`line_items[${idx}][price_data][currency]`, "eur");
        params.append(`line_items[${idx}][price_data][product_data][name]`, cat.title);
        params.append(`line_items[${idx}][price_data][unit_amount]`, String(unitAmount));
        params.append(`line_items[${idx}][quantity]`, String(q));
        idx++;
      }
    }
    if (idx === 0) return new Response("Aucun article dans la commande", { status: 400, headers: corsHeaders });

    const portMatch = (d["commande-details"] || "").match(/Port:\s*(\d+(?:[.,]\d+)?)\s*€/);
    const portEUR = portMatch ? parseFloat(portMatch[1].replace(",", ".")) : 0;
    if (portEUR > 0) {
      const portLabel = d.livraison ? `Livraison · ${d.livraison}` : "Frais de port";
      params.append(`line_items[${idx}][price_data][currency]`, "eur");
      params.append(`line_items[${idx}][price_data][product_data][name]`, portLabel);
      params.append(`line_items[${idx}][price_data][unit_amount]`, String(Math.round(portEUR * 100)));
      params.append(`line_items[${idx}][quantity]`, "1");
    }

    const META_KEYS = ["nom", "email", "telephone", "rue", "complement", "cp", "ville", "pays",
      "livraison", "paiement", "mr-relay-code", "mr-relay-info", "commande-details", "lien-etiquette",
      "qty-n1", "qty-n2", "qty-n3", "qty-n4", "qty-n5", "qty-n6", "qty-n7", "qty-n8", "qty-n9",
      "is-company", "company-name", "company-vat", "billing-same",
      "billing-rue", "billing-complement", "billing-cp", "billing-ville", "billing-pays"];
    META_KEYS.forEach((k) => {
      const v = d[k];
      if (v !== undefined && v !== null && v !== "") {
        params.append(`metadata[${k}]`, String(v).substring(0, 499));
      }
    });

    const resp = await fetch("https://api.stripe.com/v1/checkout/sessions", {
      method: "POST",
      headers: { "Authorization": "Bearer " + STRIPE_KEY, "Content-Type": "application/x-www-form-urlencoded" },
      body: params.toString(),
    });
    const data = await resp.json();
    if (!resp.ok) {
      console.error("Stripe error:", resp.status, JSON.stringify(data));
      return json(500, { error: data.error || "Stripe error" });
    }
    return json(200, { url: data.url, id: data.id });
  } catch (e) {
    console.error("create-stripe-session error:", e);
    return new Response("Server error: " + (e as Error).message, { status: 500, headers: corsHeaders });
  }
});
