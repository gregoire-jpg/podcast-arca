// bpost-label-token.js — Émet une URL signée courte (HMAC) pour
// récupérer l'étiquette PDF d'un shipment Bpost.
//
// L'admin (authentifié via ADMIN_PASSWORD) demande un token pour un cref ;
// on retourne une URL /bpost-fetch-label?ref=<cref>&exp=<ts>&sig=<hmac>
// qui sera ouverte dans un nouvel onglet. Le sig prouve que l'URL a été
// émise par cet endpoint pour ce cref précis et que l'expiration n'est
// pas encore passée — sans password en URL.
//
// Auth = ADMIN_PASSWORD. Secret HMAC = BPOST_LABEL_SECRET (env var).

const crypto = require('crypto');

const TOKEN_TTL_SEC = 600;  // 10 minutes — assez pour ouvrir l'onglet

exports.handler = async function (event) {
  if (event.httpMethod === 'OPTIONS') return { statusCode: 200, headers: cors(), body: '' };
  if (event.httpMethod !== 'POST')   return json(405, { error: 'Method Not Allowed' });

  let body;
  try { body = JSON.parse(event.body || '{}'); }
  catch { return json(400, { error: 'JSON invalide' }); }

  if (!body.password || body.password !== process.env.ADMIN_PASSWORD) {
    return json(401, { error: 'Mot de passe incorrect' });
  }
  const ref = body.ref;
  if (!ref || !/^ARCA-\d+(-r\d+)?$/.test(ref)) return json(400, { error: 'ref invalide' });

  const secret = process.env.BPOST_LABEL_SECRET || process.env.ADMIN_PASSWORD;
  if (!secret) return json(500, { error: 'BPOST_LABEL_SECRET non configuré' });

  const exp = Math.floor(Date.now() / 1000) + TOKEN_TTL_SEC;
  const sig = crypto.createHmac('sha256', secret).update(ref + '.' + exp).digest('hex');
  const url = '/.netlify/functions/bpost-fetch-label?ref=' + encodeURIComponent(ref) +
              '&exp=' + exp + '&sig=' + sig;

  return json(200, { url, expiresAt: exp });
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
    body: JSON.stringify(body),
  };
}
