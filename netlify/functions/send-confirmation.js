// Renvoie le mail de confirmation pour une commande existante (admin).
// POST { order_id: N } -> { success: true, ... }
// Charge la commande depuis Supabase, reconstitue le payload form-data,
// appelle submission-created avec _no_persist=true pour éviter le doublon en BDD.

exports.handler = async function(event) {
  if (event.httpMethod === 'OPTIONS') {
    return { statusCode: 204, headers: cors(), body: '' };
  }
  if (event.httpMethod !== 'POST') return json(405, { error: 'Method not allowed' });

  const SUPABASE_URL = process.env.SUPABASE_URL;
  const SUPABASE_KEY = process.env.SUPABASE_SERVICE_KEY;
  if (!SUPABASE_URL || !SUPABASE_KEY) return json(500, { error: 'SUPABASE_* env vars manquantes' });

  let body;
  try { body = JSON.parse(event.body || '{}'); } catch (e) { return json(400, { error: 'Invalid JSON' }); }
  const orderId = parseInt(body.order_id, 10);
  if (!orderId) return json(400, { error: 'order_id requis' });

  // Charge la commande
  const resp = await fetch(`${SUPABASE_URL}/rest/v1/arca_orders?id=eq.${orderId}&select=*`, {
    headers: { 'apikey': SUPABASE_KEY, 'Authorization': 'Bearer ' + SUPABASE_KEY }
  });
  if (!resp.ok) return json(500, { error: 'Erreur lecture Supabase: ' + resp.status });
  const rows = await resp.json();
  if (!rows.length) return json(404, { error: 'Commande introuvable' });
  const o = rows[0];

  // Reconstitue le format form-data attendu par submission-created
  const data = formDataFromOrder(o);

  // Appel à submission-created avec _no_persist (évite la duplication en BDD)
  const host  = event.headers.host || 'podcast-arca.netlify.app';
  const proto = event.headers['x-forwarded-proto'] || 'https';
  const url = `${proto}://${host}/.netlify/functions/submission-created`;
  console.log('[send-confirmation] orderId=' + orderId + ' nom=' + o.nom + ' email=' + o.email);

  let r;
  try {
    r = await fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ form_name: 'commande-arca', data: data, _no_persist: true, _order_id: orderId })
    });
  } catch (e) {
    return json(502, { error: 'Appel submission-created échoué: ' + e.message });
  }
  const text = await r.text();
  if (!r.ok) {
    console.error('[send-confirmation] submission-created KO:', r.status, text.substring(0, 300));
    return json(502, { error: 'submission-created HTTP ' + r.status, body: text.substring(0, 200) });
  }

  return json(200, { success: true, message: 'Mail envoyé' });
};

function formDataFromOrder(o) {
  const d = {
    nom: o.nom || '',
    email: o.email || '',
    telephone: o.telephone || '',
    rue: o.rue || '',
    complement: o.complement || '',
    cp: o.cp || '',
    ville: o.ville || '',
    pays: o.pays || '',
    livraison: o.livraison || '',
    'mr-relay-code': o.mr_relay_code || '',
    'mr-relay-info': o.mr_relay_info || '',
    paiement: o.paiement || '',
    'paypal-order-id': o.stripe_session_id || o.paypal_order_id || '',
    'paypal-status': o.paye ? ('PAID — ' + (o.paiement || '')) : ''
  };
  for (let i = 1; i <= 9; i++) d['qty-n' + i] = '0';
  (o.items || []).forEach(function(it) {
    if (it && it.num) d['qty-n' + it.num] = String(it.qty || 0);
  });

  // Reconstruit commande-details (parsé par submission-created pour TOTAL/Port/Pack/Remises)
  let parts = [];
  (o.items || []).forEach(function(it) {
    parts.push(`${it.title} × ${it.qty} = ${it.qty * it.price} €`);
  });
  const sousTotal = (o.items || []).reduce(function(s, it){ return s + it.qty * it.price; }, 0);
  parts.push('Sous-total revues: ' + sousTotal + ' €');
  if (o.pack_discount_eur && o.pack_discount_eur > 0) parts.push('Pack complet -' + o.pack_discount_eur + ' €');
  if (o.discount_eur && o.discount_eur > 0) parts.push('Remise panier -' + o.discount_eur + ' €');
  if (o.shipping_discount_eur && o.shipping_discount_eur > 0) parts.push('Remise port -' + o.shipping_discount_eur + ' €');
  if (o.discount_note) parts.push('Motif remise: ' + o.discount_note);
  parts.push('Port: ' + (o.port_eur || 0) + ' €');
  parts.push('TOTAL: ' + (o.total_eur || sousTotal) + ' €');
  d['commande-details'] = parts.join(' | ');
  // Champs séparés pour faciliter le parsing
  d['_discount_eur'] = o.discount_eur || 0;
  d['_shipping_discount_eur'] = o.shipping_discount_eur || 0;
  d['_discount_note'] = o.discount_note || '';
  // Articles libres (hors catalogue) — passés à submission-created pour affichage dans les mails
  d['_custom_items'] = (o.items || []).filter(function(it){ return it && !it.num; });
  return d;
}

function cors() {
  return {
    'Access-Control-Allow-Origin': '*',
    'Access-Control-Allow-Methods': 'POST, OPTIONS',
    'Access-Control-Allow-Headers': 'Content-Type'
  };
}
function json(status, body) {
  return { statusCode: status, headers: Object.assign({ 'Content-Type': 'application/json' }, cors()), body: JSON.stringify(body) };
}
