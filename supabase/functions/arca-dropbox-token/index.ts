// Edge Function — émet un access_token Dropbox court (4h) pour upload direct navigateur (ADMIN).
// (Portée depuis netlify/functions/dropbox-token.js.) POST { password } → { access_token, expires_in }.
// ⚠ Nécessite ARCA_DROPBOX_REFRESH_TOKEN / APP_KEY / APP_SECRET (à poser — absents de Netlify).

import { json, preflight } from "../_shared/cors.ts";
import { timingSafeEqual } from "../_shared/auth.ts";
import { arcaEnv } from "../_shared/env.ts";

Deno.serve(async (req) => {
  const pre = preflight(req);
  if (pre) return pre;
  if (req.method !== "POST") return json(405, { error: "Method Not Allowed" });

  let body: any;
  try { body = await req.json(); } catch { return json(400, { error: "JSON invalide" }); }

  const secret = arcaEnv("ADMIN_PASSWORD");
  if (!secret || !timingSafeEqual(String(body.password || ""), secret)) return json(401, { error: "Mot de passe incorrect" });

  const refresh = arcaEnv("DROPBOX_REFRESH_TOKEN");
  const key = arcaEnv("DROPBOX_APP_KEY");
  const secretApp = arcaEnv("DROPBOX_APP_SECRET");
  if (!refresh || !key || !secretApp) return json(500, { error: "Dropbox env vars manquants (REFRESH_TOKEN / APP_KEY / APP_SECRET)" });

  try {
    const r = await fetch("https://api.dropboxapi.com/oauth2/token", {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body: ["grant_type=refresh_token", "refresh_token=" + encodeURIComponent(refresh), "client_id=" + encodeURIComponent(key), "client_secret=" + encodeURIComponent(secretApp)].join("&"),
    });
    const data = await r.json();
    if (!data.access_token) return json(502, { error: "Dropbox refresh failed: " + JSON.stringify(data).substring(0, 300) });
    return json(200, { access_token: data.access_token, expires_in: data.expires_in || 14400 });
  } catch (e) {
    return json(500, { error: "Erreur: " + (e as Error).message });
  }
});
