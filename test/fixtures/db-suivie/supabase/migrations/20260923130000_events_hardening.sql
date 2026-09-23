-- Toujours rien : durcissement de l'historique application_events
-- (S2 de la revue de sécurité de la spec 2)
--
-- Avant : un utilisateur pouvait, par PostgREST et sa propre session, insérer dans son
-- historique un événement daté de n'importe quand, avec la date de création de son
-- choix et les colonnes d'annulation remplies, donc « annuler » un changement de statut
-- qui n'a jamais eu lieu, au-delà des 10 minutes.
--
-- 1. INSERT limité aux colonnes utiles (user_id, application_id, type, occurred_on,
--    body) : created_at prend toujours son défaut, les colonnes d'annulation
--    (from_status, to_status, previous_last_activity_on) ne s'écrivent que par la RPC.
-- 2. Un déclencheur force created_at à now() (même pour un rôle qui aurait le droit de
--    l'écrire) et borne occurred_on entre la date d'envoi et aujourd'hui (Europe/Paris,
--    calculé en SQL). Seule exception : une candidature datée dans le futur garde son
--    événement « sent » à sa date d'envoi.
-- 3. set_application_status borne p_occurred_on de la même façon et écrit l'événement
--    par une fonction du schéma private (non exposé par l'API), seule à pouvoir remplir
--    les colonnes d'annulation. Elle reste security invoker : RLS s'applique toujours.

-- ---------------------------------------------------------------------------
-- 1. Droits d'insertion par colonne
-- ---------------------------------------------------------------------------
revoke insert on public.application_events from authenticated;
grant insert (user_id, application_id, type, occurred_on, body)
  on public.application_events to authenticated;

-- ---------------------------------------------------------------------------
-- 2. created_at forcé, occurred_on borné
-- ---------------------------------------------------------------------------

-- Schéma des fonctions internes : absent de l'API (config.toml n'expose que public et
-- graphql_public), utilisable par les rôles qui en ont besoin.
create schema if not exists private;
revoke all on schema private from public, anon;
grant usage on schema private to authenticated, service_role;

-- Aujourd'hui à Paris : la même date que todayInParis() côté serveur.
create function private.today_in_paris()
returns date
language sql
stable
security invoker
set search_path = ''
as $$
  select (pg_catalog.now() at time zone 'Europe/Paris')::date;
$$;

revoke execute on function private.today_in_paris() from public, anon;
grant execute on function private.today_in_paris() to authenticated, service_role;

create function public.guard_application_event()
returns trigger
language plpgsql
security invoker
set search_path = ''
as $$
declare
  v_sent_on date;
begin
  new.created_at := pg_catalog.now();

  select a.sent_on into v_sent_on
  from public.applications a
  where a.id = new.application_id;

  -- Candidature absente ou invisible : la clé étrangère et RLS refusent déjà la ligne.
  if found and (
    new.occurred_on < v_sent_on
    or new.occurred_on > greatest(v_sent_on, private.today_in_paris())
  ) then
    raise exception 'occurred_on_out_of_range' using errcode = '22008';
  end if;
  return new;
end;
$$;

revoke execute on function public.guard_application_event()
  from public, anon, authenticated, service_role;

create trigger application_events_guard
  before insert on public.application_events
  for each row execute function public.guard_application_event();

-- ---------------------------------------------------------------------------
-- 3. Colonnes d'annulation réservées à la RPC
-- ---------------------------------------------------------------------------

-- Écrit l'événement d'un changement de statut que set_application_status vient de
-- poser. Security definer (les colonnes d'annulation ne sont insérables par aucun rôle
-- client), donc toutes les vérifications sont refaites ici pour l'utilisateur de la
-- requête : candidature à lui, non supprimée, dont le statut courant est bien p_to_status.
create function private.insert_status_event(
  p_application_id uuid,
  p_type text,
  p_occurred_on date,
  p_from_status text,
  p_to_status text,
  p_previous_last_activity_on date
)
returns uuid
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_user_id uuid := (select auth.uid());
  v_application public.applications%rowtype;
  v_event_id uuid;
begin
  select * into v_application
  from public.applications
  where id = p_application_id
    and user_id = v_user_id
    and deleted_at is null;

  if v_user_id is null or not found or v_application.status <> p_to_status then
    raise exception 'application_not_found' using errcode = 'P0002';
  end if;

  insert into public.application_events (
    user_id, application_id, type, occurred_on,
    from_status, to_status, previous_last_activity_on
  )
  values (
    v_user_id, p_application_id, p_type, p_occurred_on,
    p_from_status, p_to_status, p_previous_last_activity_on
  )
  returning id into v_event_id;

  return v_event_id;
end;
$$;

revoke execute on function private.insert_status_event(uuid, text, date, text, text, date)
  from public, anon, service_role;
grant execute on function private.insert_status_event(uuid, text, date, text, text, date)
  to authenticated;

create or replace function public.set_application_status(
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
  v_today date := private.today_in_paris();
  v_occurred_on date;
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

  -- Sans date : aujourd'hui, ou la date d'envoi si la candidature est datée plus tard.
  v_occurred_on := coalesce(p_occurred_on, greatest(v_today, v_application.sent_on));
  if v_occurred_on < v_application.sent_on
    or v_occurred_on > greatest(v_today, v_application.sent_on) then
    raise exception 'occurred_on_out_of_range' using errcode = '22008';
  end if;

  if v_application.status = p_status and p_status <> 'followed_up' then
    return null;
  end if;

  update public.applications
  set status = p_status
  where id = v_application.id;

  return private.insert_status_event(
    v_application.id,
    case p_status
      when 'followed_up' then 'follow_up'
      when 'interview' then 'reply'
      when 'offer' then 'offer'
      when 'rejected' then 'rejection'
      else 'status_change'
    end,
    v_occurred_on,
    v_application.status,
    p_status,
    v_application.last_activity_on
  );
end;
$$;

-- create or replace garde les droits existants ; ils sont rappelés ici.
revoke execute on function public.set_application_status(uuid, text, date)
  from public, anon, service_role;
grant execute on function public.set_application_status(uuid, text, date) to authenticated;

notify pgrst, 'reload schema';
