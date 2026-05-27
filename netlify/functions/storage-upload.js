// Netlify Function — upload d'un fichier vers Supabase Storage via service_role.
// Reçoit { password, bucket, path, contentType, dataBase64 } et retourne l'URL publique.
// Variables d'environnement : ADMIN_PASSWORD, SUPABASE_URL, SUPABASE_SERVICE_KEY

const ALLOWED_BUCKETS = new Set(["pensees-images"]);

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

  const { password, bucket, path, contentType, dataBase64 } = req;

  if (!password || password !== process.env.ADMIN_PASSWORD) {
    return { statusCode: 401, body: JSON.stringify({ error: "Mot de passe incorrect" }) };
  }
  if (!bucket || !ALLOWED_BUCKETS.has(bucket)) {
    return { statusCode: 403, body: JSON.stringify({ error: "Bucket non autorisé : " + bucket }) };
  }
  if (typeof path !== "string" || path.length === 0 || path.includes("..")) {
    return { statusCode: 400, body: JSON.stringify({ error: "path invalide" }) };
  }
  if (!dataBase64 || typeof dataBase64 !== "string") {
    return { statusCode: 400, body: JSON.stringify({ error: "dataBase64 manquant" }) };
  }

  const supaUrl = process.env.SUPABASE_URL;
  const supaKey = process.env.SUPABASE_SERVICE_KEY;
  if (!supaUrl || !supaKey) {
    return { statusCode: 500, body: JSON.stringify({ error: "Config Supabase manquante" }) };
  }

  let buf;
  try {
    buf = Buffer.from(dataBase64, "base64");
  } catch {
    return { statusCode: 400, body: JSON.stringify({ error: "dataBase64 invalide" }) };
  }

  let resp;
  try {
    resp = await fetch(`${supaUrl}/storage/v1/object/${bucket}/${path}`, {
      method: "POST",
      headers: {
        apikey: supaKey,
        Authorization: "Bearer " + supaKey,
        "Content-Type": contentType || "application/octet-stream",
        "x-upsert": "true",
      },
      body: buf,
    });
  } catch (e) {
    return { statusCode: 502, body: JSON.stringify({ error: "Upload échoué : " + e.message }) };
  }

  if (!resp.ok) {
    const txt = await resp.text();
    return { statusCode: resp.status, body: JSON.stringify({ error: txt }) };
  }

  const publicUrl = `${supaUrl}/storage/v1/object/public/${bucket}/${path}`;
  return {
    statusCode: 200,
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ success: true, url: publicUrl }),
  };
};
