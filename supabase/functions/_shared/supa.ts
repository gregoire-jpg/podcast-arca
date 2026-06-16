// Accès Supabase REST (PostgREST) via service_role, pour les Edge Functions ARCA.
//
// Dans le runtime Edge, Supabase injecte automatiquement :
//   - SUPABASE_URL
//   - SUPABASE_SERVICE_ROLE_KEY
// (les anciennes functions Netlify utilisaient SUPABASE_SERVICE_KEY → on garde
//  un fallback pour le code/secrets repris à l'identique.)

export function supaEnv(): { url: string; key: string } {
  const url = Deno.env.get("SUPABASE_URL") ?? "";
  const key = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY") ?? Deno.env.get("SUPABASE_SERVICE_KEY") ?? "";
  return { url, key };
}

// En-têtes PostgREST avec la clé service_role (lecture/écriture, RLS bypass).
export function supaHeaders(key: string, extra: Record<string, string> = {}): Record<string, string> {
  return {
    apikey: key,
    Authorization: `Bearer ${key}`,
    "Accept-Profile": "public",
    "Content-Profile": "public",
    ...extra,
  };
}
