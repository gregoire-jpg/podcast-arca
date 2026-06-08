// bpost-shm-test.js — Endpoint diagnostic.
// Tente plusieurs combinaisons (accountId × passphrase) contre l'API XML
// SHM (api-parcel.bpost.be/services/shm) pour identifier lesquelles
// passent l'auth.
//
// Auth = ADMIN_PASSWORD. Retourne un tableau structuré { combination,
// httpStatus, bodyPreview, verdict } pour chaque tentative.

const BASE = 'https://api-parcel.bpost.be/services/shm';

// Bidon ref pour ne pas créer de shipment. On tape GET /orders/DUMMY-REF
// qui devrait :
//   - 401 si credentials KO
//   - 404 si credentials OK mais ref inexistante
//   - 200/206 si ref existe (très improbable)
const DUMMY_REF = 'DIAG-AUTH-TEST-9999';

async function tryCombo(accountId, passphrase, label) {
  const auth = 'Basic ' + Buffer.from(accountId + ':' + passphrase).toString('base64');
  let r;
  try {
    r = await fetch(BASE + '/' + accountId + '/orders/' + DUMMY_REF, {
      headers: { Authorization: auth, Accept: 'application/xml' }
    });
  } catch (e) {
    return { combination: label, accountId, passphrasePreview: passphrase.substring(0, 6) + '…',
             error: e.message, verdict: 'erreur réseau' };
  }
  const text = await r.text();
  const verdict =
    r.status === 401 ? 'AUTH KO (credentials invalides pour cet AccountId)'
  : r.status === 403 ? 'AUTH OK mais permission refusée'
  : r.status === 404 ? '✓ AUTH OK (ref inexistante = normal pour ce test)'
  : r.status === 200 ? '✓✓ AUTH OK + ref existe'
  : 'HTTP ' + r.status;
  return {
    combination: label,
    accountId,
    passphrasePreview: passphrase.substring(0, 6) + '…',
    httpStatus: r.status,
    bodyPreview: text.substring(0, 300),
    verdict
  };
}

exports.handler = async function (event) {
  if (event.httpMethod === 'OPTIONS') return { statusCode: 200, headers: cors(), body: '' };
  if (event.httpMethod !== 'POST')   return json(405, { error: 'Method Not Allowed' });

  let body;
  try { body = JSON.parse(event.body || '{}'); }
  catch { return json(400, { error: 'JSON invalide' }); }

  if (!body.password || body.password !== process.env.ADMIN_PASSWORD) {
    return json(401, { error: 'Mot de passe incorrect' });
  }

  const pub = process.env.BPOST_SM_PUBLIC_KEY || '';
  const prv = process.env.BPOST_SM_PRIVATE_KEY || '';
  const accountId = process.env.BPOST_SHM_ACCOUNT_ID || '';
  const passphrase = process.env.BPOST_SHM_PASSPHRASE || '';

  // Candidats à tester
  const accountIdCandidates = ['381055', '119186'];
  // Ajoute aussi les env explicites si posés
  if (accountId) accountIdCandidates.unshift(accountId);

  const passphraseCandidates = [];
  if (passphrase) passphraseCandidates.push({ val: passphrase, label: 'BPOST_SHM_PASSPHRASE env' });
  if (prv) passphraseCandidates.push({ val: prv, label: 'BPOST_SM_PRIVATE_KEY env' });
  if (pub) passphraseCandidates.push({ val: pub, label: 'BPOST_SM_PUBLIC_KEY env' });

  if (passphraseCandidates.length === 0) {
    return json(500, { error: 'Aucune passphrase candidate disponible (BPOST_SHM_PASSPHRASE / BPOST_SM_PRIVATE_KEY / BPOST_SM_PUBLIC_KEY tous vides)' });
  }

  const results = [];
  for (const aid of accountIdCandidates) {
    for (const pp of passphraseCandidates) {
      const label = 'accountId=' + aid + ' × passphrase=' + pp.label;
      results.push(await tryCombo(aid, pp.val, label));
    }
  }

  return json(200, {
    BASE,
    accountIdCandidates,
    passphraseCandidatesLabels: passphraseCandidates.map(p => p.label),
    results
  });
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
