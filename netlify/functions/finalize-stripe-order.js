// Finalise une commande payée via Stripe Checkout.
// URL appelée par Stripe après paiement réussi (success_url) :
//   GET /.netlify/functions/finalize-stripe-order?session_id=cs_xxx
// 1. Vérifie la session côté Stripe (payment_status='paid')
// 2. Récupère les données de commande depuis metadata
// 3. Appelle submission-created (HTTP POST) pour envoyer le mail Brevo + étiquette MR
// 4. Redirige vers arca-revue.com/merci/?paid=stripe&id=...

const MERCI_URL = 'https://arca-revue.com/merci/';

exports.handler = async function(event) {
  const sessionId = (event.queryStringParameters || {}).session_id;
  if (!sessionId) {
    return { statusCode: 400, body: 'session_id manquant' };
  }

  try {
    const STRIPE_KEY = process.env.STRIPE_SECRET_KEY;
    if (!STRIPE_KEY) return { statusCode: 500, body: 'STRIPE_SECRET_KEY non configurée' };

    // 1. Récupération de la session Stripe
    const sessResp = await fetch('https://api.stripe.com/v1/checkout/sessions/' + encodeURIComponent(sessionId), {
      method: 'GET',
      headers: { 'Authorization': 'Bearer ' + STRIPE_KEY }
    });
    const session = await sessResp.json();
    if (!sessResp.ok) {
      console.error('Stripe retrieve error:', sessResp.status, JSON.stringify(session));
      return redirectTo(MERCI_URL + '?paid=stripe-error&reason=retrieve');
    }
    console.log('[Stripe finalize] session', sessionId, 'status:', session.payment_status);

    if (session.payment_status !== 'paid') {
      // Paiement pas finalisé — on redirige vers merci avec un statut "en attente"
      return redirectTo(MERCI_URL + '?paid=stripe-pending&id=' + encodeURIComponent(sessionId));
    }

    // 2. Reconstruction des données de commande depuis metadata
    const meta = session.metadata || {};
    const orderData = Object.assign({}, meta, {
      'paypal-order-id': sessionId,
      'paypal-status': 'PAID — Stripe — ' + (session.customer_details && session.customer_details.email || '')
    });

    // 3. Appel à submission-created pour declencher l email + l etiquette MR
    try {
      const host = event.headers.host || 'podcast-arca.netlify.app';
      const proto = (event.headers['x-forwarded-proto'] || 'https');
      const submissionUrl = `${proto}://${host}/.netlify/functions/submission-created`;
      const fnResp = await fetch(submissionUrl, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ form_name: 'commande-arca', data: orderData })
      });
      if (!fnResp.ok) {
        const t = await fnResp.text();
        console.error('submission-created KO:', fnResp.status, t);
      }
    } catch (e) {
      console.error('Erreur appel submission-created:', e.message);
      // On continue quand même la redirection (le paiement est encaissé)
    }

    // 4. Redirection finale vers la page merci sur arca-revue.com
    return redirectTo(MERCI_URL + '?paid=stripe&id=' + encodeURIComponent(sessionId));
  } catch (e) {
    console.error('finalize-stripe-order error:', e);
    return redirectTo(MERCI_URL + '?paid=stripe-error&reason=' + encodeURIComponent(e.message));
  }
};

function redirectTo(url) {
  return { statusCode: 302, headers: { Location: url }, body: '' };
}
