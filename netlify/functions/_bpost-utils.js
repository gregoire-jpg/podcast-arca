// Utilitaires Bpost Shipping Manager Plug-in API (v3)
// API doc : https://pluginsapi.bpost.be/v3/apidocs/eng/
//
// Auth : HTTP Basic
//   - username = token (récupéré via POST /v3/keys avec la public key)
//   - password = base64(HMAC-SHA256(username + body, private_key))
//
// X-APPID : identifiant du plugin (Woo officiel = C6D32390-...). On le réutilise faute
// d'APPID custom Bpost (à demander à b2bsupport.parcel@bpost.be).

const crypto = require('crypto');

const BPOST_BASE   = 'https://pluginsapi.bpost.be';
const BPOST_APPID  = 'C6D32390-F48C-3D20-81F8-91932E7E4DE1';   // APPID Woo plugin officiel
const PLUGIN_VER   = '3.2.3';
const PLATFORM_VER = '6.5';

function publicKey()  { return process.env.BPOST_SM_PUBLIC_KEY; }
function privateKey() { return process.env.BPOST_SM_PRIVATE_KEY; }
function supaUrl()    { return process.env.SUPABASE_URL; }
function supaKey()    { return process.env.SUPABASE_SERVICE_KEY; }

// HMAC-SHA256(input, privateKey) → base64
function sign(username, body) {
  return crypto.createHmac('sha256', privateKey()).update(username + body).digest('base64');
}

// Authorization: Basic base64(username:hmac)
function basicAuth(username, body) {
  const sig = sign(username, body);
  return 'Basic ' + Buffer.from(username + ':' + sig).toString('base64');
}

// ─────────────────────────────────────────────────────────────
// Gestion du Token (cache dans Supabase arca.bpost_tokens)
// ─────────────────────────────────────────────────────────────

async function fetchStoredToken() {
  const r = await fetch(supaUrl() + '/rest/v1/arca_bpost_tokens?id=eq.1&select=token,expire_at', {
    headers: { apikey: supaKey(), Authorization: 'Bearer ' + supaKey() }
  });
  if (!r.ok) return null;
  const rows = await r.json();
  return rows && rows[0] || null;
}

async function saveToken(token, expire) {
  await fetch(supaUrl() + '/rest/v1/arca_bpost_tokens?id=eq.1', {
    method: 'PATCH',
    headers: {
      apikey: supaKey(), Authorization: 'Bearer ' + supaKey(),
      'Content-Type': 'application/json'
    },
    body: JSON.stringify({ token, expire_at: expire, updated_at: new Date().toISOString() })
  });
}

// POST /v3/keys avec public key → retourne un Token (~10 jours)
async function requestNewToken(shopUrl) {
  const body = JSON.stringify({
    PluginVersion: PLUGIN_VER,
    ShopUrl: shopUrl,
    PlatformVersion: PLATFORM_VER
  });
  const r = await fetch(BPOST_BASE + '/v3/keys', {
    method: 'POST',
    headers: {
      'X-APPID': BPOST_APPID,
      'Content-Type': 'application/json',
      'Accept': 'application/json',
      'Authorization': basicAuth(publicKey(), body)
    },
    body: body
  });
  const data = await r.json();
  if (!r.ok || !data.Key) {
    throw new Error('Bpost /v3/keys failed: ' + JSON.stringify(data).substring(0, 200));
  }
  return { token: data.Key, expire: data.Expire };
}

// Renvoie un token valide : depuis le cache si expire > now+2j, sinon en demande un nouveau
async function getValidToken(shopUrl) {
  const stored = await fetchStoredToken();
  if (stored && stored.token) {
    const expire = new Date(stored.expire_at + 'T00:00:00Z');
    const limit = new Date(Date.now() + 2 * 24 * 3600 * 1000); // dans 2 jours
    if (expire > limit) return stored.token;
  }
  const fresh = await requestNewToken(shopUrl);
  await saveToken(fresh.token, fresh.expire);
  console.log('[Bpost] Token renouvelé, expire', fresh.expire);
  return fresh.token;
}

// ─────────────────────────────────────────────────────────────
// Appel authentifié Bpost (avec token)
// ─────────────────────────────────────────────────────────────

async function bpostCall(method, path, body, token) {
  const bodyStr = body == null ? '' : (typeof body === 'string' ? body : JSON.stringify(body));
  const r = await fetch(BPOST_BASE + path, {
    method: method,
    headers: {
      'X-APPID': BPOST_APPID,
      'Content-Type': 'application/json',
      'Accept': 'application/json',
      'Authorization': basicAuth(token, bodyStr)
    },
    body: method === 'GET' ? undefined : bodyStr
  });
  const text = await r.text();
  let data;
  try { data = JSON.parse(text); } catch { data = text; }
  if (!r.ok) {
    throw new Error('Bpost ' + method + ' ' + path + ' → HTTP ' + r.status + ': ' + JSON.stringify(data).substring(0, 300));
  }
  return data;
}

// Vérifie une signature HMAC reçue de Bpost (pour les callbacks)
// Format documenté : hmac(status+","+tracking_id+","+callback_url, PRIVATE_KEY) base64
function verifyCallbackSignature(receivedSig, status, trackingId, callbackUrl) {
  const expected = crypto.createHmac('sha256', privateKey())
    .update(status + ',' + trackingId + ',' + callbackUrl).digest('base64');
  return crypto.timingSafeEqual(Buffer.from(receivedSig), Buffer.from(expected));
}

module.exports = {
  BPOST_BASE, BPOST_APPID,
  sign, basicAuth, getValidToken, bpostCall, verifyCallbackSignature,
  supaUrl, supaKey
};
