// Edge Function — reçoit un PDF base64, l'uploade sur Dropbox, retourne l'URL directe (ADMIN).
// (Portée depuis netlify/functions/upload-doc.js.) POST { password, filename, content, remotePath }.
// ⚠ Nécessite ARCA_DROPBOX_* (à poser — absents de Netlify).

import { json, preflight } from "../_shared/cors.ts";
import { timingSafeEqual } from "../_shared/auth.ts";
import { arcaEnv } from "../_shared/env.ts";

async function getAccessToken(): Promise<string> {
  const res = await fetch("https://api.dropboxapi.com/oauth2/token", {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: ["grant_type=refresh_token", "refresh_token=" + encodeURIComponent(arcaEnv("DROPBOX_REFRESH_TOKEN")), "client_id=" + encodeURIComponent(arcaEnv("DROPBOX_APP_KEY")), "client_secret=" + encodeURIComponent(arcaEnv("DROPBOX_APP_SECRET"))].join("&"),
  });
  const data = await res.json();
  if (!data.access_token) throw new Error("Token refresh failed: " + JSON.stringify(data));
  return data.access_token;
}

async function uploadToDropbox(token: string, remotePath: string, buffer: Uint8Array): Promise<string> {
  const uploadRes = await fetch("https://content.dropboxapi.com/2/files/upload", {
    method: "POST",
    headers: { "Authorization": "Bearer " + token, "Dropbox-API-Arg": JSON.stringify({ path: remotePath, mode: "overwrite", autorename: false }), "Content-Type": "application/octet-stream" },
    body: buffer,
  });
  if (!uploadRes.ok) throw new Error("Upload failed: " + await uploadRes.text());

  const linkRes = await fetch("https://api.dropboxapi.com/2/sharing/create_shared_link_with_settings", {
    method: "POST",
    headers: { "Authorization": "Bearer " + token, "Content-Type": "application/json" },
    body: JSON.stringify({ path: remotePath, settings: { requested_visibility: "public" } }),
  });
  const linkData = await linkRes.json();
  let url = linkData.url || "";
  if (!url && linkData.error && linkData.error[".tag"] === "shared_link_already_exists") {
    const listData = await (await fetch("https://api.dropboxapi.com/2/sharing/list_shared_links", {
      method: "POST", headers: { "Authorization": "Bearer " + token, "Content-Type": "application/json" }, body: JSON.stringify({ path: remotePath }),
    })).json();
    url = ((listData.links || [])[0] || {}).url || "";
  }
  if (!url) throw new Error("Impossible d'obtenir le lien de partage");
  return url.replace("www.dropbox.com", "dl.dropboxusercontent.com").replace("?dl=0", "");
}

Deno.serve(async (req) => {
  const pre = preflight(req);
  if (pre) return pre;
  if (req.method !== "POST") return json(405, { error: "Method Not Allowed" });

  let body: any;
  try { body = await req.json(); } catch { return json(400, { error: "JSON invalide" }); }
  const { password, filename, content, remotePath } = body;

  const secret = arcaEnv("ADMIN_PASSWORD");
  if (!secret || !timingSafeEqual(String(password || ""), secret)) return json(401, { error: "Mot de passe incorrect" });
  if (!filename || !content || !remotePath) return json(400, { error: "filename, content et remotePath sont requis" });

  const estimatedSize = Math.round(content.length * 0.75);
  if (estimatedSize > 5 * 1024 * 1024) return json(413, { error: "Fichier trop volumineux (max ~5 MB). Uploadez-le directement sur Dropbox et collez l'URL." });
  if (!arcaEnv("DROPBOX_REFRESH_TOKEN")) return json(500, { error: "Dropbox env vars manquants" });

  try {
    const token = await getAccessToken();
    const buffer = Uint8Array.from(atob(content), (c) => c.charCodeAt(0));
    const url = await uploadToDropbox(token, remotePath, buffer);
    return json(200, { success: true, dropbox_url: url });
  } catch (err) {
    return json(500, { error: (err as Error).message });
  }
});
