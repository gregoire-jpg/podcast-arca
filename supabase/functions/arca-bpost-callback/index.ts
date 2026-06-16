// Edge Function — callback status push de Bpost (signature HMAC). WEBHOOK (pas d'auth admin).
// (Portée depuis netlify/functions/bpost-callback.js.) Vérifie la signature puis met à jour arca_orders.
// ⚠ CUTOVER : l'URL enregistrée chez Bpost (ShopUrl) doit être .../arca-bpost-callback.

import { arcaEnv } from "../_shared/env.ts";
import * as bp from "../_shared/bpost.ts";

Deno.serve(async (req) => {
  if (req.method === "GET") return new Response("Bpost callback endpoint OK", { status: 200 });
  if (req.method !== "POST") return new Response("Method not allowed", { status: 405 });

  try {
    const raw = await req.text();
    let body: any;
    try { body = JSON.parse(raw || "{}"); } catch { body = {}; }
    const status = body.Status || body.status || "";
    const trackingId = body.TrackingId || body.tracking_id || "";
    const shopItemId = body.ShopItemId || body.shop_item_id || "";
    const receivedSig = req.headers.get("x-hmac-signature") || req.headers.get("X-Hmac-Signature") || "";

    const callbackUrl = arcaEnv("FUNCTIONS_BASE") + "/arca-bpost-callback";

    if (receivedSig) {
      const valid = await bp.verifyCallbackSignature(receivedSig, status, trackingId, callbackUrl);
      if (!valid) {
        console.warn("[Bpost callback] HMAC invalid for", shopItemId, status);
        return new Response("Invalid signature", { status: 401 });
      }
    } else {
      console.warn("[Bpost callback] No signature provided, proceeding anyway");
    }

    console.log("[Bpost callback]", shopItemId, "→", status, "tracking=", trackingId);
    const m = String(shopItemId).match(/^ARCA-(\d+)$/);
    if (!m) return new Response("No matching order (" + shopItemId + ")", { status: 200 });
    const orderId = parseInt(m[1], 10);

    await fetch(bp.supaUrl() + "/rest/v1/arca_orders?id=eq." + orderId, {
      method: "PATCH",
      headers: { apikey: bp.supaKey(), Authorization: "Bearer " + bp.supaKey(), "Content-Type": "application/json" },
      body: JSON.stringify({ bpost_status: status, bpost_tracking: trackingId || null, bpost_status_at: new Date().toISOString() }),
    });
    return new Response("OK", { status: 200 });
  } catch (err) {
    console.error("bpost-callback error:", err);
    return new Response("Error: " + (err as Error).message, { status: 500 });
  }
});
