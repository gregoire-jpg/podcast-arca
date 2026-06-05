// Netlify Function — proxy Supabase authé par ADMIN_PASSWORD.
// Sert à garder le service_role key côté serveur uniquement.
// Variables d'environnement : ADMIN_PASSWORD, SUPABASE_URL, SUPABASE_SERVICE_KEY

// Whitelist stricte : schéma -> tables/vues autorisées
const ALLOWED = {
  public: new Set(["arca_orders", "arca_stock", "arca_stock_moves", "arca_restock_alerts"]),
  citations: new Set([
    "citations",
    "auteurs",
    "inscrits_email",
    "annonces",
    "votes",
    "v_stats_citations",
    "v_stats_auteurs",
  ]),
};

exports.handler = async function (event) {
  if (event.httpMethod === "OPTIONS") {
    return {
      statusCode: 200,
      headers: {
        "Access-Control-Allow-Origin": "*",
        "Access-Control-Allow-Headers": "Content-Type",
        "Access-Control-Allow-Methods": "POST, OPTIONS",
      },
      body: "",
    };
  }
  if (event.httpMethod !== "POST") {
    return { statusCode: 405, body: JSON.stringify({ error: "Method Not Allowed" }) };
  }

  let req;
  try {
    req = JSON.parse(event.body || "{}");
  } catch {
    return { statusCode: 400, body: JSON.stringify({ error: "JSON invalide" }) };
  }

  const { password, schema, path, method, body, prefer } = req;

  if (!password || password !== process.env.ADMIN_PASSWORD) {
    return { statusCode: 401, body: JSON.stringify({ error: "Mot de passe incorrect" }) };
  }

  const sch = schema || "public";
  if (!ALLOWED[sch]) {
    return { statusCode: 403, body: JSON.stringify({ error: "Schéma non autorisé : " + sch }) };
  }

  if (typeof path !== "string" || !path.startsWith("/")) {
    return { statusCode: 400, body: JSON.stringify({ error: "path invalide" }) };
  }

  // Extrait le nom de la table/vue : "/citations?select=*" -> "citations"
  const tableMatch = path.match(/^\/([A-Za-z0-9_]+)(\?|$)/);
  if (!tableMatch) {
    return { statusCode: 400, body: JSON.stringify({ error: "Table introuvable dans path" }) };
  }
  const table = tableMatch[1];
  if (!ALLOWED[sch].has(table)) {
    return { statusCode: 403, body: JSON.stringify({ error: "Table non autorisée : " + sch + "." + table }) };
  }

  const mth = (method || "GET").toUpperCase();
  if (!["GET", "POST", "PATCH", "DELETE"].includes(mth)) {
    return { statusCode: 400, body: JSON.stringify({ error: "Méthode non supportée" }) };
  }

  const supaUrl = process.env.SUPABASE_URL;
  const supaKey = process.env.SUPABASE_SERVICE_KEY;
  if (!supaUrl || !supaKey) {
    return { statusCode: 500, body: JSON.stringify({ error: "Config Supabase manquante" }) };
  }

  const headers = {
    apikey: supaKey,
    Authorization: "Bearer " + supaKey,
    "Content-Type": "application/json",
    "Accept-Profile": sch,
    "Content-Profile": sch,
  };
  if (prefer) headers["Prefer"] = String(prefer);

  const init = { method: mth, headers };
  if (body !== undefined && body !== null && mth !== "GET") {
    init.body = typeof body === "string" ? body : JSON.stringify(body);
  }

  let resp;
  try {
    resp = await fetch(supaUrl + "/rest/v1" + path, init);
  } catch (e) {
    return { statusCode: 502, body: JSON.stringify({ error: "Fetch Supabase échoué : " + e.message }) };
  }

  const text = await resp.text();
  const responseHeaders = { "Content-Type": "application/json" };
  // Propage Content-Range (utilisé par Prefer: count=exact)
  const cr = resp.headers.get("content-range");
  if (cr) responseHeaders["Content-Range"] = cr;

  return {
    statusCode: resp.status,
    headers: responseHeaders,
    body: text || "{}",
  };
};
