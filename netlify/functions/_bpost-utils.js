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
  // shop_url stocké pour invalider le cache si on change la "boutique"
  // déclarée à Bpost. Plugin Woo officiel envoie get_home_url() (URL
  // canonique du site marchand) comme ShopUrl — c'est ce qui définit le
  // SCOPE dans lequel les shipments apparaissent côté SM web.
  // Le select tente shop_url ; si la colonne n'existe pas encore, on
  // retombe sur la version legacy sans.
  let r = await fetch(supaUrl() + '/rest/v1/arca_bpost_tokens?id=eq.1&select=token,expire_at,shop_url', {
    headers: { apikey: supaKey(), Authorization: 'Bearer ' + supaKey() }
  });
  if (!r.ok) {
    r = await fetch(supaUrl() + '/rest/v1/arca_bpost_tokens?id=eq.1&select=token,expire_at', {
      headers: { apikey: supaKey(), Authorization: 'Bearer ' + supaKey() }
    });
    if (!r.ok) return null;
  }
  const rows = await r.json();
  return rows && rows[0] || null;
}

async function saveToken(token, expire, shopUrl) {
  // PATCH avec shop_url d'abord ; si la colonne n'existe pas (400), retry
  // sans (legacy schema). Garantit que la fonction ne plante pas si la
  // migration BDD n'a pas encore été appliquée.
  const fullBody = { token, expire_at: expire, shop_url: shopUrl || null, updated_at: new Date().toISOString() };
  const minimalBody = { token, expire_at: expire, updated_at: new Date().toISOString() };
  const url = supaUrl() + '/rest/v1/arca_bpost_tokens?id=eq.1';
  const hdrs = {
    apikey: supaKey(), Authorization: 'Bearer ' + supaKey(),
    'Content-Type': 'application/json'
  };
  let r = await fetch(url, { method: 'PATCH', headers: hdrs, body: JSON.stringify(fullBody) });
  if (!r.ok) {
    console.warn('[Bpost] PATCH avec shop_url KO (' + r.status + '), retry sans');
    await fetch(url, { method: 'PATCH', headers: hdrs, body: JSON.stringify(minimalBody) });
  }
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

// Renvoie un token valide. Renouvelle si :
//  - pas de token en cache
//  - token expire dans <2 jours
//  - shopUrl demandé ≠ shop_url stocké (scope a changé)
async function getValidToken(shopUrl) {
  const stored = await fetchStoredToken();
  const scopeMatches = stored && stored.shop_url === shopUrl;
  if (stored && stored.token && scopeMatches) {
    const expire = new Date(stored.expire_at + 'T00:00:00Z');
    const limit = new Date(Date.now() + 2 * 24 * 3600 * 1000);
    if (expire > limit) return stored.token;
  }
  if (stored && !scopeMatches) {
    console.log('[Bpost] ShopUrl a changé (' + (stored.shop_url || 'null') + ' → ' + shopUrl + '), nouveau token');
  }
  const fresh = await requestNewToken(shopUrl);
  await saveToken(fresh.token, fresh.expire, shopUrl);
  console.log('[Bpost] Token renouvelé pour ShopUrl=' + shopUrl + ', expire', fresh.expire);
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
  const ctype = (r.headers.get('content-type') || '').toLowerCase();
  // Bpost peut renvoyer un PDF binaire directement (Content-Type:
  // application/pdf) sur POST /v3/labels — le PDF EST le résultat.
  if (ctype.includes('application/pdf') || ctype.includes('octet-stream')) {
    const buf = Buffer.from(await r.arrayBuffer());
    if (!r.ok) {
      throw new Error('Bpost ' + method + ' ' + path + ' → HTTP ' + r.status + ' (binaire ' + buf.length + 'B)');
    }
    return { __binary: true, contentType: ctype, buffer: buf };
  }
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

// ─────────────────────────────────────────────────────────────
// GET /v3/carriers/allowed/ — liste les carriers autorisés sur
// le contrat du compte. Doc Bpost très minimaliste sur la
// structure exacte de la réponse : on accepte plusieurs formes
// (Carrier[], CarrierList[], racine = array). Le caller adapte.
// ─────────────────────────────────────────────────────────────
async function fetchAllowedCarriers(token) {
  return bpostCall('GET', '/v3/carriers/allowed/', null, token);
}

function extractCarrierArray(resp) {
  if (!resp) return [];
  if (Array.isArray(resp)) return resp;
  if (Array.isArray(resp.Carrier)) return resp.Carrier;
  if (Array.isArray(resp.CarrierList)) return resp.CarrierList;
  if (Array.isArray(resp.AllowedCarrier)) return resp.AllowedCarrier;
  if (Array.isArray(resp.AllowedCarrierList)) return resp.AllowedCarrierList;
  // Si resp = un seul objet carrier
  if (resp.Id || resp.CarrierId) return [resp];
  return [];
}

module.exports = {
  BPOST_BASE, BPOST_APPID,
  sign, basicAuth, getValidToken, bpostCall, verifyCallbackSignature,
  fetchAllowedCarriers, extractCarrierArray,
  supaUrl, supaKey
};
