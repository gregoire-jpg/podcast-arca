// bpost-activate-carrier.js — Diagnostic + activation Carrier 68.
//
// D'après la doc Bpost Plug-in API v3 (vérifiée par workflow d'investigation) :
//   POST /v3/carriers/carrier/{id} body vide → active le carrier sur le
//   compte ARCA. Sans cet appel, le carrier est "allowed" (autorisé par
//   bpost) mais pas "activated" → shipments reçus mais jamais matérialisés.
//
// Cet endpoint :
//   1. POST /v3/carriers/carrier/68 (body vide) → active
//   2. POST /v3/carriers/carrier/71 (body vide) → active SML aussi
//   3. GET /v3/carriers/ → liste des carriers RÉELLEMENT utilisables
//   4. GET /v3/rules/ → liste des rules existantes (vérifier qu'elles
//      sont bien là côté API, pas juste côté SM web)
//   5. GET /v3/settings/ → si dispo, dump settings

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

  const host = event.headers.host || 'podcast-arca.netlify.app';
  const shopUrl = process.env.BPOST_SHOP_URL || ('https://' + host + '/.netlify/functions/bpost-callback');
  const out = { shopUrl };

  try {
    const token = await utils.getValidToken(shopUrl);
    out.tokenPreview = token.substring(0, 12) + '…';

    // 1. POST /v3/carriers/carrier/68 — active le Carrier shm
    try {
      out.activateCarrier68 = await utils.bpostCall('POST', '/v3/carriers/carrier/68', null, token);
    } catch (e) {
      out.activateCarrier68Error = e.message;
    }

    // 2. POST /v3/carriers/carrier/71 — active aussi le SML
    try {
      out.activateCarrier71 = await utils.bpostCall('POST', '/v3/carriers/carrier/71', null, token);
    } catch (e) {
      out.activateCarrier71Error = e.message;
    }

    // 3. GET /v3/carriers/ — carriers réellement utilisables
    try {
      out.carriersActive = await utils.bpostCall('GET', '/v3/carriers/', null, token);
    } catch (e) {
      out.carriersActiveError = e.message;
    }

    // 4. GET /v3/rules/ — liste des rulebookTypeIds disponibles
    try {
      out.rulesIndex = await utils.bpostCall('GET', '/v3/rules/', null, token);
    } catch (e) {
      out.rulesIndexError = e.message;
    }

    // 5. GET /v3/rules/rule/1 — Shipment rules (type 1)
    try {
      out.shipmentRules = await utils.bpostCall('GET', '/v3/rules/rule/1', null, token);
    } catch (e) {
      out.shipmentRulesError = e.message;
    }

    // 6. GET /v3/rules/rule/2 — Service rules (type 2)
    try {
      out.serviceRules = await utils.bpostCall('GET', '/v3/rules/rule/2', null, token);
    } catch (e) {
      out.serviceRulesError = e.message;
    }

    // 7. GET /v3/rules/rule/3 — Checkout rules (type 3)
    try {
      out.checkoutRules = await utils.bpostCall('GET', '/v3/rules/rule/3', null, token);
    } catch (e) {
      out.checkoutRulesError = e.message;
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
    headers: Object.assign({ 'Content-Type': 'application/json', 'Cache-Control': 'private, no-store' }, cors()),
    body: JSON.stringify(body, null, 2),
  };
}
