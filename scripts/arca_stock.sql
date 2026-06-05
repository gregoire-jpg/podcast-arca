-- ════════════════════════════════════════════════════════════════
-- Module STOCK revue ARCA — schéma + seed initial
-- Appliqué sur Supabase (project fsbyoxotsmmzejefiaqg) via Management API.
-- Idempotent : ré-exécutable sans dupliquer le seed.
--
-- Modèle : Stock = initial_qty + Σ(entrées reçues) − vendu
--   - initial_qty  : stock figé AVANT la 1re vente du module (14/05/2026)
--   - entrées      : mouvements arca_stock_moves (réassort, tirage, retour…)
--   - vendu        : calculé en direct depuis public.arca_orders (non annulées)
-- ════════════════════════════════════════════════════════════════

create table if not exists public.arca_stock (
  num           int primary key,            -- 1..7 = N°1..N°7, 8 = N°8, 9 = Recueil de prières
  label         text not null,
  initial_qty   int  not null default 0,
  low_threshold int  not null default 3,    -- seuil d'alerte "stock bas"
  active        boolean not null default true,
  sort_order    int,
  created_at    timestamptz not null default now(),
  updated_at    timestamptz not null default now()
);

create table if not exists public.arca_stock_moves (
  id         bigint generated always as identity primary key,
  num        int not null references public.arca_stock(num) on delete cascade,
  qty        int not null,                  -- + entrée / − sortie
  kind       text not null default 'reassort',  -- reassort | tirage | ajustement | retour | don | perte
  note       text,
  received   boolean not null default true, -- false = commandé mais pas encore livré (hors stock physique)
  moved_at   date,
  created_at timestamptz not null default now()
);
create index if not exists arca_stock_moves_num_idx on public.arca_stock_moves(num);

-- RLS verrouillée (accès uniquement via service_role / db-proxy, comme arca_orders)
alter table public.arca_stock       enable row level security;
alter table public.arca_stock_moves enable row level security;

create or replace function public.arca_stock_touch() returns trigger language plpgsql as $func$
begin new.updated_at = now(); return new; end $func$;
drop trigger if exists arca_stock_touch_trg on public.arca_stock;
create trigger arca_stock_touch_trg before update on public.arca_stock
  for each row execute function public.arca_stock_touch();

-- ── Seed : stock initial (avant 1re vente) ──────────────────────
insert into public.arca_stock (num, label, initial_qty, sort_order) values
 (1,'N°1',0,1),(2,'N°2',9,2),(3,'N°3',9,3),(4,'N°4',13,4),
 (5,'N°5',20,5),(6,'N°6',6,6),(7,'N°7',7,7),(8,'N°8',0,8),
 (9,'Recueil de prières',4,9)
on conflict (num) do update set label = excluded.label, sort_order = excluded.sort_order;

-- ── Seed : réassort imprimeur (déjà reçu) ───────────────────────
-- N.B. : « Numéro spécial – réédition de textes oubliés » = Arca VI (N°6).
--        N°5 n'a PAS été réassorti (stock suffisant).
insert into public.arca_stock_moves (num, qty, kind, note, received)
select v.num, v.qty, v.kind, v.note, true
from (values
 (1,21,'reassort','Réassort imprimeur — Arca I réédition 2021'),
 (2,10,'reassort','Réassort imprimeur — Arca II réédition 2021'),
 (3, 9,'reassort','Réassort imprimeur — Arca III réédition 2021'),
 (4, 5,'reassort','Réassort imprimeur — Arca IV réédition 2021'),
 (6,11,'reassort','Réassort imprimeur — Numéro spécial réédition de textes oubliés (= Arca VI)'),
 (7,11,'reassort','Réassort imprimeur — Arca VII 2025'),
 (8,151,'tirage','Tirage initial — Arca VIII 2026'),
 (9,20,'reassort','Réassort imprimeur — Recueil de prières définitif')
) as v(num,qty,kind,note)
where not exists (select 1 from public.arca_stock_moves);
