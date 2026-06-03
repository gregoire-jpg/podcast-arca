// Mail de rappel chaleureux pour une commande non payée.
// POST { order_id: N } -> { success: true, payment_links: { stripe, paypal } }
//
// Rappelle au client TOUT le détail de sa commande initiale (items × prix,
// remises, port, adresse, point relais MR, mode de paiement initial choisi)
// + propose 3 modes de règlement à jour (Stripe Payment Link régénéré,
// PayPal Order régénéré, virement).
//
// Pré-requis : commande non payée, non annulée, email renseigné, total > 0.

const { createStripePaymentLink, createPaypalOrder } = require('./create-payment-link');

exports.handler = async function (event) {
  if (event.httpMethod === 'OPTIONS') return { statusCode: 204, headers: cors(), body: '' };
  if (event.httpMethod !== 'POST')   return json(405, { error: 'Method not allowed' });

  const SUPABASE_URL = process.env.SUPABASE_URL;
  const SUPABASE_KEY = process.env.SUPABASE_SERVICE_KEY;
  const BREVO_KEY    = process.env.BREVO_API_KEY;
  const FROM_EMAIL   = process.env.ORDER_EMAIL_FROM;
  if (!SUPABASE_URL || !SUPABASE_KEY) return json(500, { error: 'SUPABASE_* manquants' });
  if (!BREVO_KEY)   return json(500, { error: 'BREVO_API_KEY manquant' });
  if (!FROM_EMAIL)  return json(500, { error: 'ORDER_EMAIL_FROM manquant' });

  let body;
  try { body = JSON.parse(event.body || '{}'); } catch (e) { return json(400, { error: 'Invalid JSON' }); }
  const orderId = parseInt(body.order_id, 10);
  if (!orderId) return json(400, { error: 'order_id requis' });

  // ── 1. Charge la commande ───────────────────────────────────────
  const resp = await fetch(`${SUPABASE_URL}/rest/v1/arca_orders?id=eq.${orderId}&select=*`, {
    headers: { 'apikey': SUPABASE_KEY, 'Authorization': 'Bearer ' + SUPABASE_KEY },
  });
  if (!resp.ok) return json(500, { error: 'Lecture Supabase: ' + resp.status });
  const rows = await resp.json();
  if (!rows.length) return json(404, { error: 'Commande introuvable' });
  const o = rows[0];

  // ── 2. Garde-fous métier ────────────────────────────────────────
  if (!o.email)    return json(400, { error: 'Pas d\'email client renseigné' });
  if (o.cancelled) return json(400, { error: 'Commande annulée — pas de rappel' });
  if (o.paye)      return json(400, { error: 'Commande déjà payée — pas de rappel' });

  // Calculs détaillés
  const items = (o.items || []).filter(it => it && it.qty > 0);
  const sousTotal = items.reduce((s, it) => s + (parseFloat(it.price) || 0) * (parseInt(it.qty) || 0), 0);
  const packDisc  = parseFloat(o.pack_discount_eur || 0);
  const cartDisc  = parseFloat(o.discount_eur || 0);
  const shipDisc  = parseFloat(o.shipping_discount_eur || 0);
  const port      = parseFloat(o.port_eur || 0);
  const totalEur  = parseFloat(o.total_eur || 0) ||
                    Math.max(0, sousTotal - packDisc - cartDisc + port - shipDisc);

  if (totalEur <= 0) return json(400, { error: 'Total à payer = 0 — rien à relancer' });

  // ── 3. Génère les liens de paiement à jour ──────────────────────
  const label = `Commande Revue ARCA #${orderId}`;
  let stripeUrl = null, paypalUrl = null;
  try { stripeUrl = await createStripePaymentLink(totalEur, label, orderId); }
  catch (e) { console.error('[reminder] stripe link KO:', e.message); }
  try { paypalUrl = await createPaypalOrder(totalEur, label, orderId); }
  catch (e) { console.error('[reminder] paypal order KO:', e.message); }

  // ── 4. Compose le mail (chaleureux, récap COMPLET) ─────────────
  const prenom = (o.nom || '').trim().split(/\s+/)[0] || 'Bonjour';

  const html = buildReminderHtml({
    prenom,
    nomComplet:     o.nom || '',
    email:          o.email,
    telephone:      o.telephone || '',
    adresse:        composeAddress(o),
    pays:           o.pays || '',
    livraison:      o.livraison || '',
    mr_code:        o.mr_relay_code || '',
    mr_info:        o.mr_relay_info || '',
    paiement_init:  o.paiement || '',  // mode payment choisi à l'origine
    items,
    sousTotal,
    packDisc,
    cartDisc,
    shipDisc,
    port,
    totalEur,
    orderId,
    stripeUrl, paypalUrl,
    iban:        'BE85 7320 6963 8767',
    iban_holder: 'Arca Societas',
    communication: 'ARCA' + String(orderId).padStart(4, '0'),
    discount_note: o.discount_note || '',
  });

  const text = buildReminderText({
    prenom, items, sousTotal, packDisc, cartDisc, shipDisc, port, totalEur,
    orderId, stripeUrl, paypalUrl,
    adresse: composeAddress(o), pays: o.pays || '',
    livraison: o.livraison || '', mr_info: o.mr_relay_info || '',
  });

  // ── 5. Envoi Brevo (client uniquement) ──────────────────────────
  const payload = {
    sender: { name: 'Revue ARCA', email: FROM_EMAIL },
    to: [{ email: o.email, name: o.nom || '' }],
    subject: 'Petit rappel pour votre commande Revue ARCA n°' + orderId,
    htmlContent: html,
    textContent: text,
    replyTo: { email: 'antoine@arca-librairie.com', name: 'Antoine de Lophem' },
  };

  const brevoResp = await fetch('https://api.brevo.com/v3/smtp/email', {
    method: 'POST',
    headers: { 'accept': 'application/json', 'api-key': BREVO_KEY, 'Content-Type': 'application/json' },
    body: JSON.stringify(payload),
  });
  if (!brevoResp.ok) {
    const err = await brevoResp.text();
    console.error('[reminder] Brevo KO:', brevoResp.status, err);
    return json(502, { error: 'Brevo HTTP ' + brevoResp.status, detail: err.substring(0, 200) });
  }

  // ── 6. Trace reminder_sent_at (best-effort, ignore si colonne absente)
  try {
    await fetch(`${SUPABASE_URL}/rest/v1/arca_orders?id=eq.${orderId}`, {
      method: 'PATCH',
      headers: {
        'apikey': SUPABASE_KEY,
        'Authorization': 'Bearer ' + SUPABASE_KEY,
        'Content-Type': 'application/json',
        'Prefer': 'return=minimal',
      },
      body: JSON.stringify({ reminder_sent_at: new Date().toISOString() }),
    });
  } catch (e) { /* ignore */ }

  console.log(`[reminder] envoyé à ${o.email} pour commande #${orderId} (${totalEur} €)`);
  return json(200, {
    success: true,
    email: o.email,
    payment_links: { stripe: stripeUrl, paypal: paypalUrl },
  });
};

// ─── helpers ────────────────────────────────────────────────────

function composeAddress(o) {
  // Reconstruit l'adresse depuis les champs séparés s'ils sont là,
  // sinon utilise le champ adresse agrégé.
  if (o.adresse) return o.adresse;
  const parts = [
    [o.rue, o.complement].filter(Boolean).join(', '),
    [o.cp, o.ville].filter(Boolean).join(' '),
  ].filter(Boolean);
  return parts.join('\n');
}

function fmt(n) {
  return Number(n).toFixed(2).replace('.', ',') + ' €';
}

function esc(s) {
  return String(s == null ? '' : s)
    .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}

function buildReminderHtml(d) {
  // ─── Lignes items ─────────────────────────────────────────────
  const itemsRows = d.items.map(it => {
    const title = esc(it.title || `Article n°${it.num || '?'}`);
    const qty   = parseInt(it.qty) || 0;
    const price = parseFloat(it.price) || 0;
    const sub   = qty * price;
    return `<tr>
      <td style="padding:9px 10px;border-bottom:1px solid #e2ddd8;font:14px Georgia;color:#2d3461"><strong>${title}</strong></td>
      <td style="padding:9px 10px;border-bottom:1px solid #e2ddd8;font:14px Georgia;color:#666;text-align:center">× ${qty}</td>
      <td style="padding:9px 10px;border-bottom:1px solid #e2ddd8;font:14px Georgia;color:#666;text-align:right">${fmt(price)}</td>
      <td style="padding:9px 10px;border-bottom:1px solid #e2ddd8;font:600 14px Georgia;color:#2d3461;text-align:right">${fmt(sub)}</td>
    </tr>`;
  }).join('');

  // ─── Lignes total / remises / port ───────────────────────────
  const totalRow = (lbl, val, opts = {}) => {
    const styleLbl = opts.bold
      ? 'padding:12px 10px 4px;font:bold 16px Georgia;color:#2d3461;border-top:2px solid #c8a060'
      : 'padding:6px 10px;font:13.5px Georgia;color:' + (opts.muted ? '#c8a060;font-style:italic' : '#444');
    const styleVal = opts.bold
      ? 'padding:12px 10px 4px;font:bold 16px Georgia;color:#2d3461;border-top:2px solid #c8a060;text-align:right'
      : 'padding:6px 10px;font:13.5px Georgia;color:' + (opts.muted ? '#c8a060;font-style:italic' : '#444') + ';text-align:right';
    return `<tr><td colspan="3" style="${styleLbl}">${esc(lbl)}</td><td style="${styleVal}">${esc(val)}</td></tr>`;
  };

  let totalsHtml = totalRow('Sous-total revues', fmt(d.sousTotal));
  if (d.packDisc > 0)  totalsHtml += totalRow('★ Pack complet — remise', '−' + fmt(d.packDisc),  { muted: true });
  if (d.cartDisc > 0)  totalsHtml += totalRow('Remise panier' + (d.discount_note ? ' (' + d.discount_note + ')' : ''), '−' + fmt(d.cartDisc), { muted: true });
  if (d.shipDisc > 0)  totalsHtml += totalRow('⚑ Remise port', '−' + fmt(d.shipDisc), { muted: true });
  totalsHtml += totalRow('Frais de port' + (d.livraison ? ' (' + d.livraison + ')' : ''), fmt(d.port));
  totalsHtml += totalRow('TOTAL à régler', fmt(d.totalEur), { bold: true });

  // ─── Boutons paiement ────────────────────────────────────────
  const btnGold = 'display:inline-block;padding:14px 28px;background:#c8a060;color:#fff;text-decoration:none;border-radius:4px;font:600 14px Arial;letter-spacing:.5px;margin:6px 4px';
  const btnNavy = btnGold.replace('#c8a060', '#2d3461');
  let cta = '';
  if (d.stripeUrl) cta += `<a href="${esc(d.stripeUrl)}" style="${btnGold}">Régler par carte</a>`;
  if (d.paypalUrl) cta += `<a href="${esc(d.paypalUrl)}" style="${btnNavy}">Régler par PayPal</a>`;
  if (!cta) cta = '<p style="font:italic 14px Georgia;color:#666">Liens de paiement temporairement indisponibles — par virement (voir ci-dessous) ou répondez simplement à ce mail.</p>';

  // ─── Bloc Point relais MR si applicable ─────────────────────
  const mrBlock = (d.livraison === 'Mondial Relay' && d.mr_info) ? `
  <tr><td style="padding:0 32px 16px">
    <div style="background:#fffbf4;border:1px solid #c8a060;border-radius:4px;padding:14px 18px">
      <div style="font:11px Arial;letter-spacing:2px;text-transform:uppercase;color:#c8a060;font-weight:bold;margin-bottom:6px">Point relais Mondial Relay</div>
      ${d.mr_code ? `<div style="font:bold 14px Georgia;color:#2d3461;margin-bottom:3px">Code : ${esc(d.mr_code)}</div>` : ''}
      <div style="font:13.5px/1.5 Georgia;color:#444">${esc(d.mr_info)}</div>
    </div>
  </td></tr>` : '';

  return `<!DOCTYPE html>
<html><body style="margin:0;padding:0;background:#f0ede8;font-family:Georgia,serif;color:#2d3461">
<table width="100%" cellpadding="0" cellspacing="0" style="background:#f0ede8;padding:32px 12px">
  <tr><td align="center">
    <table width="620" cellpadding="0" cellspacing="0" style="max-width:620px;background:#fff;border-radius:6px;overflow:hidden;box-shadow:0 2px 12px rgba(0,0,0,.06)">

      <tr><td style="background:#2d3461;padding:34px 32px 30px;text-align:center">
        <div style="font:11px Arial;letter-spacing:4px;text-transform:uppercase;color:#c8a060;margin-bottom:10px">Revue ARCA · Commande n°${esc(d.orderId)}</div>
        <div style="font:300 26px Georgia;letter-spacing:5px;text-transform:uppercase;color:#fff;margin-bottom:12px">Petit rappel</div>
        <div style="width:44px;height:2px;background:#c8a060;margin:0 auto"></div>
      </td></tr>

      <tr><td style="padding:32px 32px 8px;font:16px/1.65 Georgia;color:#3a3a3a">
        <p style="margin:0 0 14px">Bonjour ${esc(d.prenom)},</p>
        <p style="margin:0 0 14px">Vous avez passé une commande pour la Revue ARCA il y a quelques jours et nous n'avons pas encore reçu le règlement. Rien de grave — il arrive à tout le monde d'oublier un mail dans le flot. Voici à toutes fins utiles le détail de votre commande, et trois manières de la finaliser.</p>
      </td></tr>

      <tr><td style="padding:14px 32px 4px">
        <div style="font:11px Arial;letter-spacing:2px;text-transform:uppercase;color:#777;margin-bottom:10px">Articles commandés</div>
        <table width="100%" cellpadding="0" cellspacing="0" style="border-collapse:collapse">
          <tr>
            <th align="left" style="padding:6px 10px;font:600 11px Arial;letter-spacing:1px;text-transform:uppercase;color:#999;border-bottom:1px solid #c8a060">Article</th>
            <th align="center" style="padding:6px 10px;font:600 11px Arial;letter-spacing:1px;text-transform:uppercase;color:#999;border-bottom:1px solid #c8a060">Qté</th>
            <th align="right" style="padding:6px 10px;font:600 11px Arial;letter-spacing:1px;text-transform:uppercase;color:#999;border-bottom:1px solid #c8a060">PU</th>
            <th align="right" style="padding:6px 10px;font:600 11px Arial;letter-spacing:1px;text-transform:uppercase;color:#999;border-bottom:1px solid #c8a060">Sous-total</th>
          </tr>
          ${itemsRows}
          ${totalsHtml}
        </table>
      </td></tr>

      <tr><td style="padding:24px 32px 0">
        <div style="font:11px Arial;letter-spacing:2px;text-transform:uppercase;color:#777;margin-bottom:8px">Livraison</div>
        <div style="background:#faf8f5;border-left:3px solid #c8a060;padding:14px 18px;font:14px/1.6 Georgia;color:#2d3461">
          <strong>${esc(d.nomComplet)}</strong><br>
          <span style="color:#444;white-space:pre-line">${esc(d.adresse)}</span>${d.pays ? '<br><span style="color:#444">' + esc(d.pays) + '</span>' : ''}
          ${d.telephone ? '<div style="margin-top:6px;font-size:13px;color:#666">Tél : ' + esc(d.telephone) + '</div>' : ''}
          ${d.livraison ? '<div style="margin-top:6px;font:italic 13px Georgia;color:#777">Mode : ' + esc(d.livraison) + '</div>' : ''}
        </div>
      </td></tr>

      ${mrBlock}

      ${d.paiement_init ? `
      <tr><td style="padding:18px 32px 0">
        <div style="font:11px Arial;letter-spacing:2px;text-transform:uppercase;color:#777;margin-bottom:8px">Mode de paiement initialement choisi</div>
        <div style="font:14px Georgia;color:#444">${esc(d.paiement_init)}</div>
      </td></tr>` : ''}

      <tr><td style="padding:26px 32px 12px;text-align:center;border-top:1px solid #e2ddd8;margin-top:20px">
        <div style="font:11px Arial;letter-spacing:2px;text-transform:uppercase;color:#777;margin-bottom:12px">Régler en un clic</div>
        ${cta}
      </td></tr>

      <tr><td style="padding:16px 32px 8px">
        <div style="background:#faf8f5;padding:16px 20px;border-radius:4px">
          <div style="font:11px Arial;letter-spacing:2px;text-transform:uppercase;color:#777;margin-bottom:8px">Ou par virement bancaire</div>
          <div style="font:14px/1.7 Georgia;color:#2d3461">
            Bénéficiaire : <strong>${esc(d.iban_holder)}</strong><br>
            IBAN : <strong>${esc(d.iban)}</strong><br>
            Communication : <strong style="color:#c8a060">${esc(d.communication)}</strong><br>
            Montant : <strong>${fmt(d.totalEur)}</strong>
          </div>
        </div>
      </td></tr>

      <tr><td style="padding:26px 32px 6px;font:15px/1.65 Georgia;color:#3a3a3a">
        <p style="margin:0 0 14px">Si quelque chose a changé pour vous, ou si vous avez la moindre question sur la commande, sur la livraison, ou sur la Revue elle-même — répondez simplement à ce courriel. Nous sommes joignables et heureux d'échanger.</p>
        <p style="margin:0 0 14px">Au plaisir de vous compter parmi nos lecteurs.</p>
      </td></tr>

      <tr><td style="padding:6px 32px 32px">
        <div style="font:italic 15px Georgia;color:#2d3461">Antoine de Lophem</div>
        <div style="font:13px Georgia;color:#777">Pour la Revue ARCA · Grez-Doiceau</div>
      </td></tr>

      <tr><td style="background:#faf8f5;padding:16px 32px;text-align:center;border-top:1px solid #e2ddd8">
        <div style="font:11px Arial;letter-spacing:2px;text-transform:uppercase;color:#999">Commande n°${esc(d.orderId)} · Revue ARCA</div>
      </td></tr>

    </table>
  </td></tr>
</table>
</body></html>`;
}

function buildReminderText(d) {
  const lines = [];
  lines.push(`Bonjour ${d.prenom},`);
  lines.push('');
  lines.push("Vous avez passé une commande pour la Revue ARCA il y a quelques jours et nous n'avons pas encore reçu le règlement. Rien de grave — il arrive à tout le monde d'oublier un mail dans le flot. Voici à toutes fins utiles le détail de votre commande.");
  lines.push('');
  lines.push('ARTICLES COMMANDÉS');
  d.items.forEach(it => {
    const qty = parseInt(it.qty) || 0;
    const price = parseFloat(it.price) || 0;
    lines.push(`  ${it.title || ('Article n°' + it.num)} × ${qty} = ${fmt(qty * price)}`);
  });
  lines.push('');
  lines.push(`  Sous-total revues : ${fmt(d.sousTotal)}`);
  if (d.packDisc > 0)  lines.push(`  Pack complet — remise : −${fmt(d.packDisc)}`);
  if (d.cartDisc > 0)  lines.push(`  Remise panier : −${fmt(d.cartDisc)}`);
  if (d.shipDisc > 0)  lines.push(`  Remise port : −${fmt(d.shipDisc)}`);
  lines.push(`  Frais de port${d.livraison ? ' (' + d.livraison + ')' : ''} : ${fmt(d.port)}`);
  lines.push(`  TOTAL à régler : ${fmt(d.totalEur)}`);
  lines.push('');
  lines.push('LIVRAISON');
  lines.push(`  ${d.adresse.replace(/\n/g, ', ')}${d.pays ? ' · ' + d.pays : ''}`);
  if (d.mr_info) lines.push(`  Point relais : ${d.mr_info}`);
  lines.push('');
  lines.push('RÉGLER EN UN CLIC');
  if (d.stripeUrl) lines.push(`  Carte : ${d.stripeUrl}`);
  if (d.paypalUrl) lines.push(`  PayPal : ${d.paypalUrl}`);
  lines.push('');
  lines.push('OU PAR VIREMENT');
  lines.push(`  IBAN : BE85 7320 6963 8767 (Arca Societas)`);
  lines.push(`  Communication : ARCA${String(d.orderId).padStart(4, '0')}`);
  lines.push(`  Montant : ${fmt(d.totalEur)}`);
  lines.push('');
  lines.push("Si quelque chose a changé pour vous, ou si vous avez la moindre question — répondez simplement à ce courriel.");
  lines.push('');
  lines.push('Au plaisir de vous compter parmi nos lecteurs.');
  lines.push('');
  lines.push('Antoine de Lophem');
  lines.push('Pour la Revue ARCA · Grez-Doiceau');
  lines.push('');
  lines.push(`Commande n°${d.orderId}`);
  return lines.join('\n');
}

function cors() {
  return {
    'Access-Control-Allow-Origin': '*',
    'Access-Control-Allow-Methods': 'POST, OPTIONS',
    'Access-Control-Allow-Headers': 'Content-Type',
  };
}
function json(status, body) {
  return { statusCode: status, headers: Object.assign({ 'Content-Type': 'application/json' }, cors()), body: JSON.stringify(body) };
}
