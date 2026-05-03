// Netlify Function — incrémente le compteur de téléchargements ou d'écoutes
// POST { type: "download"|"play", id: "doc-id-or-episode-id" }
// Lit et met à jour counts.json sur GitHub

exports.handler = async function (event) {
  if (event.httpMethod !== "POST") {
    return { statusCode: 405, body: "Method Not Allowed" };
  }

  let body;
  try { body = JSON.parse(event.body); } catch {
    return { statusCode: 400, body: JSON.stringify({ error: "JSON invalide" }) };
  }

  const { type, id } = body;
  if (!type || !id || !["download","play"].includes(type)) {
    return { statusCode: 400, body: JSON.stringify({ error: "Paramètres invalides" }) };
  }

  const token = process.env.GITHUB_TOKEN;
  const owner = process.env.GITHUB_OWNER || "gregoire-jpg";
  const repo  = process.env.GITHUB_REPO  || "podcast-arca";
  const path  = "counts.json";

  // Lire le fichier actuel
  const apiBase = `https://api.github.com/repos/${owner}/${repo}/contents/${path}`;
  const headers = {
    Authorization: `token ${token}`,
    Accept: "application/vnd.github.v3+json",
    "Content-Type": "application/json",
  };

  let counts = { downloads: {}, plays: {}, totals: { downloads: 0, plays: 0 } };
  let sha = null;

  try {
    const res = await fetch(apiBase, { headers });
    if (res.ok) {
      const data = await res.json();
      sha = data.sha;
      counts = JSON.parse(Buffer.from(data.content, "base64").toString("utf8"));
      if (!counts.downloads) counts.downloads = {};
      if (!counts.plays)     counts.plays = {};
      if (!counts.totals)    counts.totals = { downloads: 0, plays: 0 };
    }
  } catch (e) { /* fichier n'existe pas encore */ }

  // Incrémenter
  if (type === "download") {
    counts.downloads[id] = (counts.downloads[id] || 0) + 1;
    counts.totals.downloads = Object.values(counts.downloads).reduce((a,b)=>a+b,0);
  } else {
    counts.plays[id] = (counts.plays[id] || 0) + 1;
    counts.totals.plays = Object.values(counts.plays).reduce((a,b)=>a+b,0);
  }

  // Sauvegarder
  const content = Buffer.from(JSON.stringify(counts, null, 2)).toString("base64");
  const payload = { message: `count: ${type} ${id}`, content, ...(sha ? { sha } : {}) };

  try {
    await fetch(apiBase, { method: "PUT", headers, body: JSON.stringify(payload) });
  } catch (e) {
    return { statusCode: 500, body: JSON.stringify({ error: "Erreur GitHub" }) };
  }

  return {
    statusCode: 200,
    headers: { "Access-Control-Allow-Origin": "*" },
    body: JSON.stringify({
      ok: true,
      count: type === "download" ? counts.downloads[id] : counts.plays[id],
      total: type === "download" ? counts.totals.downloads : counts.totals.plays,
    }),
  };
};
