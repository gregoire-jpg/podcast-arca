// Netlify Function — "Prévenir tout le monde" (admin).
// POST { password, num } → envoie l'e-mail "de nouveau disponible" à tous les inscrits
// en attente pour ce numéro, puis les marque notified=true.
// Protégé par ADMIN_PASSWORD (même secret que db-proxy).

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

  if (!req.password || req.password !== process.env.ADMIN_PASSWORD) {
    return json(401, { error: "Mot de passe incorrect" });
  }
  const num = parseInt(req.num, 10);
  if (!(num >= 1 && num <= 9)) return json(400, { error: "Numéro invalide" });

  const supaUrl = process.env.SUPABASE_URL;
  const supaKey = process.env.SUPABASE_SERVICE_KEY;
  if (!supaUrl || !supaKey) return json(500, { error: "Config Supabase manquante" });
  const h = { apikey: supaKey, Authorization: "Bearer " + supaKey, "Accept-Profile": "public" };

  // Inscrits en attente pour ce numéro
  let pending = [];
  try {
    const r = await fetch(supaUrl + "/rest/v1/arca_restock_alerts?select=email&num=eq." + num + "&notified=eq.false", { headers: h });
    pending = await r.json();
  } catch (e) {
    return json(502, { error: "Lecture inscrits échouée : " + (e.message || String(e)) });
  }
  const emails = (pending || []).map(p => p.email).filter(Boolean);
  if (!emails.length) return json(200, { sent: 0, total: 0 });

  const orderUrl = process.env.ORDER_PAGE_URL || "https://arca-revue.com/arca-revue/";
  const subject = arcaShort(num) + " est de nouveau disponible !";
  const htmlContent = wrapHtml(
    "<p>Bonne nouvelle !</p>"
    + "<p><strong>" + arcaTitle(num).replace(/^la |^le /, "La ") + "</strong> que vous attendiez est de nouveau en stock.</p>"
    + "<p style=\"text-align:center;margin:24px 0\">"
      + "<a href=\"" + orderUrl + "\" style=\"background:#23264a;color:#c8a060;text-decoration:none;font:bold 14px Arial;letter-spacing:1px;padding:13px 26px;border-radius:5px;display:inline-block\">Commander maintenant</a>"
    + "</p>"
    + "<p style=\"color:#777;font-size:13px\">Les stocks sont limités — n'attendez pas trop si vous le souhaitez.</p>"
    + "<p>À bientôt,<br>L'équipe ARCA</p>"
  );
  const textContent = arcaShort(num) + " est de nouveau disponible ! Commandez ici : " + orderUrl + "\n\nL'équipe ARCA";

  // Envoi individuel (un e-mail par destinataire, pas de fuite d'adresses entre eux)
  const results = await Promise.allSettled(emails.map(e => sendBrevo({
    sender: { name: "ARCA Revue & Librairie", email: fromEmail() },
    to: [{ email: e }],
    replyTo: { email: "antoine@arca-librairie.com", name: "ARCA" },
    subject: subject,
    htmlContent: htmlContent,
    textContent: textContent,
  })));
  const sent = results.filter(r => r.status === "fulfilled").length;
  const failed = results.length - sent;

  // Marque comme prévenus (tous ceux qui étaient en attente pour ce numéro)
  try {
    await fetch(supaUrl + "/rest/v1/arca_restock_alerts?num=eq." + num + "&notified=eq.false", {
      method: "PATCH",
      headers: { ...h, "Content-Type": "application/json", "Content-Profile": "public", Prefer: "return=minimal" },
      body: JSON.stringify({ notified: true, notified_at: new Date().toISOString() }),
    });
  } catch (e) {
    console.error("[restock-notify] PATCH notified échec:", e.message);
  }

  return json(200, { sent: sent, failed: failed, total: emails.length });
};
