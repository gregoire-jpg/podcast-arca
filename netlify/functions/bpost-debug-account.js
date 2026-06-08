// bpost-debug-account.js — Endpoint diagnostic.
// Récupère :
//   - le token courant (et son scope ShopUrl)
//   - la liste des carriers autorisés (GET /v3/carriers/allowed/)
// Renvoyé en JSON brut côté admin pour qu'on voie EXACTEMENT ce que
// Bpost expose sur le compte ARCA.
//
// Auth = ADMIN_PASSWORD (même protection que les autres endpoints admin).

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

  try {
    const host = event.headers.host || 'podcast-arca.netlify.app';
    const fallbackShopUrl = 'https://' + host + '/.netlify/functions/bpost-callback';
    const shopUrl = process.env.BPOST_SHOP_URL || fallbackShopUrl;

    const token = await utils.getValidToken(shopUrl);
    const out = { shopUrl, tokenPreview: token.substring(0, 12) + '…' };

    try {
      out.carriersAllowed = await utils.fetchAllowedCarriers(token);
      out.carriersAllowedParsed = utils.extractCarrierArray(out.carriersAllowed);
    } catch (e) {
      out.carriersAllowedError = e.message;
    }

    // /v3/clients/ permet souvent de voir le compte rattaché à la clé
    try {
      out.client = await utils.bpostCall('GET', '/v3/clients/', null, token);
    } catch (e) {
      out.clientError = e.message;
    }

    // /v3/settings/ peut indiquer ShopUrl déclaré et autres
    try {
      out.settings = await utils.bpostCall('GET', '/v3/settings/', null, token);
    } catch (e) {
      out.settingsError = e.message;
    }

    return json(200, out);
  } catch (e) {
    return json(500, { error: e.message });
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
