// Capture automatique d'un ordre PayPal après que le client a approuvé le paiement.
// Le return_url des ordres PayPal créés via create-payment-link.js pointe ici.
//
// Flow :
//   1. Client clique le bouton PayPal dans le mail → page PayPal → approuve
//   2. PayPal redirige : /.netlify/functions/paypal-capture?token=<order_id>&PayerID=...
//   3. Cette function :
//      - GET /v2/checkout/orders/{token}  → vérifie status APPROVED + récupère reference_id (= notre order_id ARCA)
//      - POST /v2/checkout/orders/{token}/capture  → finalise le paiement
//      - PATCH Supabase arca_orders : paye=true, paid_at, paypal_order_id, paiement="PayPal"
//      - Notifie l'admin par mail
//      - Redirige client vers /merci/?paid=paypal&id=X
//
// Pas de webhook PayPal nécessaire : on profite de la redirection naturelle après paiement.

exports.handler = async function(event) {
  const token = (event.queryStringParameters || {}).token;
  if (!token) return htmlError(400, "Token PayPal manquant dans l'URL.");

  const CLIENT = process.env.PAYPAL_CLIENT_ID;
  const SECRET = process.env.PAYPAL_CLIENT_SECRET;
  const SB_URL = process.env.SUPABASE_URL;
  const SB_KEY = process.env.SUPABASE_SERVICE_KEY;
  if (!CLIENT || !SECRET) return htmlError(500, "PayPal non configuré.");

  try {
    // 1. Get access token
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
    const accessToken = tokenData.access_token;

    // 2. Get order details to find our internal order_id (= reference_id)
    const orderResp = await fetch(`https://api-m.paypal.com/v2/checkout/orders/${encodeURIComponent(token)}`, {
      headers: { "Authorization": "Bearer " + accessToken }
    });
    const orderData = await orderResp.json();
    if (!orderResp.ok) throw new Error("PayPal order get: " + (orderData.message || orderResp.status));
    const refId = orderData.purchase_units && orderData.purchase_units[0] && orderData.purchase_units[0].reference_id;
    const amount = orderData.purchase_units && orderData.purchase_units[0] && orderData.purchase_units[0].amount && orderData.purchase_units[0].amount.value;

    if (orderData.status === "COMPLETED") {
      // Déjà capturé (double clic ou retry)
      console.log("[paypal-capture] order " + token + " déjà COMPLETED, on marque juste comme payé en BDD");
    } else if (orderData.status !== "APPROVED") {
      // Pas approuvé → on ne capture pas
      return htmlMessage("Paiement non finalisé", `Le paiement PayPal est en statut <strong>${orderData.status}</strong>. Réessayez ou contactez antoine@arca-librairie.com.`);
    } else {
      // 3. Capture
      const capResp = await fetch(`https://api-m.paypal.com/v2/checkout/orders/${encodeURIComponent(token)}/capture`, {
        method: "POST",
        headers: {
          "Authorization": "Bearer " + accessToken,
          "Content-Type": "application/json",
          "Prefer": "return=representation"
        }
      });
      const capData = await capResp.json();
      if (!capResp.ok) throw new Error("PayPal capture: " + (capData.message || capResp.status));
      console.log("[paypal-capture] capturé order " + token + " status=" + capData.status);
    }

    // 4. PATCH Supabase pour marquer la commande payée
    if (refId && SB_URL && SB_KEY) {
      try {
        const patch = await fetch(`${SB_URL}/rest/v1/arca_orders?id=eq.${encodeURIComponent(refId)}`, {
          method: "PATCH",
          headers: {
            "apikey": SB_KEY,
            "Authorization": "Bearer " + SB_KEY,
            "Content-Type": "application/json",
            "Prefer": "return=representation"
          },
          body: JSON.stringify({
            paye: true,
            paid_at: new Date().toISOString(),
            paypal_order_id: token,
            paiement: "PayPal"
          })
        });
        if (!patch.ok) {
          const t = await patch.text();
          console.error("[paypal-capture] Supabase PATCH KO:", patch.status, t.substring(0, 300));
        } else {
          const rows = await patch.json();
          const order = Array.isArray(rows) ? rows[0] : rows;
          console.log("[paypal-capture] order #" + refId + " marquée payée (" + (order && order.nom) + ")");
          // 5. Notif admin
          await notifyOrderPaid(order, token, amount);
        }
      } catch (e) {
        console.error("[paypal-capture] erreur Supabase:", e.message);
      }
    }

    // 6. Redirige vers la page merci
    const redirectUrl = `https://arca-revue.com/merci/?paid=paypal&id=${encodeURIComponent(refId || '')}`;
    return {
      statusCode: 302,
      headers: { Location: redirectUrl },
      body: ""
    };
  } catch (e) {
    console.error("[paypal-capture]", e);
    return htmlError(500, "Erreur lors de la finalisation du paiement : " + e.message);
  }
};

async function notifyOrderPaid(order, paypalOrderId, amount) {
  const BREVO_KEY = process.env.BREVO_API_KEY;
  const TO_RAW = (process.env.ORDER_EMAIL_TO || '').split(',').map(s => s.trim()).filter(Boolean);
  const FROM_EMAIL = process.env.ORDER_EMAIL_FROM;
  if (!BREVO_KEY || !TO_RAW.length || !FROM_EMAIL || !order) return;
  const subject = `✅ PAYÉ · Commande ARCA #${order.id} · ${amount} € · ${order.nom || ''} (PayPal)`;
  const html = `<!DOCTYPE html><html><body style="font-family:Arial,sans-serif;background:#f5f5f5;padding:20px">
<div style="max-width:560px;margin:0 auto;background:#fff;border-radius:6px;border-top:4px solid #2a7a2a;padding:22px">
  <p style="margin:0 0 6px;font:bold 11px Arial;letter-spacing:1.5px;text-transform:uppercase;color:#2a7a2a">✅ Paiement PayPal reçu</p>
  <p style="margin:0 0 14px;font:bold 18px Georgia;color:#2d3461">Commande #${order.id} marquée payée — ${amount} €</p>
  <p style="margin:0 0 6px"><strong>Client</strong> : ${esc(order.nom || '')}</p>
  <p style="margin:0 0 6px"><strong>Email</strong> : ${esc(order.email || '')}</p>
  <p style="margin:0 0 6px"><strong>Livraison</strong> : ${esc(order.livraison || '')}</p>
  <p style="margin:14px 0 0;font-size:11px;font-family:'Courier New',monospace;color:#888">PayPal Order ID : ${esc(paypalOrderId)}</p>
</div></body></html>`;
  await fetch('https://api.brevo.com/v3/smtp/email', {
    method: 'POST',
    headers: { 'accept': 'application/json', 'api-key': BREVO_KEY, 'Content-Type': 'application/json' },
    body: JSON.stringify({
      sender: { name: 'ARCA Commandes', email: FROM_EMAIL },
      to: TO_RAW.map(e => ({ email: e })),
      subject, htmlContent: html
    })
  }).catch(e => console.error('[paypal-capture notifyOrderPaid] Brevo error:', e.message));
}

function esc(s) { return String(s||'').replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;'); }

function htmlError(status, msg) {
  return htmlMessage("Erreur paiement", msg, status);
}

function htmlMessage(title, msg, status) {
  return {
    statusCode: status || 200,
    headers: { 'Content-Type': 'text/html; charset=utf-8' },
    body: `<!DOCTYPE html><html lang="fr"><head><meta charset="UTF-8"><title>${esc(title)}</title>
<style>body{font-family:Georgia,serif;background:#f4f2ef;margin:0;padding:60px 20px;text-align:center;color:#2d3461}
.box{max-width:540px;margin:0 auto;background:#fff;padding:40px;border-radius:8px;box-shadow:0 4px 20px rgba(0,0,0,.08)}
h1{font:normal 1.8em/1.2 Georgia;margin-bottom:20px}
p{font:1.05em/1.6 Georgia;color:#444}
a{color:#c8a060;text-decoration:none;font-weight:bold}</style>
</head><body><div class="box"><h1>${esc(title)}</h1><p>${msg}</p>
<p style="margin-top:30px"><a href="https://arca-revue.com/">← Retour à la revue ARCA</a></p>
</div></body></html>`
  };
}
