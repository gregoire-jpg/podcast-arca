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
