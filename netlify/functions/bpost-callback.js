// Reçoit les status updates push de Bpost (avec signature HMAC)
//
// Format documenté :
//   POST https://podcast-arca.netlify.app/.netlify/functions/bpost-callback
//   Headers: X-Hmac-Signature: <base64>
//   Body:    { Status: "...", TrackingId: "...", ShopItemId: "ARCA-123", ... }
//
// La signature = HMAC-SHA256(status + "," + tracking_id + "," + callback_url, PRIVATE_KEY) base64
// On vérifie puis on met à jour arca.orders.

const utils = require('./_bpost-utils.js');

exports.handler = async function (event) {
  // GET = health check (Bpost ping parfois pour valider que l'URL répond)
  if (event.httpMethod === 'GET') {
    return { statusCode: 200, body: 'Bpost callback endpoint OK' };
  }
  if (event.httpMethod !== 'POST') {
    return { statusCode: 405, body: 'Method not allowed' };
  }

  try {
    const body = JSON.parse(event.body || '{}');
    const status     = body.Status || body.status || '';
    const trackingId = body.TrackingId || body.tracking_id || '';
    const shopItemId = body.ShopItemId || body.shop_item_id || '';
    const receivedSig = event.headers['x-hmac-signature'] || event.headers['X-Hmac-Signature'] || '';

    const host = event.headers.host || 'podcast-arca.netlify.app';
    const callbackUrl = 'https://' + host + '/.netlify/functions/bpost-callback';

    // Vérification HMAC (refuse si invalide)
    if (receivedSig) {
      const valid = utils.verifyCallbackSignature(receivedSig, status, trackingId, callbackUrl);
      if (!valid) {
        console.warn('[Bpost callback] HMAC invalid for', shopItemId, status);
        return { statusCode: 401, body: 'Invalid signature' };
      }
    } else {
      console.warn('[Bpost callback] No signature provided, proceeding anyway');
    }

    console.log('[Bpost callback]', shopItemId, '→', status, 'tracking=', trackingId);

    // Extrait l'order_id depuis ShopItemId = "ARCA-123"
    const m = String(shopItemId).match(/^ARCA-(\d+)$/);
    if (!m) {
      return { statusCode: 200, body: 'No matching order (' + shopItemId + ')' };
    }
    const orderId = parseInt(m[1], 10);

    // Update arca.orders
    await fetch(utils.supaUrl() + '/rest/v1/arca_orders?id=eq.' + orderId, {
      method: 'PATCH',
      headers: {
        apikey: utils.supaKey(), Authorization: 'Bearer ' + utils.supaKey(),
        'Content-Type': 'application/json'
      },
      body: JSON.stringify({
        bpost_status: status,
        bpost_tracking: trackingId || null,
        bpost_status_at: new Date().toISOString()
      })
    });

    return { statusCode: 200, body: 'OK' };
  } catch (err) {
    console.error('bpost-callback error:', err);
    return { statusCode: 500, body: 'Error: ' + err.message };
  }
};
