// dropbox-token.js — Émet un access_token Dropbox court (4h) pour permettre
// au navigateur de l'admin d'uploader DIRECTEMENT vers Dropbox, sans passer
// par les Netlify Functions (limite payload 6 MB).
//
// Architecture :
//   Admin (browser)
//     1. POST /dropbox-token  { password }  →  { access_token, expires_in }
//     2. PUT https://content.dropboxapi.com/2/files/upload  (binaire direct)
//     3. POST https://api.dropboxapi.com/2/sharing/create_shared_link_with_settings
//
// Le token retourné porte les scopes de l'app Dropbox (files.content.write +
// sharing.write — déjà restreints à ce dont l'admin a besoin). Sa durée de
// vie courte (≈4h) limite l'exposition si jamais il était intercepté.
//
// Le password est validé contre ADMIN_PASSWORD — c'est la même protection
// que save-file et upload-doc.

exports.handler = async function (event) {
  if (event.httpMethod === 'OPTIONS') {
    return {
      statusCode: 200,
      headers: cors(),
      body: '',
    };
  }
  if (event.httpMethod !== 'POST') {
    return json(405, { error: 'Method Not Allowed' });
  }

  let body;
  try { body = JSON.parse(event.body || '{}'); }
  catch { return json(400, { error: 'JSON invalide' }); }

  if (!body.password || body.password !== process.env.ADMIN_PASSWORD) {
    return json(401, { error: 'Mot de passe incorrect' });
  }

  const refresh = process.env.DROPBOX_REFRESH_TOKEN;
  const key     = process.env.DROPBOX_APP_KEY;
  const secret  = process.env.DROPBOX_APP_SECRET;
  if (!refresh || !key || !secret) {
    return json(500, { error: 'Dropbox env vars manquants (REFRESH_TOKEN / APP_KEY / APP_SECRET)' });
  }

  try {
    const r = await fetch('https://api.dropboxapi.com/oauth2/token', {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: [
        'grant_type=refresh_token',
        'refresh_token=' + encodeURIComponent(refresh),
        'client_id='     + encodeURIComponent(key),
        'client_secret=' + encodeURIComponent(secret),
      ].join('&'),
    });
    const data = await r.json();
    if (!data.access_token) {
      return json(502, { error: 'Dropbox refresh failed: ' + JSON.stringify(data).substring(0, 300) });
    }
    return json(200, {
      access_token: data.access_token,
      expires_in:   data.expires_in || 14400,  // 4h par défaut
    });
  } catch (e) {
    return json(500, { error: 'Erreur: ' + e.message });
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
    body: JSON.stringify(body),
  };
}
