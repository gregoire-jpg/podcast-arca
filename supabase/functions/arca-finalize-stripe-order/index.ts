// Edge Function — finalise une commande payée via Stripe Checkout.
// (Portée depuis netlify/functions/finalize-stripe-order.js.)
// Appelée par Stripe en success_url : GET ?session_id=cs_xxx
// 1. Vérifie la session (payment_status='paid'), 2. reconstruit la commande depuis metadata,
// 3. appelle arca-order-submit (email Brevo + étiquette MR + persistance), 4. redirige vers /merci.

import { arcaEnv } from "../_shared/env.ts";

function redirectTo(url: string): Response {
  return new Response("", { status: 302, headers: { Location: url } });
}

Deno.serve(async (req) => {
  const MERCI_URL = (arcaEnv("SITE_BASE") || "https://arca-revue.com") + "/merci/";
  const sessionId = new URL(req.url).searchParams.get("session_id");
  if (!sessionId) return new Response("session_id manquant", { status: 400 });

  try {
    const STRIPE_KEY = arcaEnv("STRIPE_SECRET_KEY");
    if (!STRIPE_KEY) return new Response("STRIPE_SECRET_KEY non configurée", { status: 500 });

    const sessResp = await fetch("https://api.stripe.com/v1/checkout/sessions/" + encodeURIComponent(sessionId), {
      headers: { "Authorization": "Bearer " + STRIPE_KEY },
    });
    const session = await sessResp.json();
    if (!sessResp.ok) {
      console.error("Stripe retrieve error:", sessResp.status, JSON.stringify(session));
      return redirectTo(MERCI_URL + "?paid=stripe-error&reason=retrieve");
    }
    console.log("[Stripe finalize] session", sessionId, "status:", session.payment_status);

    if (session.payment_status !== "paid") {
      return redirectTo(MERCI_URL + "?paid=stripe-pending&id=" + encodeURIComponent(sessionId));
    }

    const meta = session.metadata || {};
    // Pas de metadata 'nom' = paiement hors tunnel ARCA → on ne persiste pas (le webhook notifie Antoine).
    if (!meta.nom) {
      console.log("[finalize-stripe-order] Paiement HORS tunnel, skip order-submit :", sessionId);
      return redirectTo(MERCI_URL + "?paid=stripe&id=" + encodeURIComponent(sessionId));
    }

    const orderData = Object.assign({}, meta, {
      "paypal-order-id": sessionId,
      "paypal-status": "PAID — Stripe — " + ((session.customer_details && session.customer_details.email) || ""),
    });

    try {
      const submissionUrl = arcaEnv("FUNCTIONS_BASE") + "/arca-order-submit";
      const fnResp = await fetch(submissionUrl, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ form_name: "commande-arca", data: orderData }),
      });
      if (!fnResp.ok) console.error("arca-order-submit KO:", fnResp.status, await fnResp.text());
    } catch (e) {
      console.error("Erreur appel arca-order-submit:", (e as Error).message);
      // On continue la redirection (le paiement est encaissé).
    }

    return redirectTo(MERCI_URL + "?paid=stripe&id=" + encodeURIComponent(sessionId));
  } catch (e) {
    console.error("finalize-stripe-order error:", e);
    return redirectTo(MERCI_URL + "?paid=stripe-error&reason=" + encodeURIComponent((e as Error).message));
  }
});
