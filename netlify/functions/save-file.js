// Netlify Function — sauvegarde des fichiers via GitHub API
// Utilise la Git Data API pour les gros fichiers (glossaire.json > 1MB)
// Variables d'environnement : ADMIN_PASSWORD, GITHUB_TOKEN, GITHUB_OWNER, GITHUB_REPO

exports.handler = async function (event) {
  if (event.httpMethod === "OPTIONS") {
    return {
      statusCode: 200,
      headers: {
        "Access-Control-Allow-Origin":  "*",
        "Access-Control-Allow-Headers": "Content-Type",
        "Access-Control-Allow-Methods": "POST, OPTIONS",
      },
      body: "",
    };
  }

  if (event.httpMethod !== "POST") {
    return { statusCode: 405, body: "Method Not Allowed" };
  }

  let body;
  try {
    body = JSON.parse(event.body);
  } catch {
    return { statusCode: 400, body: JSON.stringify({ error: "JSON invalide" }) };
  }

  const { password, filename, data } = body;

  if (!password || password !== process.env.ADMIN_PASSWORD) {
    return { statusCode: 401, body: JSON.stringify({ error: "Mot de passe incorrect" }) };
  }

  const allowed = ["episodes.json", "config.json", "documents.json", "docs-images.json", "glossaire.json"];
  if (!allowed.includes(filename)) {
    return { statusCode: 403, body: JSON.stringify({ error: "Fichier non autorisé" }) };
  }

  const owner   = process.env.GITHUB_OWNER || "gregoire-jpg";
  const repo    = process.env.GITHUB_REPO  || "podcast-arca";
  const token   = process.env.GITHUB_TOKEN;
  const branch  = "main";
  const headers = {
    Authorization: `token ${token}`,
    Accept:        "application/vnd.github.v3+json",
    "Content-Type": "application/json",
    "User-Agent":  "podcast-arca-admin",
  };
  const apiBase  = `https://api.github.com/repos/${owner}/${repo}`;
  const content  = JSON.stringify(data, null, 2);
  const contentB64 = Buffer.from(content, "utf8").toString("base64");

  // Si le contenu fait > 900KB (base64 ~1.2MB), utiliser la Git Data API
  if (contentB64.length > 900000) {
    return await saveViaGitDataApi(apiBase, headers, filename, content, contentB64, branch);
  } else {
    return await saveViaContentsApi(apiBase, headers, filename, contentB64);
  }
};

// ── API simple (fichiers < 1MB) ──────────────────────────────────────────────
async function saveViaContentsApi(apiBase, headers, filename, contentB64) {
  const apiUrl = `${apiBase}/contents/${filename}`;
  const getRes = await fetch(apiUrl, { headers });
  const getJson = await getRes.json();
  const sha = getJson.sha;
  if (!sha) {
    return { statusCode: 500, body: JSON.stringify({ error: "SHA introuvable" }) };
  }
  const putRes = await fetch(apiUrl, {
    method: "PUT",
    headers,
    body: JSON.stringify({
      message: `admin: update ${filename}`,
      content: contentB64,
      sha,
      committer: { name: "Admin ARCA", email: "admin@podcast-arca.netlify.app" },
    }),
  });
  if (putRes.ok) {
    return { statusCode: 200, headers: { "Content-Type": "application/json" }, body: JSON.stringify({ success: true }) };
  }
  const err = await putRes.json();
  return { statusCode: 500, body: JSON.stringify({ error: err.message || "Erreur GitHub" }) };
}

// ── Git Data API (fichiers > 1MB) ─────────────────────────────────────────────
async function saveViaGitDataApi(apiBase, headers, filename, content, contentB64, branch) {
  // 1. Récupérer le SHA du dernier commit sur main
  const refRes  = await fetch(`${apiBase}/git/ref/heads/${branch}`, { headers });
  const refJson = await refRes.json();
  const latestCommitSha = refJson.object && refJson.object.sha;
  if (!latestCommitSha) {
    return { statusCode: 500, body: JSON.stringify({ error: "Ref introuvable: " + JSON.stringify(refJson) }) };
  }

  // 2. Créer un blob avec le nouveau contenu
  const blobRes  = await fetch(`${apiBase}/git/blobs`, {
    method: "POST",
    headers,
    body: JSON.stringify({ content: contentB64, encoding: "base64" }),
  });
  const blobJson = await blobRes.json();
  const blobSha  = blobJson.sha;
  if (!blobSha) {
    return { statusCode: 500, body: JSON.stringify({ error: "Blob introuvable: " + JSON.stringify(blobJson) }) };
  }

  // 3. Récupérer le tree du dernier commit
  const commitRes  = await fetch(`${apiBase}/git/commits/${latestCommitSha}`, { headers });
  const commitJson = await commitRes.json();
  const baseTreeSha = commitJson.tree && commitJson.tree.sha;
  if (!baseTreeSha) {
    return { statusCode: 500, body: JSON.stringify({ error: "Tree introuvable" }) };
  }

  // 4. Créer un nouveau tree avec le fichier mis à jour
  const treeRes  = await fetch(`${apiBase}/git/trees`, {
    method: "POST",
    headers,
    body: JSON.stringify({
      base_tree: baseTreeSha,
      tree: [{ path: filename, mode: "100644", type: "blob", sha: blobSha }],
    }),
  });
  const treeJson = await treeRes.json();
  const newTreeSha = treeJson.sha;
  if (!newTreeSha) {
    return { statusCode: 500, body: JSON.stringify({ error: "Nouveau tree introuvable" }) };
  }

  // 5. Créer un nouveau commit
  const newCommitRes  = await fetch(`${apiBase}/git/commits`, {
    method: "POST",
    headers,
    body: JSON.stringify({
      message: `admin: update ${filename}`,
      tree: newTreeSha,
      parents: [latestCommitSha],
      author:    { name: "Admin ARCA", email: "admin@podcast-arca.netlify.app", date: new Date().toISOString() },
      committer: { name: "Admin ARCA", email: "admin@podcast-arca.netlify.app", date: new Date().toISOString() },
    }),
  });
  const newCommitJson = await newCommitRes.json();
  const newCommitSha  = newCommitJson.sha;
  if (!newCommitSha) {
    return { statusCode: 500, body: JSON.stringify({ error: "Commit introuvable" }) };
  }

  // 6. Mettre à jour la référence de la branche
  const updateRefRes = await fetch(`${apiBase}/git/refs/heads/${branch}`, {
    method: "PATCH",
    headers,
    body: JSON.stringify({ sha: newCommitSha, force: false }),
  });
  if (updateRefRes.ok) {
    return { statusCode: 200, headers: { "Content-Type": "application/json" }, body: JSON.stringify({ success: true }) };
  }
  const err = await updateRefRes.json();
  return { statusCode: 500, body: JSON.stringify({ error: err.message || "Erreur mise à jour ref" }) };
}
