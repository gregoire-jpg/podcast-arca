// Envoie un mail d'annulation au client pour une commande annulée.
// POST { order_id: N, reason?: "..." } -> { success: true }
// Récupère la commande depuis Supabase, envoie un mail Brevo sobre.

exports.handler = async function(event) {
  if (event.httpMethod === 'OPTIONS') return { statusCode: 204, headers: cors(), body: '' };
  if (event.httpMethod !== 'POST') return json(405, { error: 'Method not allowed' });

  const SUPABASE_URL = process.env.SUPABASE_URL;
  const SUPABASE_KEY = process.env.SUPABASE_SERVICE_KEY;
  const BREVO_KEY    = process.env.BREVO_API_KEY;
  const FROM_EMAIL   = process.env.ORDER_EMAIL_FROM;
  if (!SUPABASE_URL || !SUPABASE_KEY) return json(500, { error: 'SUPABASE_* env vars manquantes' });
  if (!BREVO_KEY || !FROM_EMAIL)      return json(500, { error: 'BREVO_API_KEY ou ORDER_EMAIL_FROM manquant' });

  let body;
  try { body = JSON.parse(event.body || '{}'); } catch (e) { return json(400, { error: 'Invalid JSON' }); }
  const orderId = parseInt(body.order_id, 10);
  if (!orderId) return json(400, { error: 'order_id requis' });
  const reason = (body.reason || '').trim();

  // Charge la commande
  const r = await fetch(`${SUPABASE_URL}/rest/v1/arca_orders?id=eq.${orderId}&select=*`, {
    headers: { 'apikey': SUPABASE_KEY, 'Authorization': 'Bearer ' + SUPABASE_KEY }
  });
  if (!r.ok) return json(500, { error: 'Erreur lecture Supabase' });
  const rows = await r.json();
  if (!rows.length) return json(404, { error: 'Commande introuvable' });
  const o = rows[0];
  if (!o.email) return json(400, { error: "Pas d'email client" });

  const subject = 'Annulation de votre commande ARCA n°' + o.id;
  const html = buildHtml(o, reason);
  const text = buildText(o, reason);

  const payload = {
    sender:  { name: 'ARCA Revue & Librairie', email: FROM_EMAIL },
    to:      [{ email: o.email, name: o.nom || '' }],
    replyTo: { email: 'antoine@arca-librairie.com', name: 'ARCA' },
    subject: subject,
    htmlContent: html,
    textContent: text
  };
  const resp = await fetch('https://api.brevo.com/v3/smtp/email', {
    method: 'POST',
    headers: { 'accept': 'application/json', 'api-key': BREVO_KEY, 'Content-Type': 'application/json' },
    body: JSON.stringify(payload)
  });
  if (!resp.ok) {
    const err = await resp.text();
    console.error('[send-cancellation] Brevo error:', resp.status, err.substring(0, 300));
    return json(502, { error: 'Brevo HTTP ' + resp.status });
  }
  console.log('[send-cancellation] Mail annulation envoyé à', o.email, '(commande #' + o.id + ')');
  return json(200, { success: true });
};

function esc(s) {
  return String(s == null ? '' : s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}

function buildHtml(o, reason) {
  const reasonBlock = reason ? `
  <tr><td style="padding:0 40px 18px;">
    <table width="100%" cellpadding="0" cellspacing="0" style="background:#faf8f5;border-left:3px solid #c8a060;border-radius:0 4px 4px 0;">
      <tr><td style="padding:14px 18px;font:14px/1.6 Georgia;color:#555;">
        <strong style="color:#2d3461;">Motif&nbsp;:</strong> ${esc(reason)}
      </td></tr>
    </table>
  </td></tr>` : '';

  return `<!DOCTYPE html><html lang="fr"><head><meta charset="UTF-8"><meta name="viewport" content="width=device-width, initial-scale=1.0"><title>Annulation commande ARCA</title></head>
<body style="margin:0;padding:0;background:#f0ede8;font-family:Georgia,serif;">
<table width="100%" cellpadding="0" cellspacing="0" border="0" style="background:#f0ede8;"><tr><td align="center" style="padding:30px 16px;">
<table width="600" cellpadding="0" cellspacing="0" border="0" style="max-width:600px;width:100%;background:#fff;border-radius:4px;overflow:hidden;box-shadow:0 2px 16px rgba(0,0,0,.10);">
  <tr><td style="background:#2d3461;padding:38px 40px;text-align:center;">
    <p style="margin:0 0 8px;font-family:Arial,sans-serif;font-size:11px;letter-spacing:5px;text-transform:uppercase;color:#c8a060;">Revue &amp; Librairie</p>
    <h1 style="margin:0;font:42px/1 Georgia;letter-spacing:10px;text-transform:uppercase;color:#fff;font-weight:normal;">ARCA</h1>
  </td></tr>
  <tr><td style="padding:36px 40px 18px;">
    <p style="margin:0 0 16px;font:15px/1.75 Georgia;color:#2d3461;">Bonjour ${esc(o.nom || '')},</p>
    <p style="margin:0 0 14px;font:15px/1.75 Georgia;color:#444;">Nous vous informons que votre commande <strong style="color:#2d3461;">n°${o.id}</strong>${o.total_eur ? ' (' + o.total_eur + '&nbsp;€)' : ''} a été <strong>annulée</strong>.</p>
  </td></tr>
  ${reasonBlock}
  <tr><td style="padding:0 40px 28px;">
    <p style="margin:0 0 12px;font:14.5px/1.7 Georgia;color:#444;">Si vous avez déjà été débité, le remboursement sera effectué sous quelques jours.</p>
    <p style="margin:0;font:14.5px/1.7 Georgia;color:#444;">Si cette annulation vous surprend ou s'il s'agit d'une erreur, n'hésitez pas à nous répondre directement à <a href="mailto:antoine@arca-librairie.com" style="color:#2d3461;">antoine@arca-librairie.com</a>, nous reviendrons vers vous rapidement.</p>
  </td></tr>
  <tr><td style="padding:24px 40px 32px;background:#faf8f5;border-top:1px solid #e2ddd8;">
    <p style="margin:0 0 2px;font:italic 14.5px Georgia;color:#2d3461;">Bien à vous,</p>
    <p style="margin:0;font:bold 15px Georgia;color:#2d3461;">Antoine de Lophem</p>
    <p style="margin:0;font:13px Georgia;color:#777;">ARCA Revue &amp; Librairie</p>
  </td></tr>
</table></td></tr></table></body></html>`;
}

function buildText(o, reason) {
  return `Bonjour ${o.nom || ''},

Nous vous informons que votre commande ARCA n°${o.id}${o.total_eur ? ' (' + o.total_eur + ' €)' : ''} a été annulée.
${reason ? '\nMotif : ' + reason + '\n' : ''}
Si vous avez déjà été débité, le remboursement sera effectué sous quelques jours.

Si cette annulation vous surprend ou s'il s'agit d'une erreur, contactez-nous : antoine@arca-librairie.com.

Bien à vous,
Antoine de Lophem
ARCA Revue & Librairie`;
}

function cors() {
  return {
    'Access-Control-Allow-Origin': '*',
    'Access-Control-Allow-Methods': 'POST, OPTIONS',
    'Access-Control-Allow-Headers': 'Content-Type'
  };
}
function json(status, body) {
  return { statusCode: status, headers: Object.assign({ 'Content-Type': 'application/json' }, cors()), body: JSON.stringify(body) };
}
