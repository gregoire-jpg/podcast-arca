// Webhook Stripe — fiabilité de l'envoi d'email même si le client ferme l'onglet après paiement.
//
// Stripe envoie un POST signé HMAC à cette URL dès qu'un événement survient.
// On écoute uniquement "checkout.session.completed".
// On vérifie la signature, on récupère la session, on appelle submission-created.
//
// Configuration Stripe Dashboard :
//   - URL    : https://podcast-arca.netlify.app/.netlify/functions/stripe-webhook
//   - Events : checkout.session.completed
//   - Variable d'env : STRIPE_WEBHOOK_SECRET (whsec_xxx) — affichée à la création du webhook

const crypto = require('crypto');

exports.handler = async function(event) {
  if (event.httpMethod !== 'POST') {
    return { statusCode: 405, body: 'Method not allowed' };
  }

  const STRIPE_KEY     = process.env.STRIPE_SECRET_KEY;
  const WEBHOOK_SECRET = process.env.STRIPE_WEBHOOK_SECRET;
  if (!STRIPE_KEY || !WEBHOOK_SECRET) {
    console.error('[Stripe webhook] env vars manquantes');
    return { statusCode: 500, body: 'Config error' };
  }

  // 1. Vérification signature
  const sigHeader = event.headers['stripe-signature'] || event.headers['Stripe-Signature'];
  if (!sigHeader) return { statusCode: 400, body: 'Missing signature' };

  if (!verifyStripeSignature(event.body, sigHeader, WEBHOOK_SECRET)) {
    console.error('[Stripe webhook] signature invalide');
    return { statusCode: 400, body: 'Invalid signature' };
  }

  // 2. Parse event
  let evt;
  try { evt = JSON.parse(event.body); } catch (e) { return { statusCode: 400, body: 'Bad payload' }; }

  // 3. On ne traite que checkout.session.completed (les paiements PayPal sont gérés ailleurs)
  if (evt.type !== 'checkout.session.completed') {
    console.log('[Stripe webhook] event ignoré :', evt.type);
    return { statusCode: 200, body: 'Ignored' };
  }

  const session = evt.data && evt.data.object;
  if (!session || !session.id) {
    return { statusCode: 200, body: 'No session' };
  }

  if (session.payment_status !== 'paid') {
    console.log('[Stripe webhook] session non payée :', session.id, session.payment_status);
    return { statusCode: 200, body: 'Not paid' };
  }

  // 4. Reconstruction des données de commande depuis metadata
  const meta = session.metadata || {};
  const orderData = Object.assign({}, meta, {
    'paypal-order-id': session.id,
    'paypal-status': 'PAID — Stripe — ' + ((session.customer_details && session.customer_details.email) || '')
  });

  // ─── Détection paiement HORS TUNNEL ARCA ───
  // Si pas de metadata 'nom' (ou aucune metadata ARCA), c'est un paiement externe
  // (Payment Link manuel depuis Stripe Dashboard, autre interface, etc.)
  // → Ne PAS construire une commande ARCA vide. Juste notifier l'admin.
  if (!meta.nom) {
    console.log('[Stripe webhook] paiement HORS tunnel ARCA :', session.id);
    await notifyExternalStripePayment(session);
    return { statusCode: 200, body: 'External payment notified' };
  }

  console.log('[Stripe webhook] traitement session', session.id, 'pour', meta.nom || '?');

  // 5. Appel à submission-created (HTTP) — idempotence gérée côté submission-created
  try {
    const host  = event.headers.host || 'podcast-arca.netlify.app';
    const proto = event.headers['x-forwarded-proto'] || 'https';
    const submissionUrl = `${proto}://${host}/.netlify/functions/submission-created`;
    const fnResp = await fetch(submissionUrl, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ form_name: 'commande-arca', data: orderData })
    });
    if (!fnResp.ok) {
      const t = await fnResp.text();
      console.error('[Stripe webhook] submission-created KO :', fnResp.status, t.substring(0, 300));
    } else {
      console.log('[Stripe webhook] submission-created OK pour', session.id);
    }
  } catch (e) {
    console.error('[Stripe webhook] erreur appel submission-created :', e.message);
    // On renvoie 200 quand même : si on renvoie 500, Stripe va retry et on aura un effet de duplication.
    // L'erreur est loggée, on pourra rejouer manuellement si besoin.
  }

  return { statusCode: 200, body: 'OK' };
};

// Notifie l'admin d'un paiement Stripe reçu hors du tunnel ARCA
// (Payment Link Stripe Dashboard, donation externe, etc. — pas de metadata commande)
async function notifyExternalStripePayment(session) {
  const BREVO_KEY = process.env.BREVO_API_KEY;
  const TO_RAW = (process.env.ORDER_EMAIL_TO || '').split(',').map(s => s.trim()).filter(Boolean);
  const FROM_EMAIL = process.env.ORDER_EMAIL_FROM;
  if (!BREVO_KEY || !TO_RAW.length || !FROM_EMAIL) {
    console.warn('[Stripe webhook external] Brevo non configuré, skip notification');
    return;
  }
  const amount = ((session.amount_total || 0) / 100).toFixed(2);
  const currency = (session.currency || 'eur').toUpperCase();
  const email = (session.customer_details && session.customer_details.email) || '—';
  const name = (session.customer_details && session.customer_details.name) || '—';
  const subject = `💳 Paiement Stripe HORS TUNNEL · ${amount} ${currency} · ${name}`;
  const html = `<!DOCTYPE html><html><body style="font-family:Arial,sans-serif;background:#f5f5f5;margin:0;padding:20px;">
<div style="max-width:560px;margin:0 auto;background:#fff;border-radius:6px;overflow:hidden;border-top:4px solid #c8a060;">
  <div style="padding:18px 22px;background:#fffbf2;">
    <p style="margin:0;font:bold 11px Arial;letter-spacing:1.5px;text-transform:uppercase;color:#c8a060;">💳 Paiement Stripe — hors tunnel ARCA</p>
    <p style="margin:4px 0 0;font:bold 17px Georgia;color:#2d3461;">${amount} ${currency}</p>
  </div>
  <div style="padding:20px 22px;font:13px/1.5 Arial;color:#444;">
    <p style="margin:0 0 14px;">
      Un paiement a été reçu sur ton compte Stripe <strong>sans passer par le tunnel ARCA</strong>
      (probablement un Payment Link manuel ou une autre interface).
    </p>
    <p style="margin:0 0 6px;"><strong>Client</strong> : ${name}</p>
    <p style="margin:0 0 6px;"><strong>Email</strong> : <a href="mailto:${email}">${email}</a></p>
    <p style="margin:14px 0 0;font-size:11px;font-family:'Courier New',monospace;color:#888;">Session : ${session.id}</p>
    <p style="margin:14px 0 0;padding:10px;background:#fffbf2;border-radius:4px;font:13px/1.5 Arial;color:#555;font-style:italic;">
      Aucune commande n'a été créée en BDD car les métadonnées (nom, articles, adresse...) sont absentes.
      Si ce paiement correspond à une commande, crée-la manuellement dans l'admin ARCA et marque-la « payée ».
    </p>
    <p style="margin:14px 0 0;text-align:center;">
      <a href="https://dashboard.stripe.com/payments/${session.id}" style="display:inline-block;padding:10px 20px;background:#635bff;color:#fff;text-decoration:none;border-radius:4px;font-size:12px;font-weight:bold;">Voir dans Stripe Dashboard →</a>
    </p>
  </div>
</div></body></html>`;
  const text = `PAIEMENT STRIPE HORS TUNNEL ARCA\n\nMontant: ${amount} ${currency}\nClient: ${name}\nEmail: ${email}\nSession: ${session.id}\n\nAucune commande n'a été créée en BDD (métadonnées absentes).\nSi ce paiement correspond à une commande, crée-la manuellement dans l'admin et marque-la « payée ».\n\nDashboard: https://dashboard.stripe.com/payments/${session.id}`;

  const payload = {
    sender: { name: 'ARCA Commandes', email: FROM_EMAIL },
    to: TO_RAW.map(e => ({ email: e })),
    subject, htmlContent: html, textContent: text
  };
  if (email && email !== '—') payload.replyTo = { email, name: name === '—' ? '' : name };

  const resp = await fetch('https://api.brevo.com/v3/smtp/email', {
    method: 'POST',
    headers: { 'accept':'application/json', 'api-key': BREVO_KEY, 'Content-Type':'application/json' },
    body: JSON.stringify(payload)
  });
  if (!resp.ok) {
    const err = await resp.text();
    console.error('[Stripe webhook external] Brevo KO:', resp.status, err.substring(0, 200));
  } else {
    console.log('[Stripe webhook external] Notification envoyée pour', session.id);
  }
}

// Vérifie la signature Stripe (HMAC-SHA256 sur "<timestamp>.<payload>")
// Header format : "t=1234567890,v1=hexsig,v0=..."
function verifyStripeSignature(payload, sigHeader, secret) {
  const parts = sigHeader.split(',').reduce((acc, part) => {
    const [k, v] = part.split('=');
    if (k === 't') acc.timestamp = v;
    if (k === 'v1') (acc.signatures = acc.signatures || []).push(v);
    return acc;
  }, {});
  if (!parts.timestamp || !parts.signatures) return false;
  // Tolérance 5 min contre les replays
  const age = Math.abs(Date.now() / 1000 - parseInt(parts.timestamp, 10));
  if (age > 300) return false;
  const signedPayload = parts.timestamp + '.' + payload;
  const expected = crypto.createHmac('sha256', secret).update(signedPayload).digest('hex');
  return parts.signatures.some(s => safeCompare(s, expected));
}

function safeCompare(a, b) {
  if (a.length !== b.length) return false;
  try { return crypto.timingSafeEqual(Buffer.from(a, 'hex'), Buffer.from(b, 'hex')); } catch { return false; }
}
