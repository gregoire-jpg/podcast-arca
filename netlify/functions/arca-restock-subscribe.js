// Netlify Function — inscription à l'alerte réassort (livre épuisé).
// POST { email, num } → insère dans public.arca_restock_alerts (anti-doublon email+num).
// Public, sans auth ; validation e-mail + honeypot anti-bot.
// Envoie une confirmation au visiteur + une notification interne (Brevo, config partagée).

const { arcaTitle, arcaShort, wrapHtml, fromEmail, sendBrevo } = require("./_arca-mail");

function json(code, obj) {
  return {
    statusCode: code,
    headers: {
      "Content-Type": "application/json",
      "Access-Control-Allow-Origin": "*",
      "Access-Control-Allow-Headers": "Content-Type",
      "Access-Control-Allow-Methods": "POST, OPTIONS",
    },
    body: JSON.stringify(obj),
  };
}

exports.handler = async function (event) {
  if (event.httpMethod === "OPTIONS") return json(200, {});
  if (event.httpMethod !== "POST") return json(405, { error: "Method Not Allowed" });

  let req;
  try { req = JSON.parse(event.body || "{}"); } catch { return json(400, { error: "JSON invalide" }); }

  // Honeypot : un bot remplit ce champ caché → on répond OK sans rien enregistrer.
  if (req.website) return json(200, { ok: true });

  const email = String(req.email || "").trim().toLowerCase();
  const num = parseInt(req.num, 10);
  const emailOk = /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email);
  if (!emailOk) return json(400, { error: "E-mail invalide" });
  if (!(num >= 1 && num <= 9)) return json(400, { error: "Numéro invalide" });

  const supaUrl = process.env.SUPABASE_URL;
  const supaKey = process.env.SUPABASE_SERVICE_KEY;
  if (!supaUrl || !supaKey) return json(500, { error: "Config Supabase manquante" });

  let r, rows = [];
  try {
    r = await fetch(supaUrl + "/rest/v1/arca_restock_alerts?on_conflict=email,num", {
      method: "POST",
      headers: {
        apikey: supaKey,
        Authorization: "Bearer " + supaKey,
        "Content-Type": "application/json",
        "Content-Profile": "public",
        Prefer: "resolution=ignore-duplicates,return=representation",
      },
      body: JSON.stringify({ email: email, num: num }),
    });
    rows = await r.json().catch(() => []);
  } catch (e) {
    return json(502, { error: "Enregistrement échoué : " + (e.message || String(e)) });
  }

  if (!r.ok && r.status !== 409) {
    return json(502, { error: (rows && rows.message) || "HTTP " + r.status });
  }

  // Nouvelle inscription (et non un doublon ignoré) → on notifie.
  const inserted = Array.isArray(rows) && rows.length > 0;

  // ── Confirmation au visiteur (n'échoue jamais la requête : l'inscription est déjà sauvée) ──
  try {
    await sendBrevo({
      sender: { name: "ARCA Revue & Librairie", email: fromEmail() },
      to: [{ email: email }],
      replyTo: { email: "antoine@arca-librairie.com", name: "ARCA" },
      subject: "Votre demande de réassort — " + arcaShort(num),
      htmlContent: wrapHtml(
        "<p>Bonjour,</p>"
        + "<p>Nous avons bien noté votre demande concernant <strong>" + arcaTitle(num) + "</strong>, actuellement épuisé.</p>"
        + "<p>Dès qu'il sera de nouveau disponible, <strong>nous vous préviendrons par e-mail à cette adresse</strong>.</p>"
        + "<p>Merci de votre intérêt pour la revue,<br>L'équipe ARCA</p>"
      ),
      textContent: "Bonjour,\n\nNous avons bien noté votre demande concernant " + arcaTitle(num)
        + ", actuellement épuisé. Dès qu'il sera de nouveau disponible, nous vous préviendrons par e-mail.\n\nL'équipe ARCA",
    });
  } catch (e) { console.error("[restock] mail visiteur échec:", e.message); }

  // ── Notification interne (uniquement sur une vraie nouvelle inscription) ──
  if (inserted) {
    const toRaw = (process.env.ORDER_EMAIL_TO || "").split(",").map(s => s.trim()).filter(Boolean);
    if (toRaw.length) {
      try {
        await sendBrevo({
          sender: { name: "ARCA Alertes", email: fromEmail() },
          to: toRaw.map(e => ({ email: e })),
          replyTo: { email: email, name: "" },
          subject: "🔔 Nouvelle alerte réassort — " + arcaShort(num),
          htmlContent: wrapHtml(
            "<p><strong>Nouvelle inscription à l'alerte réassort.</strong></p>"
            + "<p>Ouvrage : <strong>" + arcaShort(num) + "</strong><br>E-mail : <strong>" + email + "</strong></p>"
            + "<p style=\"color:#777;font-size:13px\">Retrouvez tous les inscrits en attente dans l'admin (module Stock → Alertes réassort).</p>"
          ),
          textContent: "Nouvelle alerte réassort.\nOuvrage : " + arcaShort(num) + "\nE-mail : " + email,
        });
      } catch (e) { console.error("[restock] mail interne échec:", e.message); }
    }
  }

  return json(200, { ok: true });
};
