-- Toujours rien : rappels par e-mail et récapitulatif du lundi (spec 4)
--
-- S'applique après 20260924120000_scheduled_events.sql (spec 3), dont il lit la table
-- scheduled_events.
--
-- 1. user_settings : préférences email_reminders (défaut vrai) et weekly_digest (défaut
--    faux). Les lignes existantes prennent les défauts ; politiques de la spec 2 inchangées.
-- 2. email_deliveries : journal d'envoi idempotent, une ligne par (utilisateur, type,
--    période), réservée AVANT l'envoi. RLS activée et forcée ; l'utilisateur peut lire
--    ses propres lignes (export RGPD de la spec 6), rien d'autre ; anon n'a aucun droit.
-- 3. Sept fonctions security definer étroites, propriétaire postgres, search_path vide,
--    noms qualifiés, exécutables par service_role SEUL : ce sont les seuls appels que le
--    module privilégié de l'application (src/lib/server/privileged/) peut faire avec la
--    clé service_role, pour les envois planifiés et la désinscription sans session.
--    Chacune renvoie le minimum utile et filtre explicitement par user_id.
-- Aucune fonction existante ne change de mode de sécurité.

-- ---------------------------------------------------------------------------
-- 1. Préférences d'e-mail
-- ---------------------------------------------------------------------------
alter table public.user_settings
  add column email_reminders boolean not null default true,
  add column weekly_digest boolean not null default false;

-- ---------------------------------------------------------------------------
-- 2. Journal d'envoi
-- ---------------------------------------------------------------------------
create table public.email_deliveries (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references auth.users (id) on delete cascade,
  kind text not null
    constraint email_deliveries_kind_check check (
      kind in ('event_eve', 'morning', 'weekly_digest')
    ),
  -- AAAA-MM-JJ (jour du rendez-vous ou jour d'envoi) ou AAAA-Www (semaine ISO du lundi).
  period text not null,
  status text not null default 'pending'
    constraint email_deliveries_status_check check (
      status in ('pending', 'sent', 'skipped', 'failed')
    ),
  attempts smallint not null default 1
    constraint email_deliveries_attempts_check check (attempts between 1 and 3),
  error_code text
    constraint email_deliveries_error_code_check check (
      error_code is null or error_code ~ '^[a-z_]{1,40}$'
    ),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  sent_at timestamptz,
  constraint email_deliveries_period_check check (
    (
      kind in ('event_eve', 'morning')
      and period ~ '^[0-9]{4}-(0[1-9]|1[0-2])-(0[1-9]|[12][0-9]|3[01])$'
    )
    or (
      kind = 'weekly_digest'
      and period ~ '^[0-9]{4}-W(0[1-9]|[1-4][0-9]|5[0-3])$'
    )
  ),
  -- sent_at n'est renseigné que pour un envoi abouti.
  constraint email_deliveries_sent_at_check check (sent_at is null or status = 'sent'),
  constraint email_deliveries_user_id_kind_period_key unique (user_id, kind, period)
);

create index email_deliveries_created_at_idx on public.email_deliveries (created_at);

create trigger email_deliveries_set_updated_at
  before update on public.email_deliveries
  for each row execute function public.set_updated_at();

-- Purge des suppressions douces (purge_deleted_applications) sans parcourir la table.
create index applications_deleted_at_idx
  on public.applications (deleted_at)
  where deleted_at is not null;

alter table public.email_deliveries enable row level security;
alter table public.email_deliveries force row level security;

-- Lecture de ses propres lignes seulement (export RGPD, spec 6). Aucune écriture :
-- seules les fonctions ci-dessous, réservées à service_role, écrivent le journal.
create policy "email_deliveries_select_own"
  on public.email_deliveries
  for select
  to authenticated
  using ((select auth.uid()) = user_id);

revoke all on public.email_deliveries from public, anon, authenticated;
grant select on public.email_deliveries to authenticated;

-- ---------------------------------------------------------------------------
-- 3. Fonctions privilégiées (service_role seulement)
-- ---------------------------------------------------------------------------

-- Destinataires d'un envoi ouvert : e-mail confirmé, compte ni supprimé, ni banni, ni
-- anonyme, préférence active pour le type (défauts de la table sans ligne de réglages),
-- aucune ligne bloquante dans le journal pour (user_id, kind, period) et au moins un
-- élément candidat dans la fenêtre de p_day (jour de Paris de l'appel) :
-- - event_eve : rendez-vous non faits du lendemain avec « Rappel par e-mail » ;
-- - morning : rendez-vous non faits du jour avec « Rappel par e-mail », ou candidature
--   Envoyée ou Relancée avec « Me rappeler de relancer » due ce jour ;
-- - weekly_digest : semaine du lundi au dimanche de p_day, entretien ou relance non fait,
--   ou candidature due au plus tard le dimanche.
-- La sélection exacte (heure passée, plafonds) est refaite en TypeScript.
create function public.list_email_recipients(
  p_kind text,
  p_period text,
  p_day date,
  p_limit integer
)
returns table (user_id uuid, email text, follow_up_delay_days integer)
language plpgsql
stable
security definer
set search_path = ''
as $$
#variable_conflict use_column
declare
  v_from date;
  v_to date;
begin
  if p_kind is null or p_kind not in ('event_eve', 'morning', 'weekly_digest') then
    raise exception 'invalid_kind' using errcode = '22023';
  end if;
  if p_period is null
    or (p_kind <> 'weekly_digest'
      and p_period !~ '^[0-9]{4}-(0[1-9]|1[0-2])-(0[1-9]|[12][0-9]|3[01])$')
    or (p_kind = 'weekly_digest' and p_period !~ '^[0-9]{4}-W(0[1-9]|[1-4][0-9]|5[0-3])$') then
    raise exception 'invalid_period' using errcode = '22023';
  end if;
  if p_day is null then
    raise exception 'invalid_day' using errcode = '22023';
  end if;
  if p_limit is null or p_limit < 1 or p_limit > 500 then
    raise exception 'invalid_limit' using errcode = '22023';
  end if;

  if p_kind = 'event_eve' then
    v_from := p_day + 1;
    v_to := p_day + 1;
  elsif p_kind = 'morning' then
    v_from := p_day;
    v_to := p_day;
  else
    v_from := p_day - (extract(isodow from p_day)::integer - 1);
    v_to := v_from + 6;
  end if;

  return query
  select u.id, u.email::text, coalesce(s.follow_up_delay_days, 14)::integer
  from auth.users u
  left join public.user_settings s on s.user_id = u.id
  where u.email is not null
    and u.email_confirmed_at is not null
    and u.deleted_at is null
    and (u.banned_until is null or u.banned_until <= now())
    and coalesce(u.is_anonymous, false) = false
    and case
      when p_kind = 'weekly_digest' then coalesce(s.weekly_digest, false)
      else coalesce(s.email_reminders, true)
    end
    and not exists (
      select 1
      from public.email_deliveries d
      where d.user_id = u.id
        and d.kind = p_kind
        and d.period = p_period
        and (d.status <> 'failed' or d.attempts >= 3)
    )
    and (
      exists (
        select 1
        from public.scheduled_events e
        join public.applications a
          on a.id = e.application_id
          and a.user_id = e.user_id
        where e.user_id = u.id
          and e.done_at is null
          and a.deleted_at is null
          and e.scheduled_on between v_from and v_to
          and case
            when p_kind = 'weekly_digest' then e.kind in ('interview', 'follow_up')
            else e.email_reminder
          end
      )
      or (
        p_kind <> 'event_eve'
        and exists (
          select 1
          from public.applications a
          where a.user_id = u.id
            and a.deleted_at is null
            and a.follow_up_reminder
            and a.status in ('sent', 'followed_up')
            and case
              when p_kind = 'morning'
                then a.last_activity_on + coalesce(s.follow_up_delay_days, 14)::integer = p_day
              else a.last_activity_on + coalesce(s.follow_up_delay_days, 14)::integer <= v_to
            end
        )
      )
    )
  order by u.id
  limit p_limit;
end;
$$;

-- Données d'UN utilisateur pour son e-mail, en jsonb { events, applications } dont les
-- objets ont exactement les champs de EmailEventItem et EmailApplicationItem
-- (src/lib/notifications/selection.ts). Seulement les lignes où user_id = p_user_id :
-- - events : rendez-vous non faits de p_from à p_to, candidature non supprimée ;
-- - applications : candidatures non supprimées Envoyée ou Relancée avec « Me rappeler
--   de relancer », dues au plus tard p_to au délai de l'utilisateur (préfiltre ; la
--   règle exacte de la spec 2 est appliquée en TypeScript), les plus récentes d'abord.
-- Au plus 200 lignes en tout (rendez-vous d'abord) ; écart de 0 à 7 jours.
create function public.email_items_for_user(p_user_id uuid, p_from date, p_to date)
returns jsonb
language plpgsql
stable
security definer
set search_path = ''
as $$
declare
  v_delay integer;
  v_events jsonb;
  v_event_count integer;
  v_applications jsonb;
begin
  if p_user_id is null then
    raise exception 'invalid_user' using errcode = '22023';
  end if;
  if p_from is null or p_to is null or p_to < p_from or p_to - p_from > 7 then
    raise exception 'invalid_range' using errcode = '22023';
  end if;

  select coalesce(
    (select s.follow_up_delay_days from public.user_settings s where s.user_id = p_user_id),
    14
  )::integer
  into v_delay;

  select
    coalesce(
      jsonb_agg(
        jsonb_build_object(
          'user_id', t.user_id,
          'id', t.id,
          'kind', t.kind,
          'scheduled_on', t.scheduled_on,
          'scheduled_time', to_char(t.scheduled_time, 'HH24:MI'),
          'modality', t.modality,
          'note', t.note,
          'email_reminder', t.email_reminder,
          'done_at', t.done_at,
          'company', t.company,
          'job_title', t.job_title,
          'application_deleted_at', t.application_deleted_at
        )
        order by t.scheduled_on, t.scheduled_time, t.id
      ),
      '[]'::jsonb
    ),
    count(*)
  into v_events, v_event_count
  from (
    select
      e.user_id, e.id, e.kind, e.scheduled_on, e.scheduled_time, e.modality, e.note,
      e.email_reminder, e.done_at, a.company, a.job_title,
      a.deleted_at as application_deleted_at
    from public.scheduled_events e
    join public.applications a
      on a.id = e.application_id
      and a.user_id = e.user_id
    where e.user_id = p_user_id
      and a.user_id = p_user_id
      and e.done_at is null
      and a.deleted_at is null
      and e.scheduled_on between p_from and p_to
    order by e.scheduled_on, e.scheduled_time, e.id
    limit 200
  ) t;

  select coalesce(
    jsonb_agg(
      jsonb_build_object(
        'user_id', t.user_id,
        'id', t.id,
        'status', t.status,
        'follow_up_reminder', t.follow_up_reminder,
        'company', t.company,
        'job_title', t.job_title,
        'last_activity_on', t.last_activity_on,
        'deleted_at', t.deleted_at
      )
      order by t.last_activity_on desc, t.id
    ),
    '[]'::jsonb
  )
  into v_applications
  from (
    select
      a.user_id, a.id, a.status, a.follow_up_reminder, a.company, a.job_title,
      a.last_activity_on, a.deleted_at
    from public.applications a
    where a.user_id = p_user_id
      and a.deleted_at is null
      and a.follow_up_reminder
      and a.status in ('sent', 'followed_up')
      and a.last_activity_on + v_delay <= p_to
    order by a.last_activity_on desc, a.id
    limit 200 - v_event_count
  ) t;

  return jsonb_build_object('events', v_events, 'applications', v_applications);
end;
$$;

-- Réserve l'envoi (user_id, kind, period) avant l'envoi. Nouvelle ligne pending : son
-- id. Ligne failed avec moins de 3 tentatives : reprise (pending, attempts + 1), son id.
-- Sinon (déjà pending, sent, skipped, ou failed 3 fois) : null. Deux appels concurrents
-- ne peuvent pas réserver la même ligne (contrainte unique, puis verrou de ligne).
create function public.claim_email_delivery(p_user_id uuid, p_kind text, p_period text)
returns uuid
language plpgsql
volatile
security definer
set search_path = ''
as $$
declare
  v_id uuid;
begin
  if p_kind is null or p_kind not in ('event_eve', 'morning', 'weekly_digest') then
    raise exception 'invalid_kind' using errcode = '22023';
  end if;
  if p_period is null
    or (p_kind <> 'weekly_digest'
      and p_period !~ '^[0-9]{4}-(0[1-9]|1[0-2])-(0[1-9]|[12][0-9]|3[01])$')
    or (p_kind = 'weekly_digest' and p_period !~ '^[0-9]{4}-W(0[1-9]|[1-4][0-9]|5[0-3])$') then
    raise exception 'invalid_period' using errcode = '22023';
  end if;

  insert into public.email_deliveries (user_id, kind, period)
  values (p_user_id, p_kind, p_period)
  on conflict (user_id, kind, period) do nothing
  returning id into v_id;

  if v_id is not null then
    return v_id;
  end if;

  update public.email_deliveries d
  set status = 'pending',
      attempts = d.attempts + 1,
      error_code = null
  where d.user_id = p_user_id
    and d.kind = p_kind
    and d.period = p_period
    and d.status = 'failed'
    and d.attempts < 3
  returning d.id into v_id;

  return v_id;
end;
$$;

-- Termine un envoi réservé : pending vers sent (sent_at renseigné), skipped ou failed
-- (code d'erreur court, [a-z_] de 1 à 40 caractères, gardé pour failed seulement).
-- Ligne absente ou déjà terminée : delivery_not_pending.
create function public.finish_email_delivery(
  p_delivery_id uuid,
  p_status text,
  p_error_code text default null
)
returns void
language plpgsql
volatile
security definer
set search_path = ''
as $$
begin
  if p_status is null or p_status not in ('sent', 'skipped', 'failed') then
    raise exception 'invalid_status' using errcode = '22023';
  end if;
  if p_error_code is not null and p_error_code !~ '^[a-z_]{1,40}$' then
    raise exception 'invalid_error_code' using errcode = '22023';
  end if;

  update public.email_deliveries d
  set status = p_status,
      error_code = case when p_status = 'failed' then p_error_code end,
      sent_at = case when p_status = 'sent' then now() end
  where d.id = p_delivery_id
    and d.status = 'pending';

  if not found then
    raise exception 'delivery_not_pending' using errcode = 'P0002';
  end if;
end;
$$;

-- Désinscription sans session : reminders met email_reminders à false, digest met
-- weekly_digest à false (ligne de réglages créée au besoin). Ne peut que désactiver.
-- Compte inexistant : rien à faire. Autre portée : invalid_scope.
create function public.unsubscribe_email(p_user_id uuid, p_scope text)
returns void
language plpgsql
volatile
security definer
set search_path = ''
as $$
begin
  if p_scope is null or p_scope not in ('reminders', 'digest') then
    raise exception 'invalid_scope' using errcode = '22023';
  end if;

  if not exists (select 1 from auth.users u where u.id = p_user_id) then
    return;
  end if;

  if p_scope = 'reminders' then
    insert into public.user_settings (user_id, email_reminders)
    values (p_user_id, false)
    on conflict (user_id) do update set email_reminders = false;
  else
    insert into public.user_settings (user_id, weekly_digest)
    values (p_user_id, false)
    on conflict (user_id) do update set weekly_digest = false;
  end if;
end;
$$;

-- Purge des candidatures supprimées depuis plus de 10 minutes (délai de restauration de
-- la spec 2), au plus p_limit (1 à 1000) par appel, les plus anciennes d'abord ; leurs
-- événements et rendez-vous suivent par cascade. Renvoie le nombre supprimé.
create function public.purge_deleted_applications(p_limit integer)
returns integer
language plpgsql
volatile
security definer
set search_path = ''
as $$
declare
  v_count integer;
begin
  if p_limit is null or p_limit < 1 or p_limit > 1000 then
    raise exception 'invalid_limit' using errcode = '22023';
  end if;

  with doomed as (
    select a.id
    from public.applications a
    where a.deleted_at is not null
      and a.deleted_at < now() - interval '10 minutes'
    order by a.deleted_at
    limit p_limit
    for update skip locked
  )
  delete from public.applications a
  using doomed
  where a.id = doomed.id;

  get diagnostics v_count = row_count;
  return v_count;
end;
$$;

-- Conservation limitée du journal d'envoi : lignes de plus de 60 jours.
create function public.purge_email_deliveries()
returns integer
language plpgsql
volatile
security definer
set search_path = ''
as $$
declare
  v_count integer;
begin
  delete from public.email_deliveries d
  where d.created_at < now() - interval '60 days';

  get diagnostics v_count = row_count;
  return v_count;
end;
$$;

alter function public.list_email_recipients(text, text, date, integer) owner to postgres;
alter function public.email_items_for_user(uuid, date, date) owner to postgres;
alter function public.claim_email_delivery(uuid, text, text) owner to postgres;
alter function public.finish_email_delivery(uuid, text, text) owner to postgres;
alter function public.unsubscribe_email(uuid, text) owner to postgres;
alter function public.purge_deleted_applications(integer) owner to postgres;
alter function public.purge_email_deliveries() owner to postgres;

revoke execute on function public.list_email_recipients(text, text, date, integer)
  from public, anon, authenticated;
revoke execute on function public.email_items_for_user(uuid, date, date)
  from public, anon, authenticated;
revoke execute on function public.claim_email_delivery(uuid, text, text)
  from public, anon, authenticated;
revoke execute on function public.finish_email_delivery(uuid, text, text)
  from public, anon, authenticated;
revoke execute on function public.unsubscribe_email(uuid, text)
  from public, anon, authenticated;
revoke execute on function public.purge_deleted_applications(integer)
  from public, anon, authenticated;
revoke execute on function public.purge_email_deliveries()
  from public, anon, authenticated;

grant execute on function public.list_email_recipients(text, text, date, integer) to service_role;
grant execute on function public.email_items_for_user(uuid, date, date) to service_role;
grant execute on function public.claim_email_delivery(uuid, text, text) to service_role;
grant execute on function public.finish_email_delivery(uuid, text, text) to service_role;
grant execute on function public.unsubscribe_email(uuid, text) to service_role;
grant execute on function public.purge_deleted_applications(integer) to service_role;
grant execute on function public.purge_email_deliveries() to service_role;

notify pgrst, 'reload schema';
