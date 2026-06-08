// bpost-fetch-label.js — Stream le PDF d'étiquette Bpost directement
// au browser via une URL Netlify signée HMAC.
//
// Usage : GET /.netlify/functions/bpost-fetch-label?ref=ARCA-16&exp=...&sig=...
//   → 200 application/pdf : le binaire de l'étiquette
//   → 202 text/plain      : "label pending" (PDF pas encore généré)
//   → 401/403             : signature absente, invalide ou expirée
//   → 4xx text/plain      : erreur (cref inconnu…)
//
// Auth : signature HMAC (ref + exp) avec BPOST_LABEL_SECRET, émise par
// /bpost-label-token (qui demande ADMIN_PASSWORD). Les ARCA-N étant
// énumérables séquentiellement et le PDF contenant nom+adresse+phone
// du client, l'endpoint NE DOIT PAS être accessible sans signature.

const crypto = require('crypto');
const utils = require('./_bpost-utils.js');

function verifySignature(ref, exp, sig) {
  if (!ref || !exp || !sig) return false;
  const expNum = parseInt(exp, 10);
  if (!Number.isFinite(expNum)) return false;
  if (expNum < Math.floor(Date.now() / 1000)) return false;  // expirée
  const secret = process.env.BPOST_LABEL_SECRET || process.env.ADMIN_PASSWORD;
  if (!secret) return false;
  const expected = crypto.createHmac('sha256', secret).update(ref + '.' + expNum).digest('hex');
  const a = Buffer.from(sig, 'utf8');
  const b = Buffer.from(expected, 'utf8');
  if (a.length !== b.length) return false;
  return crypto.timingSafeEqual(a, b);
}

exports.handler = async function (event) {
  const q = event.queryStringParameters || {};
  const ref = q.ref;
  if (!ref) return text(400, 'ref manquant');
  // Format autorisé : ARCA-N (canonique), ARCA-N-rN (legacy retry suffix),
  // ARCA-N-XXXXXXXX (random hex 8 chars depuis 2026-06-08 anti-ghost).
  if (!/^ARCA-\d+(-r\d+|-[0-9a-f]{4,16})?$/.test(ref)) return text(400, 'ref invalide');

  if (!verifySignature(ref, q.exp, q.sig)) {
    return text(403, 'Signature absente, invalide ou expirée — demande un nouveau lien depuis l\'admin.');
  }

  try {
    const host = event.headers.host || 'podcast-arca.netlify.app';
    const shopUrl = process.env.BPOST_SHOP_URL || ('https://' + host + '/.netlify/functions/bpost-callback');
    const token = await utils.getValidToken(shopUrl);

    // POST /v3/labels — Bpost renvoie le PDF en binaire si déjà
    // matérialisé, ou un JSON avec CallbackURL si en attente.
    const resp = await utils.bpostCall('POST', '/v3/labels/', {
      ClientReferenceCodeList: [ref],
      LabelStart: 1,
      LabelType: 0
    }, token);

    if (resp && resp.__binary) {
      return {
        statusCode: 200,
        headers: {
          'Content-Type': 'application/pdf',
          'Content-Disposition': 'inline; filename="' + ref + '.pdf"',
          'Cache-Control': 'private, no-store, max-age=0'
        },
        body: resp.buffer.toString('base64'),
        isBase64Encoded: true
      };
    }

    // Sinon : JSON. Peut contenir LabelUrl ou CallbackURL.
    if (resp && resp.LabelUrl) {
      return { statusCode: 302, headers: { Location: resp.LabelUrl }, body: '' };
    }

    const cbUrl = resp && (resp.CallbackURL || resp.CallbackUrl);
    if (cbUrl) {
      // Poll le callback une fois (max 2s pour rester < timeout)
      await new Promise(r => setTimeout(r, 2000));
      try {
        const poll = await utils.bpostCall('GET', new URL(cbUrl).pathname, null, token);
        if (poll && poll.__binary) {
          return {
            statusCode: 200,
            headers: {
              'Content-Type': 'application/pdf',
              'Content-Disposition': 'inline; filename="' + ref + '.pdf"',
              'Cache-Control': 'private, no-store, max-age=0'
            },
            body: poll.buffer.toString('base64'),
            isBase64Encoded: true
          };
        }
        if (poll && poll.LabelUrl) {
          return { statusCode: 302, headers: { Location: poll.LabelUrl }, body: '' };
        }
      } catch (e) {
        return text(202, 'PDF pas encore prêt (poll: ' + e.message + ') — recharge dans 30s');
      }
      return text(202, 'PDF pas encore prêt — recharge dans 30s');
    }

    return text(500, 'Réponse Bpost inattendue : ' + JSON.stringify(resp).substring(0, 300));
  } catch (e) {
    return text(500, 'Erreur : ' + e.message);
  }
};

function text(status, msg) {
  return {
    statusCode: status,
    headers: { 'Content-Type': 'text/plain; charset=utf-8' },
    body: msg
  };
}
