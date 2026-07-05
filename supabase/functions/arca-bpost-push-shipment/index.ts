// Edge Function — push une commande vers Bpost (Plug-in API v3). ADMIN (crée une étiquette payante).
// (Portée depuis netlify/functions/bpost-push-shipment.js.) POST { order_id, force? }.

import { json, preflight } from "../_shared/cors.ts";
import { requireAdmin } from "../_shared/auth.ts";
import { arcaEnv } from "../_shared/env.ts";
import * as bp from "../_shared/bpost.ts";

const ISO2: Record<string, string> = {
  "Belgique": "BE", "France": "FR", "Luxembourg": "LU", "Pays-Bas": "NL", "Allemagne": "DE", "Autriche": "AT",
  "Italie": "IT", "Espagne": "ES", "Portugal": "PT", "Royaume-Uni": "GB", "Suisse": "CH", "Canada": "CA",
  "DOM-TOM": "FR", "Autres pays UE": "BE",
};
const WEIGHTS: Record<number, number> = { 1: 600, 2: 600, 3: 735, 4: 565, 5: 506, 6: 600, 7: 532, 8: 600, 9: 350 };
const UE_27 = new Set(["BE", "BG", "CZ", "DK", "DE", "EE", "IE", "GR", "ES", "FR", "HR", "IT", "CY", "LV", "LT", "LU", "HU", "MT", "NL", "AT", "PL", "PT", "RO", "SI", "SK", "FI", "SE"]);

// DOM-TOM → vrai code ISO depuis le code postal (97x/98x). 'FR' générique
// est HORS territoire douanier/fiscal UE mais déclencherait la branche UE
// (pas de douane) → colis bloqué. On résout le code réel pour générer la
// douane comme pour le Canada. Fallback 'FR' si CP inconnu = comportement
// actuel, aucune régression. À valider sur un vrai envoi pour les TOM Pacifique.
const DOM_TOM_CP: Record<string, string> = {
  "971": "GP", "972": "MQ", "973": "GF", "974": "RE",
  "975": "PM", "976": "YT", "977": "BL", "978": "MF",
};
function resolveCountry(order: any) {
  if (order.pays === "DOM-TOM") {
    const cp = String(order.cp || "").replace(/\s/g, "");
    return DOM_TOM_CP[cp.slice(0, 3)] || "FR";
  }
  return ISO2[order.pays] || "BE";
}

function randHex(n: number) {
  const a = new Uint8Array(n);
  crypto.getRandomValues(a);
  return [...a].map((b) => b.toString(16).padStart(2, "0")).join("");
}
function computeWeightG(items: any[]) {
  let g = 0;
  (items || []).forEach((i: any) => { g += (i.qty || 0) * (WEIGHTS[i.num] || 600); });
  return Math.max(g, 100);
}
function buildShipmentItems(items: any[]) {
  return (items || []).map((it: any) => ({
    Count: it.qty || 1, Id: it.num || 0, Name: it.title || ("N°" + it.num), Type: "",
    Value: parseFloat(it.price || 0), Weight: WEIGHTS[it.num] || 600, ArticleNumber: "",
  }));
}
function buildCustoms(order: any) {
  const country = resolveCountry(order);
  if (UE_27.has(country)) return null;
  const totalArticles = (order.items || []).reduce((sum: number, it: any) => sum + (it.qty || 0) * parseFloat(it.price || 0), 0);
  const fallback = parseFloat(order.total_eur || 0) - parseFloat(order.port_eur || 0);
  const value = totalArticles > 0 ? totalArticles : Math.max(fallback, 1);
  return { CustomsType: 3, Description: "Livres / Revue litteraire ARCA".substring(0, 40), Type: "", Value: value.toFixed(2) };
}
function parseStreet(rue: string) {
  if (!rue) return { street: "", number: "" };
  const cleaned = String(rue).trim();
  let m = cleaned.match(/^(.+?)[,\s]+(\d+\s*\w?)$/);
  if (m) return { street: m[1].trim(), number: m[2].replace(/\s+/g, "") };
  m = cleaned.match(/^(\d+\s*\w?)\s+(.+)$/);
  if (m) return { street: m[2].trim(), number: m[1].replace(/\s+/g, "") };
  return { street: cleaned, number: "" };
}
async function loadOrder(orderId: any) {
  const r = await fetch(bp.supaUrl() + "/rest/v1/arca_orders?id=eq." + orderId + "&select=*", {
    headers: { apikey: bp.supaKey(), Authorization: "Bearer " + bp.supaKey() },
  });
  const rows = await r.json();
  if (!rows || !rows[0]) throw new Error("Order " + orderId + " not found");
  return rows[0];
}
async function updateOrder(orderId: any, fields: any) {
  await fetch(bp.supaUrl() + "/rest/v1/arca_orders?id=eq." + orderId, {
    method: "PATCH",
    headers: { apikey: bp.supaKey(), Authorization: "Bearer " + bp.supaKey(), "Content-Type": "application/json" },
    body: JSON.stringify(fields),
  });
}
function buildCref(orderId: any, attempt: number) { return attempt === 0 ? "ARCA-" + orderId : "ARCA-" + orderId + "-" + randHex(4); }

function buildShipment(order: any, attempt: number) {
  const addr = parseStreet(order.rue);
  let houseNumber = "1";
  let numberExt = order.complement || "";
  if (addr.number) {
    const n = parseInt(addr.number, 10);
    if (Number.isFinite(n) && n > 0) {
      houseNumber = String(n);
      const ext = String(addr.number).replace(/^\d+/, "").trim();
      if (ext) numberExt = (numberExt ? numberExt + " " : "") + ext;
    }
  }
  const country = resolveCountry(order);
  const cref = buildCref(order.id, attempt);
  const productId = country === "BE" ? "302" : "303";
  const shopItemId = attempt === 0 ? order.id : parseInt(randHex(4), 16);
  const shipment: any = {
    ShopItemId: shopItemId, ClientReferenceCode: cref,
    Address: {
      CompanyName: "", Name: order.nom || "—",
      Streetname1: addr.street || (order.rue || "").slice(0, 40) || "Adresse", Streetname2: "",
      HouseNumber: houseNumber, NumberExtension: numberExt, PostalCode: order.cp || "",
      City: order.ville || "", State: "", Country: country, Phone: order.telephone || "", Email: order.email || "",
    },
    OptionList: [{ Id: 126, Value: productId }],
    Carrier: { Id: 68 },
    Weight: computeWeightG(order.items),
    ShipmentItems: buildShipmentItems(order.items),
  };
  const customs = buildCustoms(order);
  if (customs) shipment.Customs = customs;
  return shipment;
}
function extractErrors(resp: any) {
  const errs: string[] = [];
  const shipments = Array.isArray(resp && resp.Shipment) ? resp.Shipment : [];
  shipments.forEach((s: any) => {
    if (Array.isArray(s.ErrorList)) s.ErrorList.forEach((e: any) => errs.push((e.Tekst || e.Info || "erreur").trim()));
    if (s && s.Error && s.Error.Id && s.Error.Id !== 0) errs.push((s.Error.Info || ("Error " + s.Error.Id)).trim());
  });
  if (Array.isArray(resp && resp.ErrorList)) resp.ErrorList.forEach((e: any) => errs.push((e.Tekst || e.Info || "erreur").trim()));
  if (resp && resp.Error && resp.Error.Id && resp.Error.Id !== 0) errs.push((resp.Error.Info || ("Error " + resp.Error.Id)).trim());
  return errs;
}
function extractShipmentId(resp: any) {
  if (!resp) return null;
  const arr = Array.isArray(resp.Shipment) ? resp.Shipment : [resp.Shipment].filter(Boolean);
  for (const s of arr) { if (!s) continue; const id = s.ShipmentId || s.Id; if (id && String(id).length > 0) return String(id); }
  return null;
}
async function tryFetchLabel(token: string, cref: string) {
  const payload = { ClientReferenceCodeList: [cref], LabelType: 0, LabelStart: 1 };
  let resp: any;
  try { resp = await bp.bpostCall("POST", "/v3/labels/", payload, token); }
  catch (e) { return { ready: false, errors: ["exception: " + (e as Error).message] }; }
  if (resp && resp.__binary) return { ready: true, mode: "binary" };
  const errs = extractErrors(resp);
  if (errs.length > 0) return { ready: false, errors: errs };
  if (resp && resp.LabelUrl) return { ready: true, mode: "url", labelUrl: resp.LabelUrl };
  const cbUrl = resp && (resp.CallbackURL || resp.CallbackUrl);
  if (!cbUrl) return { ready: false, errors: ["Aucun CallbackURL retourné"] };
  for (let i = 0; i < 6; i++) {
    await new Promise((r) => setTimeout(r, 1300));
    let poll: any;
    try { poll = await bp.bpostCall("GET", new URL(cbUrl).pathname, null, token); } catch { continue; }
    if (poll && poll.__binary) return { ready: true, mode: "binary" };
    const pollErrs = extractErrors(poll);
    if (pollErrs.length > 0 && pollErrs.every((e: string) => /work in progress|in progress|generating/i.test(e))) continue;
    if (pollErrs.length > 0) return { ready: false, errors: pollErrs, ghost: true };
    if (poll && poll.Finished === 100) {
      if (poll.LabelPDF) return { ready: true, mode: "binary" };
      if (poll.LabelUrl) return { ready: true, mode: "url", labelUrl: poll.LabelUrl };
      return { ready: false, errors: ["Finished=100 sans LabelPDF ni LabelUrl"] };
    }
  }
  return { ready: false, pending: true, cbUrl };
}

Deno.serve(async (req) => {
  const pre = preflight(req);
  if (pre) return pre;
  if (req.method !== "POST") return json(405, { error: "Method not allowed" });
  const unauth = requireAdmin(req);
  if (unauth) return unauth;

  try {
    const { order_id, force } = await req.json();
    if (!order_id) return json(400, { error: "order_id manquant" });

    const order = await loadOrder(order_id);
    const fallbackShopUrl = arcaEnv("FUNCTIONS_BASE") + "/arca-bpost-callback";
    const shopUrl = arcaEnv("BPOST_SHOP_URL") || fallbackShopUrl;
    const token = await bp.getValidToken(shopUrl);

    if (order.bpost_reference && !force) {
      const labelRes: any = await tryFetchLabel(token, order.bpost_reference);
      if (labelRes.ready) {
        const storedUrl = labelRes.mode === "binary" ? "bpost-fetch:" + order.bpost_reference : labelRes.labelUrl;
        await updateOrder(order_id, { bpost_label_url: storedUrl });
        return json(200, { ok: true, bpost_reference: order.bpost_reference, bpost_label_url: storedUrl, label_ready: true });
      }
      if (labelRes.ghost) {
        await updateOrder(order_id, { bpost_reference: null, bpost_shipment_id: null, bpost_label_url: null, bpost_status: null, bpost_pushed_at: null });
        return json(422, { ok: false, ghost: true, error: "Shipment fantôme (" + (labelRes.errors || []).join(" · ") + "). BDD nettoyée — réessaie." });
      }
      return json(200, { ok: true, bpost_reference: order.bpost_reference, bpost_label_url: "bpost-fetch:" + order.bpost_reference, pending: true, message: "PDF en cours — réessaie dans 30s." });
    }

    let chosenCref: string | null = null, shipmentId: any = null, shipErrs: string[] = [];
    const maxAttempts = 5;
    for (let attempt = 0; attempt < maxAttempts; attempt++) {
      const shipment = buildShipment(order, attempt);
      const shipResp = await bp.bpostCall("POST", "/v3/shipments/", { Shipment: [shipment] }, token);
      shipErrs = extractErrors(shipResp);
      if (shipErrs.length === 0) {
        shipmentId = extractShipmentId(shipResp);
        chosenCref = shipment.ClientReferenceCode;
        if (!shipmentId) shipmentId = chosenCref;
        break;
      }
      if (shipErrs.some((e) => /already exists/i.test(e))) continue;
      return json(422, { ok: false, error: "Bpost a refusé : " + shipErrs.join(" · "), api_errors: shipErrs });
    }
    if (!chosenCref) return json(422, { ok: false, error: "Bpost refuse après " + maxAttempts + " essais. Dernière : " + shipErrs.join(" · ") });

    const labelRes: any = await tryFetchLabel(token, chosenCref);
    if (labelRes.ghost) return json(422, { ok: false, ghost: true, error: "Shipment créé mais label révèle ghost : " + (labelRes.errors || []).join(" · "), bpost_reference: chosenCref });

    const storedUrl = labelRes.ready && labelRes.mode === "url" ? labelRes.labelUrl : "bpost-fetch:" + chosenCref;
    await updateOrder(order_id, { bpost_shipment_id: shipmentId, bpost_reference: chosenCref, bpost_label_url: storedUrl, bpost_status: "pushed", bpost_pushed_at: new Date().toISOString() });

    return json(200, {
      ok: true, bpost_reference: chosenCref, bpost_shipment_id: shipmentId, bpost_label_url: storedUrl, label_ready: !!labelRes.ready,
      message: labelRes.ready ? "Shipment " + chosenCref + " OK. Clique \"Imprimer étiquette\"." : "Shipment " + chosenCref + " OK. PDF en génération — réessaie dans 30s.",
    });
  } catch (e) {
    console.error("[Bpost push] erreur:", (e as Error).message);
    return json(500, { ok: false, error: (e as Error).message });
  }
});
