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

// Récupère LabelUrl. Plugin API attend LabelType en INTEGER, pas string.
// Une seule tentative + polling court pour rester sous le timeout Netlify (10s).
// Override possible via env BPOST_LABEL_TYPE si jamais 0 ne marche pas.
async function tryFetchLabel(orderId, token) {
  const envOverride = process.env.BPOST_LABEL_TYPE;
  const labelType = envOverride != null && envOverride !== ''
    ? parseInt(envOverride, 10)
    : 0;  // 0 = default Bpost (Bpost choisit le format)

  const payload = {
    ClientReferenceCodeList: ['ARCA-' + orderId],
    LabelStart: 1,
    LabelType: labelType
  };

  let resp;
  try {
    resp = await utils.bpostCall('POST', '/v3/labels/', payload, token);
  } catch (e) {
    console.warn('[Bpost] /labels exception:', e.message);
    return { url: null, errors: ['exception: ' + e.message], labelTypeUsed: labelType };
  }
  console.log('[Bpost] /labels (LabelType=' + labelType + ') →', JSON.stringify(resp).substring(0, 400));

  if (resp && resp.LabelUrl) {
    return { url: resp.LabelUrl, labelTypeUsed: labelType };
  }

  // Polling : 3 essais × 1.2s = 3.6s max. Total fonction <8s.
  const cbUrl = resp && (resp.CallbackURL || resp.CallbackUrl);
  if (cbUrl) {
    for (let i = 0; i < 3; i++) {
      await new Promise(r => setTimeout(r, 1200));
      try {
        const poll = await utils.bpostCall('GET', new URL(cbUrl).pathname, null, token);
        if (poll && poll.LabelUrl) return { url: poll.LabelUrl, labelTypeUsed: labelType };
      } catch (e) {
        console.warn('[Bpost] poll', i, 'err:', e.message);
      }
    }
  }
  return { url: null, errors: extractErrors(resp), labelTypeUsed: labelType, cbUrl };
}

exports.handler = async function (event) {
  if (event.httpMethod !== 'POST') return { statusCode: 405, body: 'Method not allowed' };

  try {
    const { order_id } = JSON.parse(event.body || '{}');
    if (!order_id) return { statusCode: 400, body: 'order_id manquant' };

    const order = await loadOrder(order_id);
    // ShopUrl envoyée à Bpost /v3/keys : c'est ce qui détermine le SCOPE
    // dans lequel les shipments apparaissent côté Shipping Manager web.
    // Le plugin Woo officiel envoie get_home_url() = URL canonique du
    // site marchand. Pour ARCA c'est arca-revue.com (compte SM d'Antoine).
    // Override possible via env BPOST_SHOP_URL si on découvre une autre
    // URL associée au compte (cf. SM admin → settings).
    const shopUrl = process.env.BPOST_SHOP_URL || 'https://arca-revue.com';
    const token = await utils.getValidToken(shopUrl);

    // ── 0) Shortcut : si on a déjà un CallbackURL Bpost en attente (préfixe
    //      "pending:" dans bpost_label_url), on le hit directement avant de
    //      tout refaire. Le PDF a eu le temps d'être généré entre 2 clics
    //      utilisateur (généralement 30s suffisent côté Bpost).
    if (order.bpost_label_url && String(order.bpost_label_url).startsWith('pending:')) {
      const pendingCb = order.bpost_label_url.replace(/^pending:/, '');
      try {
        const poll = await utils.bpostCall('GET', new URL(pendingCb).pathname, null, token);
        if (poll && poll.LabelUrl) {
          await updateOrder(order_id, { bpost_label_url: poll.LabelUrl });
          console.log('[Bpost] PDF récupéré via callback stocké');
          return {
            statusCode: 200,
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ ok: true, bpost_label_url: poll.LabelUrl, bpost_reference: 'ARCA-' + order_id })
          };
        }
        console.log('[Bpost] callback stocké pas encore prêt, on relance un POST /labels');
      } catch (e) {
        console.warn('[Bpost] callback stocké KO:', e.message, '— on relance le flux');
      }
    }

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
    const { url: labelUrl, errors: labelErrs, labelTypeUsed, cbUrl } = await tryFetchLabel(order_id, token);

    // ── 3) Mettre à jour la BDD ────────────────────────────────────
    // Si le PDF est dispo on le stocke. Sinon si Bpost nous a donné un
    // CallbackURL, on le mémorise avec un préfixe "pending:" pour que le
    // prochain clic puisse aller chercher le PDF directement sans recréer.
    const storedUrl = labelUrl || (cbUrl ? 'pending:' + cbUrl : null);
    await updateOrder(order_id, {
      bpost_shipment_id: 'ARCA-' + order_id,
      bpost_reference:   'ARCA-' + order_id,
      bpost_label_url:   storedUrl,
      bpost_status:      'pushed',
      bpost_pushed_at:   new Date().toISOString()
    });

    if (!labelUrl) {
      const stillPending = !!cbUrl;
      return {
        statusCode: 200,
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          ok: true,
          bpost_reference: 'ARCA-' + order_id,
          bpost_label_url: null,
          label_pending: stillPending,
          label_errors: labelErrs || [],
          message: stillPending
            ? 'Shipment créé chez Bpost (réf ARCA-' + order_id + '). Bpost génère le PDF — réclique le bouton dans 30s pour le récupérer.'
            : 'Shipment créé mais Bpost n\'a pas retourné de URL. Va le chercher dans le Shipping Manager ou marque comme traitée manuellement.'
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
