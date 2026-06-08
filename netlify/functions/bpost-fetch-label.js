// bpost-fetch-label.js — Stream le PDF d'étiquette Bpost directement
// au browser via une URL Netlify (pas besoin de Supabase Storage).
//
// Usage : GET /.netlify/functions/bpost-fetch-label?ref=ARCA-16
//   → 200 application/pdf  : le binaire de l'étiquette
//   → 202 text/plain        : "label pending" (PDF pas encore généré)
//   → 4xx text/plain        : erreur (cref inconnu, password incorrect…)
//
// Pas de password sur cette URL — c'est un lien qu'on ouvre dans le
// browser depuis l'admin (un nouvel onglet ne peut pas POST + password).
// La protection est que la ref ARCA-XX doit exister et l'admin doit
// l'avoir poussé d'abord.

const utils = require('./_bpost-utils.js');

exports.handler = async function (event) {
  const ref = (event.queryStringParameters || {}).ref;
  if (!ref) return text(400, 'ref manquant');
  if (!/^ARCA-\d+(-r\d+)?$/.test(ref)) return text(400, 'ref invalide');

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
          'Cache-Control': 'public, max-age=86400'
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
            headers: { 'Content-Type': 'application/pdf', 'Content-Disposition': 'inline; filename="' + ref + '.pdf"' },
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
