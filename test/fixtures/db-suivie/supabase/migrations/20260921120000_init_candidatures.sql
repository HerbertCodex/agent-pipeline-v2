-- Toujours rien — schéma initial
--
-- Règle non négociable : un utilisateur n'accède qu'à ses propres lignes, sans exception.
-- Cette règle est imposée ici, par Row Level Security, et non par le code applicatif.

create extension if not exists "pgcrypto";

create table if not exists public.candidatures (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references auth.users (id) on delete cascade,
  entreprise text not null check (char_length(entreprise) between 1 and 120),
  intitule_poste text not null check (char_length(intitule_poste) between 1 and 160),
  source text check (source is null or char_length(source) <= 80),
  url_offre text check (
    url_offre is null
    or (char_length(url_offre) <= 2048 and url_offre ~* '^https?://')
  ),
  -- Vocabulaire des statuts volontairement non figé : décision Product.
  -- Une contrainte de valeurs pourra être ajoutée par une migration ultérieure.
  statut text check (statut is null or char_length(statut) <= 40),
  date_candidature date not null default current_date,
  notes text check (notes is null or char_length(notes) <= 2000),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create index if not exists candidatures_user_id_date_idx
  on public.candidatures (user_id, date_candidature desc);

alter table public.candidatures enable row level security;
alter table public.candidatures force row level security;

create policy "candidatures_select_proprietaire"
  on public.candidatures
  for select
  to authenticated
  using (auth.uid() = user_id);

create policy "candidatures_insert_proprietaire"
  on public.candidatures
  for insert
  to authenticated
  with check (auth.uid() = user_id);

create policy "candidatures_update_proprietaire"
  on public.candidatures
  for update
  to authenticated
  using (auth.uid() = user_id)
  with check (auth.uid() = user_id);

create policy "candidatures_delete_proprietaire"
  on public.candidatures
  for delete
  to authenticated
  using (auth.uid() = user_id);

-- Le rôle anonyme n'a aucun accès à cette table.
revoke all on public.candidatures from anon;
grant select, insert, update, delete on public.candidatures to authenticated;
