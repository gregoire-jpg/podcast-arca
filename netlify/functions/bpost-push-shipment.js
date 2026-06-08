// Push une commande arca_orders vers Bpost Shipping Manager (Plug-in API v3).
//
// Workflow validé le 2026-06-08 après debug-order :
//   1. POST /v3/shipments avec Carrier 68 SEUL (pas d'OptionList Product
//      — les Shipping rules d'Antoine route automatiquement vers
//      bpack 24h Pro (BE) ou bpack World Business (intl)).
//   2. La réponse doit contenir Shipment[0].ShipmentId NON VIDE — sinon
//      c'est un ghost et on remonte une erreur explicite SANS rien
//      écrire en BDD.
//   3. POST /v3/labels (asynchrone : retourne un CallbackURL) puis
//      polling GET /v3/labels/{runid} jusqu'à Finished == 100.
//   4. Le LabelPDF est en base64 dans la réponse polling — on stocke
//      le bpost-fetch:<cref> et l'admin demande l'URL signée pour
//      streamer le PDF.
//
// Points anciens debugs qui ne s'appliquent plus :
// - ShopItemId : la spec exige HEX (0-9a-f, max 60). "ARCA-16" rejeté
//   silencieusement (200 + Error 0, mais shipment non matérialisé).
//   → on dérive ShopItemId = md5(orderId+suffix).substring(0,16).
// - Carrier.OptionList Product : on NE l'envoie PAS. Les Shipping
//   rules d'Antoine (visibles sur SM web → Shipping rules) assignent
//   le bon Product selon le pays. Envoyer un Product ici peut
//   contredire la rule et casser le routage.
// - HouseNumber : doit être STRING selon la spec, pas integer.
// - 200 + Error.Id 0 ≠ succès : on doit vérifier Shipment[0].ShipmentId.

const crypto = require('crypto');
const utils = require('./_bpost-utils.js');

// Pays FR → ISO2 (Plugin API v3 attend ISO2 majuscule).
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

// ShopItemId hex pur (spec Bpost : [0-9a-f]+ max 60). On hash la cref
// "ARCA-N[-rN]" en md5 pour obtenir un hex stable et unique.
function shopItemHex(cref) {
  return crypto.createHash('md5').update(cref).digest('hex').substring(0, 32);
}

// Au premier essai on tente "ARCA-N" (lisible dans SM web). Si Bpost
// répond "already exists" (cas des commandes qui ont des ghosts laissés
// par les anciens push cassés), on bascule sur un suffixe random hex
// 8 chars — impossible de retomber sur un ghost existant.
function buildCref(orderId, attempt) {
  if (attempt === 0) return 'ARCA-' + orderId;
  const rnd = crypto.randomBytes(4).toString('hex');  // 8 chars hex
  return 'ARCA-' + orderId + '-' + rnd;
}

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

  // Product selon pays :
  //   BE  → 302 bpack 24h Pro
  //   !BE → 303 bpack World Business
  // Les Shipping rules d'Antoine ne déclenchent que si Product est
  // DÉJÀ défini et matche la condition. Sans Product dans le payload,
  // Bpost ne peut pas assigner de service level → "No valid items" sur
  // POST /labels. On envoie donc directement le bon Product ; la rule
  // écrasera avec la même valeur (no-op).
  const productId = country === 'BE' ? '302' : '303';

  return {
    ShopItemId: shopItemHex(cref),
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
    Weight: computeWeightG(order.items),
    Carrier: {
      Id: 68,
      OptionList: [
        { Id: 126, Value: productId }
      ]
    }
  };
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

// Validation critique : extrait Shipment[0].ShipmentId (ou Id, ou
// équivalent) de la réponse POST /shipments. Si vide ou absent →
// ghost (200 trompeur), on doit le signaler comme tel.
function extractShipmentId(resp) {
  if (!resp) return null;
  const arr = Array.isArray(resp.Shipment) ? resp.Shipment : [resp.Shipment].filter(Boolean);
  for (const s of arr) {
    if (!s) continue;
    const id = s.ShipmentId || s.Id || s.ShopItemId;
    if (id && String(id).length > 0) return String(id);
  }
  return null;
}

// POST /v3/labels asynchrone : retourne CallbackURL → GET /v3/labels/{runid}
// jusqu'à Finished == 100. La réponse finale contient LabelPDF en base64.
async function tryFetchLabel(token, cref) {
  const payload = {
    ClientReferenceCodeList: [cref],
    LabelType: 1,    // 1 = A4 par défaut. Antoine peut ajuster via SM
                     // web → Default settings → label format.
    LabelStart: 1
  };

  let resp;
  try {
    resp = await utils.bpostCall('POST', '/v3/labels/', payload, token);
  } catch (e) {
    console.warn('[Bpost] POST /labels exception:', e.message);
    return { ready: false, errors: ['exception: ' + e.message] };
  }

  // Cas direct (rare) : PDF binaire
  if (resp && resp.__binary) {
    return { ready: true, mode: 'binary' };
  }
  console.log('[Bpost] POST /labels →', JSON.stringify(resp).substring(0, 400));

  // Erreur immédiate (901 si shipment ghost)
  const errs = extractErrors(resp);
  if (errs.length > 0) {
    return { ready: false, errors: errs };
  }

  // Cas direct (rare) : LabelUrl directe
  if (resp && resp.LabelUrl) {
    return { ready: true, mode: 'url', labelUrl: resp.LabelUrl };
  }

  // Cas standard : CallbackURL avec polling
  const cbUrl = resp && (resp.CallbackURL || resp.CallbackUrl);
  if (!cbUrl) {
    return { ready: false, errors: ['Aucun CallbackURL retourné par Bpost'] };
  }

  // Polling court (< 6s total pour rester sous timeout Netlify 10s)
  // Bpost génère typiquement le PDF en 1-3s pour un shipment valide.
  for (let i = 0; i < 4; i++) {
    await new Promise(r => setTimeout(r, 1300));
    let poll;
    try {
      poll = await utils.bpostCall('GET', new URL(cbUrl).pathname, null, token);
    } catch (e) {
      console.warn('[Bpost] poll', i, 'err:', e.message);
      continue;
    }
    if (poll && poll.__binary) {
      return { ready: true, mode: 'binary' };
    }
    const pollErrs = extractErrors(poll);
    if (pollErrs.length > 0) {
      // Le shipment était ghost — Bpost le révèle au polling
      return { ready: false, errors: pollErrs, ghost: true };
    }
    if (poll && poll.Finished === 100) {
      if (poll.LabelPDF) {
        return { ready: true, mode: 'binary' };
      }
      if (poll.LabelUrl) {
        return { ready: true, mode: 'url', labelUrl: poll.LabelUrl };
      }
      return { ready: false, errors: ['Finished=100 sans LabelPDF ni LabelUrl'] };
    }
  }

  // Pas prêt après 5.2s — on remonte le callback pour récupération différée
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

    // ── 0) Re-push autorisé seulement avec force: true (anti-double-fact)
    if (order.bpost_reference && !force) {
      // On tente juste de récupérer le label sans recréer le shipment
      console.log('[Bpost] commande déjà poussée cref=' + order.bpost_reference + ', fetch label only');
      const labelRes = await tryFetchLabel(token, order.bpost_reference);
      if (labelRes.ready) {
        const storedUrl = labelRes.mode === 'binary'
          ? 'bpost-fetch:' + order.bpost_reference
          : labelRes.labelUrl;
        await updateOrder(order_id, { bpost_label_url: storedUrl });
        return {
          statusCode: 200,
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ ok: true, bpost_reference: order.bpost_reference, bpost_label_url: storedUrl })
        };
      }
      if (labelRes.ghost) {
        // Bpost confirme que le cref est ghost — on nettoie la BDD
        await updateOrder(order_id, {
          bpost_reference: null, bpost_shipment_id: null,
          bpost_label_url: null, bpost_status: null, bpost_pushed_at: null
        });
        return {
          statusCode: 422,
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            ok: false,
            error: 'Le shipment précédent était fantôme (' + (labelRes.errors || []).join(' · ') + '). BDD nettoyée — réessaie.',
            ghost: true
          })
        };
      }
      // Pending (PDF pas encore prêt)
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

    // ── 1) Créer le shipment ────────────────────────────────────────
    // Retry suffixe -r1, -r2… seulement si "already exists" sur premier essai.
    let chosenCref = null;
    let shipmentId = null;
    let shipErrs = [];
    let suffixIdx = 0;
    const maxAttempts = 5;

    for (let attempt = 0; attempt < maxAttempts; attempt++) {
      const suffix = suffixIdx === 0 ? null : ('r' + suffixIdx);
      const shipment = buildShipment(order, suffix);
      console.log('[Bpost] POST /shipments cref=' + shipment.ClientReferenceCode + ' shopItemId=' + shipment.ShopItemId);

      const shipResp = await utils.bpostCall('POST', '/v3/shipments/', { Shipment: [shipment] }, token);
      console.log('[Bpost] response →', JSON.stringify(shipResp).substring(0, 400));

      shipErrs = extractErrors(shipResp);
      if (shipErrs.length === 0) {
        // Validation critique : présence de Shipment[0].ShipmentId
        shipmentId = extractShipmentId(shipResp);
        if (shipmentId) {
          chosenCref = shipment.ClientReferenceCode;
          console.log('[Bpost] OK — ShipmentId=' + shipmentId + ' cref=' + chosenCref);
          break;
        }
        // 200 + Error 0 mais SANS ShipmentId = ghost
        console.warn('[Bpost] GHOST : 200 OK mais ShipmentId absent (cref=' + shipment.ClientReferenceCode + ')');
        return {
          statusCode: 422,
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            ok: false,
            ghost: true,
            error: 'Bpost a accepté le shipment mais ne l\'a pas matérialisé (réponse sans ShipmentId). Vérifie côté SM web : Shipping rules actives, Carrier 68 configuré, ShopUrl déclarée. Cref non écrit en BDD pour éviter d\'enfermer la commande.',
            bpost_response: shipResp
          })
        };
      }

      if (shipErrs.some(e => /already exists/i.test(e))) {
        suffixIdx++;
        continue;
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
          error: 'Bpost refuse après ' + maxAttempts + ' essais. Dernière erreur : ' + shipErrs.join(' · ')
        })
      };
    }

    // ── 2) Récupérer le label ───────────────────────────────────────
    const labelRes = await tryFetchLabel(token, chosenCref);

    // Si le label révèle un ghost (Bpost final return 901), on rollback
    if (labelRes.ghost) {
      return {
        statusCode: 422,
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          ok: false,
          ghost: true,
          error: 'Shipment créé mais le label révèle un ghost : ' + (labelRes.errors || []).join(' · '),
          bpost_reference: chosenCref
        })
      };
    }

    // ── 3) Écrire en BDD (seulement si shipment vraiment matérialisé)
    let storedUrl;
    if (labelRes.ready && labelRes.mode === 'binary') {
      storedUrl = 'bpost-fetch:' + chosenCref;
    } else if (labelRes.ready && labelRes.mode === 'url') {
      storedUrl = labelRes.labelUrl;
    } else if (labelRes.pending && labelRes.cbUrl) {
      storedUrl = 'bpost-fetch:' + chosenCref;  // sera récupéré au prochain clic
    } else {
      storedUrl = 'bpost-fetch:' + chosenCref;
    }

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
          ? 'Shipment ' + chosenCref + ' matérialisé. Clique "Imprimer étiquette".'
          : 'Shipment ' + chosenCref + ' matérialisé. PDF en cours de génération — clique "Imprimer étiquette" dans 30s.'
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
