-- Colonne attendue par _shared/bpost.ts (getValidToken → scopeMatches) mais jamais
-- créée lors de la migration Netlify → Supabase de juillet 2026.
--
-- Conséquence tant qu'elle manque : le SELECT avec shop_url échoue, le fallback
-- renvoie une ligne sans shop_url, `stored.shop_url === shopUrl` est toujours faux,
-- donc le token en cache n'est JAMAIS réutilisé et chaque action Bpost repart sur
-- un POST /v3/keys.
--
-- À appliquer sur le projet Supabase fsbyoxotsmmzejefiaqg (beya).
alter table public.arca_bpost_tokens add column if not exists shop_url text;
