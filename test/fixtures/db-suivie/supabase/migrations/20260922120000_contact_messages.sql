-- Toujours rien : messages du formulaire de contact (/contact).
--
-- Table en insertion seule : un visiteur, connecté ou non, peut déposer un message,
-- personne ne peut en relire un par l'API. L'éditeur les consulte depuis le tableau
-- de bord Supabase. Les bornes reprennent contactMessageSchema (src/lib/validation.ts).
--
-- RLS est activée sans FORCE : le déclencheur de limite de débit, exécuté avec les
-- droits du propriétaire de la table (SECURITY DEFINER), doit pouvoir compter les
-- messages récents. Les rôles clients (anon, authenticated) restent soumis à RLS.

create table if not exists public.contact_messages (
  id uuid primary key default gen_random_uuid(),
  email text not null check (char_length(email) between 3 and 254),
  topic text not null check (
    topic in ('Une question', 'Un bug', 'Une idée', 'Mes données personnelles', 'Autre chose')
  ),
  message text not null check (char_length(message) between 5 and 3000),
  created_at timestamptz not null default now()
);

-- Comptage par adresse sur l'heure glissante, et comptage global.
create index if not exists contact_messages_email_created_at_idx
  on public.contact_messages (email, created_at);
create index if not exists contact_messages_created_at_idx
  on public.contact_messages (created_at);

alter table public.contact_messages enable row level security;

-- Unique politique : l'insertion, avec les mêmes bornes que les CHECK.
create policy "contact_messages_insert_public"
  on public.contact_messages
  for insert
  to anon, authenticated
  with check (
    char_length(email) between 3 and 254
    and topic in ('Une question', 'Un bug', 'Une idée', 'Mes données personnelles', 'Autre chose')
    and char_length(message) between 5 and 3000
  );

-- Aucun droit par défaut, puis l'insertion des trois colonnes saisies seulement :
-- id et created_at restent aux valeurs par défaut.
revoke all on public.contact_messages from public, anon, authenticated;
grant insert (email, topic, message) on public.contact_messages to anon, authenticated;

-- Limite de débit : 3 messages par adresse et 60 au total par heure glissante.
-- La fonction ne fait que normaliser l'adresse, compter et lever une erreur.
create or replace function public.contact_messages_rate_limit()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
declare
  recent_total integer;
  recent_for_email integer;
begin
  -- Sérialise les insertions concurrentes pour que le comptage reste exact.
  perform pg_catalog.pg_advisory_xact_lock(pg_catalog.hashtext('public.contact_messages_rate_limit'));

  new.email := pg_catalog.lower(pg_catalog.btrim(new.email));

  select pg_catalog.count(*) into recent_total
    from public.contact_messages
    where created_at > pg_catalog.now() - interval '1 hour';

  if recent_total >= 60 then
    raise exception 'contact_rate_limited' using errcode = 'P0001';
  end if;

  select pg_catalog.count(*) into recent_for_email
    from public.contact_messages
    where email = new.email
      and created_at > pg_catalog.now() - interval '1 hour';

  if recent_for_email >= 3 then
    raise exception 'contact_rate_limited' using errcode = 'P0001';
  end if;

  return new;
end;
$$;

revoke execute on function public.contact_messages_rate_limit() from public, anon, authenticated;

create trigger contact_messages_rate_limit
  before insert on public.contact_messages
  for each row
  execute function public.contact_messages_rate_limit();
