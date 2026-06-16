// Edge Function — upload d'un fichier vers Supabase Storage via service_role (ADMIN).
// (Portée depuis netlify/functions/storage-upload.js.)
// POST { password, bucket, path, contentType, dataBase64 } → { success, url }.

import { json, preflight } from "../_shared/cors.ts";
import { timingSafeEqual } from "../_shared/auth.ts";
import { arcaEnv } from "../_shared/env.ts";
import { supaEnv } from "../_shared/supa.ts";

const ALLOWED_BUCKETS = new Set(["pensees-images"]);

Deno.serve(async (req) => {
  const pre = preflight(req);
  if (pre) return pre;
  if (req.method !== "POST") return json(405, { error: "Method Not Allowed" });

  let r: any;
  try { r = await req.json(); } catch { return json(400, { error: "JSON invalide" }); }
  const { password, bucket, path, contentType, dataBase64 } = r;

  const secret = arcaEnv("ADMIN_PASSWORD");
  if (!secret || !timingSafeEqual(String(password || ""), secret)) return json(401, { error: "Mot de passe incorrect" });
  if (!bucket || !ALLOWED_BUCKETS.has(bucket)) return json(403, { error: "Bucket non autorisé : " + bucket });
  if (typeof path !== "string" || path.length === 0 || path.includes("..")) return json(400, { error: "path invalide" });
  if (!dataBase64 || typeof dataBase64 !== "string") return json(400, { error: "dataBase64 manquant" });

  const { url: supaUrl, key: supaKey } = supaEnv();
  if (!supaUrl || !supaKey) return json(500, { error: "Config Supabase manquante" });

  let buf: Uint8Array;
  try { buf = Uint8Array.from(atob(dataBase64), (c) => c.charCodeAt(0)); }
  catch { return json(400, { error: "dataBase64 invalide" }); }

  let resp: Response;
  try {
    resp = await fetch(`${supaUrl}/storage/v1/object/${bucket}/${path}`, {
      method: "POST",
      headers: {
        apikey: supaKey, Authorization: "Bearer " + supaKey,
        "Content-Type": contentType || "application/octet-stream", "x-upsert": "true",
      },
      body: buf,
    });
  } catch (e) { return json(502, { error: "Upload échoué : " + (e as Error).message }); }

  if (!resp.ok) return json(resp.status, { error: await resp.text() });
  return json(200, { success: true, url: `${supaUrl}/storage/v1/object/public/${bucket}/${path}` });
});
