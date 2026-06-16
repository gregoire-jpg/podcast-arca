// Edge Function — proxy Supabase authé par ADMIN_PASSWORD (garde le service_role côté serveur).
// (Portée depuis netlify/functions/db-proxy.js.) POST { password, schema, path, method, body, prefer }.
// Whitelist stricte schéma → tables. Sert l'admin ARCA + le panel Citations du jour.

import { json, preflight } from "../_shared/cors.ts";
import { timingSafeEqual } from "../_shared/auth.ts";
import { arcaEnv } from "../_shared/env.ts";
import { supaEnv } from "../_shared/supa.ts";

const ALLOWED: Record<string, Set<string>> = {
  public: new Set(["arca_orders", "arca_stock", "arca_stock_moves", "arca_restock_alerts"]),
  citations: new Set(["citations", "auteurs", "inscrits_email", "annonces", "votes", "v_stats_citations", "v_stats_auteurs"]),
};

Deno.serve(async (req) => {
  const pre = preflight(req);
  if (pre) return pre;
  if (req.method !== "POST") return json(405, { error: "Method Not Allowed" });

  let r: any;
  try { r = await req.json(); } catch { return json(400, { error: "JSON invalide" }); }
  const { password, schema, path, method, body, prefer } = r;

  const secret = arcaEnv("ADMIN_PASSWORD");
  if (!secret || !timingSafeEqual(String(password || ""), secret)) return json(401, { error: "Mot de passe incorrect" });

  const sch = schema || "public";
  if (!ALLOWED[sch]) return json(403, { error: "Schéma non autorisé : " + sch });
  if (typeof path !== "string" || !path.startsWith("/")) return json(400, { error: "path invalide" });

  const tableMatch = path.match(/^\/([A-Za-z0-9_]+)(\?|$)/);
  if (!tableMatch) return json(400, { error: "Table introuvable dans path" });
  const table = tableMatch[1];
  if (!ALLOWED[sch].has(table)) return json(403, { error: "Table non autorisée : " + sch + "." + table });

  const mth = (method || "GET").toUpperCase();
  if (!["GET", "POST", "PATCH", "DELETE"].includes(mth)) return json(400, { error: "Méthode non supportée" });

  const { url: supaUrl, key: supaKey } = supaEnv();
  if (!supaUrl || !supaKey) return json(500, { error: "Config Supabase manquante" });

  const headers: Record<string, string> = {
    apikey: supaKey, Authorization: "Bearer " + supaKey, "Content-Type": "application/json",
    "Accept-Profile": sch, "Content-Profile": sch,
  };
  if (prefer) headers["Prefer"] = String(prefer);

  const init: RequestInit = { method: mth, headers };
  if (body !== undefined && body !== null && mth !== "GET") init.body = typeof body === "string" ? body : JSON.stringify(body);

  let resp: Response;
  try { resp = await fetch(supaUrl + "/rest/v1" + path, init); }
  catch (e) { return json(502, { error: "Fetch Supabase échoué : " + (e as Error).message }); }

  const text = await resp.text();
  const responseHeaders: Record<string, string> = { "Content-Type": "application/json", "Access-Control-Allow-Origin": "*" };
  const cr = resp.headers.get("content-range");
  if (cr) responseHeaders["Content-Range"] = cr;
  return new Response(text || "{}", { status: resp.status, headers: responseHeaders });
});
