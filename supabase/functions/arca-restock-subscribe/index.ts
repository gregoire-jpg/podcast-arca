// Edge Function — inscription à l'alerte réassort (livre épuisé). PUBLIC.
// (Portée depuis netlify/functions/arca-restock-subscribe.js.)
// POST { email, num, website? } → insère dans arca_restock_alerts (anti-doublon), honeypot anti-bot.

import { json, preflight } from "../_shared/cors.ts";
import { arcaEnv } from "../_shared/env.ts";
import { supaEnv } from "../_shared/supa.ts";
import { arcaTitle, arcaShort, wrapHtml, fromEmail, sendBrevo, esc } from "../_shared/arca-mail.ts";

Deno.serve(async (req) => {
  const pre = preflight(req);
  if (pre) return pre;
  if (req.method !== "POST") return json(405, { error: "Method Not Allowed" });

  let body: any;
  try { body = await req.json(); } catch { return json(400, { error: "JSON invalide" }); }

  // Honeypot : un bot remplit ce champ caché → OK sans rien enregistrer.
  if (body.website) return json(200, { ok: true });

  const email = String(body.email || "").trim().toLowerCase();
  const num = parseInt(body.num, 10);
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) return json(400, { error: "E-mail invalide" });
  if (!(num >= 1 && num <= 9)) return json(400, { error: "Numéro invalide" });

  const { url: supaUrl, key: supaKey } = supaEnv();
  if (!supaUrl || !supaKey) return json(500, { error: "Config Supabase manquante" });

  let r: Response, rows: any = [];
  try {
    r = await fetch(supaUrl + "/rest/v1/arca_restock_alerts?on_conflict=email,num", {
      method: "POST",
      headers: {
        apikey: supaKey, Authorization: "Bearer " + supaKey,
        "Content-Type": "application/json", "Content-Profile": "public",
        Prefer: "resolution=ignore-duplicates,return=representation",
      },
      body: JSON.stringify({ email, num }),
    });
    rows = await r.json().catch(() => []);
  } catch (e) {
    return json(502, { error: "Enregistrement échoué : " + ((e as Error).message || String(e)) });
  }
  if (!r.ok && r.status !== 409) return json(502, { error: (rows && rows.message) || "HTTP " + r.status });

  const inserted = Array.isArray(rows) && rows.length > 0;

  // Confirmation au visiteur (n'échoue jamais la requête)
  try {
    await sendBrevo({
      sender: { name: "ARCA Revue & Librairie", email: fromEmail() },
      to: [{ email }],
      replyTo: { email: "antoine@arca-librairie.com", name: "ARCA" },
      subject: "Votre demande de réassort — " + arcaShort(num),
      htmlContent: wrapHtml(
        "<p>Bonjour,</p>"
        + "<p>Nous avons bien noté votre demande concernant <strong>" + arcaTitle(num) + "</strong>, actuellement épuisé.</p>"
        + "<p>Dès qu'il sera de nouveau disponible, <strong>nous vous préviendrons par e-mail à cette adresse</strong>.</p>"
        + "<p>Merci de votre intérêt pour la revue,<br>L'équipe ARCA</p>",
      ),
      textContent: "Bonjour,\n\nNous avons bien noté votre demande concernant " + arcaTitle(num)
        + ", actuellement épuisé. Dès qu'il sera de nouveau disponible, nous vous préviendrons par e-mail.\n\nL'équipe ARCA",
    });
  } catch (e) { console.error("[restock] mail visiteur échec:", (e as Error).message); }

  // Notification interne (seulement vraie nouvelle inscription)
  if (inserted) {
    const toRaw = (arcaEnv("ORDER_EMAIL_TO") || "").split(",").map((s) => s.trim()).filter(Boolean);
    if (toRaw.length) {
      try {
        await sendBrevo({
          sender: { name: "ARCA Alertes", email: fromEmail() },
          to: toRaw.map((e) => ({ email: e })),
          replyTo: { email, name: "" },
          subject: "🔔 Nouvelle alerte réassort — " + arcaShort(num),
          htmlContent: wrapHtml(
            "<p><strong>Nouvelle inscription à l'alerte réassort.</strong></p>"
            + "<p>Ouvrage : <strong>" + arcaShort(num) + "</strong><br>E-mail : <strong>" + esc(email) + "</strong></p>"
            + "<p style=\"color:#777;font-size:13px\">Retrouvez tous les inscrits en attente dans l'admin (module Stock → Alertes réassort).</p>",
          ),
          textContent: "Nouvelle alerte réassort.\nOuvrage : " + arcaShort(num) + "\nE-mail : " + email,
        });
      } catch (e) { console.error("[restock] mail interne échec:", (e as Error).message); }
    }
  }

  return json(200, { ok: true });
});
