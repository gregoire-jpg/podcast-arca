// Edge Function — incrémente le compteur de téléchargements / écoutes.
// (Portée depuis netlify/functions/track-count.js — comportement identique.)
// POST { type: "download"|"play", id: "doc-id-or-episode-id" }
// Lit et met à jour counts.json sur GitHub.
//
// ⚠ DETTE : écrit dans le repo GitHub à chaque play/download → déclenche un
//    redeploy à chaque appel une fois le front sur Infomaniak. À migrer vers une
//    table Supabase (arca_counts) — voir PLAN_migration_arca_netlify.md.

import { json, preflight } from "../_shared/cors.ts";
import { arcaEnv } from "../_shared/env.ts";

function b64decode(s: string): string {
  return new TextDecoder().decode(Uint8Array.from(atob(s), (c) => c.charCodeAt(0)));
}
function b64encode(s: string): string {
  return btoa(String.fromCharCode(...new TextEncoder().encode(s)));
}

Deno.serve(async (req) => {
  const pre = preflight(req);
  if (pre) return pre;
  if (req.method !== "POST") return json(405, { error: "Method Not Allowed" });

  let body: any;
  try { body = await req.json(); } catch { return json(400, { error: "JSON invalide" }); }

  const { type, id } = body || {};
  if (!type || !id || !["download", "play"].includes(type)) {
    return json(400, { error: "Paramètres invalides" });
  }

  const token = arcaEnv("GITHUB_TOKEN");
  const owner = arcaEnv("GITHUB_OWNER") || "gregoire-jpg";
  const repo = arcaEnv("GITHUB_REPO") || "podcast-arca";
  const path = "counts.json";

  const apiBase = `https://api.github.com/repos/${owner}/${repo}/contents/${path}`;
  const headers = {
    Authorization: `token ${token}`,
    Accept: "application/vnd.github.v3+json",
    "Content-Type": "application/json",
    "User-Agent": "arca-track-count",
  };

  let counts: any = { downloads: {}, plays: {}, totals: { downloads: 0, plays: 0 } };
  let sha: string | null = null;

  try {
    const res = await fetch(apiBase, { headers });
    if (res.ok) {
      const data = await res.json();
      sha = data.sha;
      counts = JSON.parse(b64decode(data.content));
      if (!counts.downloads) counts.downloads = {};
      if (!counts.plays) counts.plays = {};
      if (!counts.totals) counts.totals = { downloads: 0, plays: 0 };
    }
  } catch (_e) { /* fichier n'existe pas encore */ }

  if (type === "download") {
    counts.downloads[id] = (counts.downloads[id] || 0) + 1;
    counts.totals.downloads = (Object.values(counts.downloads) as number[]).reduce((a, b) => a + b, 0);
  } else {
    counts.plays[id] = (counts.plays[id] || 0) + 1;
    counts.totals.plays = (Object.values(counts.plays) as number[]).reduce((a, b) => a + b, 0);
  }

  const content = b64encode(JSON.stringify(counts, null, 2));
  const payload = { message: `count: ${type} ${id}`, content, ...(sha ? { sha } : {}) };

  try {
    await fetch(apiBase, { method: "PUT", headers, body: JSON.stringify(payload) });
  } catch (_e) {
    return json(500, { error: "Erreur GitHub" });
  }

  return json(200, {
    ok: true,
    count: type === "download" ? counts.downloads[id] : counts.plays[id],
    total: type === "download" ? counts.totals.downloads : counts.totals.plays,
  });
});
