// Netlify Function — sauvegarde episodes.json ou config.json via GitHub API
// Variables d'environnement requises (Netlify dashboard) :
//   ADMIN_PASSWORD, GITHUB_TOKEN, GITHUB_OWNER, GITHUB_REPO

exports.handler = async function (event) {
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

  // Vérification du mot de passe côté serveur
  if (!password || password !== process.env.ADMIN_PASSWORD) {
    return { statusCode: 401, body: JSON.stringify({ error: "Mot de passe incorrect" }) };
  }

  // Seuls ces fichiers sont autorisés
  const allowed = ["episodes.json", "config.json", "documents.json", "docs-images.json"];
  if (!allowed.includes(filename)) {
    return { statusCode: 403, body: JSON.stringify({ error: "Fichier non autorisé" }) };
  }

  const owner  = process.env.GITHUB_OWNER || "gregoire-jpg";
  const repo   = process.env.GITHUB_REPO  || "podcast-arca";
  const token  = process.env.GITHUB_TOKEN;
  const apiUrl = `https://api.github.com/repos/${owner}/${repo}/contents/${filename}`;
  const headers = {
    Authorization: `token ${token}`,
    Accept: "application/vnd.github.v3+json",
    "Content-Type": "application/json",
  };

  // Récupérer le SHA du fichier actuel (requis par l'API GitHub)
  const getRes  = await fetch(apiUrl, { headers });
  const getJson = await getRes.json();
  const sha     = getJson.sha;

  if (!sha) {
    return { statusCode: 500, body: JSON.stringify({ error: "Impossible de récupérer le SHA du fichier" }) };
  }

  // Encoder le contenu en base64
  const content = Buffer.from(JSON.stringify(data, null, 2), "utf8").toString("base64");

  const putRes = await fetch(apiUrl, {
    method: "PUT",
    headers,
    body: JSON.stringify({
      message: `admin: update ${filename}`,
      content,
      sha,
      committer: { name: "Admin ARCA", email: "admin@podcast-arca.netlify.app" },
    }),
  });

  if (putRes.ok) {
    return {
      statusCode: 200,
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ success: true }),
    };
  }

  const err = await putRes.json();
  return { statusCode: 500, body: JSON.stringify({ error: err.message || "Erreur GitHub" }) };
};
