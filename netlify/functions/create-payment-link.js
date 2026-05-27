// Crée un lien de paiement Stripe (ou PayPal) pour une commande existante.
// Utilisé par submission-created.js pour insérer un bouton "Payer en ligne" dans le mail de demande de paiement.
//
// POST { order_id, provider: 'stripe'|'paypal', amount_eur, label }
// → { url }

const STRIPE_API = "https://api.stripe.com/v1";

async function createStripePaymentLink(amountEur, label, orderId) {
  const STRIPE_KEY = process.env.STRIPE_SECRET_KEY;
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
  params.append("after_completion[redirect][url]", "https://arca-revue.com/merci/?paid=stripe&id=" + encodeURIComponent(orderId));
  params.append("payment_method_types[0]", "card");
  params.append("payment_method_types[1]", "bancontact");

  const resp = await fetch(STRIPE_API + "/payment_links", {
    method: "POST",
    headers: {
      "Authorization": "Bearer " + STRIPE_KEY,
      "Content-Type": "application/x-www-form-urlencoded"
    },
    body: params.toString()
  });
  const data = await resp.json();
  if (!resp.ok) throw new Error("Stripe " + (data.error && data.error.message || resp.status));
  return data.url;
}

// PayPal Order API : crée un ordre et renvoie l'URL approve
async function createPaypalOrder(amountEur, label, orderId) {
  const CLIENT = process.env.PAYPAL_CLIENT_ID;
  const SECRET = process.env.PAYPAL_CLIENT_SECRET;
  if (!CLIENT || !SECRET) throw new Error("PAYPAL_CLIENT_ID/SECRET manquant");

  // Token
  const tokenResp = await fetch("https://api-m.paypal.com/v1/oauth2/token", {
    method: "POST",
    headers: {
      "Authorization": "Basic " + Buffer.from(CLIENT + ":" + SECRET).toString("base64"),
      "Content-Type": "application/x-www-form-urlencoded"
    },
    body: "grant_type=client_credentials"
  });
  const tokenData = await tokenResp.json();
  if (!tokenResp.ok) throw new Error("PayPal token: " + (tokenData.error_description || tokenResp.status));

  // Order
  const orderResp = await fetch("https://api-m.paypal.com/v2/checkout/orders", {
    method: "POST",
    headers: {
      "Authorization": "Bearer " + tokenData.access_token,
      "Content-Type": "application/json"
    },
    body: JSON.stringify({
      intent: "CAPTURE",
      purchase_units: [{
        reference_id: String(orderId),
        description: (label || ("Commande ARCA #" + orderId)).substring(0, 127),
        amount: { currency_code: "EUR", value: amountEur.toFixed(2) }
      }],
      application_context: {
        brand_name: "Revue ARCA",
        landing_page: "LOGIN",
        user_action: "PAY_NOW",
        return_url: "https://arca-revue.com/merci/?paid=paypal&id=" + encodeURIComponent(orderId),
        cancel_url: "https://arca-revue.com/arca-revue/"
      }
    })
  });
  const orderData = await orderResp.json();
  if (!orderResp.ok) throw new Error("PayPal order: " + (orderData.message || orderResp.status));
  const approve = (orderData.links || []).find(l => l.rel === "approve");
  if (!approve) throw new Error("PayPal order créé mais pas d'URL approve");
  return approve.href;
}

exports.handler = async function(event) {
  if (event.httpMethod === "OPTIONS") return { statusCode: 204, headers: cors(), body: "" };
  if (event.httpMethod !== "POST") return json(405, { error: "Method not allowed" });

  let body;
  try { body = JSON.parse(event.body || "{}"); } catch (e) { return json(400, { error: "Invalid JSON" }); }
  const orderId = body.order_id;
  const provider = (body.provider || "stripe").toLowerCase();
  const amount = parseFloat(body.amount_eur);
  const label = body.label || ("Commande ARCA #" + orderId);
  if (!orderId || !amount || amount <= 0) return json(400, { error: "order_id et amount_eur requis" });

  try {
    let url;
    if (provider === "paypal") url = await createPaypalOrder(amount, label, orderId);
    else url = await createStripePaymentLink(amount, label, orderId);
    return json(200, { url, provider });
  } catch (e) {
    console.error("[create-payment-link]", e);
    return json(500, { error: e.message });
  }
};

// Export for direct use from submission-created.js (same Netlify functions runtime)
module.exports.createStripePaymentLink = createStripePaymentLink;
module.exports.createPaypalOrder = createPaypalOrder;

function cors() {
  return { "Access-Control-Allow-Origin": "*", "Access-Control-Allow-Methods": "POST, OPTIONS", "Access-Control-Allow-Headers": "Content-Type" };
}
function json(status, body) {
  return { statusCode: status, headers: Object.assign({ "Content-Type": "application/json" }, cors()), body: JSON.stringify(body) };
}
