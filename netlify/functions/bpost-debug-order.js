// bpost-debug-order.js — Diagnostic profond d'une commande.
// Input : POST { password, order_id }
// Output : dump JSON brut de :
//   - état BDD (bpost_shipment_id, bpost_reference, bpost_label_url…)
//   - GET /v3/shipments/newsince/<n>/<date>  → est-ce que Bpost connaît le shipment ?
//   - GET /v3/shipments/<cref>               → status du shipment
//   - POST /v3/labels avec ClientReferenceCodeList=[cref]  → réponse brute
//   - GET /v3/tracking/<cref>                → barcode + statut suivi
//   - Si CallbackURL fourni : un poll direct
//
// Utile quand le PDF n'arrive pas pour voir où exactement ça coince.

const utils = require('./_bpost-utils.js');

exports.handler = async function (event) {
  if (event.httpMethod === 'OPTIONS') return { statusCode: 200, headers: cors(), body: '' };
  if (event.httpMethod !== 'POST')   return json(405, { error: 'Method Not Allowed' });

  let body;
  try { body = JSON.parse(event.body || '{}'); }
  catch { return json(400, { error: 'JSON invalide' }); }

  if (!body.password || body.password !== process.env.ADMIN_PASSWORD) {
    return json(401, { error: 'Mot de passe incorrect' });
  }
  if (!body.order_id) return json(400, { error: 'order_id manquant' });

  const order_id = body.order_id;
  const out = { order_id };

  try {
    // 1) État BDD
    const r = await fetch(utils.supaUrl() +
      '/rest/v1/arca_orders?id=eq.' + order_id +
      '&select=id,nom,pays,bpost_shipment_id,bpost_reference,bpost_label_url,bpost_status,bpost_pushed_at',
      { headers: { apikey: utils.supaKey(), Authorization: 'Bearer ' + utils.supaKey() } });
    const rows = await r.json();
    out.bdd = rows && rows[0] || null;

    // 2) Token
    const host = event.headers.host || 'podcast-arca.netlify.app';
    const shopUrl = process.env.BPOST_SHOP_URL || ('https://' + host + '/.netlify/functions/bpost-callback');
    const token = await utils.getValidToken(shopUrl);
    out.shopUrl = shopUrl;
    out.tokenPreview = token.substring(0, 12) + '…';

    // crefs à tester : celui en BDD + variantes
    const crefs = [];
    if (out.bdd && out.bdd.bpost_reference) crefs.push(out.bdd.bpost_reference);
    crefs.push('ARCA-' + order_id);
    for (let i = 1; i <= 3; i++) crefs.push('ARCA-' + order_id + '-r' + i);
    // dédoublonne
    out.crefsTested = [...new Set(crefs)];

    // 3) GET /v3/shipments/newsince/<n>/<date> — listes des shipments récents
    //    pour voir si Bpost connaît le nôtre
    const since = '2026-06-01T00:00:00Z';
    try {
      out.shipmentsNewSince = await utils.bpostCall('GET', '/v3/shipments/newsince/0/' + since, null, token);
    } catch (e) {
      out.shipmentsNewSinceError = e.message;
    }

    // 4) Pour chaque cref : GET shipment, POST labels, GET tracking
    out.perCref = {};
    for (const cref of out.crefsTested) {
      const r = {};

      // GET /v3/shipments/{cref}
      try {
        r.shipmentInfo = await utils.bpostCall('GET', '/v3/shipments/' + encodeURIComponent(cref), null, token);
      } catch (e) {
        r.shipmentInfoError = e.message;
      }

      // POST /v3/labels
      try {
        r.labelsResp = await utils.bpostCall('POST', '/v3/labels/', {
          ClientReferenceCodeList: [cref],
          LabelStart: 1,
          LabelType: 0
        }, token);
        // Si CallbackURL fourni, on poll une fois
        const cbUrl = r.labelsResp && (r.labelsResp.CallbackURL || r.labelsResp.CallbackUrl);
        if (cbUrl) {
          await new Promise(rs => setTimeout(rs, 1500));
          try {
            r.callbackPoll = await utils.bpostCall('GET', new URL(cbUrl).pathname, null, token);
          } catch (e) {
            r.callbackPollError = e.message;
          }
        }
      } catch (e) {
        r.labelsRespError = e.message;
      }

      // GET /v3/tracking/{cref}
      try {
        r.tracking = await utils.bpostCall('GET', '/v3/tracking/' + encodeURIComponent(cref), null, token);
      } catch (e) {
        r.trackingError = e.message;
      }

      out.perCref[cref] = r;
    }

    return json(200, out);
  } catch (e) {
    out.fatalError = e.message;
    return json(500, out);
  }
};

function cors() {
  return {
    'Access-Control-Allow-Origin':  '*',
    'Access-Control-Allow-Headers': 'Content-Type',
    'Access-Control-Allow-Methods': 'POST, OPTIONS',
  };
}
function json(status, body) {
  return {
    statusCode: status,
    headers: Object.assign({ 'Content-Type': 'application/json', 'Cache-Control': 'no-store' }, cors()),
    body: JSON.stringify(body, null, 2),
  };
}
