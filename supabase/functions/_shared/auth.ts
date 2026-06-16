// Auth admin pour les Edge Functions ARCA sensibles (lien de paiement, proxy DB…).
// Le front admin envoie le mot de passe dans l'en-tête `x-admin-password`.
// Comparaison à temps constant. FAIL-CLOSED : si ARCA_ADMIN_PASSWORD n'est pas
// configuré, on refuse tout le monde (jamais d'ouverture par défaut).

import { arcaEnv } from "./env.ts";
import { corsHeaders } from "./cors.ts";

function timingSafeEqual(a: string, b: string): boolean {
  const ab = new TextEncoder().encode(a);
  const bb = new TextEncoder().encode(b);
  if (ab.length !== bb.length) return false;
  let diff = 0;
  for (let i = 0; i < ab.length; i++) diff |= ab[i] ^ bb[i];
  return diff === 0;
}

// Retourne une Response 401 si l'appel n'est pas authentifié admin, sinon null.
export function requireAdmin(req: Request): Response | null {
  const secret = arcaEnv("ADMIN_PASSWORD");
  const provided = req.headers.get("x-admin-password") ?? "";
  if (!secret || !timingSafeEqual(provided, secret)) {
    return new Response(JSON.stringify({ error: "unauthorized" }), {
      status: 401,
      headers: { ...corsHeaders, "Content-Type": "application/json" },
    });
  }
  return null;
}
