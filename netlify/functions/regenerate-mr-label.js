// Etiquette Mondial Relay pour une commande existante (admin only).
// POST { order_id: N, force?: true } -> { success, mr_expedition, mr_label_url, reused? }
//
// IMPORTANT — ANTI DOUBLE-FACTURATION :
// L'endpoint MR Connect v2 /api/Shipment est la SEULE methode dispo et chaque
// appel CREE une expedition => MR facture a chaque fois. Il n'existe aucun verbe
// "reprint". L'URL PDF renvoyee (outputField) est une URL GET statique (clef
// expedition + crc), valable tant que l'expedition existe : ce n'est PAS un token
// qui expire. Donc si la commande a deja une expedition + une URL stockee, on
// RENVOIE l'URL telle quelle, sans rappeler createLabel (= sans re-facturer).
// On ne (re)cree une expedition que si aucune n'existe encore, ou si force:true
// est explicitement passe (cas rare : URL stockee reellement corrompue).

const { createLabel } = require('./mr-label');

exports.handler = async function(event) {
  if (event.httpMethod === 'OPTIONS') {
    return { statusCode: 204, headers: corsHeaders(), body: '' };
  }
  if (event.httpMethod !== 'POST') {
    return json(405, { error: 'Method not allowed' });
  }

  const SUPABASE_URL = process.env.SUPABASE_URL;
  const SUPABASE_KEY = process.env.SUPABASE_SERVICE_KEY;
  if (!SUPABASE_URL || !SUPABASE_KEY) return json(500, { error: 'SUPABASE_* env vars manquantes' });

  let body;
  try { body = JSON.parse(event.body || '{}'); } catch (e) { return json(400, { error: 'Invalid JSON' }); }
  const orderId = parseInt(body.order_id, 10);
  if (!orderId) return json(400, { error: 'order_id requis' });

  // Charge la commande
  const fetchUrl = `${SUPABASE_URL}/rest/v1/arca_orders?id=eq.${orderId}&select=*`;
  const resp = await fetch(fetchUrl, {
    headers: { 'apikey': SUPABASE_KEY, 'Authorization': 'Bearer ' + SUPABASE_KEY }
  });
  if (!resp.ok) return json(500, { error: 'Erreur lecture Supabase: ' + resp.status });
  const rows = await resp.json();
  if (!rows.length) return json(404, { error: 'Commande introuvable' });
  const order = rows[0];

  if ((order.livraison || '').toLowerCase().indexOf('mondial') < 0) {
    return json(400, { error: "Cette commande n'est pas en livraison Mondial Relay" });
  }

  // ── Idempotence : etiquette deja generee → on renvoie l'URL stockee sans
  //    recreer d'expedition (chaque POST /api/Shipment est facture par MR).
  const force = body.force === true || body.force === 1 || body.force === '1';
  if (!force && order.mr_expedition && order.mr_label_url) {
    console.log('[regenerate-mr-label] orderId=' + orderId + ' etiquette deja existante (exp=' + order.mr_expedition + ') → reimpression URL stockee, AUCUNE nouvelle expedition MR creee.');
    return json(200, {
      success: true,
      mr_expedition: order.mr_expedition,
      mr_label_url: order.mr_label_url,
      reused: true
    });
  }

  if (!order.mr_relay_code) {
    return json(400, { error: 'Code point relais manquant sur la commande' });
  }

  // Reconstitue les champs au format attendu par createLabel
  const orderData = {
    nom:        order.nom,
    email:      order.email,
    telephone:  order.telephone,
    rue:        order.rue,
    complement: order.complement,
    cp:         order.cp,
    ville:      order.ville,
    pays:       order.pays,
    livraison:  order.livraison,
    'mr-relay-code': order.mr_relay_code,
    'mr-relay-info': order.mr_relay_info
  };
  // Quantites par numero -> qty-n1..qty-n9
  (order.items || []).forEach(function(it) {
    if (it && it.num) orderData['qty-n' + it.num] = String(it.qty || 0);
  });

  console.log('[regenerate-mr-label] CREATION expedition MR FACTUREE pour orderId=' + orderId + ' nom=' + order.nom + ' relay=' + order.mr_relay_code + (force ? ' (force=true)' : ' (1ere generation, pas d\'expedition existante)'));

  let label;
  try {
    label = await createLabel(orderData);
  } catch (e) {
    return json(500, { error: 'createLabel a leve une exception: ' + e.message });
  }
  if (!label || label.error) {
    return json(502, { error: label && label.error || 'Echec creation etiquette MR' });
  }

  const labelUrl = label.url_pdf || label.url_a6 || label.url_a4 || label.url_a5 || null;
  const expedition = label.expedition || null;

  // Update Supabase
  const patch = { mr_expedition: expedition, mr_label_url: labelUrl };
  const upResp = await fetch(`${SUPABASE_URL}/rest/v1/arca_orders?id=eq.${orderId}`, {
    method: 'PATCH',
    headers: {
      'apikey': SUPABASE_KEY,
      'Authorization': 'Bearer ' + SUPABASE_KEY,
      'Content-Type': 'application/json',
      'Prefer': 'return=minimal'
    },
    body: JSON.stringify(patch)
  });
  if (!upResp.ok) {
    const t = await upResp.text();
    console.error('Supabase update fail:', upResp.status, t);
    return json(500, { error: 'createLabel OK mais sauvegarde Supabase KO: ' + t.substring(0, 300) });
  }

  return json(200, { success: true, mr_expedition: expedition, mr_label_url: labelUrl });
};

function corsHeaders() {
  return {
    'Access-Control-Allow-Origin': '*',
    'Access-Control-Allow-Methods': 'POST, OPTIONS',
    'Access-Control-Allow-Headers': 'Content-Type'
  };
}
function json(status, body) {
  return { statusCode: status, headers: Object.assign({ 'Content-Type': 'application/json' }, corsHeaders()), body: JSON.stringify(body) };
}
