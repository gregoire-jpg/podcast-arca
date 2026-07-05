// Edge Function — compteurs d'écoutes / téléchargements sur table public.arca_counts.
// (v2 : remplace les commits GitHub de counts.json — un commit par écoute déclenchait
//  un redéploiement du site. Données migrées le 2026-07-05, totaux vérifiés.)
//
// POST { type: "download"|"play", id } → incrémente (RPC arca_increment_count) → { ok, count, total }
// GET  → { downloads: {...}, plays: {...}, totals: { downloads, plays } }  (même forme que l'ancien counts.json)

import { json, preflight } from "../_shared/cors.ts";
import { supaEnv, supaHeaders } from "../_shared/supa.ts";

Deno.serve(async (req) => {
  const pre = preflight(req);
  if (pre) return pre;

  const { url, key } = supaEnv();
  if (!url || !key) return json(500, { error: "Config Supabase manquante" });
  const h = supaHeaders(key);

  if (req.method === "GET") {
    const r = await fetch(url + "/rest/v1/arca_counts?select=type,item_id,count", { headers: h });
    if (!r.ok) return json(502, { error: "Lecture compteurs échouée" });
    const rows = await r.json();
    const out: any = { downloads: {}, plays: {}, totals: { downloads: 0, plays: 0 } };
    for (const row of rows) {
      const bucket = row.type === "download" ? "downloads" : "plays";
      out[bucket][row.item_id] = row.count;
      out.totals[bucket] += row.count;
    }
    return json(200, out, 60); // cache court : les embeds la chargent à chaque affichage
  }

  if (req.method !== "POST") return json(405, { error: "Method Not Allowed" });

  let body: any;
  try { body = await req.json(); } catch { return json(400, { error: "JSON invalide" }); }
  const { type, id } = body || {};
  if (!type || !id || !["download", "play"].includes(type)) return json(400, { error: "Paramètres invalides" });

  const rpc = await fetch(url + "/rest/v1/rpc/arca_increment_count", {
    method: "POST",
    headers: { ...h, "Content-Type": "application/json" },
    body: JSON.stringify({ p_type: type, p_id: String(id).slice(0, 200) }),
  });
  if (!rpc.ok) return json(502, { error: "Incrément échoué : " + (await rpc.text()).slice(0, 150) });
  const count = await rpc.json();

  const tot = await fetch(url + `/rest/v1/arca_counts?select=count&type=eq.${type}`, { headers: h });
  const total = tot.ok ? (await tot.json()).reduce((s: number, r: any) => s + r.count, 0) : null;

  return json(200, { ok: true, count, total });
});
