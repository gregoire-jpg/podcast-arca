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

// Mapping pays → ISO3 (Bpost exige ISO3)
const ISO3 = {
  'Belgique': 'BEL', 'France': 'FRA', 'Luxembourg': 'LUX', 'Pays-Bas': 'NLD',
  'Allemagne': 'DEU', 'Autriche': 'AUT', 'Italie': 'ITA', 'Espagne': 'ESP',
  'Portugal': 'PRT', 'Royaume-Uni': 'GBR', 'Suisse': 'CHE', 'Canada': 'CAN',
  'DOM-TOM': 'FRA', 'Autres pays UE': 'BEL'
};

// Poids mesurés (pesées réelles 2026-05-18 pour 3/4/5/7; 600g par défaut, 350g recueil)
const WEIGHTS = { 1:600, 2:600, 3:735, 4:565, 5:506, 6:600, 7:532, 8:600, 9:350 };
function computeWeightG(items) {
  let g = 0;
  (items || []).forEach(i => { g += (i.qty || 0) * (WEIGHTS[i.num] || 600); });
  return Math.max(g, 100);
}

// Parse une rue "Rue de la Brasserie, 18" → { street: "Rue de la Brasserie", number: 18 }
function parseStreet(rue) {
  if (!rue) return { street: '', number: '' };
  const m = rue.match(/^(.+?)[,\s]+(\d+\w?)$/);
  if (m) return { street: m[1].trim(), number: m[2] };
  return { street: rue, number: '' };
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

function buildShipment(order, carrierId) {
  const addr = parseStreet(order.rue);
  return {
    ShopItemId: 'ARCA-' + order.id,
    ClientReferenceCode: 'ARCA-' + order.id,
    Address: {
      Name: order.nom || '—',
      CompanyName: '',
      Streetname1: addr.street,
      HouseNumber: addr.number ? parseInt(addr.number, 10) : 0,
      NumberExtension: order.complement || '',
      PostalCode: order.cp || '',
      City: order.ville || '',
      Country: ISO3[order.pays] || 'BEL',
      Phone: order.telephone || '',
      Email: order.email || ''
    },
    Carrier: { Id: carrierId },
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

    // Récupère le 1er carrier compatible (bpack@home par défaut)
    // Pour MVP : on prend l'ID 301 (Bpack 24/7 & Bpack@bpost) si dispo, sinon le premier
    let carrierId = 301; // valeur par défaut testée sur GET /carriers
    try {
      const carriers = await utils.bpostCall('GET', '/v3/carriers/', null, token);
      const list = (carriers.Carrier || []).flatMap(c =>
        (c.OptionList || []).flatMap(o => o.OptionValues || [])
      );
      const home = list.find(o => /bpack/i.test(o.Name) && !o.IsPickup);
      if (home && home.Id) carrierId = parseInt(home.Id, 10);
    } catch (e) {
      console.warn('Carrier lookup failed, using default 301:', e.message);
    }

    // 1) POST /v3/shipments
    const shipPayload = { Shipment: [buildShipment(order, carrierId)] };
    const shipResp = await utils.bpostCall('POST', '/v3/shipments/', shipPayload, token);
    console.log('[Bpost] shipments resp:', JSON.stringify(shipResp).substring(0, 500));

    // 2) POST /v3/labels — démarre génération PDF
    let labelUrl = null;
    try {
      const labelPayload = {
        ClientReferenceCodeList: ['ARCA-' + order.id],
        LabelStart: 1,
        LabelType: 'A6'   // format A6 standard Bpost
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
