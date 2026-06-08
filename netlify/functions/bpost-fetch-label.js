// Récupère l'étiquette PDF d'un shipment Bpost DÉJÀ CRÉÉ.
// Pas de re-création — donc pas de double facturation.
//
// Cas d'usage : un push initial a réussi côté shipment mais échoué côté
// label (ex. erreur LabelType durcie). On veut juste récupérer le PDF
// sans repayer un nouveau shipment.
//
// Input  : POST { order_id }
// Output : { ok, bpost_label_url }

const utils = require('./_bpost-utils.js');

async function loadOrder(orderId) {
  const r = await fetch(utils.supaUrl() + '/rest/v1/arca_orders?id=eq.' + orderId + '&select=*', {
    headers: { apikey: utils.supaKey(), Authorization: 'Bearer ' + utils.supaKey() }
  });
  const rows = await r.json();
  if (!rows || !rows[0]) throw new Error('Order ' + orderId + ' not found');
  return rows[0];
}

async function updateOrder(orderId, fields) {
  await fetch(utils.supaUrl() + '/rest/v1/arca_orders?id=eq.' + orderId, {
    method: 'PATCH',
    headers: {
      apikey: utils.supaKey(), Authorization: 'Bearer ' + utils.supaKey(),
      'Content-Type': 'application/json'
    },
    body: JSON.stringify(fields)
  });
}

exports.handler = async function (event) {
  if (event.httpMethod !== 'POST') return { statusCode: 405, body: 'Method not allowed' };

  try {
    const { order_id } = JSON.parse(event.body || '{}');
    if (!order_id) return { statusCode: 400, body: 'order_id manquant' };

    const order = await loadOrder(order_id);
    if (!order.bpost_pushed_at) {
      return {
        statusCode: 400,
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ ok: false, error: 'Aucun shipment Bpost créé pour cette commande. Utiliser "Envoyer à Bpost" plutôt.' })
      };
    }

    const host = event.headers.host || 'podcast-arca.netlify.app';
    const callbackUrl = 'https://' + host + '/.netlify/functions/bpost-callback';
    const token = await utils.getValidToken(callbackUrl);

    const labelType = process.env.BPOST_LABEL_TYPE || '';
    const payload = {
      ClientReferenceCodeList: ['ARCA-' + order.id],
      LabelStart: 1
    };
    if (labelType) payload.LabelType = labelType;

    const resp = await utils.bpostCall('POST', '/v3/labels/', payload, token);
    console.log('[Bpost fetch-label] resp:', JSON.stringify(resp).substring(0, 500));

    let labelUrl = null;
    if (resp.LabelUrl) labelUrl = resp.LabelUrl;
    else if (resp.CallbackURL || resp.CallbackUrl) {
      const cbUrl = resp.CallbackURL || resp.CallbackUrl;
      // Polling : 6 essais à 1.5s d'intervalle
      for (let i = 0; i < 6; i++) {
        await new Promise(r => setTimeout(r, 1500));
        try {
          const poll = await utils.bpostCall('GET', new URL(cbUrl).pathname, null, token);
          if (poll.LabelUrl) { labelUrl = poll.LabelUrl; break; }
        } catch (e) { console.warn('[Bpost fetch-label] poll', i, 'err:', e.message); }
      }
    }

    if (!labelUrl) {
      // Vérifie si Bpost retourne une erreur exploitable
      const errs = [];
      if (resp.ErrorList && Array.isArray(resp.ErrorList)) {
        resp.ErrorList.forEach(e => errs.push((e.Tekst || e.Info || 'erreur').trim()));
      }
      if (resp.Error && resp.Error.Info) errs.push(resp.Error.Info);
      return {
        statusCode: 502,
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          ok: false,
          error: errs.length
            ? 'Bpost label : ' + errs.join(' · ')
            : 'Bpost label : pas de PDF retourné. Va le télécharger manuellement depuis le Shipping Manager.',
          api_errors: errs
        })
      };
    }

    await updateOrder(order_id, { bpost_label_url: labelUrl });

    return {
      statusCode: 200,
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ ok: true, bpost_label_url: labelUrl })
    };
  } catch (e) {
    console.error('[Bpost fetch-label] erreur:', e.message);
    return {
      statusCode: 500,
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ ok: false, error: e.message })
    };
  }
};
