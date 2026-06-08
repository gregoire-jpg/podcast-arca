// Push une commande arca_orders vers Bpost Shipping Manager (Plug-in API v3).
//
// Input : POST { order_id }
// Output : { ok, bpost_label_url, bpost_reference, carrier }
//
// Flux unique :
//   1. Load order from Supabase.
//   2. POST /v3/shipments (auto-select carrier).
//      - Si "Shipment already exists" → on continue, le shipment est OK
//        (créé par un push précédent qui a planté côté labels). Pas de
//        double facturation.
//      - Si autre erreur → on remonte explicite.
//   3. POST /v3/labels avec LabelType integer 0 (default Bpost).
//      - Si "Illegal format" → essai 1, 2, 3 (les autres formats integer).
//   4. Récupère LabelUrl direct ou via CallbackURL polling.
//   5. UPDATE arca_orders avec label_url + pushed_at.
//
// Bouton admin = UN SEUL "📦 Envoyer à Bpost" qui gère TOUS les cas
// (premier push, retry après échec, déjà créé).

const utils = require('./_bpost-utils.js');

// Pays FR → ISO2 (Plugin API v3 attend ISO2, pas ISO3).
const ISO2 = {
  'Belgique': 'BE', 'France': 'FR', 'Luxembourg': 'LU', 'Pays-Bas': 'NL',
  'Allemagne': 'DE', 'Autriche': 'AT', 'Italie': 'IT', 'Espagne': 'ES',
  'Portugal': 'PT', 'Royaume-Uni': 'GB', 'Suisse': 'CH', 'Canada': 'CA',
  'DOM-TOM': 'FR', 'Autres pays UE': 'BE'
};

const WEIGHTS = { 1:600, 2:600, 3:735, 4:565, 5:506, 6:600, 7:532, 8:600, 9:350 };
function computeWeightG(items) {
  let g = 0;
  (items || []).forEach(i => { g += (i.qty || 0) * (WEIGHTS[i.num] || 600); });
  return Math.max(g, 100);
}

// Parse "Rue de la Brasserie 18A", "18 Rue X", "Rue X, 18" → {street, number}
function parseStreet(rue) {
  if (!rue) return { street: '', number: '' };
  const cleaned = String(rue).trim();
  let m = cleaned.match(/^(.+?)[,\s]+(\d+\s*\w?)$/);
  if (m) return { street: m[1].trim(), number: m[2].replace(/\s+/g, '') };
  m = cleaned.match(/^(\d+\s*\w?)\s+(.+)$/);
  if (m) return { street: m[2].trim(), number: m[1].replace(/\s+/g, '') };
  return { street: cleaned, number: '' };
}

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

function buildShipment(order) {
  const addr = parseStreet(order.rue);
  // Bpost refuse HouseNumber == 0. Si rien d'extractible, on met 1.
  let houseNumber = 1;
  let numberExt = order.complement || '';
  if (addr.number) {
    const n = parseInt(addr.number, 10);
    if (Number.isFinite(n) && n > 0) {
      houseNumber = n;
      const ext = String(addr.number).replace(/^\d+/, '').trim();
      if (ext) numberExt = (numberExt ? numberExt + ' ' : '') + ext;
    }
  }
  return {
    ShopItemId: 'ARCA-' + order.id,
    ClientReferenceCode: 'ARCA-' + order.id,
    Address: {
      Name: order.nom || '—',
      CompanyName: '',
      Streetname1: addr.street || (order.rue || '').slice(0, 40) || 'Adresse',
      HouseNumber: houseNumber,
      NumberExtension: numberExt,
      PostalCode: order.cp || '',
      City: order.ville || '',
      Country: ISO2[order.pays] || 'BE',
      Phone: order.telephone || '',
      Email: order.email || ''
    },
    Weight: computeWeightG(order.items)
  };
}

function extractErrors(resp) {
  const errs = [];
  const shipments = Array.isArray(resp && resp.Shipment) ? resp.Shipment : [];
  shipments.forEach(s => {
    if (Array.isArray(s.ErrorList)) {
      s.ErrorList.forEach(e => errs.push((e.Tekst || e.Info || 'erreur').trim()));
    }
  });
  if (Array.isArray(resp && resp.ErrorList)) {
    resp.ErrorList.forEach(e => errs.push((e.Tekst || e.Info || 'erreur').trim()));
  }
  if (resp && resp.Error && resp.Error.Id && resp.Error.Id !== 0) {
    errs.push((resp.Error.Info || ('Error ' + resp.Error.Id)).trim());
  }
  return errs;
}

// Récupère LabelUrl en testant plusieurs LabelType integer (Plugin API attend
// INTEGER, pas string). Ordre essayé : env override → 0 (default) → 1, 2, 3.
async function tryFetchLabel(orderId, token) {
  const envOverride = process.env.BPOST_LABEL_TYPE;
  const candidates = envOverride
    ? [parseInt(envOverride, 10)]
    : [0, 1, 2, 3, 4];

  let lastErrs = [];
  for (const lt of candidates) {
    if (!Number.isFinite(lt)) continue;
    const payload = {
      ClientReferenceCodeList: ['ARCA-' + orderId],
      LabelStart: 1,
      LabelType: lt
    };
    let resp;
    try {
      resp = await utils.bpostCall('POST', '/v3/labels/', payload, token);
    } catch (e) {
      console.warn('[Bpost] LabelType=' + lt + ' exception:', e.message);
      lastErrs = ['exception: ' + e.message];
      continue;
    }
    console.log('[Bpost] try LabelType=' + lt + ' →', JSON.stringify(resp).substring(0, 300));

    if (resp && resp.LabelUrl) {
      console.log('[Bpost] LabelType=' + lt + ' a renvoyé LabelUrl direct');
      return { url: resp.LabelUrl, labelTypeUsed: lt };
    }
    const cbUrl = resp && (resp.CallbackURL || resp.CallbackUrl);
    if (cbUrl) {
      for (let i = 0; i < 6; i++) {
        await new Promise(r => setTimeout(r, 1500));
        try {
          const poll = await utils.bpostCall('GET', new URL(cbUrl).pathname, null, token);
          if (poll && poll.LabelUrl) {
            console.log('[Bpost] LabelType=' + lt + ' a renvoyé via callback');
            return { url: poll.LabelUrl, labelTypeUsed: lt };
          }
        } catch (e) {
          console.warn('[Bpost] poll', i, 'err:', e.message);
        }
      }
    }
    lastErrs = extractErrors(resp);
    if (lastErrs.length) console.warn('[Bpost] LabelType=' + lt + ' erreurs:', lastErrs.join(' | '));
  }
  return { url: null, errors: lastErrs };
}

exports.handler = async function (event) {
  if (event.httpMethod !== 'POST') return { statusCode: 405, body: 'Method not allowed' };

  try {
    const { order_id } = JSON.parse(event.body || '{}');
    if (!order_id) return { statusCode: 400, body: 'order_id manquant' };

    const order = await loadOrder(order_id);
    const host = event.headers.host || 'podcast-arca.netlify.app';
    const callbackUrl = 'https://' + host + '/.netlify/functions/bpost-callback';
    const token = await utils.getValidToken(callbackUrl);

    // ── 1) Créer le shipment (ou détecter qu'il existe déjà) ────────
    const shipment = buildShipment(order);
    console.log('[Bpost] shipment payload:', JSON.stringify(shipment));

    const shipResp = await utils.bpostCall('POST', '/v3/shipments/', { Shipment: [shipment] }, token);
    console.log('[Bpost] /shipments →', JSON.stringify(shipResp).substring(0, 400));

    const shipErrs = extractErrors(shipResp);
    let shipmentReady = false;
    if (shipErrs.length === 0) {
      shipmentReady = true;
    } else if (shipErrs.some(e => /already exists/i.test(e))) {
      // Le shipment existe déjà côté Bpost : on continue vers labels SANS
      // recréer (pas de double facturation).
      console.log('[Bpost] shipment ARCA-' + order_id + ' existait déjà, on poursuit vers labels');
      shipmentReady = true;
    } else {
      // Vraie erreur (adresse invalide, pays, contrat, etc.)
      return {
        statusCode: 422,
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          ok: false,
          error: 'Bpost a refusé la commande : ' + shipErrs.join(' · '),
          api_errors: shipErrs
        })
      };
    }

    // ── 2) Récupérer l'étiquette PDF ────────────────────────────────
    const { url: labelUrl, errors: labelErrs, labelTypeUsed } = await tryFetchLabel(order_id, token);

    // ── 3) Mettre à jour la BDD ────────────────────────────────────
    await updateOrder(order_id, {
      bpost_shipment_id: 'ARCA-' + order_id,
      bpost_reference:   'ARCA-' + order_id,
      bpost_label_url:   labelUrl,
      bpost_status:      'pushed',
      bpost_pushed_at:   new Date().toISOString()
    });

    if (!labelUrl) {
      // Shipment OK mais aucun LabelType n'a produit de PDF. Antoine peut
      // soit retenter (Bpost peut prendre quelques minutes), soit aller
      // chercher l'étiquette dans le Shipping Manager.
      return {
        statusCode: 200,
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          ok: true,
          bpost_reference: 'ARCA-' + order_id,
          bpost_label_url: null,
          label_pending: true,
          label_errors: labelErrs || [],
          message: 'Shipment créé chez Bpost (réf ARCA-' + order_id + ') mais le PDF n\'est pas encore récupérable. Réessaye dans quelques minutes ou télécharge depuis le Shipping Manager.'
        })
      };
    }

    return {
      statusCode: 200,
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        ok: true,
        bpost_reference: 'ARCA-' + order_id,
        bpost_label_url: labelUrl,
        label_type_used: labelTypeUsed
      })
    };
  } catch (e) {
    console.error('[Bpost push] erreur:', e.message);
    return {
      statusCode: 500,
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ ok: false, error: e.message })
    };
  }
};
