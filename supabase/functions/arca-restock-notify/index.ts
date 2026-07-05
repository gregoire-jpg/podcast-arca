// Edge Function — "Prévenir tout le monde" (ADMIN).
// (Portée depuis netlify/functions/arca-restock-notify.js.)
// POST { password, num } → e-mail "de nouveau disponible" à tous les inscrits en attente,
// puis notified=true. Protégé par ARCA_ADMIN_PASSWORD (mot de passe dans le corps, comparé
// en temps constant) — le front admin réassort envoie le password dans le body.

import { json, preflight } from "../_shared/cors.ts";
import { timingSafeEqual } from "../_shared/auth.ts";
import { arcaEnv } from "../_shared/env.ts";
import { supaEnv } from "../_shared/supa.ts";
import { arcaTitle, arcaShort, wrapHtml, fromEmail, sendBrevo } from "../_shared/arca-mail.ts";

Deno.serve(async (req) => {
  const pre = preflight(req);
  if (pre) return pre;
  if (req.method !== "POST") return json(405, { error: "Method Not Allowed" });

  let body: any;
  try { body = await req.json(); } catch { return json(400, { error: "JSON invalide" }); }

  const secret = arcaEnv("ADMIN_PASSWORD");
  if (!secret || !timingSafeEqual(String(body.password || ""), secret)) {
    return json(401, { error: "Mot de passe incorrect" });
  }
  const num = parseInt(body.num, 10);
  if (!(num >= 1 && num <= 9)) return json(400, { error: "Numéro invalide" });

  const { url: supaUrl, key: supaKey } = supaEnv();
  if (!supaUrl || !supaKey) return json(500, { error: "Config Supabase manquante" });
  const h = { apikey: supaKey, Authorization: "Bearer " + supaKey, "Accept-Profile": "public" };

  let pending: any = [];
  try {
    const r = await fetch(supaUrl + "/rest/v1/arca_restock_alerts?select=email&num=eq." + num + "&notified=eq.false", { headers: h });
    pending = await r.json();
  } catch (e) {
    return json(502, { error: "Lecture inscrits échouée : " + ((e as Error).message || String(e)) });
  }
  const emails = (pending || []).map((p: any) => p.email).filter(Boolean);
  if (!emails.length) return json(200, { sent: 0, total: 0 });

  const orderUrl = arcaEnv("ORDER_PAGE_URL") || "https://arca-revue.com/arca-revue/";
  const subject = arcaShort(num) + " est de nouveau disponible !";
  const htmlContent = wrapHtml(
    "<p>Bonne nouvelle !</p>"
    + "<p><strong>" + arcaTitle(num).replace(/^la |^le /, "La ") + "</strong> que vous attendiez est de nouveau en stock.</p>"
    + "<p style=\"text-align:center;margin:24px 0\">"
      + "<a href=\"" + orderUrl + "\" style=\"background:#23264a;color:#c8a060;text-decoration:none;font:bold 14px Arial;letter-spacing:1px;padding:13px 26px;border-radius:5px;display:inline-block\">Commander maintenant</a>"
    + "</p>"
    + "<p style=\"color:#777;font-size:13px\">Les stocks sont limités — n'attendez pas trop si vous le souhaitez.</p>"
    + "<p>À bientôt,<br>L'équipe ARCA</p>",
  );
  const textContent = arcaShort(num) + " est de nouveau disponible ! Commandez ici : " + orderUrl + "\n\nL'équipe ARCA";

  const results = await Promise.allSettled(emails.map((e: string) => sendBrevo({
    sender: { name: "ARCA Revue & Librairie", email: fromEmail() },
    to: [{ email: e }],
    replyTo: { email: "antoine@arca-librairie.com", name: "ARCA" },
    subject, htmlContent, textContent,
  })));
  const sent = results.filter((r) => r.status === "fulfilled").length;
  const failed = results.length - sent;

  try {
    await fetch(supaUrl + "/rest/v1/arca_restock_alerts?num=eq." + num + "&notified=eq.false", {
      method: "PATCH",
      headers: { ...h, "Content-Type": "application/json", "Content-Profile": "public", Prefer: "return=minimal" },
      body: JSON.stringify({ notified: true, notified_at: new Date().toISOString() }),
    });
  } catch (e) {
    console.error("[restock-notify] PATCH notified échec:", (e as Error).message);
  }

  return json(200, { sent, failed, total: emails.length });
});
