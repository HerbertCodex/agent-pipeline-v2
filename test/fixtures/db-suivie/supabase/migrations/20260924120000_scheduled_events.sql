-- Toujours rien : rendez-vous planifiés (spec 3)
--
-- 1. Table scheduled_events : entretiens, relances et autres rendez-vous rattachés à une
--    candidature du même utilisateur, avec préparation, « C'est fait » et lien vers
--    l'événement d'historique écrit par « C'est fait ».
-- 2. email_reminder est seulement enregistré : aucun e-mail n'est envoyé avant la spec 4.
-- 3. Deux RPC security invoker à search_path vide : complete_scheduled_event et
--    reopen_scheduled_event, qui calculent elles-mêmes le jour de Paris. RLS s'applique
--    toujours à l'appelant ; l'événement d'historique est écrit par une fonction
--    security definer du schéma private (non exposé), qui revérifie tout.
-- 4. RLS activée ET forcée, politiques (select auth.uid()) = user_id ; création et
--    modification exigent une candidature de l'appelant non supprimée ; anon sans droit.

-- ---------------------------------------------------------------------------
-- 1. Cible de la clé étrangère composite vers l'historique : un rendez-vous ne peut
--    désigner qu'un événement du même utilisateur.
-- ---------------------------------------------------------------------------
alter table public.application_events
  add constraint application_events_id_user_id_key unique (id, user_id);

-- ---------------------------------------------------------------------------
-- 2. Table
-- ---------------------------------------------------------------------------
create table public.scheduled_events (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references auth.users (id) on delete cascade,
  application_id uuid not null,
  kind text not null
    constraint scheduled_events_kind_check check (kind in ('interview', 'follow_up', 'other')),
  scheduled_on date not null,
  -- Heure à la minute (HH:MM), de 00:00 à 23:59 : Postgres accepterait 24:00 et les secondes.
  scheduled_time time not null
    constraint scheduled_events_scheduled_time_check check (
      scheduled_time <= time '23:59' and extract(second from scheduled_time) = 0
    ),
  modality text not null default 'video'
    constraint scheduled_events_modality_check check (modality in ('video', 'on_site', 'phone')),
  note text
    constraint scheduled_events_note_check check (
      note is null
      or (char_length(btrim(note)) >= 1 and char_length(note) <= 200)
    ),
  email_reminder boolean not null default true,
  prepared_at timestamptz,
  done_at timestamptz,
  activity_event_id uuid,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  -- Seul un rendez-vous fait porte un événement d'historique.
  constraint scheduled_events_activity_requires_done_check check (
    activity_event_id is null or done_at is not null
  ),
  constraint scheduled_events_application_fkey
    foreign key (application_id, user_id)
    references public.applications (id, user_id)
    on delete cascade,
  -- L'événement supprimé (annulation, historique effacé) laisse le rendez-vous fait.
  constraint scheduled_events_activity_event_fkey
    foreign key (activity_event_id, user_id)
    references public.application_events (id, user_id)
    on delete set null (activity_event_id)
);

create index scheduled_events_user_id_done_at_scheduled_on_idx
  on public.scheduled_events (user_id, done_at, scheduled_on);
create index scheduled_events_application_id_idx
  on public.scheduled_events (application_id);
create index scheduled_events_activity_event_id_idx
  on public.scheduled_events (activity_event_id)
  where activity_event_id is not null;

-- set_updated_at (spec 2) : security invoker, search_path vide, exécutable par aucun rôle.
create trigger scheduled_events_set_updated_at
  before update on public.scheduled_events
  for each row execute function public.set_updated_at();

-- ---------------------------------------------------------------------------
-- 3. RPC (security invoker : RLS de l'appelant ; execute à authenticated seulement)
--
-- « Aujourd'hui » est toujours calculé en SQL (private.today_in_paris(), migration
-- 20260923130000) : aucune RPC ne reçoit la date du jour du client ni du serveur.
-- ---------------------------------------------------------------------------

-- Écrit l'événement d'historique de « C'est fait ». Security definer, comme
-- private.insert_status_event : previous_last_activity_on n'est insérable par aucun rôle
-- client (20260923130000). Tout est donc recalculé ici pour l'utilisateur de la requête,
-- à partir du seul identifiant : rendez-vous à lui, pas encore fait, sur une candidature
-- à lui non supprimée ; type, libellé et date ne viennent jamais de l'appelant. La date
-- est aujourd'hui à Paris, ou la date d'envoi si la candidature est datée plus tard
-- (même règle que set_application_status). Schéma private : absent de l'API.
create function private.insert_scheduled_activity(p_event_id uuid)
returns uuid
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_user_id uuid := (select auth.uid());
  v_event public.scheduled_events%rowtype;
  v_application public.applications%rowtype;
  v_activity_id uuid;
begin
  select * into v_event
  from public.scheduled_events
  where id = p_event_id
    and user_id = v_user_id
    and done_at is null;

  if v_user_id is null or not found then
    raise exception 'scheduled_event_not_found' using errcode = 'P0002';
  end if;

  select * into v_application
  from public.applications
  where id = v_event.application_id
    and user_id = v_user_id
    and deleted_at is null;

  if not found then
    raise exception 'scheduled_event_not_found' using errcode = 'P0002';
  end if;

  insert into public.application_events (
    user_id, application_id, type, occurred_on, body, previous_last_activity_on
  )
  values (
    v_user_id,
    v_application.id,
    case v_event.kind
      when 'interview' then 'interview'
      when 'follow_up' then 'follow_up'
      else 'note'
    end,
    greatest(private.today_in_paris(), v_application.sent_on),
    case v_event.kind
      when 'interview' then 'Entretien'
      when 'follow_up' then 'Relance'
      else coalesce(v_event.note, 'Autre')
    end || ' fait.',
    v_application.last_activity_on
  )
  returning id into v_activity_id;

  return v_activity_id;
end;
$$;

revoke execute on function private.insert_scheduled_activity(uuid)
  from public, anon, service_role;
grant execute on function private.insert_scheduled_activity(uuid) to authenticated;

-- « C'est fait » : écrit dans la même transaction done_at et un événement d'historique
-- (interview, follow_up, ou note pour « Autre ») daté du jour de Paris, dont le
-- déclencheur de la spec 2 avance le dernier signe de vie (sauf pour une note). Le
-- statut ne change pas. Renvoie l'identifiant de l'événement écrit.
create function public.complete_scheduled_event(p_event_id uuid)
returns uuid
language plpgsql
security invoker
set search_path = ''
as $$
declare
  v_event public.scheduled_events%rowtype;
  v_activity_id uuid;
begin
  select e.* into v_event
  from public.scheduled_events e
  where e.id = p_event_id
    and exists (
      select 1
      from public.applications a
      where a.id = e.application_id
        and a.deleted_at is null
    )
  for update;

  if not found then
    raise exception 'scheduled_event_not_found' using errcode = 'P0002';
  end if;

  if v_event.done_at is not null then
    raise exception 'already_done' using errcode = 'P0001';
  end if;

  -- Verrou de la candidature : dernier signe de vie lu et avancé sans course.
  perform 1
  from public.applications a
  where a.id = v_event.application_id
  for update;

  v_activity_id := private.insert_scheduled_activity(v_event.id);

  update public.scheduled_events
  set done_at = now(),
      activity_event_id = v_activity_id
  where id = v_event.id;

  return v_activity_id;
end;
$$;

-- Annule « C'est fait » le jour même à Paris seulement (jour calculé ici) : supprime
-- l'événement lié, rétablit le dernier signe de vie depuis l'état d'avant et les signes
-- de vie restants, remet done_at et activity_event_id à null. Sinon reopen_unavailable.
create function public.reopen_scheduled_event(p_event_id uuid)
returns void
language plpgsql
security invoker
set search_path = ''
as $$
declare
  v_event public.scheduled_events%rowtype;
  v_activity public.application_events%rowtype;
  v_current date;
  v_remaining date;
begin
  select e.* into v_event
  from public.scheduled_events e
  where e.id = p_event_id
    and exists (
      select 1
      from public.applications a
      where a.id = e.application_id
        and a.deleted_at is null
    )
  for update;

  if not found then
    raise exception 'scheduled_event_not_found' using errcode = 'P0002';
  end if;

  if v_event.done_at is null
    or (v_event.done_at at time zone 'Europe/Paris')::date <> private.today_in_paris() then
    raise exception 'reopen_unavailable' using errcode = 'P0001';
  end if;

  if v_event.activity_event_id is not null then
    select * into v_activity
    from public.application_events
    where id = v_event.activity_event_id;

    if found then
      select a.last_activity_on into v_current
      from public.applications a
      where a.id = v_event.application_id
      for update;

      -- Le signe de vie retiré n'est rétabli que s'il portait le dernier signe de vie :
      -- on reprend alors la valeur d'avant, ou un signe de vie restant plus récent.
      if v_activity.type <> 'note' and v_current = v_activity.occurred_on then
        select max(ev.occurred_on) into v_remaining
        from public.application_events ev
        where ev.application_id = v_event.application_id
          and ev.id <> v_activity.id
          and ev.type not in ('note', 'sent');

        update public.applications
        set last_activity_on = greatest(v_activity.previous_last_activity_on, v_remaining)
        where id = v_event.application_id
          and greatest(v_activity.previous_last_activity_on, v_remaining) is not null
          and greatest(v_activity.previous_last_activity_on, v_remaining) < v_current;
      end if;

      delete from public.application_events
      where id = v_activity.id;
    end if;
  end if;

  update public.scheduled_events
  set done_at = null,
      activity_event_id = null
  where id = v_event.id;
end;
$$;

revoke execute on function public.complete_scheduled_event(uuid)
  from public, anon, service_role;
revoke execute on function public.reopen_scheduled_event(uuid)
  from public, anon, service_role;
grant execute on function public.complete_scheduled_event(uuid) to authenticated;
grant execute on function public.reopen_scheduled_event(uuid) to authenticated;

-- ---------------------------------------------------------------------------
-- 4. RLS activée et forcée, politiques et privilèges
-- ---------------------------------------------------------------------------
alter table public.scheduled_events enable row level security;
alter table public.scheduled_events force row level security;

create policy "scheduled_events_select_own"
  on public.scheduled_events
  for select
  to authenticated
  using ((select auth.uid()) = user_id);

-- La candidature doit être celle de l'appelant et ne pas être supprimée.
create policy "scheduled_events_insert_own"
  on public.scheduled_events
  for insert
  to authenticated
  with check (
    (select auth.uid()) = user_id
    and exists (
      select 1
      from public.applications a
      where a.id = application_id
        and a.user_id = (select auth.uid())
        and a.deleted_at is null
    )
  );

create policy "scheduled_events_update_own"
  on public.scheduled_events
  for update
  to authenticated
  using ((select auth.uid()) = user_id)
  with check (
    (select auth.uid()) = user_id
    and exists (
      select 1
      from public.applications a
      where a.id = application_id
        and a.user_id = (select auth.uid())
        and a.deleted_at is null
    )
  );

create policy "scheduled_events_delete_own"
  on public.scheduled_events
  for delete
  to authenticated
  using ((select auth.uid()) = user_id);

-- Privilèges au plus juste : droits par défaut (dont truncate) retirés. À la création,
-- ni identifiant, ni done_at, ni événement lié, ni horodatages : « C'est fait » passe
-- par la RPC. La modification couvre les colonnes que la RPC (security invoker) écrit.
revoke all on public.scheduled_events from public, anon, authenticated;

grant select, delete on public.scheduled_events to authenticated;
grant insert (
  user_id, application_id, kind, scheduled_on, scheduled_time, modality, note,
  email_reminder, prepared_at
) on public.scheduled_events to authenticated;
grant update (
  application_id, kind, scheduled_on, scheduled_time, modality, note,
  email_reminder, prepared_at, done_at, activity_event_id
) on public.scheduled_events to authenticated;

notify pgrst, 'reload schema';
