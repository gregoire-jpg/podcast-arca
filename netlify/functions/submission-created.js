// Netlify Function — submission-created.js
// Déclenchée automatiquement à chaque soumission du formulaire commande-arca.
// Envoie un email HTML stylisé aux couleurs ARCA via Brevo (ex-Sendinblue).
//
// Variables d'environnement requises (Netlify → Site configuration → Environment variables):
//   - BREVO_API_KEY     : clé API Brevo (xkeysib-...)
//   - ORDER_EMAIL_TO    : destinataire(s) — ex: antoine@arca-librairie.com
//                          (séparer par virgule pour plusieurs)
//   - ORDER_EMAIL_FROM  : expéditeur — ex: commandes@arca-librairie.com
//                          (doit être une adresse d'un domaine vérifié sur Brevo)
//   - MR_PRIVATE_KEY    : clé privée Mondial Relay (pour génération auto étiquette)

// NB : l'étiquette Mondial Relay n'est plus générée ici (à la commande) — elle
// est créée au moment de l'expédition depuis l'admin (regenerate-mr-label.js),
// pour ne pas facturer un colis avant paiement / avant expédition réelle.
const { createStripePaymentLink, createPaypalOrder } = require('./create-payment-link');

// Fin de la souscription préférentielle N°8 : 25 mai 2026 minuit heure belge = 25 mai 22:00 UTC
const PROMO_DEADLINE = new Date('2026-05-25T22:00:00Z');
function getN8Price() { return new Date() < PROMO_DEADLINE ? 15 : 20; }

// Extrait le code MR à 8 chiffres depuis le barcode complet 26 chiffres (format
// '41' + code 8 + 16 internes). C'est ce code court qui sert pour le suivi
// (numeroExpedition=…). Le retour MR Connect v2 stocke le barcode complet,
// mais MR attend le code court pour le tracking. Sinon le lien ne marche pas.
function shortMrExp(barcode) {
  if (!barcode) return barcode;
  const s = String(barcode).replace(/\D/g, '');
  if (s.length >= 10 && s.indexOf('41') === 0) return s.substring(2, 10);
  if (s.length === 8) return s;
  return barcode;
}

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

    // ─── Idempotence : si Stripe webhook ET redirect navigateur firent tous deux,
    //     on ne re-envoie pas les mails. On reconnaît un duplicate via stripe_session_id.
    //     Skip si _no_persist (renvoi manuel depuis l'admin -> on VEUT envoyer le mail).
    const skipDedup = body._no_persist || d._no_persist;
    const sessId = d["paypal-order-id"] || "";
    const isStripeId = sessId.startsWith("cs_");
    if (!skipDedup && isStripeId && process.env.SUPABASE_URL && process.env.SUPABASE_SERVICE_KEY) {
      try {
        const checkUrl = `${process.env.SUPABASE_URL}/rest/v1/arca_orders?stripe_session_id=eq.${encodeURIComponent(sessId)}&select=id`;
        const ck = await fetch(checkUrl, {
          headers: { 'apikey': process.env.SUPABASE_SERVICE_KEY, 'Authorization': 'Bearer ' + process.env.SUPABASE_SERVICE_KEY }
        });
        if (ck.ok) {
          const rows = await ck.json();
          if (rows.length > 0) {
            console.log("[Dedup] Commande Stripe déjà traitée (id=" + rows[0].id + "), skip envoi mail.");
            return { statusCode: 200, body: "Already processed" };
          }
        }
      } catch (e) {
        console.error("[Dedup] check Supabase échec:", e.message);
        // On continue : mieux vaut un mail en double qu'un mail manqué
      }
    }

    // ─── Vérification PayPal côté serveur ───
    // Le frontend envoie l'order_id + un statut "PAID" — un attaquant pourrait forger ces champs.
    // On appelle l'API PayPal pour confirmer que l'order est bien APPROVED ou COMPLETED.
    // Si invalide → on force le statut "non payé" et on flag pour alerter dans le mail interne.
    let paypalVerifyWarning = null;
    const ppOrderId = d["paypal-order-id"] || "";
    const isPaypalOrder = ppOrderId && !ppOrderId.startsWith("cs_") && /paypal/i.test(d.paiement || "" + d["paypal-status"] || "");
    const declaredPaid = (d["paypal-status"] || "").startsWith("PAID");
    if (isPaypalOrder && declaredPaid) {
      const verify = await verifyPayPalOrder(ppOrderId);
      if (!verify.ok) {
        console.error("[PayPal verify] ÉCHEC pour", ppOrderId, ":", verify.reason);
        paypalVerifyWarning = "Vérification PayPal ÉCHOUÉE : " + verify.reason;
        // Override le statut → la commande sera marquée non payée
        d["paypal-status"] = "";
      } else {
        console.log("[PayPal verify] OK pour", ppOrderId, "· status=" + verify.status + " · amount=" + verify.amount + " " + verify.currency);
      }
    }

    // Étiquette Mondial Relay : VOLONTAIREMENT non générée à la commande.
    // Chaque POST /api/Shipment est facturé par MR ; générer avant l'expédition
    // coûtait pour rien (virements jamais payés, doublons à l'impression).
    // → L'étiquette est créée UNE seule fois, au moment de l'expédition, via le
    //   bouton "Générer étiquette MR" de l'admin (regenerate-mr-label.js).
    // mrLabel reste null : les mails affichent le point relais mais pas encore
    // de n° d'expédition (le tracking client suivra à la génération si besoin).
    let mrLabel = null;

    const html = buildEmailHtml(d, mrLabel, paypalVerifyWarning);
    const text = buildEmailText(d, mrLabel);
    const totalLine = d["commande-details"] || "";
    const totalMatch = totalLine.match(/TOTAL:\s*(\d+(?:[.,]\d+)?)/);
    const totalEUR = totalMatch ? totalMatch[1].replace(',', '.') + " €" : "—";
    const isPaid = (d["paypal-status"] || "").startsWith("PAID");
    const subjectPrefix = isPaid ? "✓ PAYÉ" : "⏳ À traiter";
    const subject = `${subjectPrefix} · Commande ARCA · ${totalEUR} · ${d.nom || "Sans nom"}`;

    if (!apiKey || !toRaw.length || !fromEmail) {
      console.error("Configuration manquante: BREVO_API_KEY, ORDER_EMAIL_TO ou ORDER_EMAIL_FROM");
      return { statusCode: 500, body: "Missing env vars" };
    }

    // Validation email client : Brevo rejette les emails mal formés (ex: client tape "orange.f" au lieu de "orange.fr")
    // Si l'email client est invalide, on ne le met PAS en replyTo (sinon la requête entière échoue)
    // et on ne tente PAS d'envoyer au client (Brevo refusera de toute façon).
    const EMAIL_REGEX = /^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/;
    const clientEmailValid = d.email && EMAIL_REGEX.test(d.email);
    if (d.email && !clientEmailValid) {
      console.warn("[Email invalide] '" + d.email + "' — replyTo et envoi client skippés. Corrige en BDD pour relancer manuellement.");
    }

    const payload = {
      sender: { name: "ARCA Commandes", email: fromEmail },
      to: toRaw.map(e => ({ email: e })),
      subject: subject,
      htmlContent: html,
      textContent: text
    };
    if (clientEmailValid) {
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
      console.error("Brevo error (interne ARCA):", resp.status, err);
      // On continue quand même pour tenter l'envoi au client
    }

    // ─── Génération des liens de paiement en ligne (Stripe + PayPal) si commande non payée ───
    // Permet au client de payer en 1 clic depuis le mail. Webhook Stripe marque comme payée auto.
    let payLinks = { stripeUrl: null, paypalUrl: null };
    const orderIdForPay = body._order_id || d._order_id;
    if (!isPaid && orderIdForPay) {
      const totMatch = (d["commande-details"] || "").match(/TOTAL:\s*(\d+(?:[.,]\d+)?)/);
      const amountEur = totMatch ? parseFloat(totMatch[1].replace(',', '.')) : 0;
      if (amountEur > 0) {
        const label = "Commande ARCA #" + orderIdForPay + " — " + (d.nom || "").trim();
        try {
          payLinks.stripeUrl = await createStripePaymentLink(amountEur, label, orderIdForPay);
          console.log("[Stripe link] OK", payLinks.stripeUrl);
        } catch (e) { console.error("[Stripe link] échec:", e.message); }
        try {
          payLinks.paypalUrl = await createPaypalOrder(amountEur, label, orderIdForPay);
          console.log("[PayPal order] OK", payLinks.paypalUrl);
        } catch (e) { console.error("[PayPal order] échec:", e.message); }
      }
    }

    // ─── Email de confirmation au client (sans l'étiquette MR) ───
    if (clientEmailValid) {
      try {
        const clientHtml = buildClientEmailHtml(d, mrLabel, payLinks);
        const clientText = buildClientEmailText(d, mrLabel, payLinks);
        const clientSubject = isPaid
          ? `Votre commande ARCA · Paiement reçu`
          : `Votre commande ARCA · Bien reçue`;
        const clientPayload = {
          sender: { name: "ARCA Revue & Librairie", email: fromEmail },
          to: [{ email: d.email, name: d.nom || "" }],
          replyTo: { email: "antoine@arca-librairie.com", name: "ARCA" },
          subject: clientSubject,
          htmlContent: clientHtml,
          textContent: clientText
        };
        const clientResp = await fetch("https://api.brevo.com/v3/smtp/email", {
          method: "POST",
          headers: { "accept": "application/json", "api-key": apiKey, "Content-Type": "application/json" },
          body: JSON.stringify(clientPayload)
        });
        if (!clientResp.ok) {
          const err2 = await clientResp.text();
          console.error("Brevo error (client):", clientResp.status, err2);
        }
      } catch (e) {
        console.error("Erreur envoi mail client:", e.message);
      }
    }

    // ─── Persistance Supabase (table arca.orders) ───
    // Skippable via `_no_persist: true` (utile pour les commandes manuelles déjà insérées par l'admin)
    // Échec ici ne bloque pas la réponse (emails déjà partis)
    if (!body._no_persist && !d._no_persist) {
      try {
        await persistOrder(d, mrLabel);
      } catch (e) {
        console.error("Supabase persist error:", e.message);
      }
    } else {
      console.log("[Skip persist] _no_persist flag set");
    }

    return { statusCode: 200, body: "Email sent" };
  } catch (err) {
    console.error("Function error:", err);
    return { statusCode: 500, body: "Error: " + err.message };
  }
};

// ─────────────────────────────────────────────────────────────
// Vérification d'un order PayPal côté serveur (anti-forgery)
// Retourne { ok, status, amount, currency, payerEmail, reason }
// ─────────────────────────────────────────────────────────────
async function verifyPayPalOrder(orderId) {
  const CID = process.env.PAYPAL_CLIENT_ID;
  const SEC = process.env.PAYPAL_CLIENT_SECRET;
  if (!CID || !SEC) {
    return { ok: false, reason: "PAYPAL_CLIENT_ID/SECRET non configurés" };
  }
  try {
    // 1. Get OAuth2 access token
    const auth = Buffer.from(CID + ":" + SEC).toString("base64");
    const tokenResp = await fetch("https://api-m.paypal.com/v1/oauth2/token", {
      method: "POST",
      headers: {
        "Authorization": "Basic " + auth,
        "Content-Type": "application/x-www-form-urlencoded"
      },
      body: "grant_type=client_credentials"
    });
    if (!tokenResp.ok) {
      const t = await tokenResp.text();
      return { ok: false, reason: "Token PayPal KO (" + tokenResp.status + "): " + t.substring(0, 200) };
    }
    const tokenData = await tokenResp.json();
    const accessToken = tokenData.access_token;
    if (!accessToken) return { ok: false, reason: "Pas d'access_token retourné" };

    // 2. Get order details
    const orderResp = await fetch("https://api-m.paypal.com/v2/checkout/orders/" + encodeURIComponent(orderId), {
      headers: { "Authorization": "Bearer " + accessToken }
    });
    if (!orderResp.ok) {
      const t = await orderResp.text();
      if (orderResp.status === 404) {
        return { ok: false, reason: "Order introuvable côté PayPal (sandbox-vs-live ? autre compte ?)" };
      }
      return { ok: false, reason: "PayPal GET order " + orderResp.status + ": " + t.substring(0, 200) };
    }
    const order = await orderResp.json();
    const status = order.status || "?";
    const purchase = (order.purchase_units || [])[0] || {};
    const amount = purchase.amount && purchase.amount.value || "?";
    const currency = purchase.amount && purchase.amount.currency_code || "?";
    const payerEmail = order.payer && order.payer.email_address || null;

    // 3. On accepte APPROVED (autorisé par le client) ou COMPLETED (capturé)
    if (status !== "APPROVED" && status !== "COMPLETED") {
      return { ok: false, status, amount, currency, payerEmail, reason: "Status PayPal '" + status + "' (attendu APPROVED ou COMPLETED)" };
    }
    return { ok: true, status, amount, currency, payerEmail };
  } catch (e) {
    return { ok: false, reason: "Exception : " + e.message };
  }
}

// ─────────────────────────────────────────────────────────────
// Persistance dans Supabase (schéma arca, table orders)
// ─────────────────────────────────────────────────────────────
async function persistOrder(d, mrLabel) {
  const SUPABASE_URL = process.env.SUPABASE_URL;
  const SUPABASE_KEY = process.env.SUPABASE_SERVICE_KEY;
  if (!SUPABASE_URL || !SUPABASE_KEY) {
    console.warn("Supabase env vars missing, skipping persistence.");
    return;
  }

  // Items : extrait depuis qty-n1..qty-n9
  const CATALOG = {
    1: { title: 'N°1', price: 20 }, 2: { title: 'N°2', price: 20 },
    3: { title: 'N°3', price: 20 }, 4: { title: 'N°4', price: 20 },
    5: { title: 'N°5', price: 20 }, 6: { title: 'N°6', price: 20 },
    7: { title: 'N°7', price: 20 }, 8: { title: 'N°8', price: getN8Price() },
    9: { title: 'Recueil de prières', price: 20 }
  };
  const items = [];
  for (let i = 1; i <= 9; i++) {
    const q = parseInt(d["qty-n" + i] || "0", 10);
    if (q > 0) items.push({ num: i, title: CATALOG[i].title, qty: q, price: CATALOG[i].price });
  }

  // Parsing du commande-details (TOTAL, Port, Pack) — tolère décimales (3.9 ou 3,9)
  const details = d["commande-details"] || "";
  const num = '(\\d+(?:[.,]\\d+)?)';
  const totalMatch = details.match(new RegExp('TOTAL:\\s*' + num));
  const portMatch = details.match(new RegExp('Port:\\s*' + num));
  const packMatch = details.match(new RegExp('Pack complet -' + num));
  const parseN = m => m ? parseFloat(m[1].replace(',', '.')) : null;

  const paypalStatus = d["paypal-status"] || "";
  const isPaid = paypalStatus.startsWith("PAID");
  const isStripe = /stripe/i.test(paypalStatus) || /carte|bancontact/i.test(d.paiement || "");

  const row = {
    stripe_session_id: isStripe ? (d["paypal-order-id"] || null) : null,
    paypal_order_id:   !isStripe ? (d["paypal-order-id"] || null) : null,
    nom:       d.nom || "—",
    email:     d.email || null,
    telephone: d.telephone || null,
    rue:        d.rue || null,
    complement: d.complement || null,
    cp:         d.cp || null,
    ville:      d.ville || null,
    pays:       d.pays || null,
    items:      items,
    total_eur:  parseN(totalMatch),
    port_eur:   parseN(portMatch),
    pack_discount_eur: parseN(packMatch) || 0,
    livraison:     d.livraison || null,
    mr_relay_code: d["mr-relay-code"] || null,
    mr_relay_info: d["mr-relay-info"] || null,
    mr_expedition: (mrLabel && mrLabel.success && mrLabel.expedition) ? mrLabel.expedition : null,
    mr_label_url:  (mrLabel && mrLabel.success && (mrLabel.url_pdf || mrLabel.url_a6)) ? (mrLabel.url_pdf || mrLabel.url_a6) : null,
    paiement:   isStripe ? "Stripe" : (d.paiement || "PayPal"),
    paye:       isPaid,
    paid_at:    isPaid ? new Date().toISOString() : null,
    cloturee:   false,
    notes:      null,
    // Société (B2B)
    is_company:                d["is-company"] === "1" || d["is-company"] === true,
    company_name:              d["company-name"] || null,
    company_vat:               d["company-vat"] || null,
    billing_same_as_delivery:  (d["billing-same"] === "1" || d["billing-same"] === true || !d["is-company"]),
    billing_rue:               d["billing-rue"] || null,
    billing_complement:        d["billing-complement"] || null,
    billing_cp:                d["billing-cp"] || null,
    billing_ville:             d["billing-ville"] || null,
    billing_pays:              d["billing-pays"] || null
  };

  const resp = await fetch(`${SUPABASE_URL}/rest/v1/arca_orders`, {
    method: "POST",
    headers: {
      "apikey": SUPABASE_KEY,
      "Authorization": "Bearer " + SUPABASE_KEY,
      "Content-Type": "application/json",
      "Prefer": "return=minimal,resolution=ignore-duplicates"  // ignore si stripe_session_id existe deja
    },
    body: JSON.stringify(row)
  });

  if (!resp.ok) {
    const err = await resp.text();
    throw new Error(`Supabase POST ${resp.status}: ${err.substring(0, 200)}`);
  }
  console.log("[Supabase] Commande persistée:", d.nom, "/", d.email);
}

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

function buildEmailHtml(d, mrLabel, paypalVerifyWarning) {
  // Catalogue (titres + prix + badge) — doit rester aligné avec ISSUES dans commande.html
  const CATALOG = {
    1: { title: 'N°1', price: 20, badge: null },
    2: { title: 'N°2', price: 20, badge: null },
    3: { title: 'N°3', price: 20, badge: null },
    4: { title: 'N°4', price: 20, badge: null },
    5: { title: 'N°5', price: 20, badge: null },
    6: { title: 'N°6', price: 20, badge: null },
    7: { title: 'N°7', price: 20, badge: null },
    8: { title: 'N°8', price: getN8Price(), badge: (getN8Price() === 15 ? 'souscription' : 'dernier paru') },
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

  // Détails (sous-total / port / total / pack)
  const details = d["commande-details"] || "";
  let sousTotal = "—", port = "—", total = "—";
  // Regex tolérantes : capture décimales (3.9 ou 3,9)
  const subMatch = details.match(/Sous-total revues:\s*(\d+(?:[.,]\d+)?)\s*€/);
  const portMatch = details.match(/Port:\s*(\d+(?:[.,]\d+)?)\s*€/);
  const totMatch = details.match(/TOTAL:\s*(\d+(?:[.,]\d+)?)\s*€/);
  const packMatch = details.match(/Pack complet -(\d+(?:[.,]\d+)?)/);
  const parseN = m => m ? parseFloat(m[1].replace(',', '.')) : null;
  if (subMatch) sousTotal = subMatch[1].replace(',', '.') + " €";
  if (portMatch) port = portMatch[1].replace(',', '.') + " €";
  if (totMatch) total = totMatch[1].replace(',', '.') + " €";

  // Statut paiement
  const paypalStatus = d["paypal-status"] || "";
  const paypalId = d["paypal-order-id"] || "";
  const isPaid = paypalStatus.startsWith("PAID");
  // Détection du provider à partir de paypal-status ou du mode paiement choisi.
  // Bug fix : utilise le paiement réel saisi (Autre, Virement, En main propre…)
  // au lieu de retomber sur PayPal par défaut.
  const isStripe = /stripe/i.test(paypalStatus) || /carte|bancontact/i.test(d.paiement || "");
  const isPaypalProvider = /paypal/i.test(paypalStatus) || /paypal/i.test(d.paiement || "");
  const provider = isStripe ? "Stripe"
                  : isPaypalProvider ? "PayPal"
                  : (d.paiement || "—");
  const statusBadge = isPaid
    ? `<div style="display:inline-block;padding:6px 14px;background:#3a8a4a;color:#fff;font:bold 11px Arial;letter-spacing:1.5px;text-transform:uppercase;border-radius:4px;">✓ Payé via ${esc(provider)}</div>`
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

  // Rappel : l'étiquette MR se génère au moment de l'expédition, depuis l'admin
  // Commandes ARCA (PAS sur le portail MR — sinon le colis n'est pas relié à la
  // commande en base). Affiché tant qu'aucune étiquette n'existe pour la commande.
  const mrNotYet = isMondialRelay && (!mrLabel || !mrLabel.success);
  const mrConnectButton = mrNotYet ? `
  <tr><td style="padding:0 36px 18px;">
    <table width="100%" cellpadding="0" cellspacing="0" style="background:#fff8ec;border:1px dashed #c8a060;border-radius:4px;">
      <tr><td style="padding:14px 18px;">
        <p style="margin:0 0 10px;font:13px/1.5 Georgia;color:#7a5c20;">Étiquette à générer <strong>au moment de l'expédition</strong> (après réception du paiement le cas échéant).</p>
        <table cellpadding="0" cellspacing="0"><tr><td style="background:#c8a060;border-radius:4px;">
          <a href="https://podcast-arca.netlify.app/admin/#commandes" target="_blank" style="display:inline-block;padding:12px 22px;font:bold 11px Arial;letter-spacing:1.5px;text-transform:uppercase;color:#fff;text-decoration:none;">
            📍 Générer l'étiquette dans l'admin →
          </a>
        </td></tr></table>
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

  ${paypalVerifyWarning ? `
  <!-- ALERTE PAYPAL -->
  <tr><td style="background:#fde4e6;padding:14px 36px;border-bottom:2px solid #9d1018;">
    <p style="margin:0;font:bold 13px Arial;color:#9d1018;">⚠ ALERTE PAYPAL — Vérification ÉCHOUÉE</p>
    <p style="margin:6px 0 0;font:13px/1.5 Georgia;color:#444;">${esc(paypalVerifyWarning)}</p>
    <p style="margin:6px 0 0;font:12px/1.4 Georgia;color:#666;font-style:italic;">La commande a été créée mais marquée NON PAYÉE. Vérifie manuellement sur dashboard PayPal avant d'expédier.</p>
  </td></tr>
  ` : ''}

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
    ${d["is-company"] === "1" ? `
    <table width="100%" cellpadding="0" cellspacing="0" style="margin-top:14px;background:#fffbf4;border:1px solid #c8a060;border-radius:5px;">
      <tr><td style="padding:14px 18px;">
        <p style="margin:0 0 6px;font-family:Arial,sans-serif;font-size:10px;letter-spacing:2px;text-transform:uppercase;color:#c8a060;font-weight:bold;">🏢 Facturation société</p>
        <p style="margin:0 0 3px;font:14px Georgia;color:#2d3461;"><strong>${esc(d["company-name"] || "—")}</strong></p>
        <p style="margin:0 0 6px;font:13px 'Courier New',monospace;color:#444;">TVA : ${esc(d["company-vat"] || "—")}</p>
        ${d["billing-same"] === "1" ? `<p style="margin:0;font:12px Georgia;color:#777;font-style:italic;">Adresse de facturation = adresse de livraison</p>`
        : `<p style="margin:6px 0 0;font:13px/1.5 Georgia;color:#444;white-space:pre-line;">Adresse de facturation :<br>${esc(d["billing-rue"] || "")} ${esc(d["billing-complement"] || "")}<br>${esc(d["billing-cp"] || "")} ${esc(d["billing-ville"] || "")} · ${esc(d["billing-pays"] || "")}</p>`}
      </td></tr>
    </table>` : ""}
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
      <tbody>${qtyRows.join("")}${(Array.isArray(d._custom_items) ? d._custom_items : []).map(function(it){
        const sub = (it.qty || 0) * (it.price || 0);
        return `<tr><td style="padding:8px 10px;border-top:1px solid #e2ddd8;font:14px Georgia;color:#2d3461;"><strong>${esc(it.title || '')}</strong> <span style="color:#c8a060;font-size:10px;letter-spacing:1px;text-transform:uppercase;">livre</span></td><td style="padding:8px 10px;border-top:1px solid #e2ddd8;font:14px Georgia;color:#444;text-align:center;">× ${it.qty || 0}</td><td style="padding:8px 10px;border-top:1px solid #e2ddd8;font:14px Georgia;color:#444;text-align:right;">${it.price || 0} €</td><td style="padding:8px 10px;border-top:1px solid #e2ddd8;font:bold 14px Georgia;color:#2d3461;text-align:right;">${sub} €</td></tr>`;
      }).join('')}</tbody>
    </table>
    <table width="100%" cellpadding="0" cellspacing="0" style="margin-top:14px;">
      <tr><td style="padding:4px 0;font:13.5px Georgia;color:#444;">Sous-total revues</td>
          <td style="padding:4px 0;font:13.5px Georgia;color:#444;text-align:right;">${esc(sousTotal)}</td></tr>
      ${packMatch ? `
      <tr><td style="padding:4px 0;font:13.5px Georgia;color:#c8a060;font-style:italic;">★ Pack complet — réduction</td>
          <td style="padding:4px 0;font:13.5px Georgia;color:#c8a060;font-style:italic;text-align:right;">−${parseN(packMatch)} €</td></tr>
      ` : ''}
      ${(parseFloat(d._discount_eur) > 0) ? `
      <tr><td style="padding:4px 0;font:13.5px Georgia;color:#c8a060;font-style:italic;">⚑ Remise panier${d._discount_note ? ' <span style="color:#777;font-size:12px;font-style:normal;">(' + esc(d._discount_note) + ')</span>' : ''}</td>
          <td style="padding:4px 0;font:13.5px Georgia;color:#c8a060;font-style:italic;text-align:right;">−${parseFloat(d._discount_eur)} €</td></tr>
      ` : ''}
      ${(parseFloat(d._shipping_discount_eur) > 0) ? `
      <tr><td style="padding:4px 0;font:13.5px Georgia;color:#c8a060;font-style:italic;">⚑ Remise port</td>
          <td style="padding:4px 0;font:13.5px Georgia;color:#c8a060;font-style:italic;text-align:right;">−${parseFloat(d._shipping_discount_eur)} €</td></tr>
      ` : ''}
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
    <p style="margin:6px 0 0;font:13px Georgia;color:#777;font-style:italic;">✓ Le client a reçu l'IBAN par e-mail.</p>
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
    7: ['N°7', 20, null], 8: ['N°8', getN8Price(), (getN8Price() === 15 ? 'souscription' : 'dernier paru')],
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

// ═══════════════════════════════════════════════════════════════
// Email de confirmation au client (stylisé ARCA, sans l'étiquette MR)
// ═══════════════════════════════════════════════════════════════
// Libellé humain du moyen de paiement à insérer dans "Votre paiement <X> a bien
// été enregistré". Retourne null si mode non reconnu → on enlève la mention.
function paymentLabel(paymentMode, paypalStatus) {
  const s = (paypalStatus || "") + " " + (paymentMode || "");
  if (/stripe|carte|bancontact/i.test(s)) return "par carte bancaire";
  if (/paypal/i.test(s))                  return "PayPal";
  if (/virement/i.test(s))                return "par virement bancaire";
  if (/main propre/i.test(s))             return "en main propre";
  return null;
}

function buildClientEmailHtml(d, mrLabel, payLinks) {
  const paypalStatus = d["paypal-status"] || "";
  const isPaid = paypalStatus.startsWith("PAID");
  const isStripe = /stripe/i.test(paypalStatus) || /carte|bancontact/i.test(d.paiement || "");
  const providerLabel = paymentLabel(d.paiement, paypalStatus);
  const isMondialRelay = (d.livraison || "") === "Mondial Relay";
  const totMatchClient = (d["commande-details"] || "").match(/TOTAL:\s*(\d+(?:[.,]\d+)?)\s*€/);
  const total = totMatchClient ? totMatchClient[1].replace(',', '.') : "—";
  const packMatchClient = (d["commande-details"] || "").match(/Pack complet -(\d+(?:[.,]\d+)?)/);
  const packDiscountClient = packMatchClient ? parseFloat(packMatchClient[1].replace(',', '.')) : 0;
  const portMatchClient = (d["commande-details"] || "").match(/Port:\s*(\d+(?:[.,]\d+)?)\s*€/);
  const portClient = portMatchClient ? parseFloat(portMatchClient[1].replace(',', '.')) : 0;
  const hasN8 = parseInt(d["qty-n8"] || "0", 10) > 0;
  // Note expédition mi-juin si N°8 commandé pendant la souscription
  const PROMO_DEADLINE = new Date('2026-05-25T22:00:00Z');
  const isSubscriptionPeriod = hasN8 && new Date() < PROMO_DEADLINE;

  // Lignes commande
  const CAT = {
    1:['N°1',20], 2:['N°2',20], 3:['N°3',20], 4:['N°4',20], 5:['N°5',20],
    6:['N°6',20], 7:['N°7',20], 8:['N°8',getN8Price()], 9:['Recueil de prières',20]
  };
  let rows = "";
  for (let i = 1; i <= 9; i++) {
    const q = parseInt(d["qty-n" + i] || "0", 10);
    if (q > 0) {
      const [title, price] = CAT[i];
      rows += `<tr><td style="padding:6px 0;font:14px Georgia;color:#444;">${title} × ${q}</td><td style="padding:6px 0;font:14px Georgia;color:#2d3461;text-align:right;">${price * q} €</td></tr>`;
    }
  }
  // Articles libres (livres hors catalogue, ajoutés en création manuelle)
  (Array.isArray(d._custom_items) ? d._custom_items : []).forEach(function(it) {
    const sub = (it.qty || 0) * (it.price || 0);
    rows += `<tr><td style="padding:6px 0;font:14px Georgia;color:#444;">${esc(it.title || '')} × ${it.qty || 0}</td><td style="padding:6px 0;font:14px Georgia;color:#2d3461;text-align:right;">${sub} €</td></tr>`;
  });

  // Bloc suivi Mondial Relay (si étiquette générée)
  let trackingBlock = "";
  if (isMondialRelay && mrLabel && mrLabel.success && mrLabel.expedition) {
    const cp = String(d.cp || "").replace(/\D/g, "");
    const trackingCode = shortMrExp(mrLabel.expedition);
    const trackUrl = `https://www.mondialrelay.fr/suivi-de-colis/?numeroExpedition=${encodeURIComponent(trackingCode)}&codePostal=${encodeURIComponent(cp)}`;
    trackingBlock = `
    <tr><td style="padding:0 36px 20px;">
      <table width="100%" cellpadding="0" cellspacing="0" style="background:#fffbf4;border:1px solid #c8a060;border-radius:5px;">
        <tr><td style="padding:18px 22px;">
          <p style="margin:0 0 6px;font:11px Arial;letter-spacing:2px;text-transform:uppercase;color:#c8a060;font-weight:bold;">📦 Suivi de votre colis</p>
          <p style="margin:0 0 10px;font:14px Georgia;color:#444;">Numéro d'expédition : <strong style="color:#2d3461;font-family:'Courier New',monospace;">${esc(trackingCode)}</strong></p>
          <table cellpadding="0" cellspacing="0"><tr><td style="background:#2d3461;border-radius:4px;">
            <a href="${esc(trackUrl)}" style="display:inline-block;padding:10px 20px;font:bold 11px Arial;letter-spacing:1.5px;text-transform:uppercase;color:#fff;text-decoration:none;">Suivre mon colis →</a>
          </td></tr></table>
        </td></tr>
      </table>
    </td></tr>`;
  }

  // Message selon mode paiement
  const ref = `ARCA ${(d.nom || "").trim()}`.substring(0, 35);
  const paiementChoisi = (d.paiement || "").toLowerCase();
  const isPaypalChoice = /paypal/i.test(paiementChoisi);
  const isStripeChoice = /stripe|carte|bancontact/i.test(paiementChoisi);

  // Bloc IBAN (toujours proposé en option virement)
  const ibanBlock = `
       <table width="100%" cellpadding="0" cellspacing="0" style="background:#faf8f5;border:1px solid #e2ddd8;border-radius:5px;margin-bottom:14px">
         <tr><td style="padding:18px 22px;">
           <p style="margin:0 0 10px;font:bold 12px Arial;letter-spacing:1.5px;text-transform:uppercase;color:#2d3461;">Virement bancaire</p>
           <table width="100%" cellpadding="0" cellspacing="0" style="font:14px/1.7 Georgia;color:#2d3461;">
             <tr><td style="color:#777;font-size:12px;letter-spacing:1px;text-transform:uppercase;width:140px;padding:3px 0;">Bénéficiaire</td><td style="padding:3px 0;">ARCA Societas SRL</td></tr>
             <tr><td style="color:#777;font-size:12px;letter-spacing:1px;text-transform:uppercase;padding:3px 0;">IBAN</td><td style="padding:3px 0;"><strong style="font-family:'Courier New',monospace;letter-spacing:.5px;">BE92 0017 7210 5023</strong></td></tr>
             <tr><td style="color:#777;font-size:12px;letter-spacing:1px;text-transform:uppercase;padding:3px 0;">BIC</td><td style="padding:3px 0;"><strong style="font-family:'Courier New',monospace;letter-spacing:.5px;">GEBABEBB</strong></td></tr>
             <tr><td style="color:#777;font-size:12px;letter-spacing:1px;text-transform:uppercase;padding:3px 0;border-top:1px solid #e2ddd8;">Montant</td><td style="padding:3px 0;border-top:1px solid #e2ddd8;"><strong style="color:#c8a060;font-size:16px;">${esc(total)} €</strong></td></tr>
             <tr><td style="color:#777;font-size:12px;letter-spacing:1px;text-transform:uppercase;padding:3px 0;">Communication</td><td style="padding:3px 0;font-family:'Courier New',monospace;font-size:13px;letter-spacing:.5px;">${esc(ref)}</td></tr>
           </table>
         </td></tr>
       </table>`;

  // Bloc PayPal (lien direct paypal.me — Antoine doit configurer paypal.me/ArcaLibrairie ou similaire)
  const paypalBlock = `
       <table width="100%" cellpadding="0" cellspacing="0" style="background:#fffbf2;border:1px solid #c8a060;border-radius:5px;margin-bottom:14px">
         <tr><td style="padding:18px 22px;">
           <p style="margin:0 0 10px;font:bold 12px Arial;letter-spacing:1.5px;text-transform:uppercase;color:#c8a060;">PayPal</p>
           <p style="margin:0 0 12px;font:14px/1.6 Georgia;color:#444;">Envoyez <strong style="color:#2d3461;">${esc(total)} €</strong> à l'adresse PayPal&nbsp;: <strong style="color:#2d3461;font-family:'Courier New',monospace">antoine@arca-librairie.com</strong></p>
           <p style="margin:0;font:12px Georgia;color:#777;font-style:italic">Mentionnez votre nom (${esc((d.nom || "").trim())}) dans le message du paiement.</p>
         </td></tr>
       </table>`;

  // Bloc "Payer en ligne en 1 clic" — boutons Stripe + PayPal si links générés
  const links = payLinks || {};
  let payNowBlock = "";
  if (!isPaid && (links.stripeUrl || links.paypalUrl)) {
    const stripeBtn = links.stripeUrl ? `
      <table cellpadding="0" cellspacing="0" style="display:inline-block;margin:4px 6px"><tr><td style="background:#635bff;border-radius:5px">
        <a href="${esc(links.stripeUrl)}" style="display:inline-block;padding:14px 26px;font:bold 13px Arial;letter-spacing:1px;text-transform:uppercase;color:#fff;text-decoration:none;">💳 Payer par carte / Bancontact</a>
      </td></tr></table>` : "";
    const paypalBtn = links.paypalUrl ? `
      <table cellpadding="0" cellspacing="0" style="display:inline-block;margin:4px 6px"><tr><td style="background:#ffc439;border-radius:5px">
        <a href="${esc(links.paypalUrl)}" style="display:inline-block;padding:14px 26px;font:bold 13px Arial;letter-spacing:1px;text-transform:uppercase;color:#003087;text-decoration:none;">PayPal</a>
      </td></tr></table>` : "";
    payNowBlock = `
       <table width="100%" cellpadding="0" cellspacing="0" style="background:linear-gradient(135deg,#fdf8ea,#f7efd5);border:2px solid #c8a060;border-radius:6px;margin-bottom:18px">
         <tr><td style="padding:22px 22px;text-align:center;">
           <p style="margin:0 0 6px;font:bold 11px Arial;letter-spacing:2.5px;text-transform:uppercase;color:#6b5a2d;">⚡ Payer en ligne en 1 clic</p>
           <p style="margin:0 0 14px;font:15px Georgia;color:#2d3461;">Montant à régler&nbsp;: <strong style="font-size:18px">${esc(total)} €</strong></p>
           ${stripeBtn}${paypalBtn}
           <p style="margin:14px 0 0;font:12px Georgia;color:#777;font-style:italic">Paiement sécurisé. Votre commande sera marquée payée automatiquement.</p>
         </td></tr>
       </table>`;
  }

  let paymentMsg;
  if (isPaid) {
    paymentMsg = providerLabel
      ? `<p style="margin:0;font:15px/1.7 Georgia;color:#444;">Votre paiement <strong style="color:#2d3461;">${providerLabel}</strong> a bien été enregistré. Nous préparons votre commande.</p>`
      : `<p style="margin:0;font:15px/1.7 Georgia;color:#444;">Votre commande a bien été enregistrée. Nous la préparons.</p>`;
  } else if (payNowBlock) {
    // Avec liens de paiement direct : pay-now en avant, IBAN en alternative
    paymentMsg = `<p style="margin:0 0 14px;font:15px/1.7 Georgia;color:#444;">Pour finaliser votre commande, choisissez votre moyen de paiement préféré&nbsp;:</p>${payNowBlock}<p style="margin:0 0 8px;font:13px Georgia;color:#666;font-style:italic">Ou par virement bancaire&nbsp;:</p>${ibanBlock}`;
  } else if (isPaypalChoice) {
    paymentMsg = `<p style="margin:0 0 14px;font:15px/1.7 Georgia;color:#444;">Voici les coordonnées pour effectuer votre paiement. Dès réception, nous préparerons votre commande.</p>${paypalBlock}<p style="margin:0 0 8px;font:13px Georgia;color:#666;font-style:italic">Vous préférez le virement bancaire ?</p>${ibanBlock}`;
  } else {
    paymentMsg = `<p style="margin:0 0 14px;font:15px/1.7 Georgia;color:#444;">Voici les coordonnées pour effectuer votre <strong style="color:#2d3461;">virement bancaire</strong>. Dès réception, nous préparerons votre commande.</p>${ibanBlock}<p style="margin:0 0 8px;font:13px Georgia;color:#666;font-style:italic">Vous préférez PayPal ?</p>${paypalBlock}`;
  }

  return `<!DOCTYPE html>
<html lang="fr"><head><meta charset="UTF-8"></head>
<body style="margin:0;padding:0;background:#f0ede8;font-family:Georgia,serif;">
<table width="100%" cellpadding="0" cellspacing="0" style="background:#f0ede8;"><tr><td align="center" style="padding:30px 16px;">
<table width="600" cellpadding="0" cellspacing="0" style="max-width:600px;width:100%;background:#fff;border-radius:5px;overflow:hidden;box-shadow:0 2px 16px rgba(0,0,0,.1);">

  <!-- HEADER -->
  <tr><td style="background:#2d3461;padding:38px 36px 30px;text-align:center;">
    <p style="margin:0 0 8px;font:11px Arial;letter-spacing:4px;text-transform:uppercase;color:#c8a060;">Revue &amp; Librairie</p>
    <h1 style="margin:0 0 12px;font:34px/1 Georgia;letter-spacing:10px;text-transform:uppercase;color:#fff;font-weight:normal;">ARCA</h1>
    <div style="width:40px;height:2px;background:#c8a060;margin:0 auto;"></div>
  </td></tr>

  <!-- INTRO -->
  <tr><td style="padding:32px 36px 20px;">
    <h2 style="margin:0 0 14px;font:normal 22px/1.3 Georgia;color:#2d3461;">Merci pour votre commande, ${esc((d.nom || "").split(' ')[0] || "")}.</h2>
    ${paymentMsg}
  </td></tr>

  <!-- SUIVI MR -->
  ${trackingBlock}

  <!-- RÉCAP -->
  <tr><td style="padding:0 36px 24px;">
    <p style="margin:0 0 10px;font:11px Arial;letter-spacing:2px;text-transform:uppercase;color:#c8a060;font-weight:bold;">— Récapitulatif —</p>
    <table width="100%" cellpadding="0" cellspacing="0">
      ${rows}
      ${packDiscountClient > 0 ? `
      <tr><td style="padding:6px 0;font:italic 14px Georgia;color:#c8a060;">★ Pack complet — réduction</td>
          <td style="padding:6px 0;font:italic 14px Georgia;color:#c8a060;text-align:right;">−${packDiscountClient} €</td></tr>
      ` : ''}
      ${(parseFloat(d._discount_eur) > 0) ? `
      <tr><td style="padding:6px 0;font:italic 14px Georgia;color:#c8a060;">⚑ Remise</td>
          <td style="padding:6px 0;font:italic 14px Georgia;color:#c8a060;text-align:right;">−${parseFloat(d._discount_eur)} €</td></tr>
      ` : ''}
      ${(parseFloat(d._shipping_discount_eur) > 0) ? `
      <tr><td style="padding:6px 0;font:italic 14px Georgia;color:#c8a060;">⚑ Remise sur frais de port</td>
          <td style="padding:6px 0;font:italic 14px Georgia;color:#c8a060;text-align:right;">−${parseFloat(d._shipping_discount_eur)} €</td></tr>
      ` : ''}
      ${portClient > 0 ? `
      <tr><td style="padding:6px 0;font:14px Georgia;color:#444;">Frais de port${d.livraison ? ' (' + esc(d.livraison) + ')' : ''}</td>
          <td style="padding:6px 0;font:14px Georgia;color:#444;text-align:right;">${portClient} €</td></tr>
      ` : (d.livraison === 'En main propre' ? `
      <tr><td style="padding:6px 0;font:14px Georgia;color:#444;">Livraison en main propre</td>
          <td style="padding:6px 0;font:14px Georgia;color:#444;text-align:right;">gratuite</td></tr>
      ` : '')}
      <tr><td colspan="2" style="padding:10px 0 0;border-top:2px solid #c8a060;"></td></tr>
      <tr><td style="padding:8px 0;font:bold 16px Georgia;color:#2d3461;">Total</td>
          <td style="padding:8px 0;font:bold 18px Georgia;color:#2d3461;text-align:right;">${esc(total)} €</td></tr>
    </table>
    ${d["is-company"] === "1" ? `
    <table width="100%" cellpadding="0" cellspacing="0" style="margin-top:18px;background:#faf8f3;border-left:3px solid #c8a060;border-radius:0 4px 4px 0;">
      <tr><td style="padding:14px 18px;">
        <p style="margin:0 0 4px;font:10px Arial;letter-spacing:2px;text-transform:uppercase;color:#c8a060;font-weight:bold;">🏢 Facturation société</p>
        <p style="margin:0 0 3px;font:14px Georgia;color:#2d3461;"><strong>${esc(d["company-name"] || "")}</strong></p>
        <p style="margin:0;font:13px 'Courier New',monospace;color:#444;">N° TVA : ${esc(d["company-vat"] || "")}</p>
        ${d["billing-same"] !== "1" ? `<p style="margin:8px 0 0;font:13px/1.5 Georgia;color:#444;">Adresse de facturation :<br>${esc(d["billing-rue"] || "")} ${esc(d["billing-complement"] || "")}<br>${esc(d["billing-cp"] || "")} ${esc(d["billing-ville"] || "")} · ${esc(d["billing-pays"] || "")}</p>` : ""}
        <p style="margin:8px 0 0;font:12px Georgia;color:#777;font-style:italic;">Une facture détaillée vous sera adressée séparément.</p>
      </td></tr>
    </table>` : ""}
  </td></tr>

  <!-- LIVRAISON -->
  <tr><td style="padding:0 36px 28px;">
    <p style="margin:0 0 6px;font:11px Arial;letter-spacing:2px;text-transform:uppercase;color:#c8a060;font-weight:bold;">— Livraison —</p>
    <p style="margin:0;font:14px/1.6 Georgia;color:#444;"><strong style="color:#2d3461;">${esc(d.livraison || "—")}</strong>${isMondialRelay && d["mr-relay-info"] ? `<br><span style="font-size:13px;color:#777;">${esc(d["mr-relay-info"])}</span>` : ""}</p>
  </td></tr>
${isSubscriptionPeriod ? `
  <!-- NOTICE EXPÉDITION MI-JUIN -->
  <tr><td style="padding:0 36px 28px;">
    <table width="100%" cellpadding="0" cellspacing="0" style="background:#fffbf2;border-left:4px solid #c8a060;border-radius:0 4px 4px 0;">
      <tr><td style="padding:18px 22px;">
        <p style="margin:0 0 8px;font:bold 12px Arial;letter-spacing:1.5px;text-transform:uppercase;color:#c8a060;">📅 Expédition mi-juin</p>
        <p style="margin:0;font:14px/1.6 Georgia;color:#444;">
          Le <strong style="color:#2d3461;">n°8 de la revue ARCA</strong> est en cours d'impression. Vos exemplaires partiront <strong>dès réception de l'imprimeur</strong>, vers mi-juin, dans un seul colis avec tous les autres numéros commandés.
        </p>
      </td></tr>
    </table>
  </td></tr>` : ""}

  <!-- FOOTER -->
  <tr><td style="background:#1e2245;padding:22px 36px;text-align:center;">
    <p style="margin:0 0 6px;font:13px Georgia;color:rgba(255,255,255,.7);">Une question ?</p>
    <p style="margin:0;font:13px Georgia;"><a href="mailto:antoine@arca-librairie.com" style="color:#c8a060;text-decoration:none;">antoine@arca-librairie.com</a></p>
  </td></tr>

</table>
</td></tr></table>
</body></html>`;
}

function buildClientEmailText(d, mrLabel, payLinks) {
  const paypalStatus = d["paypal-status"] || "";
  const isPaid = paypalStatus.startsWith("PAID");
  const isStripe = /stripe/i.test(paypalStatus) || /carte|bancontact/i.test(d.paiement || "");
  const providerLabel = paymentLabel(d.paiement, paypalStatus);
  const isMondialRelay = (d.livraison || "") === "Mondial Relay";
  const totMatch = (d["commande-details"] || "").match(/TOTAL:\s*(\d+(?:[.,]\d+)?)\s*€/);
  const total = totMatch ? totMatch[1].replace(',', '.') : "—";
  const ref = `ARCA ${(d.nom || "").trim()}`.substring(0, 35);
  let txt = `MERCI POUR VOTRE COMMANDE — ARCA\n\n`;
  txt += `Bonjour ${(d.nom || "").split(' ')[0] || ""},\n\n`;
  const links = payLinks || {};
  if (isPaid) {
    txt += providerLabel
      ? `Votre paiement ${providerLabel} a bien été enregistré. Nous préparons votre commande.\n\n`
      : `Votre commande a bien été enregistrée. Nous la préparons.\n\n`;
  } else if (links.stripeUrl || links.paypalUrl) {
    txt += `PAYER EN LIGNE EN 1 CLIC\n  Montant : ${total} €\n`;
    if (links.stripeUrl) txt += `  Carte bancaire / Bancontact : ${links.stripeUrl}\n`;
    if (links.paypalUrl) txt += `  PayPal : ${links.paypalUrl}\n`;
    txt += `  → Votre commande sera marquée payée automatiquement.\n\n`;
    txt += `Ou par virement bancaire :\n`;
    txt += `  Bénéficiaire  : ARCA Societas SRL\n`;
    txt += `  IBAN          : BE92 0017 7210 5023\n`;
    txt += `  BIC           : GEBABEBB\n`;
    txt += `  Montant       : ${total} €\n`;
    txt += `  Communication : ${ref}\n\n`;
  } else {
    const isPaypalChoice = /paypal/i.test(d.paiement || "");
    if (isPaypalChoice) {
      txt += `PAYPAL\n`;
      txt += `  Envoyez ${total} € à : antoine@arca-librairie.com\n`;
      txt += `  Mentionnez votre nom (${(d.nom || "").trim()}) dans le message.\n\n`;
      txt += `Vous préférez le virement bancaire ?\n`;
    } else {
      txt += `VIREMENT BANCAIRE\n`;
    }
    txt += `  Bénéficiaire  : ARCA Societas SRL\n`;
    txt += `  IBAN          : BE92 0017 7210 5023\n`;
    txt += `  BIC           : GEBABEBB\n`;
    txt += `  Montant       : ${total} €\n`;
    txt += `  Communication : ${ref}\n\n`;
    if (!isPaypalChoice) {
      txt += `Vous préférez PayPal ?\n  Envoyez ${total} € à : antoine@arca-librairie.com\n\n`;
    }
    txt += `Dès réception de votre paiement, nous préparerons votre commande.\n\n`;
  }
  if (isMondialRelay && mrLabel && mrLabel.success && mrLabel.expedition) {
    const cp = String(d.cp || "").replace(/\D/g, "");
    txt += `SUIVI MONDIAL RELAY\n`;
    txt += `  Numéro d'expédition : ${mrLabel.expedition}\n`;
    txt += `  Suivre : https://www.mondialrelay.fr/suivi-de-colis/?numeroExpedition=${encodeURIComponent(shortMrExp(mrLabel.expedition))}&codePostal=${encodeURIComponent(cp)}\n\n`;
  }
  txt += `LIVRAISON : ${d.livraison || "—"}\n`;
  if (isMondialRelay && d["mr-relay-info"]) txt += `  ${d["mr-relay-info"]}\n`;
  txt += `\nUne question ? antoine@arca-librairie.com\n`;
  return txt;
}
