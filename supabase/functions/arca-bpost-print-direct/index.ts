// Edge Function — récupère le PDF étiquette Bpost et le retourne directement (ADMIN).
// (Portée depuis netlify/functions/bpost-print-direct.js.) Appelé via <form POST target=_blank>
// avec password en hidden input. Anti-double-facturation : cache PDF en BDD (sert sans rappeler Bpost).

import { timingSafeEqual } from "../_shared/auth.ts";
import { arcaEnv } from "../_shared/env.ts";
import { supaEnv } from "../_shared/supa.ts";
import * as bp from "../_shared/bpost.ts";

function b64FromBytes(bytes: Uint8Array): string {
  let bin = "";
  const chunk = 0x8000;
  for (let i = 0; i < bytes.length; i += chunk) bin += String.fromCharCode(...bytes.subarray(i, i + chunk));
  return btoa(bin);
}
function bytesFromB64(b64: string): Uint8Array { return Uint8Array.from(atob(b64), (c) => c.charCodeAt(0)); }
function esc(s: any) { return String(s).replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;").replace(/'/g, "&#39;"); }

function htmlError(status: number, msg: string): Response {
  const body = '<!DOCTYPE html><html><head><title>Erreur Bpost</title><meta charset="utf-8"></head>'
    + '<body style="font:14px Arial;padding:2em;color:#333"><h2 style="color:#c00">Erreur Bpost</h2><p>' + esc(msg) + "</p></body></html>";
  return new Response(body, { status, headers: { "Content-Type": "text/html; charset=utf-8", "Cache-Control": "no-store" } });
}
function pdfResponse(bytes: Uint8Array, ref: string): Response {
  return new Response(bytes, {
    status: 200,
    headers: { "Content-Type": "application/pdf", "Content-Disposition": 'inline; filename="' + ref + '.pdf"', "Cache-Control": "private, no-store, max-age=0" },
  });
}

function extractErrors(resp: any) {
  const errs: string[] = [];
  const shipments = Array.isArray(resp && resp.Shipment) ? resp.Shipment : [];
  shipments.forEach((s: any) => {
    if (Array.isArray(s.ErrorList)) s.ErrorList.forEach((e: any) => errs.push((e.Tekst || e.Info || "erreur").trim()));
    if (s && s.Error && s.Error.Id && s.Error.Id !== 0) errs.push((s.Error.Info || ("Error " + s.Error.Id)).trim());
  });
  if (resp && resp.Error && resp.Error.Id && resp.Error.Id !== 0) errs.push((resp.Error.Info || ("Error " + resp.Error.Id)).trim());
  return errs;
}

async function loadCachedPdf(ref: string) {
  const { url, key } = supaEnv();
  if (!url || !key) return null;
  const r = await fetch(url + "/rest/v1/arca_orders?bpost_reference=eq." + encodeURIComponent(ref) + "&select=bpost_label_pdf_b64,bpost_label_fetched_at", {
    headers: { apikey: key, Authorization: "Bearer " + key },
  });
  if (!r.ok) return null;
  const rows = await r.json();
  if (rows && rows[0] && rows[0].bpost_label_pdf_b64) return { b64: rows[0].bpost_label_pdf_b64 };
  return null;
}
async function saveCachedPdf(ref: string, bytes: Uint8Array) {
  const { url, key } = supaEnv();
  if (!url || !key) return;
  await fetch(url + "/rest/v1/arca_orders?bpost_reference=eq." + encodeURIComponent(ref), {
    method: "PATCH",
    headers: { apikey: key, Authorization: "Bearer " + key, "Content-Type": "application/json" },
    body: JSON.stringify({ bpost_label_pdf_b64: b64FromBytes(bytes), bpost_label_fetched_at: new Date().toISOString(), bpost_status: "PRINTED" }),
  });
}

async function parseBody(req: Request): Promise<any> {
  const ctype = (req.headers.get("content-type") || "").toLowerCase();
  const raw = await req.text();
  if (ctype.includes("application/json")) { try { return JSON.parse(raw); } catch { return {}; } }
  const params: any = {};
  raw.split("&").forEach((pair) => {
    const [k, v] = pair.split("=");
    if (k) params[decodeURIComponent(k.replace(/\+/g, " "))] = decodeURIComponent((v || "").replace(/\+/g, " "));
  });
  return params;
}

Deno.serve(async (req) => {
  if (req.method !== "POST") return htmlError(405, "Method Not Allowed");

  const body = await parseBody(req);
  const secret = arcaEnv("ADMIN_PASSWORD");
  if (!secret || !timingSafeEqual(String(body.password || ""), secret)) return htmlError(401, "Mot de passe incorrect.");
  const ref = body.ref;
  if (!ref || !/^ARCA-\d+(-r\d+|-[0-9a-f]{4,16})?$/.test(ref)) return htmlError(400, "Référence invalide : " + ref);

  try {
    const cached = await loadCachedPdf(ref);
    if (cached && cached.b64) {
      console.log("[Bpost print] cache HIT pour " + ref);
      return pdfResponse(bytesFromB64(cached.b64), ref);
    }
    console.log("[Bpost print] cache MISS pour " + ref);

    const shopUrl = arcaEnv("BPOST_SHOP_URL") || (arcaEnv("FUNCTIONS_BASE") + "/arca-bpost-callback");
    const token = await bp.getValidToken(shopUrl);

    let resp: any = await bp.bpostCall("POST", "/v3/labels/", { ClientReferenceCodeList: [ref], LabelStart: 1, LabelType: 0 }, token);
    if (resp && resp.__binary) {
      try { await saveCachedPdf(ref, resp.buffer); } catch (e) { console.warn("[cache] save KO:", (e as Error).message); }
      return pdfResponse(resp.buffer, ref);
    }

    const cbUrl = resp && (resp.CallbackURL || resp.CallbackUrl);
    if (cbUrl) {
      for (let i = 0; i < 5; i++) {
        await new Promise((r) => setTimeout(r, 1300));
        let poll: any;
        try { poll = await bp.bpostCall("GET", new URL(cbUrl).pathname, null, token); } catch { continue; }
        if (poll && poll.__binary) { try { await saveCachedPdf(ref, poll.buffer); } catch { /* */ } return pdfResponse(poll.buffer, ref); }
        const errs = extractErrors(poll);
        if (errs.length > 0 && !errs.every((e) => /work in progress|in progress|generating/i.test(e))) return htmlError(500, "Erreur Bpost : " + errs.join(" · "));
        if (poll && poll.Finished === 100) {
          if (poll.LabelPDF) { const bytes = bytesFromB64(poll.LabelPDF); try { await saveCachedPdf(ref, bytes); } catch { /* */ } return pdfResponse(bytes, ref); }
          if (poll.LabelUrl) return new Response("", { status: 302, headers: { Location: poll.LabelUrl } });
        }
      }
      return htmlError(202, "PDF pas encore prêt côté Bpost. Réessaie dans 30 secondes.");
    }
    return htmlError(500, "Réponse Bpost inattendue : " + JSON.stringify(resp).substring(0, 200));
  } catch (e) {
    return htmlError(500, "Erreur : " + (e as Error).message);
  }
});
