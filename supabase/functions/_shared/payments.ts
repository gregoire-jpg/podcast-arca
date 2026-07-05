// Liens de paiement Stripe / PayPal — module partagé (porté depuis create-payment-link.js).
// Appelé par arca-create-payment-link et arca-order-submit.

import { arcaEnv } from "./env.ts";

const STRIPE_API = "https://api.stripe.com/v1";

function siteBase() { return arcaEnv("SITE_BASE") || "https://arca-revue.com"; }
function fnBase() { return arcaEnv("FUNCTIONS_BASE"); }

export async function createStripePaymentLink(amountEur: number, label: string, orderId: string | number): Promise<string> {
  const STRIPE_KEY = arcaEnv("STRIPE_SECRET_KEY");
  if (!STRIPE_KEY) throw new Error("STRIPE_SECRET_KEY manquant");

  const amountCents = Math.round(amountEur * 100);
  const params = new URLSearchParams();
  params.append("line_items[0][price_data][currency]", "eur");
  params.append("line_items[0][price_data][unit_amount]", String(amountCents));
  params.append("line_items[0][price_data][product_data][name]", label || ("Commande ARCA #" + orderId));
  params.append("line_items[0][quantity]", "1");
  params.append("metadata[order_id]", String(orderId));
  params.append("metadata[source]", "admin_manual");
  params.append("after_completion[type]", "redirect");
  params.append("after_completion[redirect][url]", siteBase() + "/merci/?paid=stripe&id=" + encodeURIComponent(String(orderId)));
  params.append("payment_method_types[0]", "card");
  params.append("payment_method_types[1]", "bancontact");

  const resp = await fetch(STRIPE_API + "/payment_links", {
    method: "POST",
    headers: { "Authorization": "Bearer " + STRIPE_KEY, "Content-Type": "application/x-www-form-urlencoded" },
    body: params.toString(),
  });
  const data = await resp.json();
  if (!resp.ok) throw new Error("Stripe " + ((data.error && data.error.message) || resp.status));
  return data.url;
}

export async function createPaypalOrder(amountEur: number, label: string, orderId: string | number): Promise<string> {
  const CLIENT = arcaEnv("PAYPAL_CLIENT_ID");
  const SECRET = arcaEnv("PAYPAL_CLIENT_SECRET");
  if (!CLIENT || !SECRET) throw new Error("PAYPAL_CLIENT_ID/SECRET manquant");

  const tokenResp = await fetch("https://api-m.paypal.com/v1/oauth2/token", {
    method: "POST",
    headers: {
      "Authorization": "Basic " + btoa(CLIENT + ":" + SECRET),
      "Content-Type": "application/x-www-form-urlencoded",
    },
    body: "grant_type=client_credentials",
  });
  const tokenData = await tokenResp.json();
  if (!tokenResp.ok) throw new Error("PayPal token: " + (tokenData.error_description || tokenResp.status));

  const orderResp = await fetch("https://api-m.paypal.com/v2/checkout/orders", {
    method: "POST",
    headers: { "Authorization": "Bearer " + tokenData.access_token, "Content-Type": "application/json" },
    body: JSON.stringify({
      intent: "CAPTURE",
      purchase_units: [{
        reference_id: String(orderId),
        description: (label || ("Commande ARCA #" + orderId)).substring(0, 127),
        amount: { currency_code: "EUR", value: amountEur.toFixed(2) },
      }],
      application_context: {
        brand_name: "Revue ARCA",
        landing_page: "LOGIN",
        user_action: "PAY_NOW",
        // return_url → notre function paypal-capture qui capture + finalise la commande
        return_url: fnBase() + "/arca-paypal-capture",
        cancel_url: siteBase() + "/arca-revue/",
      },
    }),
  });
  const orderData = await orderResp.json();
  if (!orderResp.ok) throw new Error("PayPal order: " + (orderData.message || orderResp.status));
  const approve = (orderData.links || []).find((l: any) => l.rel === "approve");
  if (!approve) throw new Error("PayPal order créé mais pas d'URL approve");
  return approve.href;
}
