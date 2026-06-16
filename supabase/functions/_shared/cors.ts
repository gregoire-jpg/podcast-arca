// Helpers partagés pour les Edge Functions ARCA (portées depuis netlify/functions).
// CORS ouvert (* ) car appelées depuis arca-revue.com et l'admin.

export const corsHeaders: Record<string, string> = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Methods": "GET, POST, OPTIONS",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
};

// Réponse JSON standard. maxAge en secondes → Cache-Control public ; sinon no-store.
export function json(code: number, obj: unknown, maxAge?: number): Response {
  return new Response(JSON.stringify(obj), {
    status: code,
    headers: {
      ...corsHeaders,
      "Content-Type": "application/json",
      "Cache-Control": maxAge ? `public, max-age=${maxAge}` : "no-store",
    },
  });
}

// Réponse au préflight OPTIONS. À appeler en tête de chaque handler.
export function preflight(req: Request): Response | null {
  if (req.method === "OPTIONS") return new Response("ok", { headers: corsHeaders });
  return null;
}
