// Edge Function — disponibilité publique du stock ARCA.
// (Portée depuis netlify/functions/arca-stock.js — comportement identique.)
// GET → { available: { "1": true, ... }, packAvailable: bool }
// Lecture seule via service_role (le front public ne voit jamais la clé ni les quantités exactes).
// Stock = initial_qty + Σ(entrées reçues) − Σ(vendu, commandes non annulées).

import { json, preflight } from "../_shared/cors.ts";
import { supaEnv, supaHeaders } from "../_shared/supa.ts";

Deno.serve(async (req) => {
  const pre = preflight(req);
  if (pre) return pre;

  const { url: supaUrl, key: supaKey } = supaEnv();
  if (!supaUrl || !supaKey) return json(500, { error: "Config Supabase manquante" });

  const h = supaHeaders(supaKey);

  try {
    const [stockR, movesR, ordersR] = await Promise.all([
      fetch(supaUrl + "/rest/v1/arca_stock?select=num,initial_qty,active", { headers: h }),
      fetch(supaUrl + "/rest/v1/arca_stock_moves?select=num,qty,received", { headers: h }),
      fetch(supaUrl + "/rest/v1/arca_orders?select=items,cancelled", { headers: h }),
    ]);
    const stock = await stockR.json();
    const moves = await movesR.json();
    const orders = await ordersR.json();

    const reassort: Record<number, number> = {};
    const sold: Record<number, number> = {};
    (moves || []).forEach((m: any) => {
      if (m.received === false) return;
      const n = parseInt(m.num, 10);
      reassort[n] = (reassort[n] || 0) + (+m.qty || 0);
    });
    (orders || []).forEach((o: any) => {
      if (o.cancelled) return; // null/false = pris en compte (cohérent avec l'admin)
      (o.items || []).forEach((it: any) => {
        const n = parseInt(it.num, 10);
        const q = it.qty || 0;
        if (!n || q <= 0) return;
        sold[n] = (sold[n] || 0) + q;
      });
    });

    const available: Record<number, boolean> = {};
    (stock || []).forEach((s: any) => {
      if (s.active === false) return;
      const n = parseInt(s.num, 10);
      const st = (+s.initial_qty || 0) + (reassort[n] || 0) - (sold[n] || 0);
      available[n] = st > 0;
    });

    let packAvailable = true;
    for (let i = 1; i <= 9; i++) { if (!available[i]) packAvailable = false; }

    return json(200, { available, packAvailable });
  } catch (e) {
    return json(502, { error: "Lecture stock échouée : " + ((e as Error).message || String(e)) });
  }
});
