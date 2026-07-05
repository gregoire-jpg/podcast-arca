// Edge Function — admin du site ina-illustrations (remplace Decap CMS + Netlify Identity/git-gateway).
// Proxy authentifié vers l'API GitHub Contents du repo gregoire-jpg/ina-illustrations.
// POST { password, op, ... } — fail-closed sur INA_ADMIN_PASSWORD (temps constant).
//   op:"list"   { collection }                    → [{ filename, data }]
//   op:"save"   { collection, filename, data }    → { ok } (create ou update)
//   op:"delete" { collection, filename }          → { ok }
//   op:"upload" { filename, contentBase64 }       → { ok, path } (image → images/uploads/)
// Les commits déclenchent le rebuild du site (workflow Pages / build Netlify).

const OWNER = "gregoire-jpg";
const REPO = "ina-illustrations";
const BRANCH = "main";
const COLLECTIONS = new Set(["galerie", "boutique"]);
const SAFE_NAME = /^[a-zA-Z0-9._à-ÿÀ-Ÿ' -]{1,120}\.(json|jpg|jpeg|png|gif|webp)$/;

const CORS = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
  "Access-Control-Allow-Headers": "content-type",
};
function json(status: number, body: unknown) {
  return new Response(JSON.stringify(body), { status, headers: { ...CORS, "Content-Type": "application/json" } });
}
function timingSafeEqual(a: string, b: string): boolean {
  const ab = new TextEncoder().encode(a), bb = new TextEncoder().encode(b);
  if (ab.length !== bb.length) return false;
  let d = 0;
  for (let i = 0; i < ab.length; i++) d |= ab[i] ^ bb[i];
  return d === 0;
}
function ghHeaders() {
  return {
    Authorization: `token ${Deno.env.get("INA_GITHUB_TOKEN") ?? ""}`,
    Accept: "application/vnd.github.v3+json",
    "Content-Type": "application/json",
    "User-Agent": "ina-admin",
  };
}
function b64utf8(s: string): string {
  const bytes = new TextEncoder().encode(s);
  let bin = "";
  for (let i = 0; i < bytes.length; i += 0x8000) bin += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
  return btoa(bin);
}
async function getSha(path: string): Promise<string | null> {
  const r = await fetch(`https://api.github.com/repos/${OWNER}/${REPO}/contents/${encodeURIComponent(path).replace(/%2F/g, "/")}?ref=${BRANCH}`, { headers: ghHeaders() });
  if (!r.ok) return null;
  return (await r.json()).sha ?? null;
}
async function putFile(path: string, contentB64: string, message: string) {
  const sha = await getSha(path);
  const body: any = { message, content: contentB64, branch: BRANCH, committer: { name: "Admin Ina", email: "contact@ina-illustrations.be" } };
  if (sha) body.sha = sha;
  const r = await fetch(`https://api.github.com/repos/${OWNER}/${REPO}/contents/${encodeURIComponent(path).replace(/%2F/g, "/")}`, {
    method: "PUT", headers: ghHeaders(), body: JSON.stringify(body),
  });
  if (!r.ok) throw new Error("GitHub PUT " + r.status + ": " + ((await r.json()).message || ""));
}

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: CORS });
  if (req.method !== "POST") return json(405, { error: "Method Not Allowed" });

  let b: any;
  try { b = await req.json(); } catch { return json(400, { error: "JSON invalide" }); }

  const secret = Deno.env.get("INA_ADMIN_PASSWORD") ?? "";
  if (!secret || !timingSafeEqual(String(b.password || ""), secret)) return json(401, { error: "Mot de passe incorrect" });
  if (!Deno.env.get("INA_GITHUB_TOKEN")) return json(500, { error: "INA_GITHUB_TOKEN manquant" });

  try {
    switch (b.op) {
      case "list": {
        if (!COLLECTIONS.has(b.collection)) return json(400, { error: "Collection inconnue" });
        const r = await fetch(`https://api.github.com/repos/${OWNER}/${REPO}/contents/_data/${b.collection}?ref=${BRANCH}`, { headers: ghHeaders() });
        if (r.status === 404) return json(200, { items: [] });
        if (!r.ok) return json(502, { error: "GitHub list " + r.status });
        const files = (await r.json()).filter((f: any) => f.type === "file" && f.name.endsWith(".json") && f.name !== "index.json");
        const items = await Promise.all(files.map(async (f: any) => {
          const raw = await fetch(f.download_url, { headers: ghHeaders() });
          let data = null;
          try { data = await raw.json(); } catch { /* fichier illisible */ }
          return { filename: f.name, data };
        }));
        return json(200, { items });
      }
      case "save": {
        if (!COLLECTIONS.has(b.collection)) return json(400, { error: "Collection inconnue" });
        if (typeof b.filename !== "string" || !SAFE_NAME.test(b.filename) || !b.filename.endsWith(".json")) return json(400, { error: "Nom de fichier invalide" });
        if (!b.data || typeof b.data !== "object") return json(400, { error: "data manquant" });
        await putFile(`_data/${b.collection}/${b.filename}`, b64utf8(JSON.stringify(b.data, null, 2)), `admin ina: ${b.collection}/${b.filename}`);
        return json(200, { ok: true });
      }
      case "delete": {
        if (!COLLECTIONS.has(b.collection)) return json(400, { error: "Collection inconnue" });
        if (typeof b.filename !== "string" || !SAFE_NAME.test(b.filename)) return json(400, { error: "Nom de fichier invalide" });
        const path = `_data/${b.collection}/${b.filename}`;
        const sha = await getSha(path);
        if (!sha) return json(404, { error: "Fichier introuvable" });
        const r = await fetch(`https://api.github.com/repos/${OWNER}/${REPO}/contents/${path}`, {
          method: "DELETE", headers: ghHeaders(),
          body: JSON.stringify({ message: `admin ina: suppression ${path}`, sha, branch: BRANCH }),
        });
        if (!r.ok) return json(502, { error: "GitHub DELETE " + r.status });
        return json(200, { ok: true });
      }
      case "upload": {
        if (typeof b.filename !== "string" || !SAFE_NAME.test(b.filename) || b.filename.endsWith(".json")) return json(400, { error: "Nom d'image invalide" });
        if (typeof b.contentBase64 !== "string" || !b.contentBase64) return json(400, { error: "contentBase64 manquant" });
        if (b.contentBase64.length > 8 * 1024 * 1024) return json(413, { error: "Image trop lourde (max ~6 Mo)" });
        const path = `images/uploads/${b.filename}`;
        await putFile(path, b.contentBase64, `admin ina: upload ${b.filename}`);
        return json(200, { ok: true, path: "/" + path });
      }
      default:
        return json(400, { error: "op inconnue" });
    }
  } catch (e) {
    return json(500, { error: (e as Error).message });
  }
});
