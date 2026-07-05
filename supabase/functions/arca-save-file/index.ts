// Edge Function — sauvegarde de fichiers JSON via l'API GitHub (ADMIN).
// (Portée depuis netlify/functions/save-file.js.) Contents API (<1MB) ou Git Data API (gros).
// POST { password, filename, data } → commit dans le repo → redeploy auto (Infomaniak/GitHub Actions).

import { json, preflight } from "../_shared/cors.ts";
import { timingSafeEqual } from "../_shared/auth.ts";
import { arcaEnv } from "../_shared/env.ts";

// base64 UTF-8 sûr pour gros contenu (évite l'overflow de String.fromCharCode(...big)).
function toBase64Utf8(str: string): string {
  const bytes = new TextEncoder().encode(str);
  let bin = "";
  const chunk = 0x8000;
  for (let i = 0; i < bytes.length; i += chunk) bin += String.fromCharCode(...bytes.subarray(i, i + chunk));
  return btoa(bin);
}

Deno.serve(async (req) => {
  const pre = preflight(req);
  if (pre) return pre;
  if (req.method !== "POST") return json(405, { error: "Method Not Allowed" });

  let body: any;
  try { body = await req.json(); } catch { return json(400, { error: "JSON invalide" }); }
  const { password, filename, data } = body;

  const secret = arcaEnv("ADMIN_PASSWORD");
  if (!secret || !timingSafeEqual(String(password || ""), secret)) return json(401, { error: "Mot de passe incorrect" });

  const allowed = ["episodes.json", "config.json", "documents.json", "docs-images.json", "glossaire.json"];
  if (!allowed.includes(filename)) return json(403, { error: "Fichier non autorisé" });

  const owner = arcaEnv("GITHUB_OWNER") || "gregoire-jpg";
  const repo = arcaEnv("GITHUB_REPO") || "podcast-arca";
  const token = arcaEnv("GITHUB_TOKEN");
  const branch = "main";
  const headers = {
    Authorization: `token ${token}`, Accept: "application/vnd.github.v3+json",
    "Content-Type": "application/json", "User-Agent": "podcast-arca-admin",
  };
  const apiBase = `https://api.github.com/repos/${owner}/${repo}`;
  const content = JSON.stringify(data, null, 2);
  const contentB64 = toBase64Utf8(content);

  if (contentB64.length > 900000) return await saveViaGitDataApi(apiBase, headers, filename, contentB64, branch);
  return await saveViaContentsApi(apiBase, headers, filename, contentB64);
});

async function saveViaContentsApi(apiBase: string, headers: any, filename: string, contentB64: string) {
  const apiUrl = `${apiBase}/contents/${filename}`;
  const getJson = await (await fetch(apiUrl, { headers })).json();
  const sha = getJson.sha;
  if (!sha) return json(500, { error: "SHA introuvable" });
  const putRes = await fetch(apiUrl, {
    method: "PUT", headers,
    body: JSON.stringify({
      message: `admin: update ${filename}`, content: contentB64, sha,
      committer: { name: "Admin ARCA", email: "admin@arca-revue.com" },
    }),
  });
  if (putRes.ok) return json(200, { success: true });
  return json(500, { error: (await putRes.json()).message || "Erreur GitHub" });
}

async function saveViaGitDataApi(apiBase: string, headers: any, filename: string, contentB64: string, branch: string) {
  const refJson = await (await fetch(`${apiBase}/git/ref/heads/${branch}`, { headers })).json();
  const latestCommitSha = refJson.object && refJson.object.sha;
  if (!latestCommitSha) return json(500, { error: "Ref introuvable: " + JSON.stringify(refJson) });

  const blobJson = await (await fetch(`${apiBase}/git/blobs`, { method: "POST", headers, body: JSON.stringify({ content: contentB64, encoding: "base64" }) })).json();
  const blobSha = blobJson.sha;
  if (!blobSha) return json(500, { error: "Blob introuvable: " + JSON.stringify(blobJson) });

  const commitJson = await (await fetch(`${apiBase}/git/commits/${latestCommitSha}`, { headers })).json();
  const baseTreeSha = commitJson.tree && commitJson.tree.sha;
  if (!baseTreeSha) return json(500, { error: "Tree introuvable" });

  const treeJson = await (await fetch(`${apiBase}/git/trees`, {
    method: "POST", headers,
    body: JSON.stringify({ base_tree: baseTreeSha, tree: [{ path: filename, mode: "100644", type: "blob", sha: blobSha }] }),
  })).json();
  const newTreeSha = treeJson.sha;
  if (!newTreeSha) return json(500, { error: "Nouveau tree introuvable" });

  const newCommitJson = await (await fetch(`${apiBase}/git/commits`, {
    method: "POST", headers,
    body: JSON.stringify({
      message: `admin: update ${filename}`, tree: newTreeSha, parents: [latestCommitSha],
      author: { name: "Admin ARCA", email: "admin@arca-revue.com", date: new Date().toISOString() },
      committer: { name: "Admin ARCA", email: "admin@arca-revue.com", date: new Date().toISOString() },
    }),
  })).json();
  const newCommitSha = newCommitJson.sha;
  if (!newCommitSha) return json(500, { error: "Commit introuvable" });

  const updateRefRes = await fetch(`${apiBase}/git/refs/heads/${branch}`, {
    method: "PATCH", headers, body: JSON.stringify({ sha: newCommitSha, force: false }),
  });
  if (updateRefRes.ok) return json(200, { success: true });
  return json(500, { error: (await updateRefRes.json()).message || "Erreur mise à jour ref" });
}
