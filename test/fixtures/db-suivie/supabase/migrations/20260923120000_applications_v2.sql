-- Toujours rien : modèle de données v2
--
-- 1. La table candidatures devient applications (schéma en anglais), sans recopie :
--    renommage en place, chaque ligne existante est conservée.
-- 2. Nouveaux champs (lieu, mode, contrat, salaire, contact, statut contraint,
--    dernier signe de vie, suppression douce), historique application_events et
--    réglages user_settings.
-- 3. Reprise de l'existant : dernier signe de vie, statut libre normalisé vers les
--    cinq statuts, un événement « sent » par ligne, statut d'origine non canonique
--    conservé dans une note. Aucune valeur n'est inventée (lieu et mode restent null).
-- 4. Déclencheurs et deux fonctions RPC, toutes security invoker à search_path vide :
--    RLS s'applique toujours à l'appelant, aucune fonction ne la contourne.
-- 5. RLS activée ET forcée sur les trois tables, politiques (select auth.uid()) = user_id,
--    aucun droit pour anon.

-- ---------------------------------------------------------------------------
-- Reprise : FORCE RLS levé le temps de la reprise, rétabli plus bas.
-- ---------------------------------------------------------------------------
alter table public.candidatures no force row level security;

-- ---------------------------------------------------------------------------
-- 1. Renommages (table, colonnes, contraintes, index, politiques)
-- ---------------------------------------------------------------------------
alter table public.candidatures rename to applications;

alter table public.applications rename column entreprise to company;
alter table public.applications rename column intitule_poste to job_title;
alter table public.applications rename column url_offre to offer_url;
alter table public.applications rename column date_candidature to sent_on;

alter table public.applications rename constraint candidatures_pkey to applications_pkey;
alter table public.applications rename constraint candidatures_user_id_fkey to applications_user_id_fkey;
alter table public.applications rename constraint candidatures_entreprise_check to applications_company_check;
alter table public.applications rename constraint candidatures_intitule_poste_check to applications_job_title_check;
alter table public.applications rename constraint candidatures_source_check to applications_source_check;
alter table public.applications rename constraint candidatures_url_offre_check to applications_offer_url_check;
alter table public.applications rename constraint candidatures_notes_check to applications_notes_check;

alter index public.candidatures_user_id_date_idx rename to applications_user_id_sent_on_idx;

alter policy "candidatures_select_proprietaire" on public.applications rename to "applications_select_own";
alter policy "candidatures_insert_proprietaire" on public.applications rename to "applications_insert_own";
alter policy "candidatures_update_proprietaire" on public.applications rename to "applications_update_own";
alter policy "candidatures_delete_proprietaire" on public.applications rename to "applications_delete_own";

-- ---------------------------------------------------------------------------
-- 2. Nouveaux champs de applications
-- ---------------------------------------------------------------------------
alter table public.applications
  add column location text
    constraint applications_location_check check (
      location is null
      or (char_length(btrim(location)) >= 1 and char_length(location) <= 80)
    ),
  add column work_mode text
    constraint applications_work_mode_check check (
      work_mode is null or work_mode in ('on_site', 'hybrid', 'remote')
    ),
  add column contract_type text not null default 'unspecified'
    constraint applications_contract_type_check check (
      contract_type in (
        'unspecified', 'permanent', 'fixed_term', 'internship', 'apprenticeship', 'freelance'
      )
    ),
  add column salary_text text
    constraint applications_salary_text_check check (
      salary_text is null or char_length(salary_text) <= 60
    ),
  add column salary_unit text not null default 'gross_yearly'
    constraint applications_salary_unit_check check (
      salary_unit in ('gross_yearly', 'gross_monthly', 'net_monthly', 'daily', 'hourly')
    ),
  add column last_activity_on date,
  add column contact_name text
    constraint applications_contact_name_check check (
      contact_name is null or char_length(contact_name) <= 120
    ),
  add column contact_role text
    constraint applications_contact_role_check check (
      contact_role is null or char_length(contact_role) <= 120
    ),
  add column contact_email text
    constraint applications_contact_email_check check (
      contact_email is null
      or (
        char_length(contact_email) <= 254
        and contact_email ~ '^[^@[:space:]]+@[^@[:space:]]+$'
      )
    ),
  add column status text,
  add column follow_up_reminder boolean not null default true,
  add column deleted_at timestamptz;

-- Cible des clés étrangères composites de application_events : un événement ne peut
-- désigner qu'une candidature du même utilisateur.
alter table public.applications
  add constraint applications_id_user_id_key unique (id, user_id);

-- ---------------------------------------------------------------------------
-- 3. Historique et réglages
-- ---------------------------------------------------------------------------
create table public.application_events (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references auth.users (id) on delete cascade,
  application_id uuid not null,
  type text not null check (
    type in (
      'sent', 'follow_up', 'reply', 'rejection', 'interview',
      'note', 'call', 'email_received', 'offer', 'status_change'
    )
  ),
  occurred_on date not null default current_date,
  body text check (body is null or char_length(body) <= 2000),
  from_status text check (
    from_status is null
    or from_status in ('sent', 'followed_up', 'interview', 'offer', 'rejected')
  ),
  to_status text check (
    to_status is null
    or to_status in ('sent', 'followed_up', 'interview', 'offer', 'rejected')
  ),
  previous_last_activity_on date,
  created_at timestamptz not null default now(),
  constraint application_events_application_fkey
    foreign key (application_id, user_id)
    references public.applications (id, user_id)
    on delete cascade
);

create index application_events_application_id_idx
  on public.application_events (application_id, occurred_on);
create index application_events_user_id_idx
  on public.application_events (user_id);

create table public.user_settings (
  user_id uuid primary key references auth.users (id) on delete cascade,
  first_name text check (
    first_name is null
    or (char_length(btrim(first_name)) >= 1 and char_length(first_name) <= 40)
  ),
  follow_up_delay_days smallint not null default 14
    check (follow_up_delay_days in (7, 14, 21)),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

-- ---------------------------------------------------------------------------
-- 4. Reprise de l'existant (avant les déclencheurs : updated_at n'est pas touché)
-- ---------------------------------------------------------------------------
update public.applications set last_activity_on = sent_on;

-- Statut libre normalisé : minuscules, espaces retirés aux bords, sans accents.
create temporary table legacy_status as
select
  a.id,
  a.user_id,
  a.sent_on,
  a.statut as original,
  translate(
    lower(btrim(coalesce(a.statut, ''))),
    'àâäáãåéèêëíìîïóòôöõúùûüçñÿ',
    'aaaaaaeeeeiiiiooooouuuucny'
  ) as normalized
from public.applications a;

alter table legacy_status add column mapped text;

update legacy_status
set mapped = case
  when normalized = '' then 'sent'
  when normalized like '%relanc%' then 'followed_up'
  when normalized like '%entretien%' then 'interview'
  when normalized like '%offre%' or normalized like '%proposition%' then 'offer'
  when normalized like '%refus%' or normalized like '%rejet%' or normalized like '%negati%'
    then 'rejected'
  else 'sent'
end;

update public.applications a
set status = s.mapped
from legacy_status s
where s.id = a.id;

insert into public.application_events (user_id, application_id, type, occurred_on)
select s.user_id, s.id, 'sent', s.sent_on
from legacy_status s;

-- Un statut d'origine est canonique quand il est exactement le libellé français de son
-- statut (« Envoyée », « Relancée », « Entretien », « Offre », « Refus ») aux accents,
-- à la casse et aux espaces de bord près. Sinon il est conservé mot pour mot en note.
insert into public.application_events (user_id, application_id, type, occurred_on, body)
select s.user_id, s.id, 'note', s.sent_on, 'Statut d''origine : ' || s.original
from legacy_status s
where s.normalized <> ''
  and s.normalized <> case s.mapped
    when 'sent' then 'envoyee'
    when 'followed_up' then 'relancee'
    when 'interview' then 'entretien'
    when 'offer' then 'offre'
    when 'rejected' then 'refus'
  end;

drop table legacy_status;

alter table public.applications drop column statut;

alter table public.applications
  alter column status set default 'sent',
  alter column status set not null,
  add constraint applications_status_check check (
    status in ('sent', 'followed_up', 'interview', 'offer', 'rejected')
  ),
  alter column last_activity_on set not null,
  add constraint applications_last_activity_on_check check (last_activity_on >= sent_on);

create index applications_user_id_deleted_at_last_activity_on_idx
  on public.applications (user_id, deleted_at, last_activity_on);

-- ---------------------------------------------------------------------------
-- 5. Déclencheurs (security invoker, search_path vide)
-- ---------------------------------------------------------------------------
create function public.set_updated_at()
returns trigger
language plpgsql
security invoker
set search_path = ''
as $$
begin
  new.updated_at := now();
  return new;
end;
$$;

-- Le dernier signe de vie n'est jamais antérieur à la date d'envoi.
create function public.clamp_last_activity_on()
returns trigger
language plpgsql
security invoker
set search_path = ''
as $$
begin
  if new.last_activity_on is null or new.last_activity_on < new.sent_on then
    new.last_activity_on := new.sent_on;
  end if;
  return new;
end;
$$;

-- L'événement « sent » naît avec la candidature et suit sa date d'envoi.
create function public.create_sent_event()
returns trigger
language plpgsql
security invoker
set search_path = ''
as $$
begin
  insert into public.application_events (user_id, application_id, type, occurred_on)
  values (new.user_id, new.id, 'sent', new.sent_on);
  return null;
end;
$$;

create function public.redate_sent_event()
returns trigger
language plpgsql
security invoker
set search_path = ''
as $$
begin
  -- Suppression puis recréation plutôt qu'une modification : les événements ne
  -- s'éditent pas (aucune politique ni aucun droit update), déclencheur compris.
  delete from public.application_events
  where application_id = new.id
    and type = 'sent';

  insert into public.application_events (user_id, application_id, type, occurred_on)
  values (new.user_id, new.id, 'sent', new.sent_on);
  return null;
end;
$$;

-- Tout signe de vie (tous les types sauf note et sent) avance le dernier signe de vie.
create function public.advance_last_activity_on()
returns trigger
language plpgsql
security invoker
set search_path = ''
as $$
begin
  if new.type not in ('note', 'sent') then
    update public.applications
    set last_activity_on = new.occurred_on
    where id = new.application_id
      and last_activity_on < new.occurred_on;
  end if;
  return null;
end;
$$;

revoke execute on function public.set_updated_at() from public, anon, authenticated, service_role;
revoke execute on function public.clamp_last_activity_on() from public, anon, authenticated, service_role;
revoke execute on function public.create_sent_event() from public, anon, authenticated, service_role;
revoke execute on function public.redate_sent_event() from public, anon, authenticated, service_role;
revoke execute on function public.advance_last_activity_on() from public, anon, authenticated, service_role;

create trigger applications_set_updated_at
  before update on public.applications
  for each row execute function public.set_updated_at();

create trigger applications_clamp_last_activity_on
  before insert or update on public.applications
  for each row execute function public.clamp_last_activity_on();

create trigger applications_create_sent_event
  after insert on public.applications
  for each row execute function public.create_sent_event();

create trigger applications_redate_sent_event
  after update of sent_on on public.applications
  for each row
  when (old.sent_on is distinct from new.sent_on)
  execute function public.redate_sent_event();

create trigger application_events_advance_last_activity_on
  after insert on public.application_events
  for each row execute function public.advance_last_activity_on();

create trigger user_settings_set_updated_at
  before update on public.user_settings
  for each row execute function public.set_updated_at();

-- ---------------------------------------------------------------------------
-- 6. RPC (security invoker : RLS de l'appelant ; execute à authenticated seulement)
-- ---------------------------------------------------------------------------

-- Écrit le statut et l'événement correspondant dans la même transaction, en gardant
-- l'état précédent pour l'annulation. Renvoie l'identifiant de l'événement, ou null
-- quand le statut demandé est déjà le statut courant (sauf relance, toujours journalisée).
create function public.set_application_status(
  p_application_id uuid,
  p_status text,
  p_occurred_on date default null
)
returns uuid
language plpgsql
security invoker
set search_path = ''
as $$
declare
  v_application public.applications%rowtype;
  v_event_id uuid;
begin
  if p_status is null
    or p_status not in ('sent', 'followed_up', 'interview', 'offer', 'rejected') then
    raise exception 'invalid_status' using errcode = '22023';
  end if;

  select * into v_application
  from public.applications
  where id = p_application_id
    and deleted_at is null
  for update;

  if not found then
    raise exception 'application_not_found' using errcode = 'P0002';
  end if;

  if v_application.status = p_status and p_status <> 'followed_up' then
    return null;
  end if;

  update public.applications
  set status = p_status
  where id = v_application.id;

  insert into public.application_events (
    user_id, application_id, type, occurred_on,
    from_status, to_status, previous_last_activity_on
  )
  values (
    v_application.user_id,
    v_application.id,
    case p_status
      when 'followed_up' then 'follow_up'
      when 'interview' then 'reply'
      when 'offer' then 'offer'
      when 'rejected' then 'rejection'
      else 'status_change'
    end,
    coalesce(p_occurred_on, (now() at time zone 'Europe/Paris')::date),
    v_application.status,
    p_status,
    v_application.last_activity_on
  )
  returning id into v_event_id;

  return v_event_id;
end;
$$;

-- Annule un changement de statut de moins de 10 minutes, tant que le statut courant
-- est encore celui qu'il a posé : restaure statut et dernier signe de vie, supprime
-- l'événement.
create function public.undo_status_change(p_event_id uuid)
returns void
language plpgsql
security invoker
set search_path = ''
as $$
declare
  v_event public.application_events%rowtype;
  v_application public.applications%rowtype;
begin
  -- Pas de verrou sur l'événement (il exigerait un droit update que personne n'a) :
  -- c'est le verrou sur la candidature, plus bas, qui sérialise deux annulations.
  select * into v_event
  from public.application_events
  where id = p_event_id;

  if not found
    or v_event.to_status is null
    or v_event.from_status is null
    or v_event.previous_last_activity_on is null
    or v_event.created_at < now() - interval '10 minutes' then
    raise exception 'undo_unavailable' using errcode = 'P0001';
  end if;

  select * into v_application
  from public.applications
  where id = v_event.application_id
  for update;

  if not found or v_application.status <> v_event.to_status then
    raise exception 'undo_unavailable' using errcode = 'P0001';
  end if;

  update public.applications
  set status = v_event.from_status,
      last_activity_on = v_event.previous_last_activity_on
  where id = v_application.id;

  delete from public.application_events
  where id = v_event.id;
end;
$$;

revoke execute on function public.set_application_status(uuid, text, date)
  from public, anon, service_role;
revoke execute on function public.undo_status_change(uuid)
  from public, anon, service_role;
grant execute on function public.set_application_status(uuid, text, date) to authenticated;
grant execute on function public.undo_status_change(uuid) to authenticated;

-- ---------------------------------------------------------------------------
-- 7. RLS activée et forcée, politiques et privilèges
-- ---------------------------------------------------------------------------
alter table public.applications enable row level security;
alter table public.applications force row level security;
alter table public.application_events enable row level security;
alter table public.application_events force row level security;
alter table public.user_settings enable row level security;
alter table public.user_settings force row level security;

-- applications : CRUD du propriétaire. (select auth.uid()) est évalué une fois par requête.
alter policy "applications_select_own" on public.applications
  to authenticated
  using ((select auth.uid()) = user_id);

alter policy "applications_insert_own" on public.applications
  to authenticated
  with check ((select auth.uid()) = user_id);

alter policy "applications_update_own" on public.applications
  to authenticated
  using ((select auth.uid()) = user_id)
  with check ((select auth.uid()) = user_id);

alter policy "applications_delete_own" on public.applications
  to authenticated
  using ((select auth.uid()) = user_id);

-- application_events : lecture, ajout et suppression ; pas de modification.
create policy "application_events_select_own"
  on public.application_events
  for select
  to authenticated
  using ((select auth.uid()) = user_id);

create policy "application_events_insert_own"
  on public.application_events
  for insert
  to authenticated
  with check (
    (select auth.uid()) = user_id
    and exists (
      select 1
      from public.applications a
      where a.id = application_id
        and a.user_id = (select auth.uid())
    )
  );

create policy "application_events_delete_own"
  on public.application_events
  for delete
  to authenticated
  using ((select auth.uid()) = user_id);

-- user_settings : lecture, création et modification ; la suppression suit le compte.
create policy "user_settings_select_own"
  on public.user_settings
  for select
  to authenticated
  using ((select auth.uid()) = user_id);

create policy "user_settings_insert_own"
  on public.user_settings
  for insert
  to authenticated
  with check ((select auth.uid()) = user_id);

create policy "user_settings_update_own"
  on public.user_settings
  for update
  to authenticated
  using ((select auth.uid()) = user_id)
  with check ((select auth.uid()) = user_id);

-- Privilèges au plus juste : les droits par défaut du schéma public (dont truncate,
-- qui ignore RLS) sont retirés, puis seules les opérations couvertes par une
-- politique sont accordées. Le rôle anonyme n'a aucun droit.
revoke all on public.applications from public, anon, authenticated;
revoke all on public.application_events from public, anon, authenticated;
revoke all on public.user_settings from public, anon, authenticated;

grant select, insert, update, delete on public.applications to authenticated;
grant select, insert, delete on public.application_events to authenticated;
grant select, insert, update on public.user_settings to authenticated;

notify pgrst, 'reload schema';
