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

// Sélection dynamique du carrier : on liste ceux autorisés sur le
// contrat ARCA (GET /v3/carriers/allowed/) et on choisit celui qui
// matche le pays cible. Doc Bpost trop évasive pour hardcoder un
// CarrierId — il dépend du contrat de chaque marchand.
//
// Heuristique de matching :
//   - pays BE  → carrier dont le nom NE contient PAS "international/world"
//   - pays !BE → carrier dont le nom contient "international/world", ou
//                carrier marqué internationalAllowed=true / countries=...
//   - fallback : on prend le premier
//
// Si la requête /carriers/allowed/ retourne 0 carrier (compte
// non configuré) → on omet le bloc Carrier et on laisse Bpost
// trancher. Si Bpost refuse à nouveau, c'est qu'il faut configurer
// les produits dans le SM web (côté ARCA).
function pickCarrierForCountry(carriers, iso2) {
  if (!Array.isArray(carriers) || carriers.length === 0) return null;
  const wantsIntl = iso2 !== 'BE';

  const score = (c) => {
    const name = ((c.Name || c.CarrierName || c.Code || '') + '').toLowerCase();
    const isIntl = /international|world|europe|abroad/.test(name);
    // Champ explicite "countries" si Bpost le retourne
    const countries = (c.Countries || c.CountryList || '').toString().toUpperCase();
    const matchesCountry = countries && countries.indexOf(iso2) !== -1;

    if (wantsIntl) {
      if (matchesCountry) return 10;
      if (isIntl) return 5;
      return 1;
    }
    if (matchesCountry) return 10;
    if (isIntl) return 1;
    return 5;
  };

  const sorted = carriers.slice().sort((a, b) => score(b) - score(a));
  const best = sorted[0];
  return best && (best.Id || best.CarrierId) || null;
}

function buildShipment(order, refSuffix, carrierId) {
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
  const country = ISO2[order.pays] || 'BE';
  const cref = 'ARCA-' + order.id + (refSuffix ? '-' + refSuffix : '');

  const shipment = {
    ShopItemId: cref,
    ClientReferenceCode: cref,
    Address: {
      Name: order.nom || '—',
      CompanyName: '',
      Streetname1: addr.street || (order.rue || '').slice(0, 40) || 'Adresse',
      HouseNumber: houseNumber,
      NumberExtension: numberExt,
      PostalCode: order.cp || '',
      City: order.ville || '',
      Country: country,
      Phone: order.telephone || '',
      Email: order.email || ''
    },
    Weight: computeWeightG(order.items)
  };
  if (carrierId) {
    shipment.Carrier = { Id: carrierId };
  }
  return shipment;
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
async function tryFetchLabel(orderId, token, cref) {
  cref = cref || ('ARCA-' + orderId);
  const envOverride = process.env.BPOST_LABEL_TYPE;
  const labelType = envOverride != null && envOverride !== ''
    ? parseInt(envOverride, 10)
    : 0;  // 0 = default Bpost (Bpost choisit le format)

  const payload = {
    ClientReferenceCodeList: [cref],
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
    // ShopUrl envoyée à Bpost /v3/keys : DOIT correspondre exactement à ce
    // qu'Antoine a déclaré à Bpost lors de l'install initiale du SM (Bpost
    // mappe strictement PUBLIC_KEY ↔ ShopUrl autorisée, sinon HTTP 401 sur
    // /v3/keys).
    //
    // L'URL callback Netlify a passé l'auth 401 mais nos shipments tombent
    // dans un shop fantôme invisible dans "New Shop". L'idéal serait
    // d'utiliser la vraie URL canonique d'Antoine (à demander au SM admin
    // → Settings → Shop URL). En attendant que BPOST_SHOP_URL soit posée
    // en env var, on retombe sur l'URL legacy pour ne pas tout casser.
    const host = event.headers.host || 'podcast-arca.netlify.app';
    const fallbackShopUrl = 'https://' + host + '/.netlify/functions/bpost-callback';
    const shopUrl = process.env.BPOST_SHOP_URL || fallbackShopUrl;
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

    // ── 0bis) Lister les carriers autorisés sur le compte ──────────
    // On choisit celui qui matche le pays. Si la requête échoue ou
    // retourne vide, on tente sans bloc Carrier (auto-select).
    const country = ISO2[order.pays] || 'BE';
    let carrierId = null;
    try {
      const allowedResp = await utils.fetchAllowedCarriers(token);
      console.log('[Bpost] /carriers/allowed/ →', JSON.stringify(allowedResp).substring(0, 600));
      const carriers = utils.extractCarrierArray(allowedResp);
      carrierId = pickCarrierForCountry(carriers, country);
      console.log('[Bpost] carrier choisi pour ' + country + ' → ' + (carrierId || 'aucun (auto-select)'));
    } catch (e) {
      console.warn('[Bpost] /carriers/allowed/ KO:', e.message, '— on tente auto-select');
    }

    // ── 1) Créer le shipment, avec suffixe -r1, -r2… si "already exists" ──
    // Stratégie :
    //   - 1er essai avec le carrier choisi (ou sans bloc si null)
    //   - "already exists" → on incrémente le suffixe et on retente
    //   - "Carrier not available" → on retire le bloc Carrier et on retente
    //     une fois (auto-select)
    let chosenCref = null;
    let shipErrs = [];
    let carrierIdUsed = carrierId;
    let triedWithoutCarrier = false;
    const maxRetries = 5;

    for (let i = 0; i < maxRetries; i++) {
      const suffix = i === 0 ? null : ('r' + i);
      const shipment = buildShipment(order, suffix, carrierIdUsed);
      console.log('[Bpost] try shipment cref=' + shipment.ClientReferenceCode +
        ' carrier=' + (carrierIdUsed || 'auto'));

      const shipResp = await utils.bpostCall('POST', '/v3/shipments/', { Shipment: [shipment] }, token);
      console.log('[Bpost] /shipments →', JSON.stringify(shipResp).substring(0, 300));

      shipErrs = extractErrors(shipResp);
      if (shipErrs.length === 0) {
        chosenCref = shipment.ClientReferenceCode;
        console.log('[Bpost] shipment matérialisé avec cref=' + chosenCref);
        break;
      }
      // "already exists" → on tente le suffixe suivant
      if (shipErrs.some(e => /already exists/i.test(e))) {
        console.log('[Bpost] ' + shipment.ClientReferenceCode + ' déjà pris (ghost), retry avec suffixe');
        continue;
      }
      // "Carrier not available" → fallback : retire le bloc Carrier UNE FOIS
      if (shipErrs.some(e => /carrier.*not.*available|choose another/i.test(e)) && !triedWithoutCarrier) {
        console.log('[Bpost] carrier ' + carrierIdUsed + ' refusé, retry sans bloc Carrier (auto-select)');
        carrierIdUsed = null;
        triedWithoutCarrier = true;
        // on garde le même suffixe → on rejoue ce tour (i--)
        i--;
        continue;
      }
      // Toute autre erreur → on arrête
      return {
        statusCode: 422,
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          ok: false,
          error: 'Bpost a refusé la commande : ' + shipErrs.join(' · '),
          api_errors: shipErrs,
          carrier_tried: carrierIdUsed
        })
      };
    }

    if (!chosenCref) {
      return {
        statusCode: 422,
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          ok: false,
          error: 'Bpost a refusé après ' + maxRetries + ' tentatives (tous les crefs en collision). Dernière erreur : ' + shipErrs.join(' · '),
          api_errors: shipErrs
        })
      };
    }

    // ── 2) Récupérer l'étiquette PDF ────────────────────────────────
    const { url: labelUrl, errors: labelErrs, labelTypeUsed, cbUrl } = await tryFetchLabel(order_id, token, chosenCref);

    // ── 3) Mettre à jour la BDD ────────────────────────────────────
    // Si le PDF est dispo on le stocke. Sinon si Bpost nous a donné un
    // CallbackURL, on le mémorise avec un préfixe "pending:" pour que le
    // prochain clic puisse aller chercher le PDF directement sans recréer.
    const storedUrl = labelUrl || (cbUrl ? 'pending:' + cbUrl : null);
    await updateOrder(order_id, {
      bpost_shipment_id: chosenCref,
      bpost_reference:   chosenCref,
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
