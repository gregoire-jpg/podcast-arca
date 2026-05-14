// Netlify Function — submission-created.js
// Déclenchée automatiquement à chaque soumission du formulaire commande-arca.
// Envoie un email HTML stylisé aux couleurs ARCA via Brevo (ex-Sendinblue).
//
// Variables d'environnement requises (Netlify → Site configuration → Environment variables):
//   - BREVO_API_KEY     : clé API Brevo (xkeysib-...)
//   - ORDER_EMAIL_TO    : destinataire(s) — ex: info@arca-librairie.com
//                          (séparer par virgule pour plusieurs)
//   - ORDER_EMAIL_FROM  : expéditeur — ex: commandes@arca-librairie.com
//                          (doit être une adresse d'un domaine vérifié sur Brevo)
//   - MR_PRIVATE_KEY    : clé privée Mondial Relay (pour génération auto étiquette)

const { createLabel } = require('./mr-label');

exports.handler = async function(event) {
  // Note: les invocations event-triggered (Netlify Forms) n'ont pas de httpMethod.
  try {
    const body = JSON.parse(event.body);
    const apiKey = process.env.BREVO_API_KEY;
    const toRaw = (process.env.ORDER_EMAIL_TO || "").split(",").map(s => s.trim()).filter(Boolean);
    const fromEmail = process.env.ORDER_EMAIL_FROM || "";

    // Netlify Forms peut envelopper la soumission dans payload
    const submission = body.payload || body;
    const formName = submission.form_name || submission.formName || body.form_name;
    console.log("submission-created invoked, form_name =", formName);

    if (formName !== "commande-arca") {
      return { statusCode: 200, body: "Ignored (form_name=" + formName + ")" };
    }

    const d = submission.data || body.data || {};
    console.log("Processing commande for:", d.nom, "/", d.email, "/ paiement:", d.paiement);

    // Génération étiquette Mondial Relay si applicable
    let mrLabel = null;
    if ((d.livraison || "") === "Mondial Relay" && d["mr-relay-code"]) {
      console.log("Génération étiquette Mondial Relay pour code relais", d["mr-relay-code"]);
      mrLabel = await createLabel(d);
      if (mrLabel.error) {
        console.error("Erreur Mondial Relay:", mrLabel.error);
      } else {
        console.log("Étiquette MR créée:", mrLabel.expedition);
      }
    }

    const html = buildEmailHtml(d, mrLabel);
    const text = buildEmailText(d, mrLabel);
    const totalLine = d["commande-details"] || "";
    const totalMatch = totalLine.match(/TOTAL:\s*(\d+)/);
    const totalEUR = totalMatch ? totalMatch[1] + " €" : "—";
    const isPaid = (d["paypal-status"] || "").startsWith("PAID");
    const subjectPrefix = isPaid ? "✓ PAYÉ" : "⏳ À traiter";
    const subject = `${subjectPrefix} · Commande ARCA · ${totalEUR} · ${d.nom || "Sans nom"}`;

    if (!apiKey || !toRaw.length || !fromEmail) {
      console.error("Configuration manquante: BREVO_API_KEY, ORDER_EMAIL_TO ou ORDER_EMAIL_FROM");
      return { statusCode: 500, body: "Missing env vars" };
    }

    const payload = {
      sender: { name: "ARCA Commandes", email: fromEmail },
      to: toRaw.map(e => ({ email: e })),
      subject: subject,
      htmlContent: html,
      textContent: text
    };
    if (d.email) {
      payload.replyTo = { email: d.email, name: d.nom || "" };
    }

    const resp = await fetch("https://api.brevo.com/v3/smtp/email", {
      method: "POST",
      headers: {
        "accept": "application/json",
        "api-key": apiKey,
        "Content-Type": "application/json"
      },
      body: JSON.stringify(payload)
    });

    if (!resp.ok) {
      const err = await resp.text();
      console.error("Brevo error:", resp.status, err);
      return { statusCode: 500, body: "Brevo error: " + err };
    }

    return { statusCode: 200, body: "Email sent" };
  } catch (err) {
    console.error("Function error:", err);
    return { statusCode: 500, body: "Error: " + err.message };
  }
};

// ─────────────────────────────────────────────────────────────
// Génération du HTML stylisé ARCA
// ─────────────────────────────────────────────────────────────

function esc(s) {
  return String(s == null ? "" : s)
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

function buildEmailHtml(d, mrLabel) {
  // Catalogue (titres + prix + badge) — doit rester aligné avec ISSUES dans commande.html
  const CATALOG = {
    1: { title: 'N°1', price: 20, badge: null },
    2: { title: 'N°2', price: 20, badge: null },
    3: { title: 'N°3', price: 20, badge: null },
    4: { title: 'N°4', price: 20, badge: null },
    5: { title: 'N°5', price: 20, badge: null },
    6: { title: 'N°6', price: 20, badge: null },
    7: { title: 'N°7', price: 20, badge: null },
    8: { title: 'N°8', price: 15, badge: 'souscription' },
    9: { title: 'Recueil de prières', price: 20, badge: 'hors collection' }
  };
  // Numéros commandés
  const qtyRows = [];
  let totalQty = 0;
  for (let i = 1; i <= 9; i++) {
    const q = parseInt(d["qty-n" + i] || "0", 10);
    if (q > 0) {
      const cat = CATALOG[i];
      totalQty += q;
      const price = cat.price;
      const sub = price * q;
      const badgeHtml = cat.badge ? ` <span style="color:#c8a060;font-size:10px;letter-spacing:1px;text-transform:uppercase;">${cat.badge}</span>` : "";
      qtyRows.push(
        `<tr><td style="padding:8px 10px;border-bottom:1px solid #e2ddd8;font:14px Georgia,serif;color:#2d3461;"><strong>${cat.title}</strong>${badgeHtml}</td>` +
        `<td style="padding:8px 10px;border-bottom:1px solid #e2ddd8;font:14px Georgia,serif;color:#444;text-align:center;">× ${q}</td>` +
        `<td style="padding:8px 10px;border-bottom:1px solid #e2ddd8;font:14px Georgia,serif;color:#444;text-align:right;">${price} €</td>` +
        `<td style="padding:8px 10px;border-bottom:1px solid #e2ddd8;font:bold 14px Georgia,serif;color:#2d3461;text-align:right;">${sub} €</td></tr>`
      );
    }
  }

  // Détails (sous-total / port / total)
  const details = d["commande-details"] || "";
  let sousTotal = "—", port = "—", total = "—";
  const subMatch = details.match(/Sous-total revues:\s*(\d+)\s*€/);
  const portMatch = details.match(/Port:\s*(\d+)\s*€/);
  const totMatch = details.match(/TOTAL:\s*(\d+)\s*€/);
  if (subMatch) sousTotal = subMatch[1] + " €";
  if (portMatch) port = portMatch[1] + " €";
  if (totMatch) total = totMatch[1] + " €";

  // Statut paiement
  const paypalStatus = d["paypal-status"] || "";
  const paypalId = d["paypal-order-id"] || "";
  const isPaid = paypalStatus.startsWith("PAID");
  const statusBadge = isPaid
    ? `<div style="display:inline-block;padding:6px 14px;background:#3a8a4a;color:#fff;font:bold 11px Arial;letter-spacing:1.5px;text-transform:uppercase;border-radius:4px;">✓ Payé via PayPal</div>`
    : `<div style="display:inline-block;padding:6px 14px;background:#c8a060;color:#fff;font:bold 11px Arial;letter-spacing:1.5px;text-transform:uppercase;border-radius:4px;">⏳ Paiement à recevoir</div>`;

  // Lien étiquette
  const etiquetteLink = d["lien-etiquette"] || "";

  // Point relais Mondial Relay
  const mrRelayInfo = d["mr-relay-info"] || "";
  const mrRelayCode = d["mr-relay-code"] || "";
  const isMondialRelay = (d.livraison || "") === "Mondial Relay";
  const mrBlock = isMondialRelay && mrRelayInfo ? `
  <tr><td style="padding:0 36px 20px;">
    <table width="100%" cellpadding="0" cellspacing="0" style="background:#fffbf4;border:1px solid #c8a060;border-radius:4px;">
      <tr><td style="padding:16px 20px;">
        <p style="margin:0 0 6px;font-family:Arial,sans-serif;font-size:10px;letter-spacing:2px;text-transform:uppercase;color:#c8a060;font-weight:bold;">📦 Point relais Mondial Relay</p>
        <p style="margin:0 0 4px;font:bold 14px Georgia;color:#2d3461;">Code : ${esc(mrRelayCode)}</p>
        <p style="margin:0;font:13.5px/1.5 Georgia;color:#444;">${esc(mrRelayInfo)}</p>
      </td></tr>
    </table>
  </td></tr>` : "";

  // Bouton "Créer l'étiquette sur MR Connect" — toujours visible si livraison MR,
  // que la génération API ait marché ou non. Sert de filet de sécurité pour
  // créer l'étiquette manuellement en 30 sec sans réencoder les infos.
  const mrConnectButton = isMondialRelay ? `
  <tr><td style="padding:0 36px 18px;">
    <table cellpadding="0" cellspacing="0">
      <tr><td style="background:#c8a060;border-radius:4px;">
        <a href="https://connect.mondialrelay.com/" target="_blank" style="display:inline-block;padding:12px 22px;font:bold 11px Arial;letter-spacing:1.5px;text-transform:uppercase;color:#fff;text-decoration:none;">
          📦 Créer l'étiquette sur MR Connect →
        </a>
      </td></tr>
    </table>
  </td></tr>` : "";

  // Bloc étiquette Mondial Relay générée automatiquement
  let mrLabelBlock = "";
  if (isMondialRelay && mrLabel) {
    if (mrLabel.success) {
      const labelUrl = mrLabel.url_a4 || mrLabel.url_pdf || mrLabel.url_a5 || "";
      mrLabelBlock = `
  <tr><td style="padding:0 36px 20px;">
    <table width="100%" cellpadding="0" cellspacing="0" style="background:#eef7ee;border:1px solid #3a8a4a;border-radius:4px;">
      <tr><td style="padding:16px 20px;">
        <p style="margin:0 0 6px;font-family:Arial,sans-serif;font-size:10px;letter-spacing:2px;text-transform:uppercase;color:#3a8a4a;font-weight:bold;">✓ Étiquette Mondial Relay générée</p>
        <p style="margin:0 0 10px;font:13.5px Georgia;color:#444;">N° expédition : <strong style="color:#2d3461;">${esc(mrLabel.expedition || "—")}</strong></p>
        ${labelUrl ? `<table cellpadding="0" cellspacing="0"><tr><td style="background:#3a8a4a;border-radius:4px;">
          <a href="${esc(labelUrl)}" style="display:inline-block;padding:11px 22px;font:bold 11px Arial;letter-spacing:1.5px;text-transform:uppercase;color:#fff;text-decoration:none;">🖨 Télécharger l'étiquette PDF</a>
        </td></tr></table>` : ""}
      </td></tr>
    </table>
  </td></tr>`;
    } else {
      mrLabelBlock = `
  <tr><td style="padding:0 36px 20px;">
    <table width="100%" cellpadding="0" cellspacing="0" style="background:#fef0f0;border:1px solid #c44;border-radius:4px;">
      <tr><td style="padding:16px 20px;">
        <p style="margin:0 0 6px;font-family:Arial,sans-serif;font-size:10px;letter-spacing:2px;text-transform:uppercase;color:#c44;font-weight:bold;">⚠ Étiquette MR non générée</p>
        <p style="margin:0 0 10px;font:13px Georgia;color:#444;">${esc(mrLabel.error || "Erreur inconnue")} — créer l'étiquette manuellement sur connect.mondialrelay.com</p>
        ${mrLabel.sigDebug ? `<p style="margin:14px 0 4px;font:11px Arial;color:#888;text-transform:uppercase;letter-spacing:1px;">Signature debug (STAT=97)</p><div style="margin:0;padding:10px;background:#fff;border:1px solid #eee;border-radius:3px;font:11px/1.4 'Courier New',monospace;color:#555;word-break:break-all;"><strong>Enseigne:</strong> ${esc(mrLabel.sigDebug.enseigne)}<br><strong>Cle longueur:</strong> ${mrLabel.sigDebug.keyLen}<br><strong>Concat longueur:</strong> ${mrLabel.sigDebug.concatLen}<br><strong>Signature:</strong> ${esc(mrLabel.sigDebug.signature)}<br><strong>Preview concat (200 premiers car):</strong><br>${esc(mrLabel.sigDebug.concatPreview)}</div>` : ""}
        ${mrLabel.xml ? `<p style="margin:14px 0 4px;font:11px Arial;color:#888;text-transform:uppercase;letter-spacing:1px;">Réponse XML brute (debug)</p><div style="margin:0;padding:10px;background:#fff;border:1px solid #eee;border-radius:3px;font:11px/1.4 'Courier New',monospace;color:#555;word-break:break-all;">${esc(mrLabel.xml)}</div>` : ""}
      </td></tr>
    </table>
  </td></tr>`;
    }
  }

  return `<!DOCTYPE html>
<html lang="fr"><head><meta charset="UTF-8"><meta name="viewport" content="width=device-width, initial-scale=1.0"></head>
<body style="margin:0;padding:0;background:#f0ede8;font-family:Georgia,serif;">
<table width="100%" cellpadding="0" cellspacing="0" border="0" style="background:#f0ede8;">
<tr><td align="center" style="padding:30px 16px;">
<table width="640" cellpadding="0" cellspacing="0" border="0" style="max-width:640px;width:100%;background:#fff;border-radius:4px;overflow:hidden;box-shadow:0 2px 16px rgba(0,0,0,.10);">

  <!-- HEADER -->
  <tr><td style="background:#2d3461;padding:32px 36px;text-align:center;">
    <p style="margin:0 0 6px;font-family:Arial,sans-serif;font-size:10px;letter-spacing:4px;text-transform:uppercase;color:#c8a060;">Nouvelle commande</p>
    <h1 style="margin:0 0 12px;font:32px/1 Georgia;letter-spacing:8px;text-transform:uppercase;color:#fff;font-weight:normal;">ARCA</h1>
    <div style="width:36px;height:2px;background:#c8a060;margin:0 auto 14px;"></div>
    ${statusBadge}
  </td></tr>

  <!-- TOTAL -->
  <tr><td style="background:#faf8f5;padding:24px 36px;text-align:center;border-bottom:1px solid #e2ddd8;">
    <p style="margin:0 0 4px;font-family:Arial,sans-serif;font-size:11px;letter-spacing:2px;text-transform:uppercase;color:#777;">Montant total</p>
    <p style="margin:0;font:bold 34px/1 Georgia;color:#2d3461;">${esc(total)}</p>
    <p style="margin:8px 0 0;font:13px Georgia;color:#777;">${totalQty} exemplaire${totalQty > 1 ? "s" : ""} · ${esc(d.livraison || "—")}</p>
  </td></tr>

  <!-- CLIENT -->
  <tr><td style="padding:28px 36px 20px;">
    <p style="margin:0 0 12px;font-family:Arial,sans-serif;font-size:11px;letter-spacing:2px;text-transform:uppercase;color:#c8a060;font-weight:bold;">— Client —</p>
    <p style="margin:0 0 4px;font:bold 18px Georgia;color:#2d3461;">${esc(d.nom || "—")}</p>
    <p style="margin:0 0 4px;font:14px Georgia;color:#444;"><a href="mailto:${esc(d.email || "")}" style="color:#c8a060;text-decoration:none;">${esc(d.email || "—")}</a>${d.telephone ? ' · ' + esc(d.telephone) : ""}</p>
    <p style="margin:10px 0 0;font:14px/1.5 Georgia;color:#444;white-space:pre-line;">${esc(d.adresse || "—")}</p>
    <p style="margin:4px 0 0;font:13px Georgia;color:#777;">${esc(d.pays || "—")}</p>
  </td></tr>

  <!-- POINT RELAIS MONDIAL RELAY -->
  ${mrBlock}

  <!-- BOUTON MR CONNECT (toujours présent si livraison MR) -->
  ${mrConnectButton}

  <!-- ÉTIQUETTE MONDIAL RELAY (générée auto) -->
  ${mrLabelBlock}

  <!-- ÉTIQUETTE -->
  ${etiquetteLink && !isMondialRelay ? `<tr><td style="padding:0 36px 20px;">
    <table cellpadding="0" cellspacing="0">
      <tr><td style="background:#c8a060;border-radius:4px;">
        <a href="${esc(etiquetteLink)}" style="display:inline-block;padding:11px 22px;font:bold 11px Arial;letter-spacing:1.5px;text-transform:uppercase;color:#fff;text-decoration:none;">🖨 Imprimer l'étiquette (A6 paysage)</a>
      </td></tr>
    </table>
  </td></tr>` : ""}

  <!-- COMMANDE -->
  <tr><td style="padding:8px 36px 20px;">
    <p style="margin:0 0 12px;font-family:Arial,sans-serif;font-size:11px;letter-spacing:2px;text-transform:uppercase;color:#c8a060;font-weight:bold;">— Détail de la commande —</p>
    <table width="100%" cellpadding="0" cellspacing="0" style="border-collapse:collapse;border:1px solid #e2ddd8;border-radius:4px;overflow:hidden;">
      <thead><tr style="background:#2d3461;">
        <th style="padding:9px 10px;font:bold 10px Arial;letter-spacing:1px;text-transform:uppercase;color:#c8a060;text-align:left;">Numéro</th>
        <th style="padding:9px 10px;font:bold 10px Arial;letter-spacing:1px;text-transform:uppercase;color:#c8a060;text-align:center;">Qté</th>
        <th style="padding:9px 10px;font:bold 10px Arial;letter-spacing:1px;text-transform:uppercase;color:#c8a060;text-align:right;">P.U.</th>
        <th style="padding:9px 10px;font:bold 10px Arial;letter-spacing:1px;text-transform:uppercase;color:#c8a060;text-align:right;">Sous-total</th>
      </tr></thead>
      <tbody>${qtyRows.join("")}</tbody>
    </table>
    <table width="100%" cellpadding="0" cellspacing="0" style="margin-top:14px;">
      <tr><td style="padding:4px 0;font:13.5px Georgia;color:#444;">Sous-total revues</td>
          <td style="padding:4px 0;font:13.5px Georgia;color:#444;text-align:right;">${esc(sousTotal)}</td></tr>
      <tr><td style="padding:4px 0;font:13.5px Georgia;color:#444;">Frais de port (${esc(d.livraison || "")})</td>
          <td style="padding:4px 0;font:13.5px Georgia;color:#444;text-align:right;">${esc(port)}</td></tr>
      <tr><td style="padding:10px 0 4px;border-top:2px solid #c8a060;font:bold 16px Georgia;color:#2d3461;">TOTAL</td>
          <td style="padding:10px 0 4px;border-top:2px solid #c8a060;font:bold 18px Georgia;color:#2d3461;text-align:right;">${esc(total)}</td></tr>
    </table>
  </td></tr>

  <!-- PAIEMENT -->
  <tr><td style="padding:8px 36px 28px;">
    <p style="margin:0 0 10px;font-family:Arial,sans-serif;font-size:11px;letter-spacing:2px;text-transform:uppercase;color:#c8a060;font-weight:bold;">— Paiement —</p>
    <p style="margin:0;font:14px Georgia;color:#444;"><strong style="color:#2d3461;">Mode :</strong> ${esc(d.paiement || "—")}</p>
    ${isPaid ? `
    <p style="margin:6px 0 0;font:13px Georgia;color:#3a8a4a;"><strong>${esc(paypalStatus)}</strong></p>
    <p style="margin:4px 0 0;font:12px 'Courier New',monospace;color:#777;">ID transaction : ${esc(paypalId)}</p>
    ` : `
    <p style="margin:6px 0 0;font:13px Georgia;color:#c8a060;font-style:italic;">À envoyer : RIB pour virement bancaire.</p>
    `}
  </td></tr>

  <!-- FOOTER -->
  <tr><td style="background:#1e2245;padding:16px 36px;text-align:center;">
    <p style="margin:0;font:11px Arial;letter-spacing:2px;text-transform:uppercase;color:rgba(255,255,255,.4);">ARCA · Notification de commande</p>
  </td></tr>

</table>
</td></tr>
</table>
</body></html>`;
}

function buildEmailText(d, mrLabel) {
  let txt = "NOUVELLE COMMANDE ARCA\n";
  txt += "═══════════════════════════════════════\n\n";
  txt += "CLIENT\n";
  txt += `  ${d.nom || "—"}\n  ${d.email || "—"}${d.telephone ? " · " + d.telephone : ""}\n  ${d.adresse || "—"}\n  ${d.pays || "—"}\n\n`;
  txt += "COMMANDE\n";
  const CAT_TXT = {
    1: ['N°1', 20, null], 2: ['N°2', 20, null], 3: ['N°3', 20, null],
    4: ['N°4', 20, null], 5: ['N°5', 20, null], 6: ['N°6', 20, null],
    7: ['N°7', 20, null], 8: ['N°8', 15, 'souscription'],
    9: ['Recueil de prières', 20, 'hors collection']
  };
  for (let i = 1; i <= 9; i++) {
    const q = parseInt(d["qty-n" + i] || "0", 10);
    if (q > 0) {
      const [title, price, badge] = CAT_TXT[i];
      txt += `  ${title}${badge ? ' (' + badge + ')' : ''}  × ${q} = ${price * q} €\n`;
    }
  }
  txt += `\n  ${d["commande-details"] || ""}\n\n`;
  txt += `LIVRAISON : ${d.livraison || "—"}\n`;
  if ((d.livraison || "") === "Mondial Relay" && d["mr-relay-info"]) {
    txt += `  POINT RELAIS : ${d["mr-relay-info"]}\n`;
  }
  txt += `PAIEMENT  : ${d.paiement || "—"}\n`;
  if ((d["paypal-status"] || "").startsWith("PAID")) {
    txt += `STATUT    : ${d["paypal-status"]}\n`;
    txt += `ID PAYPAL : ${d["paypal-order-id"] || "—"}\n`;
  }
  if (d["lien-etiquette"]) {
    txt += `\nÉTIQUETTE : ${d["lien-etiquette"]}\n`;
  }
  if (mrLabel && mrLabel.success) {
    txt += `\nÉTIQUETTE MR : ${mrLabel.url_a4 || mrLabel.url_pdf || ""}\n`;
    txt += `  Expédition : ${mrLabel.expedition || "—"}\n`;
  } else if (mrLabel && mrLabel.error) {
    txt += `\n⚠ MR : ${mrLabel.error}\n`;
  }
  return txt;
}
