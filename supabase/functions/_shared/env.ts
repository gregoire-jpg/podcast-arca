// Lecture des secrets ARCA, tous préfixés ARCA_ dans le projet Supabase beya
// (le projet est PARTAGÉ avec l'ERP Beya → le préfixe évite toute collision :
//  Beya a son propre Stripe/SMTP sous d'autres noms, on ne les touche jamais).
//
// Exception : SUPABASE_URL / SUPABASE_SERVICE_ROLE_KEY sont auto-injectés par
// le runtime Edge et lus via _shared/supa.ts (pas de préfixe).

export function arcaEnv(name: string): string {
  return Deno.env.get("ARCA_" + name) ?? "";
}

export function requireEnv(...names: string[]): string | null {
  for (const n of names) {
    if (!arcaEnv(n)) return n;
  }
  return null; // null = tout est présent ; sinon le nom manquant
}
