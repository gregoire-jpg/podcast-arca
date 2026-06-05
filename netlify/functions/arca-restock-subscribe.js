// Netlify Function — inscription à l'alerte réassort (livre épuisé).
// POST { email, num } → insère dans public.arca_restock_alerts (anti-doublon email+num).
// Public, sans auth ; validation e-mail + honeypot anti-bot.

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

  let r;
  try {
    r = await fetch(supaUrl + "/rest/v1/arca_restock_alerts?on_conflict=email,num", {
      method: "POST",
      headers: {
        apikey: supaKey,
        Authorization: "Bearer " + supaKey,
        "Content-Type": "application/json",
        "Content-Profile": "public",
        Prefer: "resolution=ignore-duplicates,return=minimal",
      },
      body: JSON.stringify({ email: email, num: num }),
    });
  } catch (e) {
    return json(502, { error: "Enregistrement échoué : " + (e.message || String(e)) });
  }

  if (!r.ok && r.status !== 409) {
    const t = await r.text();
    return json(502, { error: t || "HTTP " + r.status });
  }
  return json(200, { ok: true });
};
