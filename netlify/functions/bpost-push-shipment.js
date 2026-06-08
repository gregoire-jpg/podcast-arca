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

// Sélection dynamique Carrier + Product depuis /v3/carriers/allowed/.
//
// Structure réelle Bpost (validée le 2026-06-08 sur le contrat ARCA) :
//   - Carrier 68 = "bpost shm" (home + PUDO)
//   - Carrier 71 = "bpost SML" (Send My Label)
//   - À l'intérieur, OptionList "Product" (ClassId 126) avec :
//       302 bpack 24h Pro              ← BE national, livraison domicile
//       303 bpack World Business       ← international, domicile
//       301 Bpack 24/7 & Bpack@bpost   ← PUDO (point relais)
//       304 bpack 24h business         ← BE national alt
//       309 International Home Economy ← intl éco (liste pays restreinte)
//   - Le payload /shipments attend Carrier.Id (le carrier 68) ET un
//     OptionList contenant le Product. Sinon Bpost répond "Carrier not
//     available" ou "Product required".
function pickCarrierForCountry(carriers, iso2) {
  if (!Array.isArray(carriers) || carriers.length === 0) return null;

  // 1) Choisir le Carrier "bpost shm" (livraison domicile)
  const carrier = carriers.find(c => /bpost\s*shm/i.test(c.Name || ''))
               || carriers.find(c => String(c.Id) === '68')
               || carriers[0];
  if (!carrier) return null;

  // 2) Trouver l'OptionList "Product"
  const productOpt = (carrier.OptionList || []).find(o =>
    o && (o.Name === 'Product' || o.ClassId === 126)
  );
  if (!productOpt || !Array.isArray(productOpt.OptionValues)) {
    return { carrierId: parseInt(carrier.Id, 10), productClassId: null, productId: null };
  }

  // 3) Choisir le Product selon le pays cible
  const wantsIntl = iso2 !== 'BE';
  const candidates = productOpt.OptionValues.filter(v => v && v.IsPickup === 0);
  let chosen = null;

  if (wantsIntl) {
    // International : préfère bpack World Business (303), fallback Economy
    chosen = candidates.find(v => String(v.Id) === '303')
          || candidates.find(v => /world business/i.test(v.Name || ''))
          || candidates.find(v => String(v.Id) === '309')
          || candidates.find(v => /international.*home/i.test(v.Name || ''));
  } else {
    // BE national : préfère bpack 24h Pro (302), fallback business/Pack
    chosen = candidates.find(v => String(v.Id) === '302')
          || candidates.find(v => /24h\s*pro/i.test(v.Name || ''))
          || candidates.find(v => String(v.Id) === '304')
          || candidates.find(v => /24h\s*business/i.test(v.Name || ''));
  }

  return {
    carrierId: parseInt(carrier.Id, 10),
    productClassId: productOpt.Id,
    productId: chosen ? String(chosen.Id) : null,
    productName: chosen ? chosen.Name : null
  };
}

function buildShipment(order, refSuffix, carrierInfo, includeProduct) {
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
  if (carrierInfo && carrierInfo.carrierId) {
    shipment.Carrier = { Id: carrierInfo.carrierId };
    if (includeProduct && carrierInfo.productId && carrierInfo.productClassId) {
      shipment.Carrier.OptionList = [{
        Id: carrierInfo.productClassId,
        Value: carrierInfo.productId
      }];
    }
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

// Vérifie que le label est récupérable. POST /v3/labels peut renvoyer :
//   - un PDF binaire direct (Content-Type: application/pdf)
//     → on a la preuve qu'il est dispo, on retourne {ready: true}
//   - un JSON avec LabelUrl  → idem ready, on remonte l'URL Bpost
//   - un JSON avec CallbackURL → label en attente, retourne {pending, cbUrl}
//
// On ne stream PAS le PDF ici (la function bpost-push-shipment doit
// rester sous 10s de timeout Netlify). Le binaire sera récupéré à la
// demande via /bpost-fetch-label?ref=<cref>.
async function tryFetchLabel(orderId, token, cref) {
  cref = cref || ('ARCA-' + orderId);
  const payload = {
    ClientReferenceCodeList: [cref],
    LabelStart: 1,
    LabelType: 0
  };

  let resp;
  try {
    resp = await utils.bpostCall('POST', '/v3/labels/', payload, token);
  } catch (e) {
    console.warn('[Bpost] /labels exception:', e.message);
    return { ready: false, errors: ['exception: ' + e.message] };
  }

  if (resp && resp.__binary) {
    console.log('[Bpost] /labels → PDF binaire ' + resp.buffer.length + 'B, prêt');
    return { ready: true, mode: 'binary' };
  }

  console.log('[Bpost] /labels →', JSON.stringify(resp).substring(0, 400));

  if (resp && resp.LabelUrl) {
    return { ready: true, mode: 'url', labelUrl: resp.LabelUrl };
  }

  const cbUrl = resp && (resp.CallbackURL || resp.CallbackUrl);
  if (cbUrl) {
    // Un poll rapide pour voir si le PDF est déjà prêt (souvent oui)
    await new Promise(r => setTimeout(r, 1200));
    try {
      const poll = await utils.bpostCall('GET', new URL(cbUrl).pathname, null, token);
      if (poll && poll.__binary) {
        console.log('[Bpost] callback → PDF binaire ' + poll.buffer.length + 'B');
        return { ready: true, mode: 'binary' };
      }
      if (poll && poll.LabelUrl) {
        return { ready: true, mode: 'url', labelUrl: poll.LabelUrl };
      }
    } catch (e) {
      console.warn('[Bpost] poll cb err:', e.message);
    }
    return { ready: false, pending: true, cbUrl };
  }

  return { ready: false, errors: extractErrors(resp) };
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

    // ── 0ter) Si la commande a déjà été poussée, on ne re-crée pas.
    //          L'impression se fait dans Shipping Manager web Bpost
    //          (Carrier 68 = bpost shm ne génère pas de PDF via API
    //          Plug-in, c'est by design). On renvoie juste le cref.
    if (order.bpost_reference && /^ARCA-\d+/.test(order.bpost_reference)) {
      console.log('[Bpost] commande déjà poussée cref=' + order.bpost_reference + ', skip recréation');
      const storedUrl = 'manual:shipping-manager:' + order.bpost_reference;
      await updateOrder(order_id, { bpost_label_url: storedUrl });
      return {
        statusCode: 200,
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          ok: true,
          bpost_reference: order.bpost_reference,
          bpost_label_url: storedUrl,
          message: 'Shipment ' + order.bpost_reference + ' déjà chez Bpost. Imprime-le dans Shipping Manager web (onglet Commandes).'
        })
      };
    }

    // ── 0bis) Lister les carriers autorisés et choisir Carrier+Product ──
    // Structure validée le 2026-06-08 : Carrier 68 ("bpost shm") + un
    // Product dans OptionList (302 = bpack 24h Pro pour BE, 303 = bpack
    // World Business pour intl).
    const country = ISO2[order.pays] || 'BE';
    let carrierInfo = null;
    try {
      const allowedResp = await utils.fetchAllowedCarriers(token);
      const carriers = utils.extractCarrierArray(allowedResp);
      carrierInfo = pickCarrierForCountry(carriers, country);
      console.log('[Bpost] choix pour ' + country + ' →',
        carrierInfo
          ? ('Carrier ' + carrierInfo.carrierId + ' + Product ' +
             (carrierInfo.productId || 'aucun') +
             ' (' + (carrierInfo.productName || '') + ')')
          : 'aucun carrier disponible');
    } catch (e) {
      console.warn('[Bpost] /carriers/allowed/ KO:', e.message, '— on tente auto-select');
    }

    // ── 1) Créer le shipment ────────────────────────────────────────
    // Cascade de fallbacks :
    //   mode A : Carrier + Product (config la plus complète)
    //   mode B : Carrier seul (sans OptionList)
    //   mode C : pas de bloc Carrier (auto-select Bpost)
    // + retry suffixe -r1, -r2… si "already exists" (ghosts).
    let chosenCref = null;
    let shipErrs = [];
    let mode = carrierInfo && carrierInfo.productId ? 'A' : (carrierInfo ? 'B' : 'C');
    let suffixIdx = 0;
    const maxAttempts = 10;
    let attempts = 0;

    while (attempts++ < maxAttempts) {
      const suffix = suffixIdx === 0 ? null : ('r' + suffixIdx);
      let ci = null, includeProduct = false;
      if (mode === 'A') { ci = carrierInfo; includeProduct = true; }
      else if (mode === 'B') { ci = carrierInfo; includeProduct = false; }
      // mode C → ci=null → pas de Carrier

      const shipment = buildShipment(order, suffix, ci, includeProduct);
      console.log('[Bpost] try mode=' + mode + ' cref=' + shipment.ClientReferenceCode);

      const shipResp = await utils.bpostCall('POST', '/v3/shipments/', { Shipment: [shipment] }, token);
      console.log('[Bpost] /shipments →', JSON.stringify(shipResp).substring(0, 300));

      shipErrs = extractErrors(shipResp);
      if (shipErrs.length === 0) {
        chosenCref = shipment.ClientReferenceCode;
        console.log('[Bpost] OK — shipment matérialisé en mode ' + mode + ' avec cref=' + chosenCref);
        break;
      }

      // "already exists" → suffixe suivant, même mode
      if (shipErrs.some(e => /already exists/i.test(e))) {
        console.log('[Bpost] cref déjà pris (ghost), retry suffixe');
        suffixIdx++;
        continue;
      }

      // "Carrier not available" / "Product invalid" → on rétrograde le mode
      if (shipErrs.some(e => /carrier.*not.*available|choose another|product/i.test(e))) {
        if (mode === 'A') {
          console.log('[Bpost] mode A refusé → mode B (Carrier sans Product)');
          mode = 'B';
          continue;
        }
        if (mode === 'B') {
          console.log('[Bpost] mode B refusé → mode C (auto-select)');
          mode = 'C';
          continue;
        }
      }

      // Toute autre erreur → on arrête
      return {
        statusCode: 422,
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          ok: false,
          error: 'Bpost a refusé la commande : ' + shipErrs.join(' · '),
          api_errors: shipErrs,
          mode_tried: mode,
          carrier_info: carrierInfo
        })
      };
    }

    if (!chosenCref) {
      return {
        statusCode: 422,
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          ok: false,
          error: 'Bpost refuse après ' + maxAttempts + ' tentatives. Dernière erreur : ' + shipErrs.join(' · '),
          api_errors: shipErrs,
          carrier_info: carrierInfo
        })
      };
    }

    // ── 2) Shipment matérialisé chez Bpost — on stocke le cref et on
    //       laisse l'admin ouvrir Shipping Manager web pour imprimer.
    //       (Carrier 68 / bpost shm ne fournit pas de PDF via Plug-in
    //       API ; "Invalid service level code" sur /v3/labels confirmé
    //       le 2026-06-08. Pour auto-PDF il faudrait l'API XML deep
    //       integration api.bpost.be/services/shm/.)
    const storedUrl = 'manual:shipping-manager:' + chosenCref;
    await updateOrder(order_id, {
      bpost_shipment_id: chosenCref,
      bpost_reference:   chosenCref,
      bpost_label_url:   storedUrl,
      bpost_status:      'pushed',
      bpost_pushed_at:   new Date().toISOString()
    });

    return {
      statusCode: 200,
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        ok: true,
        bpost_reference: chosenCref,
        bpost_label_url: storedUrl,
        message: 'Shipment ' + chosenCref + ' poussé chez Bpost. Ouvre Shipping Manager web → onglet Commandes → imprime.'
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
