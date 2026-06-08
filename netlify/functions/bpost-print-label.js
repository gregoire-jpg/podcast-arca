// bpost-print-label.js — Stream le PDF d'étiquette Bpost (API XML).
//
// Usage : GET /.netlify/functions/bpost-print-label?ref=ARCA-N&exp=...&sig=...
//   → 200 application/pdf : le binaire de l'étiquette
//   → 403 : signature absente/invalide/expirée
//   → 4xx : erreur (cref inconnu, credentials manquantes…)
//
// Auth : signature HMAC (ref + exp) avec BPOST_LABEL_SECRET, émise par
// /bpost-label-token. Les ARCA-N étant énumérables séquentiellement,
// l'endpoint refuse sans signature valide.
//
// Première récupération du label = facture le pli (PENDING → PRINTED).
// Re-récupération possible avec forcePrinting=true.

const crypto = require('crypto');
const shm = require('./_bpost-shm.js');

function verifySignature(ref, exp, sig) {
  if (!ref || !exp || !sig) return false;
  const expNum = parseInt(exp, 10);
  if (!Number.isFinite(expNum)) return false;
  if (expNum < Math.floor(Date.now() / 1000)) return false;
  const secret = process.env.BPOST_LABEL_SECRET || process.env.ADMIN_PASSWORD;
  if (!secret) return false;
  const expected = crypto.createHmac('sha256', secret).update(ref + '.' + expNum).digest('hex');
  const a = Buffer.from(sig, 'utf8');
  const b = Buffer.from(expected, 'utf8');
  if (a.length !== b.length) return false;
  return crypto.timingSafeEqual(a, b);
}

async function updateOrderByRef(ref, fields) {
  await fetch(process.env.SUPABASE_URL + '/rest/v1/arca_orders?bpost_reference=eq.' + encodeURIComponent(ref), {
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
  const q = event.queryStringParameters || {};
  const ref = q.ref;
  if (!ref) return text(400, 'ref manquant');
  if (!/^ARCA-\d+(-r\d+|-[0-9a-f]{4,16})?$/.test(ref)) return text(400, 'ref invalide');

  if (!verifySignature(ref, q.exp, q.sig)) {
    return text(403, 'Signature absente, invalide ou expirée — relance depuis l\'admin.');
  }

  if (!process.env.BPOST_SHM_ACCOUNT_ID || !process.env.BPOST_SHM_PASSPHRASE) {
    return text(503, 'Credentials Bpost SHM non configurées (BPOST_SHM_ACCOUNT_ID + BPOST_SHM_PASSPHRASE).');
  }

  const format = (q.format === 'A4') ? 'A4' : 'A6';
  // Si la 1re fois échoue avec "already printed", on retry avec forcePrinting=true
  let labelRes;
  try {
    labelRes = await shm.fetchLabelPdf(ref, format, false);
  } catch (e) {
    if (/already.*printed|PRINTED/i.test(e.message)) {
      console.log('[Bpost SHM] label déjà imprimé, retry avec forcePrinting=true');
      try {
        labelRes = await shm.fetchLabelPdf(ref, format, true);
      } catch (e2) {
        return text(500, 'Erreur réimpression : ' + e2.message);
      }
    } else {
      return text(500, 'Erreur récupération PDF : ' + e.message);
    }
  }

  // Update BDD : PRINTED + barcode (best-effort, n'empêche pas le retour PDF)
  try {
    await updateOrderByRef(ref, {
      bpost_status: 'PRINTED',
      bpost_shipment_id: labelRes.barcode || ref,
      bpost_label_url: 'bpost-shm:' + ref  // marqueur pour l'admin
    });
  } catch (e) {
    console.warn('[Bpost SHM] update BDD KO (PDF retourné quand même):', e.message);
  }

  return {
    statusCode: 200,
    headers: {
      'Content-Type': 'application/pdf',
      'Content-Disposition': 'inline; filename="' + ref + '.pdf"',
      'Cache-Control': 'private, no-store, max-age=0'
    },
    body: labelRes.pdfBuffer.toString('base64'),
    isBase64Encoded: true
  };
};

function text(status, msg) {
  return {
    statusCode: status,
    headers: { 'Content-Type': 'text/plain; charset=utf-8', 'Cache-Control': 'private, no-store' },
    body: msg
  };
}
