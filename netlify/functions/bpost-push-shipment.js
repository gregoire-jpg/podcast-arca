// Push une commande arca_orders vers Bpost via Plug-in API v3 sur le
// VRAI domaine plugins.bpost.be (confirmé 2026-06-08 par le screenshot
// SM web → Key management → "Orders are sent to: https://plugins.bpost.be").
//
// Workflow :
//   1. GET /carriers/allowed/ — vérifie carrier 68 actif
//   2. POST /shipments/ avec :
//      - Carrier.Id = 68 (bpost shm)
//      - Carrier.OptionList = [{Id:126, Value:"302"|"303"}] (Product BE|intl)
//      - ShopItemId hex md5 (spec exige 0-9a-f)
//      - HouseNumber string
//      - Country ISO2 majuscule
//   3. Lecture Shipment[0].ShipmentId — vide = ghost = abort SANS BDD
//   4. POST /labels/ → CallbackURL → polling jusqu'à PDF base64
//   5. Stocke bpost-fetch:<cref> dans la BDD, l'admin lit via token HMAC.

const crypto = require('crypto');
const utils = require('./_bpost-utils.js');

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

// ShipmentItems[] — sans ce tableau, Bpost retombe sur 100g par défaut
// pour l'affichage du poids sur l'étiquette intl (validé 2026-06-08
// après que ARTERO ait reçu une étiquette à 0.100kg au lieu de 0.6kg).
// Format aligné sur plugin Woo officiel 3.2.3 (class-woo-Bpost-order.php:316).
function buildShipmentItems(items) {
  return (items || []).map(it => ({
    Count: it.qty || 1,
    Id: it.num || 0,
    Name: it.title || ('N°' + it.num),
    Type: '',
    Value: parseFloat(it.price || 0),
    Weight: WEIGHTS[it.num] || 600,
    ArticleNumber: ''
  }));
}

// Pays UE 27 (mai 2026 — UK exclu post-Brexit, CH/NO/IS pas UE).
// Pour ces pays : pas de douane (Customs absent du payload).
// Pour tout le reste (CA, US, UK, CH, AU, JP…) : Bpost exige Customs.
const UE_27 = new Set([
  'BE','BG','CZ','DK','DE','EE','IE','GR','ES','FR','HR','IT','CY',
  'LV','LT','LU','HU','MT','NL','AT','PL','PT','RO','SI','SK','FI','SE'
]);

// Customs CN22/CN23 — format Plug-in API v3 aligné sur plugin Woo
// officiel (class-Bpost-order.php:627). CustomsType : 3 = GOODS
// (marchandises), 2 = GIFT, 4 = DOCUMENTS, 5 = SAMPLE, 6 = OTHER.
// Pour ARCA = livres + revue littéraire = GOODS (3).
// Description max 40 chars. Value en euros (string décimal).
function buildCustoms(order) {
  const country = ISO2[order.pays] || 'BE';
  if (UE_27.has(country)) return null;  // pas de douane intra-UE

  const totalArticles = (order.items || []).reduce((sum, it) => {
    return sum + (it.qty || 0) * parseFloat(it.price || 0);
  }, 0);
  // Fallback sur total_eur - port_eur si items vides
  const fallback = parseFloat(order.total_eur || 0) - parseFloat(order.port_eur || 0);
  const value = totalArticles > 0 ? totalArticles : Math.max(fallback, 1);

  return {
    CustomsType: 3,  // GOODS
    Description: 'Livres / Revue litteraire ARCA'.substring(0, 40),
    Type: '',
    Value: value.toFixed(2)
  };
}

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

function buildCref(orderId, attempt) {
  if (attempt === 0) return 'ARCA-' + orderId;
  const rnd = crypto.randomBytes(4).toString('hex');
  return 'ARCA-' + orderId + '-' + rnd;
}

// Format payload validé sur le plugin Woo officiel v3.2.3 (téléchargé
// le 2026-06-08, classes-Bpost-order.php get_api_props ligne 574).
// Différences critiques avec ce qu'on faisait avant :
//   - ShopItemId = order.id ENTIER brut (pas md5 hex)
//   - OptionList à la RACINE du Shipment (PAS dans Carrier !) ← LE BUG
//   - Carrier = { Id: 68 } seul
//   - Streetname2 + State ajoutés (vides acceptables) pour matcher 100%
function buildShipment(order, attempt) {
  const addr = parseStreet(order.rue);
  let houseNumber = '1';
  let numberExt = order.complement || '';
  if (addr.number) {
    const n = parseInt(addr.number, 10);
    if (Number.isFinite(n) && n > 0) {
      houseNumber = String(n);
      const ext = String(addr.number).replace(/^\d+/, '').trim();
      if (ext) numberExt = (numberExt ? numberExt + ' ' : '') + ext;
    }
  }
  const country = ISO2[order.pays] || 'BE';
  const cref = buildCref(order.id, attempt);
  // Product Bpost selon pays (cf. Shipping rules Antoine + contrat ARCA) :
  //   BE → 302 bpack 24h Pro
  //   !BE → 303 bpack World Business
  const productId = country === 'BE' ? '302' : '303';

  // ShopItemId = entier nu si premier essai (cas plugin officiel),
  // ou random hex 8 chars en retry pour éviter collision avec ghosts.
  const shopItemId = attempt === 0
    ? order.id
    : parseInt(crypto.randomBytes(4).toString('hex'), 16);

  const shipment = {
    ShopItemId: shopItemId,
    ClientReferenceCode: cref,
    Address: {
      CompanyName: '',
      Name: order.nom || '—',
      Streetname1: addr.street || (order.rue || '').slice(0, 40) || 'Adresse',
      Streetname2: '',
      HouseNumber: houseNumber,
      NumberExtension: numberExt,
      PostalCode: order.cp || '',
      City: order.ville || '',
      State: '',
      Country: country,
      Phone: order.telephone || '',
      Email: order.email || ''
    },
    OptionList: [
      { Id: 126, Value: productId }
    ],
    Carrier: { Id: 68 },
    Weight: computeWeightG(order.items),
    ShipmentItems: buildShipmentItems(order.items)
  };
  // Customs : ajouté UNIQUEMENT si pays hors UE (CA, US, UK, CH…)
  const customs = buildCustoms(order);
  if (customs) shipment.Customs = customs;
  return shipment;
}

function extractErrors(resp) {
  const errs = [];
  const shipments = Array.isArray(resp && resp.Shipment) ? resp.Shipment : [];
  shipments.forEach(s => {
    if (Array.isArray(s.ErrorList)) {
      s.ErrorList.forEach(e => errs.push((e.Tekst || e.Info || 'erreur').trim()));
    }
    if (s && s.Error && s.Error.Id && s.Error.Id !== 0) {
      errs.push((s.Error.Info || ('Error ' + s.Error.Id)).trim());
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

function extractShipmentId(resp) {
  if (!resp) return null;
  const arr = Array.isArray(resp.Shipment) ? resp.Shipment : [resp.Shipment].filter(Boolean);
  for (const s of arr) {
    if (!s) continue;
    const id = s.ShipmentId || s.Id;
    if (id && String(id).length > 0) return String(id);
  }
  return null;
}

async function tryFetchLabel(token, cref) {
  const payload = {
    ClientReferenceCodeList: [cref],
    LabelType: 0,
    LabelStart: 1
  };
  let resp;
  try {
    resp = await utils.bpostCall('POST', '/v3/labels/', payload, token);
  } catch (e) {
    return { ready: false, errors: ['exception: ' + e.message] };
  }
  if (resp && resp.__binary) {
    return { ready: true, mode: 'binary' };
  }
  const errs = extractErrors(resp);
  if (errs.length > 0) {
    return { ready: false, errors: errs };
  }
  if (resp && resp.LabelUrl) {
    return { ready: true, mode: 'url', labelUrl: resp.LabelUrl };
  }
  const cbUrl = resp && (resp.CallbackURL || resp.CallbackUrl);
  if (!cbUrl) {
    return { ready: false, errors: ['Aucun CallbackURL retourné'] };
  }
  // Polling long (6×1.3s = 7.8s, < timeout Netlify 10s).
  // "API work in progress" = label en cours côté Bpost, on continue.
  // Vrai ghost = erreur définitive (Invalid service level, etc.).
  for (let i = 0; i < 6; i++) {
    await new Promise(r => setTimeout(r, 1300));
    let poll;
    try {
      poll = await utils.bpostCall('GET', new URL(cbUrl).pathname, null, token);
    } catch (e) {
      continue;
    }
    if (poll && poll.__binary) {
      return { ready: true, mode: 'binary' };
    }
    const pollErrs = extractErrors(poll);
    // Status transitoire "work in progress" → continue polling
    if (pollErrs.length > 0 && pollErrs.every(e => /work in progress|in progress|generating/i.test(e))) {
      console.log('[Bpost] label en cours de génération, attente…');
      continue;
    }
    // Vraie erreur définitive
    if (pollErrs.length > 0) {
      return { ready: false, errors: pollErrs, ghost: true };
    }
    if (poll && poll.Finished === 100) {
      if (poll.LabelPDF) return { ready: true, mode: 'binary' };
      if (poll.LabelUrl) return { ready: true, mode: 'url', labelUrl: poll.LabelUrl };
      return { ready: false, errors: ['Finished=100 sans LabelPDF ni LabelUrl'] };
    }
  }
  // Pas prêt après 7.8s — on stocke le callback, admin réessayera plus tard
  return { ready: false, pending: true, cbUrl };
}

exports.handler = async function (event) {
  if (event.httpMethod !== 'POST') return { statusCode: 405, body: 'Method not allowed' };

  try {
    const { order_id, force } = JSON.parse(event.body || '{}');
    if (!order_id) return { statusCode: 400, body: 'order_id manquant' };

    const order = await loadOrder(order_id);
    const host = event.headers.host || 'podcast-arca.netlify.app';
    const fallbackShopUrl = 'https://' + host + '/.netlify/functions/bpost-callback';
    const shopUrl = process.env.BPOST_SHOP_URL || fallbackShopUrl;
    const token = await utils.getValidToken(shopUrl);

    // ── Skip create si déjà poussée : fetch label seul
    if (order.bpost_reference && !force) {
      console.log('[Bpost] cref existant=' + order.bpost_reference + ', fetch label seul');
      const labelRes = await tryFetchLabel(token, order.bpost_reference);
      if (labelRes.ready) {
        const storedUrl = labelRes.mode === 'binary'
          ? 'bpost-fetch:' + order.bpost_reference
          : labelRes.labelUrl;
        await updateOrder(order_id, { bpost_label_url: storedUrl });
        return {
          statusCode: 200,
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ ok: true, bpost_reference: order.bpost_reference, bpost_label_url: storedUrl, label_ready: true })
        };
      }
      if (labelRes.ghost) {
        await updateOrder(order_id, {
          bpost_reference: null, bpost_shipment_id: null,
          bpost_label_url: null, bpost_status: null, bpost_pushed_at: null
        });
        return {
          statusCode: 422,
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            ok: false, ghost: true,
            error: 'Shipment fantôme (' + (labelRes.errors || []).join(' · ') + '). BDD nettoyée — réessaie.'
          })
        };
      }
      return {
        statusCode: 200,
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          ok: true,
          bpost_reference: order.bpost_reference,
          bpost_label_url: 'bpost-fetch:' + order.bpost_reference,
          pending: true,
          message: 'PDF en cours de génération côté Bpost — réessaie dans 30s.'
        })
      };
    }

    // ── Créer le shipment (retry random hex sur "already exists")
    let chosenCref = null;
    let shipmentId = null;
    let shipErrs = [];
    const maxAttempts = 5;

    for (let attempt = 0; attempt < maxAttempts; attempt++) {
      const shipment = buildShipment(order, attempt);
      console.log('[Bpost] POST /shipments cref=' + shipment.ClientReferenceCode);

      const shipResp = await utils.bpostCall('POST', '/v3/shipments/', { Shipment: [shipment] }, token);
      console.log('[Bpost] response →', JSON.stringify(shipResp).substring(0, 400));

      shipErrs = extractErrors(shipResp);
      if (shipErrs.length === 0) {
        shipmentId = extractShipmentId(shipResp);
        if (shipmentId) {
          chosenCref = shipment.ClientReferenceCode;
          console.log('[Bpost] OK — ShipmentId=' + shipmentId + ' cref=' + chosenCref);
          break;
        }
        // Si pas de ShipmentId mais pas d'erreur → on accepte quand
        // même et on tente le label (Bpost peut renvoyer juste le cref)
        chosenCref = shipment.ClientReferenceCode;
        shipmentId = chosenCref;
        console.log('[Bpost] pas de ShipmentId explicite, on assume OK avec cref=' + chosenCref);
        break;
      }

      if (shipErrs.some(e => /already exists/i.test(e))) {
        continue;  // random hex au prochain tour
      }

      return {
        statusCode: 422,
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          ok: false,
          error: 'Bpost a refusé : ' + shipErrs.join(' · '),
          api_errors: shipErrs
        })
      };
    }

    if (!chosenCref) {
      return {
        statusCode: 422,
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          ok: false,
          error: 'Bpost refuse après ' + maxAttempts + ' essais. Dernière : ' + shipErrs.join(' · ')
        })
      };
    }

    // ── Récupérer le label
    const labelRes = await tryFetchLabel(token, chosenCref);

    if (labelRes.ghost) {
      return {
        statusCode: 422,
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          ok: false, ghost: true,
          error: 'Shipment créé mais label révèle ghost : ' + (labelRes.errors || []).join(' · '),
          bpost_reference: chosenCref
        })
      };
    }

    const storedUrl = labelRes.ready && labelRes.mode === 'url'
      ? labelRes.labelUrl
      : 'bpost-fetch:' + chosenCref;

    await updateOrder(order_id, {
      bpost_shipment_id: shipmentId,
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
        bpost_shipment_id: shipmentId,
        bpost_label_url: storedUrl,
        label_ready: !!labelRes.ready,
        message: labelRes.ready
          ? 'Shipment ' + chosenCref + ' OK. Clique "Imprimer étiquette".'
          : 'Shipment ' + chosenCref + ' OK. PDF en génération — clique "Imprimer étiquette" dans 30s.'
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
