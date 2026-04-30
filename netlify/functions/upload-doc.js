// upload-doc.js — Reçoit un PDF en base64, l'uploade sur Dropbox, retourne l'URL directe
// Variables requises : ADMIN_PASSWORD, DROPBOX_APP_KEY, DROPBOX_APP_SECRET, DROPBOX_REFRESH_TOKEN

async function getAccessToken() {
  const res = await fetch('https://api.dropboxapi.com/oauth2/token', {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: [
      'grant_type=refresh_token',
      'refresh_token=' + encodeURIComponent(process.env.DROPBOX_REFRESH_TOKEN),
      'client_id='     + encodeURIComponent(process.env.DROPBOX_APP_KEY),
      'client_secret=' + encodeURIComponent(process.env.DROPBOX_APP_SECRET),
    ].join('&'),
  });
  const data = await res.json();
  if (!data.access_token) throw new Error('Token refresh failed: ' + JSON.stringify(data));
  return data.access_token;
}

async function uploadToDropbox(token, remotePath, buffer) {
  // Upload du fichier
  const uploadRes = await fetch('https://content.dropboxapi.com/2/files/upload', {
    method: 'POST',
    headers: {
      'Authorization':    'Bearer ' + token,
      'Dropbox-API-Arg':  JSON.stringify({ path: remotePath, mode: 'overwrite', autorename: false }),
      'Content-Type':     'application/octet-stream',
    },
    body: buffer,
  });
  if (!uploadRes.ok) throw new Error('Upload failed: ' + await uploadRes.text());

  // Créer/récupérer le lien de partage
  const linkRes = await fetch('https://api.dropboxapi.com/2/sharing/create_shared_link_with_settings', {
    method: 'POST',
    headers: { 'Authorization': 'Bearer ' + token, 'Content-Type': 'application/json' },
    body: JSON.stringify({ path: remotePath, settings: { requested_visibility: 'public' } }),
  });
  const linkData = await linkRes.json();

  let url = linkData.url || '';

  // Gérer le cas où le lien existe déjà
  if (!url && linkData.error && linkData.error['.tag'] === 'shared_link_already_exists') {
    const listRes = await fetch('https://api.dropboxapi.com/2/sharing/list_shared_links', {
      method: 'POST',
      headers: { 'Authorization': 'Bearer ' + token, 'Content-Type': 'application/json' },
      body: JSON.stringify({ path: remotePath }),
    });
    const listData = await listRes.json();
    url = ((listData.links || [])[0] || {}).url || '';
  }

  if (!url) throw new Error('Impossible d\'obtenir le lien de partage');

  return url.replace('www.dropbox.com', 'dl.dropboxusercontent.com').replace('?dl=0', '');
}

exports.handler = async function (event) {
  if (event.httpMethod !== 'POST') {
    return { statusCode: 405, body: 'Method Not Allowed' };
  }

  let body;
  try { body = JSON.parse(event.body); }
  catch { return { statusCode: 400, body: JSON.stringify({ error: 'JSON invalide' }) }; }

  const { password, filename, content, remotePath } = body;

  if (!password || password !== process.env.ADMIN_PASSWORD) {
    return { statusCode: 401, body: JSON.stringify({ error: 'Mot de passe incorrect' }) };
  }

  if (!filename || !content || !remotePath) {
    return { statusCode: 400, body: JSON.stringify({ error: 'filename, content et remotePath sont requis' }) };
  }

  // Vérifier la taille (base64 → ~33% overhead, limite Netlify ~6MB)
  const estimatedSize = Math.round(content.length * 0.75);
  if (estimatedSize > 5 * 1024 * 1024) {
    return {
      statusCode: 413,
      body: JSON.stringify({ error: 'Fichier trop volumineux (max ~5 MB). Uploadez-le directement sur Dropbox et collez l\'URL.' }),
    };
  }

  try {
    const token  = await getAccessToken();
    const buffer = Buffer.from(content, 'base64');
    const url    = await uploadToDropbox(token, remotePath, buffer);

    return {
      statusCode: 200,
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ success: true, dropbox_url: url }),
    };
  } catch (err) {
    return { statusCode: 500, body: JSON.stringify({ error: err.message }) };
  }
};
