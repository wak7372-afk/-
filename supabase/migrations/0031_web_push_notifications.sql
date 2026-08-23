-- User-controlled Web Push subscriptions and notification delivery queue.

alter table public.notifications
  add column if not exists action_url text,
  add column if not exists dedupe_key text;

create unique index if not exists notifications_user_dedupe_idx
  on public.notifications (user_id, dedupe_key)
  where dedupe_key is not null;

create table if not exists public.notification_preferences (
  user_id uuid primary key references public.users(id) on delete cascade,
  push_enabled boolean not null default false,
  report_reminders boolean not null default true,
  direct_messages boolean not null default true,
  circle_updates boolean not null default true,
  daily_report_time time not null default '08:00',
  timezone text not null default 'Asia/Muscat' check (timezone = 'Asia/Muscat'),
  updated_at timestamptz not null default now()
);

create table if not exists public.push_subscriptions (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references public.users(id) on delete cascade,
  endpoint text not null unique,
  p256dh text not null,
  auth_secret text not null,
  user_agent text,
  created_at timestamptz not null default now(),
  last_used_at timestamptz not null default now(),
  disabled_at timestamptz
);

create index if not exists push_subscriptions_active_user_idx
  on public.push_subscriptions (user_id)
  where disabled_at is null;

create table if not exists public.notification_deliveries (
  id uuid primary key default gen_random_uuid(),
  notification_id uuid not null references public.notifications(id) on delete cascade,
  subscription_id uuid not null references public.push_subscriptions(id) on delete cascade,
  status text not null default 'pending' check (status in ('pending', 'processing', 'sent', 'failed')),
  attempts integer not null default 0 check (attempts >= 0),
  next_attempt_at timestamptz not null default now(),
  claimed_at timestamptz,
  sent_at timestamptz,
  error_message text,
  created_at timestamptz not null default now(),
  unique (notification_id, subscription_id)
);

create index if not exists notification_deliveries_pending_idx
  on public.notification_deliveries (next_attempt_at, created_at)
  where status in ('pending', 'failed');

alter table public.notification_preferences enable row level security;
alter table public.push_subscriptions enable row level security;
alter table public.notification_deliveries enable row level security;

drop policy if exists "Users read own notification preferences" on public.notification_preferences;
create policy "Users read own notification preferences"
  on public.notification_preferences for select to authenticated
  using (user_id = auth.uid());

drop policy if exists "Users insert own notification preferences" on public.notification_preferences;
create policy "Users insert own notification preferences"
  on public.notification_preferences for insert to authenticated
  with check (user_id = auth.uid());

drop policy if exists "Users update own notification preferences" on public.notification_preferences;
create policy "Users update own notification preferences"
  on public.notification_preferences for update to authenticated
  using (user_id = auth.uid()) with check (user_id = auth.uid());

drop policy if exists "Users read own push subscriptions" on public.push_subscriptions;
create policy "Users read own push subscriptions"
  on public.push_subscriptions for select to authenticated
  using (user_id = auth.uid());

drop policy if exists "Users insert own push subscriptions" on public.push_subscriptions;
create policy "Users insert own push subscriptions"
  on public.push_subscriptions for insert to authenticated
  with check (user_id = auth.uid());

drop policy if exists "Users update own push subscriptions" on public.push_subscriptions;
create policy "Users update own push subscriptions"
  on public.push_subscriptions for update to authenticated
  using (user_id = auth.uid()) with check (user_id = auth.uid());

drop policy if exists "Users delete own push subscriptions" on public.push_subscriptions;
create policy "Users delete own push subscriptions"
  on public.push_subscriptions for delete to authenticated
  using (user_id = auth.uid());

revoke all on public.notification_preferences, public.push_subscriptions, public.notification_deliveries from anon, authenticated;
grant select, insert, update on public.notification_preferences to authenticated;
grant select, insert, update, delete on public.push_subscriptions to authenticated;

create or replace function public.touch_notification_preferences()
returns trigger language plpgsql set search_path = pg_catalog, public as $$
begin
  new.updated_at := now();
  return new;
end;
$$;

drop trigger if exists touch_notification_preferences on public.notification_preferences;
create trigger touch_notification_preferences
  before update on public.notification_preferences
  for each row execute function public.touch_notification_preferences();

create or replace function public.queue_push_delivery()
returns trigger
language plpgsql
security definer
set search_path = pg_catalog, public
set row_security = off
as $$
begin
  insert into public.notification_deliveries (notification_id, subscription_id)
  select new.id, subscription.id
  from public.push_subscriptions subscription
  join public.notification_preferences preference on preference.user_id = subscription.user_id
  where subscription.user_id = new.user_id
    and subscription.disabled_at is null
    and preference.push_enabled = true
    and case
      when new.type = 'quran_daily_reminder' then preference.report_reminders
      when new.type = 'direct_message' then preference.direct_messages
      when new.type = 'circle_post' then preference.circle_updates
      else true
    end
  on conflict (notification_id, subscription_id) do nothing;
  return new;
end;
$$;

drop trigger if exists queue_push_delivery on public.notifications;
create trigger queue_push_delivery
  after insert on public.notifications
  for each row execute function public.queue_push_delivery();

create or replace function public.notify_direct_message_receiver()
returns trigger
language plpgsql
security definer
set search_path = pg_catalog, public
set row_security = off
as $$
declare
  sender_name text;
  receiver_role text;
  destination text;
begin
  select full_name into sender_name from public.users where id = new.sender_id;
  select role into receiver_role from public.users where id = new.receiver_id;
  destination := case when receiver_role = 'teacher' then '/teacher/chat.html' else '/student/chat.html' end
    || '?contact=' || new.sender_id::text;

  insert into public.notifications (user_id, title, body, type, action_url, dedupe_key)
  values (
    new.receiver_id,
    'رسالة جديدة من ' || coalesce(sender_name, 'أحد مستخدمي المركز'),
    left(new.content, 180),
    'direct_message',
    destination,
    'direct-message:' || new.id::text
  ) on conflict (user_id, dedupe_key) where dedupe_key is not null do nothing;
  return new;
end;
$$;

drop trigger if exists notify_direct_message_receiver on public.messages;
create trigger notify_direct_message_receiver
  after insert on public.messages
  for each row execute function public.notify_direct_message_receiver();

create or replace function public.enqueue_due_quran_report_reminders(p_now timestamptz default now())
returns integer
language plpgsql
security definer
set search_path = pg_catalog, public
set row_security = off
as $$
declare
  inserted_count integer := 0;
begin
  if auth.role() <> 'service_role' then
    raise exception 'Service role required' using errcode = '42501';
  end if;

  insert into public.notifications (user_id, title, body, type, action_url, dedupe_key)
  select
    preference.user_id,
    'تذكير بتقرير القرآن اليومي',
    'لديك تقرير يومي ينتظر الإنجاز. افتح تقارير القرآن وابدأ من حيث وصلت.',
    'quran_daily_reminder',
    '/student/reports.html?date=' || local_clock.local_date::text,
    'quran-daily-reminder:' || local_clock.local_date::text
  from public.notification_preferences preference
  cross join lateral (
    select
      (p_now at time zone preference.timezone)::date as local_date,
      (p_now at time zone preference.timezone)::time as local_time
  ) local_clock
  where preference.push_enabled = true
    and preference.report_reminders = true
    and local_clock.local_time >= preference.daily_report_time
    and local_clock.local_time < preference.daily_report_time + interval '10 minutes'
    and exists (
      select 1
      from public.quran_report_assignments assignment
      where assignment.student_id = preference.user_id
        and assignment.report_date = local_clock.local_date
        and assignment.status = 'pending'
        and assignment.starts_at <= p_now
    )
  on conflict (user_id, dedupe_key) where dedupe_key is not null do nothing;

  get diagnostics inserted_count = row_count;
  return inserted_count;
end;
$$;

revoke all on function public.enqueue_due_quran_report_reminders(timestamptz) from public, anon, authenticated;
grant execute on function public.enqueue_due_quran_report_reminders(timestamptz) to service_role;

create or replace function public.claim_push_deliveries(p_limit integer default 100)
returns uuid[]
language plpgsql
security definer
set search_path = pg_catalog, public
set row_security = off
as $$
declare
  claimed_ids uuid[];
begin
  if auth.role() <> 'service_role' then
    raise exception 'Service role required' using errcode = '42501';
  end if;

  with candidates as (
    select delivery.id
    from public.notification_deliveries delivery
    where (
        delivery.status in ('pending', 'failed') and delivery.next_attempt_at <= now()
      ) or (
        delivery.status = 'processing' and delivery.claimed_at < now() - interval '15 minutes'
      )
    order by delivery.created_at
    for update skip locked
    limit greatest(1, least(coalesce(p_limit, 100), 250))
  ), claimed as (
    update public.notification_deliveries delivery
    set status = 'processing', attempts = delivery.attempts + 1, claimed_at = now(), error_message = null
    from candidates
    where delivery.id = candidates.id
    returning delivery.id
  )
  select coalesce(array_agg(id), array[]::uuid[]) into claimed_ids from claimed;

  return claimed_ids;
end;
$$;

revoke all on function public.claim_push_deliveries(integer) from public, anon, authenticated;
grant execute on function public.claim_push_deliveries(integer) to service_role;

create extension if not exists pg_net with schema extensions;
create extension if not exists supabase_vault with schema vault;

create or replace function public.dispatch_pending_push_notifications()
returns bigint
language plpgsql
security definer
set search_path = pg_catalog, public, extensions, net, vault
as $$
declare
  endpoint_url text := 'https://yyqxesnrlgzifydkzkpd.supabase.co/functions/v1/push-notifications';
  scheduler_secret text;
  anonymous_key text;
  request_id bigint;
begin
  select decrypted_secret into scheduler_secret
  from vault.decrypted_secrets
  where name = 'push_cron_secret'
  order by created_at desc
  limit 1;

  select decrypted_secret into anonymous_key
  from vault.decrypted_secrets
  where name = 'push_anon_key'
  order by created_at desc
  limit 1;

  if nullif(scheduler_secret, '') is null or nullif(anonymous_key, '') is null then
    raise warning 'Push scheduler secrets are not configured in Supabase Vault';
    return null;
  end if;

  select net.http_post(
    url := endpoint_url,
    headers := jsonb_build_object(
      'Content-Type', 'application/json',
      'Authorization', 'Bearer ' || anonymous_key,
      'x-cron-secret', scheduler_secret
    ),
    body := jsonb_build_object('action', 'dispatch'),
    timeout_milliseconds := 10000
  ) into request_id;

  return request_id;
end;
$$;

revoke all on function public.dispatch_pending_push_notifications() from public, anon, authenticated;

do $$
declare
  existing_job bigint;
begin
  select jobid into existing_job
  from cron.job
  where jobname = 'push-notifications-every-five-minutes';

  if existing_job is not null then
    perform cron.unschedule(existing_job);
  end if;

  perform cron.schedule(
    'push-notifications-every-five-minutes',
    '*/5 * * * *',
    'select public.dispatch_pending_push_notifications();'
  );
end;
$$;
