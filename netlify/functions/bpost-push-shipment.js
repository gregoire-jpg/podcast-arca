// Pousse une commande arca.orders vers Bpost Shipping Manager via Plug-in API.
//
// Input  : POST { order_id: 123 }
// Output : { ok: true, bpost_shipment_id, bpost_reference, bpost_label_url?, status }
//
// Étapes :
//   1. Charge l'order depuis Supabase
//   2. Mappe en payload Bpost Shipment (bpack@home par défaut)
//   3. POST /v3/shipments → récupère ShopItemId / ClientReferenceCode
//   4. POST /v3/labels → démarre génération PDF
//   5. Polling /v3/labels/<id> jusqu'à ready (ou timeout) → URL PDF
//   6. Update arca.orders avec les infos Bpost

const utils = require('./_bpost-utils.js');

// Mapping pays FR → ISO2 (Bpost API v3 attend ISO2, pas ISO3).
// L'ancien mapping ISO3 (BEL, FRA…) faisait que Bpost rejetait toutes les
// commandes hors-BE avec "Carrier not available" (commande ARTERO 2026-06-08).
const ISO2 = {
  'Belgique':       'BE',
  'France':         'FR',
  'Luxembourg':     'LU',
  'Pays-Bas':       'NL',
  'Allemagne':      'DE',
  'Autriche':       'AT',
  'Italie':         'IT',
  'Espagne':        'ES',
  'Portugal':       'PT',
  'Royaume-Uni':    'GB',
  'Suisse':         'CH',
  'Canada':         'CA',
  'DOM-TOM':        'FR',
  'Autres pays UE': 'BE'
};

// Poids mesurés (pesées réelles 2026-05-18 pour 3/4/5/7; 600g par défaut, 350g recueil)
const WEIGHTS = { 1:600, 2:600, 3:735, 4:565, 5:506, 6:600, 7:532, 8:600, 9:350 };
function computeWeightG(items) {
  let g = 0;
  (items || []).forEach(i => { g += (i.qty || 0) * (WEIGHTS[i.num] || 600); });
  return Math.max(g, 100);
}

// Parse une rue → { street, number }. Tolère plusieurs formats :
//   "Rue de la Brasserie, 18"   → "Rue de la Brasserie" + 18
//   "Rue de la Brasserie 18"    → "Rue de la Brasserie" + 18
//   "18 Rue de la Brasserie"    → "Rue de la Brasserie" + 18  (rare, anglo)
//   "Avenue Louise 18A"          → "Avenue Louise" + 18A
function parseStreet(rue) {
  if (!rue) return { street: '', number: '' };
  const cleaned = String(rue).trim();
  // Numéro à la fin (cas usuel)
  let m = cleaned.match(/^(.+?)[,\s]+(\d+\s*\w?)$/);
  if (m) return { street: m[1].trim(), number: m[2].replace(/\s+/g, '') };
  // Numéro au début (anglo-saxon)
  m = cleaned.match(/^(\d+\s*\w?)\s+(.+)$/);
  if (m) return { street: m[2].trim(), number: m[1].replace(/\s+/g, '') };
  // Pas de numéro extractible
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

// Extrait les erreurs API d'une réponse Bpost /v3/shipments.
function extractBpostErrors(resp) {
  const errs = [];
  const shipments = Array.isArray(resp && resp.Shipment) ? resp.Shipment : [];
  shipments.forEach(s => {
    if (Array.isArray(s.ErrorList)) {
      s.ErrorList.forEach(e => errs.push((e.Tekst || e.Info || 'erreur').trim()));
    }
  });
  if (resp && resp.Error && resp.Error.Id && resp.Error.Id !== 0) {
    errs.push((resp.Error.Info || ('Error ' + resp.Error.Id)).trim());
  }
  return errs;
}

function buildShipment(order, carrierId) {
  const addr = parseStreet(order.rue);
  // Bpost refuse les HouseNumber == 0 ("Value too low or string too short").
  // Si on n'a pas pu extraire de numéro, on met 1 par défaut et on déplace la
  // mention exacte dans NumberExtension/Streetname1 pour que le facteur la voie.
  let houseNumber = 1;
  let numberExt = order.complement || '';
  if (addr.number) {
    const n = parseInt(addr.number, 10);
    if (Number.isFinite(n) && n > 0) {
      houseNumber = n;
      // Si "18A" → 18 + extension "A"
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
    // Carrier optionnel : null → auto-select par Bpost (recommandé Plugin v3)
    Carrier: carrierId ? { Id: carrierId } : undefined,
    Weight: computeWeightG(order.items)
  };
}

exports.handler = async function (event) {
  if (event.httpMethod !== 'POST') return { statusCode: 405, body: 'Method not allowed' };

  try {
    const { order_id } = JSON.parse(event.body || '{}');
    if (!order_id) return { statusCode: 400, body: 'order_id manquant' };

    const order = await loadOrder(order_id);

    // Token valide (renouvelle si besoin)
    const host = event.headers.host || 'podcast-arca.netlify.app';
    const callbackUrl = 'https://' + host + '/.netlify/functions/bpost-callback';
    const token = await utils.getValidToken(callbackUrl);

    // Construit la liste des carriers candidats selon le pays.
    // ARTERO (France) le 2026-06-08 a planté avec carrier 301 ("Carrier not
    // available") → il fallait International. Stratégie : on essaye plusieurs
    // candidats dans l'ordre, on garde le premier qui passe.
    const isBE = !order.pays || /belgique/i.test(order.pays);
    let candidates = [];
    try {
      const carriers = await utils.bpostCall('GET', '/v3/carriers/', null, token);
      const list = (carriers.Carrier || []).flatMap(c =>
        (c.OptionList || []).flatMap(o => o.OptionValues || [])
      );
      if (isBE) {
        // BE : home > pickup. Priorité bpack@home / bpack 24h.
        const home = list.filter(o => /bpack/i.test(o.Name) && !o.IsPickup);
        const pickup = list.filter(o => /bpack/i.test(o.Name) && o.IsPickup);
        candidates = [...home, ...pickup].map(o => ({ id: parseInt(o.Id, 10), name: o.Name }));
        // Filet : fallback codé en dur si la liste API est vide
        if (!candidates.length) candidates = [{ id: 301, name: 'Bpack 24h home (default)' }];
      } else {
        // International : tout ce qui contient "international" en priorité,
        // puis le reste. On filtre les pickup pour les envois hors BE.
        const intl = list.filter(o => /international/i.test(o.Name) && !o.IsPickup);
        const others = list.filter(o => !o.IsPickup && !intl.includes(o));
        candidates = [...intl, ...others].map(o => ({ id: parseInt(o.Id, 10), name: o.Name }));
      }
    } catch (e) {
      console.warn('Carrier lookup failed:', e.message);
      candidates = [{ id: 301, name: 'Bpack 24h home (fallback)' }];
    }
    if (!candidates.length) {
      return {
        statusCode: 422,
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ ok: false, error: 'Aucun carrier Bpost disponible pour ' + (order.pays || 'la destination') })
      };
    }

    // 1) POST /v3/shipments — stratégie multi-tentatives
    //
    // Tentative #1 : SANS Carrier dans le payload. Bpost auto-sélectionne le
    // carrier optimal selon (poids × destination × contrats du compte). C'est
    // la voie recommandée par la doc Plugin v3 — le forçage d'un carrier
    // déclenche "Carrier not available" si le mapping option↔contrat n'est
    // pas exact.
    //
    // Tentative #2..N : si #1 échoue, on retombe sur le forçage par carrier
    // (ancien comportement) en passant chaque candidat.
    let shipResp = null;
    let usedCarrier = null;
    let lastErrors = [];

    // Log du payload exact (debug 2026-06-08 ARTERO)
    const baseShipment = buildShipment(order, null);
    console.log('[Bpost] base shipment payload:', JSON.stringify(baseShipment));

    // Tentative 1 : auto-select
    {
      const autoShipment = Object.assign({}, baseShipment);
      delete autoShipment.Carrier;
      const resp = await utils.bpostCall('POST', '/v3/shipments/', { Shipment: [autoShipment] }, token);
      console.log('[Bpost] try auto-select →', JSON.stringify(resp).substring(0, 400));
      const errs = extractBpostErrors(resp);
      if (!errs.length) {
        shipResp = resp;
        usedCarrier = { id: null, name: 'auto-select' };
      } else {
        lastErrors = errs;
        const onlyCarrierIssue = errs.every(e => /carrier not available/i.test(e));
        if (!onlyCarrierIssue) {
          console.error('[Bpost] erreur non-carrier dès auto-select, arrêt:', errs.join(' | '));
          return {
            statusCode: 422,
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ ok: false, error: 'Bpost a refusé la commande : ' + errs.join(' · '), api_errors: errs })
          };
        }
      }
    }

    // Tentatives 2..N : forçage carrier par candidat
    if (!shipResp) {
      for (const c of candidates) {
        const shipPayload = { Shipment: [buildShipment(order, c.id)] };
        const resp = await utils.bpostCall('POST', '/v3/shipments/', shipPayload, token);
        console.log('[Bpost] try carrier', c.id, c.name, '→', JSON.stringify(resp).substring(0, 400));
        const errs = extractBpostErrors(resp);
        if (!errs.length) { shipResp = resp; usedCarrier = c; break; }
        lastErrors = errs;
        const onlyCarrierIssue = errs.every(e => /carrier not available/i.test(e));
        if (!onlyCarrierIssue) {
          console.error('[Bpost] erreur non-carrier, arrêt:', errs.join(' | '));
          return {
            statusCode: 422,
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ ok: false, error: 'Bpost a refusé la commande : ' + errs.join(' · '), api_errors: errs })
          };
        }
        console.warn('[Bpost] carrier', c.id, 'non disponible, on essaie le suivant');
      }
    }

    if (!shipResp || !usedCarrier) {
      return {
        statusCode: 422,
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          ok: false,
          error: 'Bpost : aucun carrier disponible pour cette destination (' + (order.pays || '?') + '). Cause probable : contrat international non activé sur le compte Shipping Manager OU adresse mal formatée. ' + lastErrors.join(' · '),
          api_errors: lastErrors,
          tried_auto_select: true,
          tried_carriers: candidates.map(c => c.id + ' ' + c.name)
        })
      };
    }

    const carrierId = usedCarrier.id || 0;
    console.log('[Bpost] shipment accepté avec', usedCarrier.name, '(id=' + carrierId + ')');

    // 2) POST /v3/labels — démarre génération PDF
    // LabelType : A4 par défaut (format universel, accepté partout). Surchargeable
    // via env BPOST_LABEL_TYPE pour s'aligner sur une étiqueteuse thermique. Le
    // format A6 a été retiré de l'API Bpost en juin 2026 (cf. erreur HTTP du
    // 2026-06-08 "Data error LabelType (A6)").
    let labelUrl = null;
    const labelType = process.env.BPOST_LABEL_TYPE || 'A4';
    try {
      const labelPayload = {
        ClientReferenceCodeList: ['ARCA-' + order.id],
        LabelStart: 1,
        LabelType: labelType
      };
      const labelResp = await utils.bpostCall('POST', '/v3/labels/', labelPayload, token);
      console.log('[Bpost] labels resp:', JSON.stringify(labelResp).substring(0, 500));

      // L'API retourne soit l'URL directe, soit un callback URL pour polling
      if (labelResp.LabelUrl) labelUrl = labelResp.LabelUrl;
      else if (labelResp.CallbackUrl) {
        // Polling simple : 5 essais à 1s d'intervalle
        for (let i = 0; i < 5; i++) {
          await new Promise(r => setTimeout(r, 1500));
          const poll = await utils.bpostCall('GET', new URL(labelResp.CallbackUrl).pathname, null, token);
          if (poll.LabelUrl) { labelUrl = poll.LabelUrl; break; }
        }
      }
    } catch (e) {
      console.warn('Label generation failed (shipment OK):', e.message);
    }

    // 3) Update arca.orders
    await updateOrder(order_id, {
      bpost_shipment_id: 'ARCA-' + order.id,
      bpost_reference:   'ARCA-' + order.id,
      bpost_label_url:   labelUrl,
      bpost_status:      'pushed',
      bpost_pushed_at:   new Date().toISOString()
    });

    return {
      statusCode: 200,
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        ok: true,
        bpost_reference: 'ARCA-' + order.id,
        bpost_label_url: labelUrl,
        carrier_id: carrierId
      })
    };
  } catch (err) {
    console.error('bpost-push-shipment error:', err);
    return {
      statusCode: 500,
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ ok: false, error: err.message })
    };
  }
};
