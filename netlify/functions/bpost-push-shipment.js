// Bpost — préparation côté admin pour saisie manuelle dans SM web.
//
// HISTORIQUE 2026-06-05 → 2026-06-08 : tentative d'intégration via
// Plug-in API v3 (pluginsapi.bpost.be) abandonnée. POST /v3/shipments
// retourne 200 mais le shipment n'est jamais matérialisé côté SM web
// d'Antoine (compteur "Imprimé(s) aujourd'hui" jamais incrémenté par
// nos pushes), et POST /v3/labels renvoie systématiquement
// "Invalid service level code: 1" quelle que soit la config (Product
// 302/303 explicite ou laissé aux Shipping rules, ShopItemId hex ou
// non, Carrier 68 seul ou avec OptionList). Probablement un manque
// de contrat backend Bpost côté ARCA — pas un bug code.
//
// WORKFLOW ACTUEL : on ne pousse plus rien à Bpost via API. Le bouton
// admin marque la commande comme "à préparer dans SM web", l'admin
// ouvre shippingmanager.bpost.be dans un onglet (avec les infos de
// livraison dans le presse-papier pour copier-coller rapide). Une
// fois l'étiquette imprimée dans SM web, l'admin clique
// "Traitée manuellement".
//
// MIGRATION future possible : API XML deep integration
// (api-parcel.bpost.be/services/shm/) — nécessite accountId + passphrase
// à demander à esolutions@bpost.be. Cf. project_tunnel_arca.md.

async function loadOrder(orderId) {
  const r = await fetch(process.env.SUPABASE_URL + '/rest/v1/arca_orders?id=eq.' + orderId + '&select=*', {
    headers: {
      apikey: process.env.SUPABASE_SERVICE_KEY,
      Authorization: 'Bearer ' + process.env.SUPABASE_SERVICE_KEY
    }
  });
  const rows = await r.json();
  if (!rows || !rows[0]) throw new Error('Order ' + orderId + ' not found');
  return rows[0];
}

async function updateOrder(orderId, fields) {
  await fetch(process.env.SUPABASE_URL + '/rest/v1/arca_orders?id=eq.' + orderId, {
    method: 'PATCH',
    headers: {
      apikey: process.env.SUPABASE_SERVICE_KEY,
      Authorization: 'Bearer ' + process.env.SUPABASE_SERVICE_KEY,
      'Content-Type': 'application/json'
    },
    body: JSON.stringify(fields)
  });
}

exports.handler = async function (event) {
  if (event.httpMethod !== 'POST') return { statusCode: 405, body: 'Method not allowed' };

  try {
    const { order_id } = JSON.parse(event.body || '{}');
    if (!order_id) return { statusCode: 400, body: 'order_id manquant' };

    const order = await loadOrder(order_id);
    const cref = 'ARCA-' + order.id;

    // Marque la commande comme "à préparer dans SM web". L'admin va
    // ensuite ouvrir SM web avec ces infos pour saisie manuelle.
    await updateOrder(order_id, {
      bpost_reference: cref,
      bpost_label_url: 'manual:shipping-manager:' + cref,
      bpost_status:    'to-print-in-sm',
      bpost_pushed_at: new Date().toISOString()
    });

    // Récap des infos pour copier-coller dans SM web
    const lines = [
      'Nom: ' + (order.nom || ''),
      'Adresse: ' + (order.rue || '') + (order.complement ? ' (' + order.complement + ')' : ''),
      'CP / Ville: ' + (order.cp || '') + ' ' + (order.ville || ''),
      'Pays: ' + (order.pays || ''),
      'Email: ' + (order.email || ''),
      'Téléphone: ' + (order.telephone || ''),
      'Référence: ' + cref
    ];

    return {
      statusCode: 200,
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        ok: true,
        bpost_reference: cref,
        bpost_label_url: 'manual:shipping-manager:' + cref,
        clipboard_text: lines.join('\n'),
        sm_url: 'https://shippingmanager.bpost.be/',
        message: 'Infos copiées. Ouvre Shipping Manager web → New shipment → colle les infos → imprime.'
      })
    };
  } catch (e) {
    console.error('[Bpost] erreur:', e.message);
    return {
      statusCode: 500,
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ ok: false, error: e.message })
    };
  }
};
