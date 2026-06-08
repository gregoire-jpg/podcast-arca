// bpost-print-direct.js — Reçoit { password, ref } en form-encoded
// (ou JSON), récupère le PDF chez Bpost et le retourne directement.
//
// Conçu pour être appelé via un <form method="POST" target="_blank">
// avec password en hidden input — comme ça pas d'async JS qui perd le
// user gesture, et le password ne transite jamais en URL.

const utils = require('./_bpost-utils.js');

// ── Cache PDF en BDD (anti-double-facturation) ─────────────────────
// Après la 1ère impression réussie, on stocke le PDF base64 dans
// arca_orders.bpost_label_pdf_b64. Au re-clic, on sert depuis la BDD
// SANS appeler /v3/labels (qui pourrait potentiellement re-facturer).
async function loadCachedPdf(ref) {
  if (!process.env.SUPABASE_URL || !process.env.SUPABASE_SERVICE_KEY) return null;
  const url = process.env.SUPABASE_URL + '/rest/v1/arca_orders'
            + '?bpost_reference=eq.' + encodeURIComponent(ref)
            + '&select=bpost_label_pdf_b64,bpost_label_fetched_at';
  const r = await fetch(url, {
    headers: { apikey: process.env.SUPABASE_SERVICE_KEY, Authorization: 'Bearer ' + process.env.SUPABASE_SERVICE_KEY }
  });
  if (!r.ok) return null;
  const rows = await r.json();
  if (rows && rows[0] && rows[0].bpost_label_pdf_b64) {
    return { b64: rows[0].bpost_label_pdf_b64, fetchedAt: rows[0].bpost_label_fetched_at };
  }
  return null;
}

async function saveCachedPdf(ref, buffer) {
  if (!process.env.SUPABASE_URL || !process.env.SUPABASE_SERVICE_KEY) return;
  const url = process.env.SUPABASE_URL + '/rest/v1/arca_orders?bpost_reference=eq.' + encodeURIComponent(ref);
  await fetch(url, {
    method: 'PATCH',
    headers: {
      apikey: process.env.SUPABASE_SERVICE_KEY,
      Authorization: 'Bearer ' + process.env.SUPABASE_SERVICE_KEY,
      'Content-Type': 'application/json'
    },
    body: JSON.stringify({
      bpost_label_pdf_b64: buffer.toString('base64'),
      bpost_label_fetched_at: new Date().toISOString(),
      bpost_status: 'PRINTED'
    })
  });
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
  if (resp && resp.Error && resp.Error.Id && resp.Error.Id !== 0) {
    errs.push((resp.Error.Info || ('Error ' + resp.Error.Id)).trim());
  }
  return errs;
}

function parseBody(event) {
  const ctype = (event.headers['content-type'] || event.headers['Content-Type'] || '').toLowerCase();
  const body = event.body || '';
  if (ctype.includes('application/json')) {
    try { return JSON.parse(body); } catch { return {}; }
  }
  // form-urlencoded
  const params = {};
  body.split('&').forEach(pair => {
    const [k, v] = pair.split('=');
    if (k) params[decodeURIComponent(k.replace(/\+/g, ' '))] = decodeURIComponent((v || '').replace(/\+/g, ' '));
  });
  return params;
}

exports.handler = async function (event) {
  if (event.httpMethod !== 'POST') {
    return htmlError(405, 'Method Not Allowed');
  }

  const body = parseBody(event);
  if (!body.password || body.password !== process.env.ADMIN_PASSWORD) {
    return htmlError(401, 'Mot de passe incorrect.');
  }
  const ref = body.ref;
  if (!ref || !/^ARCA-\d+(-r\d+|-[0-9a-f]{4,16})?$/.test(ref)) {
    return htmlError(400, 'Référence invalide : ' + ref);
  }

  try {
    // ── ANTI-DOUBLE-FACTURATION : check cache PDF en BDD ──────────
    // Si le PDF est déjà imprimé une fois, on le sert depuis la BDD
    // SANS appeler Bpost (zéro risque de double facture).
    const cached = await loadCachedPdf(ref);
    if (cached && cached.b64) {
      console.log('[Bpost print] cache HIT pour ' + ref + ' (fetched ' + cached.fetchedAt + ')');
      return pdfResponse(Buffer.from(cached.b64, 'base64'), ref);
    }
    console.log('[Bpost print] cache MISS pour ' + ref + ', appel Bpost');

    const host = event.headers.host || 'podcast-arca.netlify.app';
    const shopUrl = process.env.BPOST_SHOP_URL || ('https://' + host + '/.netlify/functions/bpost-callback');
    const token = await utils.getValidToken(shopUrl);

    // POST /v3/labels avec ClientReferenceCode
    const labelPayload = {
      ClientReferenceCodeList: [ref],
      LabelStart: 1,
      LabelType: 0
    };

    let resp = await utils.bpostCall('POST', '/v3/labels/', labelPayload, token);

    if (resp && resp.__binary) {
      try { await saveCachedPdf(ref, resp.buffer); } catch (e) { console.warn('[cache] save KO:', e.message); }
      return pdfResponse(resp.buffer, ref);
    }

    // Polling sur CallbackURL si retour async
    const cbUrl = resp && (resp.CallbackURL || resp.CallbackUrl);
    if (cbUrl) {
      for (let i = 0; i < 5; i++) {
        await new Promise(r => setTimeout(r, 1300));
        let poll;
        try {
          poll = await utils.bpostCall('GET', new URL(cbUrl).pathname, null, token);
        } catch (e) {
          continue;
        }
        if (poll && poll.__binary) {
          try { await saveCachedPdf(ref, poll.buffer); } catch (e) { console.warn('[cache] save KO:', e.message); }
          return pdfResponse(poll.buffer, ref);
        }
        const errs = extractErrors(poll);
        if (errs.length > 0 && !errs.every(e => /work in progress|in progress|generating/i.test(e))) {
          return htmlError(500, 'Erreur Bpost : ' + errs.join(' · '));
        }
        if (poll && poll.Finished === 100) {
          if (poll.LabelPDF) {
            const pdfBuf = Buffer.from(poll.LabelPDF, 'base64');
            try { await saveCachedPdf(ref, pdfBuf); } catch (e) { console.warn('[cache] save KO:', e.message); }
            return pdfResponse(pdfBuf, ref);
          }
          if (poll.LabelUrl) {
            return { statusCode: 302, headers: { Location: poll.LabelUrl }, body: '' };
          }
        }
      }
      return htmlError(202, 'PDF pas encore prêt côté Bpost. Réessaie dans 30 secondes.');
    }

    return htmlError(500, 'Réponse Bpost inattendue : ' + JSON.stringify(resp).substring(0, 200));
  } catch (e) {
    return htmlError(500, 'Erreur : ' + e.message);
  }
};

function pdfResponse(buffer, ref) {
  return {
    statusCode: 200,
    headers: {
      'Content-Type': 'application/pdf',
      'Content-Disposition': 'inline; filename="' + ref + '.pdf"',
      'Cache-Control': 'private, no-store, max-age=0'
    },
    body: buffer.toString('base64'),
    isBase64Encoded: true
  };
}

function htmlError(status, msg) {
  return {
    statusCode: status,
    headers: { 'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'no-store' },
    body: '<!DOCTYPE html><html><head><title>Erreur Bpost</title><meta charset="utf-8"></head>' +
          '<body style="font:14px Arial;padding:2em;color:#333"><h2 style="color:#c00">Erreur Bpost</h2><p>' +
          escapeHtml(msg) + '</p></body></html>'
  };
}

function escapeHtml(s) {
  return String(s)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}
