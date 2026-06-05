// Netlify Function — disponibilité publique du stock ARCA.
// GET → { available: { "1": true, ... }, packAvailable: bool }
// Lecture seule via service_role (le front public ne voit jamais la clé ni les quantités exactes).
// Stock = initial_qty + Σ(entrées reçues) − Σ(vendu, commandes non annulées).

function json(code, obj, maxAge) {
  return {
    statusCode: code,
    headers: {
      "Content-Type": "application/json",
      "Cache-Control": maxAge ? "public, max-age=" + maxAge : "no-store",
      "Access-Control-Allow-Origin": "*",
    },
    body: JSON.stringify(obj),
  };
}

exports.handler = async function () {
  const supaUrl = process.env.SUPABASE_URL;
  const supaKey = process.env.SUPABASE_SERVICE_KEY;
  if (!supaUrl || !supaKey) return json(500, { error: "Config Supabase manquante" });

  const h = { apikey: supaKey, Authorization: "Bearer " + supaKey, "Accept-Profile": "public" };

  try {
    const [stockR, movesR, ordersR] = await Promise.all([
      fetch(supaUrl + "/rest/v1/arca_stock?select=num,initial_qty,active", { headers: h }),
      fetch(supaUrl + "/rest/v1/arca_stock_moves?select=num,qty,received", { headers: h }),
      fetch(supaUrl + "/rest/v1/arca_orders?select=items,cancelled", { headers: h }),
    ]);
    const stock = await stockR.json();
    const moves = await movesR.json();
    const orders = await ordersR.json();

    const reassort = {}, sold = {};
    (moves || []).forEach(function (m) {
      if (m.received === false) return;
      const n = parseInt(m.num, 10);
      reassort[n] = (reassort[n] || 0) + (+m.qty || 0);
    });
    (orders || []).forEach(function (o) {
      if (o.cancelled) return; // null/false = pris en compte (cohérent avec l'admin)
      (o.items || []).forEach(function (it) {
        const n = parseInt(it.num, 10);
        const q = it.qty || 0;
        if (!n || q <= 0) return;
        sold[n] = (sold[n] || 0) + q;
      });
    });

    const available = {};
    (stock || []).forEach(function (s) {
      if (s.active === false) return;
      const n = parseInt(s.num, 10);
      const st = (+s.initial_qty || 0) + (reassort[n] || 0) - (sold[n] || 0);
      available[n] = st > 0;
    });

    let packAvailable = true;
    for (let i = 1; i <= 9; i++) { if (!available[i]) packAvailable = false; }

    return json(200, { available: available, packAvailable: packAvailable });
  } catch (e) {
    return json(502, { error: "Lecture stock échouée : " + (e.message || String(e)) });
  }
};
