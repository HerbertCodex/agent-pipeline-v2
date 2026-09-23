# Exemples SQL (PostgreSQL, Supabase)

Exemples de forme, à adapter au modèle du projet. Noms en anglais `snake_case`.

## Table utilisateur, contraintes, clé composite
```sql
create table public.applications (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references auth.users (id) on delete cascade,
  company text not null check (char_length(company) between 1 and 200),
  status public.application_status not null default 'sent',
  sent_on date not null check (sent_on between date '1900-01-01' and date '9999-12-31'),
  idempotency_key uuid not null,
  version integer not null default 1,
  created_at timestamptz not null default now(),
  unique (id, user_id),
  unique (user_id, idempotency_key)
);

create table public.application_events (
  id uuid primary key default gen_random_uuid(),
  application_id uuid not null,
  user_id uuid not null,
  occurred_on date not null check (occurred_on between date '1900-01-01' and date '9999-12-31'),
  -- L'événement appartient forcément au même utilisateur que sa candidature.
  foreign key (application_id, user_id) references public.applications (id, user_id) on delete cascade
);
create index application_events_application_id_user_id_idx on public.application_events (application_id, user_id);
```

## RLS
```sql
alter table public.applications enable row level security;
alter table public.applications force row level security;

create policy applications_select_own on public.applications
  for select to authenticated using (user_id = (select auth.uid()));
create policy applications_insert_own on public.applications
  for insert to authenticated with check (user_id = (select auth.uid()));
create policy applications_update_own on public.applications
  for update to authenticated using (user_id = (select auth.uid())) with check (user_id = (select auth.uid()));

-- Colonnes réservées : seul ce qui est saisissable est accordé.
revoke insert, update on public.application_events from authenticated;
grant insert (application_id, user_id, occurred_on) on public.application_events to authenticated;
```

## Fonction `security definer` bornée
```sql
create or replace function public.complete_event(p_event_id uuid)
returns uuid
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_user uuid := (select auth.uid());
  v_id uuid;
begin
  if v_user is null then
    raise exception 'not authenticated' using errcode = '42501';
  end if;
  update public.scheduled_events
     set done_at = now()
   where id = p_event_id and user_id = v_user and done_at is null
  returning id into v_id;
  if v_id is null then
    raise exception 'not found or already done' using errcode = 'P0002';
  end if;
  return v_id;
end;
$$;
revoke execute on function public.complete_event(uuid) from public, anon;
grant execute on function public.complete_event(uuid) to authenticated;
```

## Création idempotente (anti double clic)
```sql
-- La seconde requête avec la même clé renvoie la ligne de la première.
insert into public.applications (user_id, company, sent_on, idempotency_key)
values ((select auth.uid()), $1, $2, $3)
on conflict (user_id, idempotency_key) do nothing
returning id;
-- Si rien n'est renvoyé : select id from public.applications where user_id = (select auth.uid()) and idempotency_key = $3;
```

## Verrou optimiste
```sql
update public.applications
   set company = $3, version = version + 1
 where id = $1 and user_id = (select auth.uid()) and version = $2
returning id, version;
-- Zéro ligne : conflit. Relire la valeur actuelle et l'afficher, ne rien écraser.
```

## Invariant concurrent (quota) dans une transaction courte
```sql
begin;
set local lock_timeout = '2s';
set local statement_timeout = '5s';
select pg_advisory_xact_lock(hashtextextended('documents:' || $1::text, 0));
-- lire le total de l'utilisateur, refuser au-delà du quota, puis insérer
commit; -- le verrou consultatif est libéré ici, jamais en mode session
```

## Index et EXPLAIN
```sql
-- La liste trie par created_at et exclut les lignes supprimées : l'index suit la requête réelle.
create index applications_user_id_created_at_idx
  on public.applications (user_id, created_at desc) where deleted_at is null;

-- Volume réaliste sur une base locale, jamais en production.
explain (analyze, buffers)
select id, company, status, sent_on
  from public.applications
 where user_id = $1 and deleted_at is null
 order by created_at desc
 limit 50;
```

## Migration sur données existantes
```sql
-- Nettoyer avant de contraindre, pour que la migration passe sur une base réelle.
update public.scheduled_events set modality = null where kind <> 'interview';
alter table public.scheduled_events
  add constraint scheduled_events_modality_check check (modality is null or kind = 'interview');
```
