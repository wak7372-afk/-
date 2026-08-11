-- Idempotent daily Quran completion summaries, published at 23:05 Asia/Muscat.

create extension if not exists pg_cron;

create table if not exists public.quran_daily_summary_runs (
  circle_id uuid not null references public.learning_circles(id) on delete restrict,
  summary_date date not null,
  post_id uuid not null unique references public.learning_circle_posts(id) on delete restrict,
  counts jsonb not null,
  generated_at timestamptz not null default now(),
  primary key (circle_id, summary_date),
  constraint quran_daily_summary_counts_object check (jsonb_typeof(counts) = 'object')
);

create index if not exists quran_daily_summary_runs_generated_idx
  on public.quran_daily_summary_runs (generated_at desc);

create or replace function public.prevent_quran_daily_summary_run_changes()
returns trigger
language plpgsql
set search_path = pg_catalog, public
as $$
begin
  raise exception 'Quran daily summary runs are immutable';
end;
$$;

drop trigger if exists protect_quran_daily_summary_runs on public.quran_daily_summary_runs;
create trigger protect_quran_daily_summary_runs
  before update or delete on public.quran_daily_summary_runs
  for each row execute procedure public.prevent_quran_daily_summary_run_changes();

create or replace function public.get_quran_daily_summary_snapshot(
  p_circle_id uuid,
  p_summary_date date,
  p_as_of timestamptz
)
returns jsonb
language sql
stable
security definer
set search_path = pg_catalog, public
set row_security = off
as $$
  with student_rollup as (
    select
      assignment.student_id,
      user_profile.full_name,
      user_profile.username,
      count(*)::integer as assignment_count,
      count(*) filter (where assignment.status = 'completed')::integer as completed_count,
      count(*) filter (where assignment.status = 'exempted')::integer as exempted_count,
      count(*) filter (where assignment.status = 'pending')::integer as pending_count,
      bool_or(
        assignment.status = 'pending'
        and assignment.effective_due_at <= p_as_of
      ) as has_expired_pending,
      bool_or(
        assignment.status = 'pending'
        and assignment.effective_due_at > p_as_of
      ) as has_future_pending,
      bool_or(
        assignment.status = 'completed'
        and assignment.completed_at > assignment.effective_due_at
      ) as has_late_completion
    from public.quran_report_assignments assignment
    join public.quran_reports report on report.id = assignment.report_id
    join public.users user_profile on user_profile.id = assignment.student_id
    where assignment.circle_id = p_circle_id
      and assignment.report_date = p_summary_date
      and assignment.status in ('pending', 'completed', 'exempted')
      and report.status = 'published'
    group by assignment.student_id, user_profile.full_name, user_profile.username
  ), classified as (
    select
      student_rollup.*,
      case
        when has_expired_pending then 'incomplete'
        when has_future_pending then 'extended'
        when completed_count = 0 and exempted_count > 0 then 'exempted'
        when has_late_completion then 'late'
        else 'on_time'
      end as completion_state
    from student_rollup
  ), student_items as (
    select
      completion_state,
      full_name,
      jsonb_build_object(
        'student_id', student_id,
        'full_name', full_name,
        'username', username,
        'assignment_count', assignment_count,
        'completed_count', completed_count,
        'exempted_count', exempted_count,
        'pending_count', pending_count
      ) as student_item
    from classified
  )
  select jsonb_build_object(
    'circle_id', p_circle_id,
    'summary_date', p_summary_date,
    'generated_as_of', p_as_of,
    'student_count', count(*),
    'counts', jsonb_build_object(
      'on_time', count(*) filter (where completion_state = 'on_time'),
      'late', count(*) filter (where completion_state = 'late'),
      'incomplete', count(*) filter (where completion_state = 'incomplete'),
      'extended', count(*) filter (where completion_state = 'extended'),
      'exempted', count(*) filter (where completion_state = 'exempted')
    ),
    'groups', jsonb_build_object(
      'on_time', coalesce(jsonb_agg(student_item order by full_name) filter (where completion_state = 'on_time'), '[]'::jsonb),
      'late', coalesce(jsonb_agg(student_item order by full_name) filter (where completion_state = 'late'), '[]'::jsonb),
      'incomplete', coalesce(jsonb_agg(student_item order by full_name) filter (where completion_state = 'incomplete'), '[]'::jsonb),
      'extended', coalesce(jsonb_agg(student_item order by full_name) filter (where completion_state = 'extended'), '[]'::jsonb),
      'exempted', coalesce(jsonb_agg(student_item order by full_name) filter (where completion_state = 'exempted'), '[]'::jsonb)
    )
  )
  from student_items;
$$;

create or replace function public.quran_daily_summary_group_text(
  p_icon text,
  p_label text,
  p_students jsonb
)
returns text
language plpgsql
immutable
set search_path = pg_catalog, public
as $$
declare
  student_record record;
  student_count integer := jsonb_array_length(coalesce(p_students, '[]'::jsonb));
  output_text text := format('%s %s (%s):', p_icon, p_label, student_count);
begin
  if student_count = 0 then
    return output_text || E'\nلا يوجد';
  end if;

  for student_record in
    select item.value, item.ordinality
    from jsonb_array_elements(p_students) with ordinality as item(value, ordinality)
    where item.ordinality <= 18
    order by item.ordinality
  loop
    output_text := output_text || format(
      E'\n%s. %s',
      student_record.ordinality,
      left(coalesce(student_record.value ->> 'full_name', 'طالب'), 120)
    );
  end loop;

  if student_count > 18 then
    output_text := output_text || format(E'\nو%s طالباً آخر.', student_count - 18);
  end if;

  return output_text;
end;
$$;

create or replace function public.publish_quran_daily_summaries(
  p_summary_date date default ((now() at time zone 'Asia/Muscat')::date),
  p_circle_id uuid default null
)
returns jsonb
language plpgsql
security definer
set search_path = pg_catalog, public, cron
set row_security = off
as $$
declare
  circle_record record;
  snapshot jsonb;
  post_body text;
  post_id_value uuid;
  post_was_created boolean;
  processed_count integer := 0;
  published_count integer := 0;
  skipped_count integer := 0;
  system_key_value text;
begin
  if auth.uid() is not null and not public.is_admin() then
    raise exception 'Only administrators may publish Quran daily summaries manually' using errcode = '42501';
  end if;
  if p_summary_date is null then raise exception 'Summary date is required'; end if;
  if p_summary_date > (now() at time zone 'Asia/Muscat')::date then
    raise exception 'A future Quran summary cannot be published';
  end if;
  if p_summary_date = (now() at time zone 'Asia/Muscat')::date
     and (now() at time zone 'Asia/Muscat')::time < time '23:00' then
    raise exception 'The current Quran summary may only be published after 23:00 Asia/Muscat';
  end if;

  for circle_record in
    select distinct circle.id, circle.name
    from public.learning_circles circle
    join public.quran_report_assignments assignment on assignment.circle_id = circle.id
    join public.quran_reports report on report.id = assignment.report_id
    where circle.circle_type = 'quran'
      and circle.status = 'active'
      and assignment.report_date = p_summary_date
      and assignment.status in ('pending', 'completed', 'exempted')
      and report.status = 'published'
      and (p_circle_id is null or circle.id = p_circle_id)
    order by circle.name
  loop
    processed_count := processed_count + 1;
    post_id_value := null;
    post_was_created := false;
    snapshot := public.get_quran_daily_summary_snapshot(circle_record.id, p_summary_date, now());
    system_key_value := format('quran-daily-summary:%s', p_summary_date);

    post_body := format('ملخص تقارير القرآن اليومية للحلقة: %s', circle_record.name)
      || E'\nالتاريخ: ' || p_summary_date::text
      || E'\n\n' || public.quran_daily_summary_group_text('✓', 'المنجزون في الوقت', snapshot #> '{groups,on_time}')
      || E'\n\n' || public.quran_daily_summary_group_text('⏱', 'المنجزون بعد المهلة', snapshot #> '{groups,late}')
      || E'\n\n' || public.quran_daily_summary_group_text('⌛', 'ضمن مهلة معتمدة', snapshot #> '{groups,extended}')
      || E'\n\n' || public.quran_daily_summary_group_text('✕', 'غير المنجزين', snapshot #> '{groups,incomplete}')
      || E'\n\n' || public.quran_daily_summary_group_text('◇', 'المعفون من تقارير اليوم', snapshot #> '{groups,exempted}');

    if char_length(post_body) > 10000 then
      post_body := left(post_body, 9940) || E'\nتم اختصار القائمة لكثرة عدد الطلاب.';
    end if;

    insert into public.learning_circle_posts (
      circle_id, post_type, title, body, author_id, status, replies_enabled,
      is_pinned, system_key, published_at
    ) values (
      circle_record.id,
      'system',
      'تقرير إنجاز يوم ' || p_summary_date::text,
      post_body,
      null,
      'published',
      false,
      false,
      system_key_value,
      now()
    )
    on conflict (circle_id, system_key) where system_key is not null do nothing
    returning id into post_id_value;

    if post_id_value is not null then
      post_was_created := true;
      published_count := published_count + 1;
    else
      skipped_count := skipped_count + 1;
      select post.id into post_id_value
      from public.learning_circle_posts post
      where post.circle_id = circle_record.id and post.system_key = system_key_value;
    end if;

    insert into public.quran_daily_summary_runs (
      circle_id, summary_date, post_id, counts, generated_at
    ) values (
      circle_record.id, p_summary_date, post_id_value, snapshot -> 'counts', now()
    ) on conflict (circle_id, summary_date) do nothing;

    if post_was_created then
      insert into public.platform_audit_events (
        actor_id, circle_id, action, entity_type, entity_id, after_data, metadata
      ) values (
        auth.uid(),
        circle_record.id,
        'quran_reports.daily_summary_published',
        'learning_circle_post',
        post_id_value::text,
        snapshot -> 'counts',
        jsonb_build_object('summary_date', p_summary_date, 'system_key', system_key_value)
      );
    end if;
  end loop;

  return jsonb_build_object(
    'summary_date', p_summary_date,
    'processed_circles', processed_count,
    'published_posts', published_count,
    'skipped_existing', skipped_count
  );
end;
$$;

alter table public.quran_daily_summary_runs enable row level security;

drop policy if exists "Admins view Quran summary runs" on public.quran_daily_summary_runs;
create policy "Admins view Quran summary runs"
  on public.quran_daily_summary_runs for select to authenticated
  using (public.is_admin());

revoke all on public.quran_daily_summary_runs from anon, authenticated;
grant select on public.quran_daily_summary_runs to authenticated;

revoke all on function public.prevent_quran_daily_summary_run_changes() from public;
revoke all on function public.get_quran_daily_summary_snapshot(uuid, date, timestamptz) from public;
revoke all on function public.quran_daily_summary_group_text(text, text, jsonb) from public;
revoke all on function public.publish_quran_daily_summaries(date, uuid) from public;
grant execute on function public.publish_quran_daily_summaries(date, uuid) to authenticated, service_role;

select cron.schedule(
  'quran-daily-summary-muscat-2305',
  '5 19 * * *',
  'select public.publish_quran_daily_summaries();'
);
