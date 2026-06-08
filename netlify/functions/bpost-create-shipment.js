// bpost-create-shipment.js — Crée un envoi Bpost via API XML Deep Integration.
//
// Input  : POST { order_id }
// Output : { ok, bpost_reference, bpost_status: "PENDING", message }
//
// Le shipment est créé chez Bpost en statut PENDING — aucune facturation
// tant que /bpost-print-label n'est pas appelé. Antoine peut le voir dans
// SM web → Pending orders.

const shm = require('./_bpost-shm.js');

const WEIGHTS = { 1:600, 2:600, 3:735, 4:565, 5:506, 6:600, 7:532, 8:600, 9:350 };
function computeWeightG(items) {
  let g = 0;
  (items || []).forEach(i => { g += (i.qty || 0) * (WEIGHTS[i.num] || 600); });
  return Math.max(g, 100);
}

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

    if (!process.env.BPOST_SHM_ACCOUNT_ID || !process.env.BPOST_SHM_PASSPHRASE) {
      return {
        statusCode: 503,
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          ok: false,
          error: 'Credentials Bpost SHM non configurées. Antoine doit fournir accountId + passphrase, à poser en env Netlify : BPOST_SHM_ACCOUNT_ID et BPOST_SHM_PASSPHRASE.'
        })
      };
    }

    const order = await loadOrder(order_id);
    const reference = 'ARCA-' + order.id;
    const weightG = computeWeightG(order.items);

    console.log('[Bpost SHM] create order', reference, '→', order.pays, '(', weightG, 'g)');
    const orderXml = shm.buildOrderXml(reference, order, weightG);
    console.log('[Bpost SHM] XML payload:', orderXml.substring(0, 500));

    try {
      await shm.createOrder(reference, orderXml);
    } catch (e) {
      // Si déjà existant (409), c'est OK : on continue avec la même ref
      if (/409/.test(e.message)) {
        console.log('[Bpost SHM] order', reference, 'existe déjà chez Bpost, OK');
      } else {
        throw e;
      }
    }

    await updateOrder(order_id, {
      bpost_reference:   reference,
      bpost_shipment_id: reference,
      bpost_status:      'PENDING',
      bpost_pushed_at:   new Date().toISOString()
    });

    return {
      statusCode: 200,
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        ok: true,
        bpost_reference: reference,
        bpost_status:    'PENDING',
        message: 'Envoi créé chez Bpost (réf ' + reference + ', statut PENDING). Clique "Imprimer étiquette" pour récupérer le PDF.'
      })
    };
  } catch (e) {
    console.error('[Bpost SHM create] erreur:', e.message);
    return {
      statusCode: 500,
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ ok: false, error: e.message })
    };
  }
};
