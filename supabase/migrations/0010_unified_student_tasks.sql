-- Unified scheduled tasks for Quran assignments and classroom work.

update public.users
set full_name = 'مدير المركز', updated_at = now()
where username = 'warith'
  and (full_name is null or btrim(full_name) = '' or full_name ~ '^\?+$' or full_name like '%??%');

create table if not exists public.task_import_batches (
  id uuid primary key default gen_random_uuid(),
  created_by uuid not null references public.users(id) on delete restrict,
  halaqa_id uuid not null references public.halaqat(id) on delete cascade,
  source text not null default 'manual' check (source in ('manual', 'excel', 'ai')),
  file_name text,
  row_count integer not null default 0 check (row_count between 0 and 500),
  metadata jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default now()
);

alter table public.task_import_batches enable row level security;
revoke all on public.task_import_batches from anon;
grant select on public.task_import_batches to authenticated;

create policy "Teachers view own task batches"
  on public.task_import_batches for select
  using (created_by = auth.uid() or public.is_admin());

alter table public.daily_assignments
  add column if not exists title text,
  add column if not exists period text not null default 'flexible',
  add column if not exists scheduled_at timestamptz,
  add column if not exists due_at timestamptz,
  add column if not exists estimated_minutes smallint not null default 30,
  add column if not exists priority smallint not null default 2,
  add column if not exists source text not null default 'manual',
  add column if not exists import_batch_id uuid references public.task_import_batches(id) on delete set null,
  add column if not exists series_id uuid,
  add column if not exists is_published boolean not null default true,
  add column if not exists updated_at timestamptz not null default now();

update public.daily_assignments
set title = case when type = 'hifz' then 'مهمة حفظ' else 'مهمة مراجعة' end
where title is null or btrim(title) = '';

alter table public.daily_assignments
  alter column title set not null;

alter table public.daily_assignments
  add constraint daily_assignments_title_length
  check (char_length(title) between 1 and 160) not valid;
alter table public.daily_assignments
  add constraint daily_assignments_content_length
  check (char_length(content) between 1 and 2000) not valid;
alter table public.daily_assignments
  add constraint daily_assignments_period_check
  check (period in ('morning', 'evening', 'flexible')) not valid;
alter table public.daily_assignments
  add constraint daily_assignments_estimated_minutes_check
  check (estimated_minutes between 5 and 480) not valid;
alter table public.daily_assignments
  add constraint daily_assignments_priority_check
  check (priority between 1 and 3) not valid;
alter table public.daily_assignments
  add constraint daily_assignments_source_check
  check (source in ('manual', 'excel', 'ai')) not valid;
alter table public.daily_assignments
  add constraint daily_assignments_schedule_check
  check (due_at is null or scheduled_at is null or due_at >= scheduled_at) not valid;

create index if not exists daily_assignments_schedule_idx
  on public.daily_assignments (assignment_date, period, due_at);
create index if not exists daily_assignments_import_batch_idx
  on public.daily_assignments (import_batch_id)
  where import_batch_id is not null;
create index if not exists assignment_submissions_student_status_idx
  on public.assignment_submissions (student_id, status, created_at desc);

create or replace function public.touch_daily_assignment_updated_at()
returns trigger
language plpgsql
set search_path = public
as $$
begin
  new.updated_at := now();
  return new;
end;
$$;

drop trigger if exists touch_daily_assignment_updated_at on public.daily_assignments;
create trigger touch_daily_assignment_updated_at
  before update on public.daily_assignments
  for each row execute procedure public.touch_daily_assignment_updated_at();

create or replace function public.publish_task_batch(
  p_halaqa_id uuid,
  p_assignments jsonb,
  p_source text default 'manual',
  p_file_name text default null,
  p_metadata jsonb default '{}'::jsonb
)
returns jsonb
language plpgsql
security definer
set search_path = pg_catalog, public
set row_security = off
as $$
declare
  caller_role public.user_role;
  halaqa_teacher_id uuid;
  batch_id uuid;
  item jsonb;
  assignment_id uuid;
  target_student_id uuid;
  item_type public.assignment_type;
  item_date date;
  item_title text;
  item_content text;
  item_period text;
  item_scheduled_at timestamptz;
  item_due_at timestamptz;
  item_estimated_minutes smallint;
  item_priority smallint;
  item_series_id uuid;
  assignment_count integer := 0;
  recipient_count integer := 0;
  inserted_recipients integer := 0;
begin
  caller_role := public.current_user_role();
  if caller_role not in ('teacher', 'admin') then
    raise exception 'Only active teachers and administrators may publish tasks' using errcode = '42501';
  end if;

  if p_source not in ('manual', 'excel', 'ai') then
    raise exception 'Invalid task source';
  end if;
  if jsonb_typeof(p_assignments) <> 'array'
     or jsonb_array_length(p_assignments) < 1
     or jsonb_array_length(p_assignments) > 500 then
    raise exception 'Assignments must contain between 1 and 500 rows';
  end if;

  select teacher_id into halaqa_teacher_id
  from public.halaqat
  where id = p_halaqa_id;
  if halaqa_teacher_id is null then raise exception 'Halaqa not found'; end if;
  if caller_role = 'teacher' and halaqa_teacher_id <> auth.uid() then
    raise exception 'The halaqa is not owned by this teacher' using errcode = '42501';
  end if;

  insert into public.task_import_batches (created_by, halaqa_id, source, file_name, row_count, metadata)
  values (auth.uid(), p_halaqa_id, p_source, p_file_name, jsonb_array_length(p_assignments), coalesce(p_metadata, '{}'::jsonb))
  returning id into batch_id;

  for item in select value from jsonb_array_elements(p_assignments)
  loop
    item_type := case item ->> 'type'
      when 'hifz' then 'hifz'::public.assignment_type
      when 'murajaa' then 'murajaa'::public.assignment_type
      else null
    end;
    item_title := btrim(coalesce(item ->> 'title', ''));
    item_content := btrim(coalesce(item ->> 'content', ''));
    item_period := coalesce(nullif(item ->> 'period', ''), 'flexible');
    item_date := nullif(item ->> 'date', '')::date;
    item_scheduled_at := nullif(item ->> 'scheduled_at', '')::timestamptz;
    item_due_at := nullif(item ->> 'due_at', '')::timestamptz;
    item_estimated_minutes := coalesce(nullif(item ->> 'estimated_minutes', '')::smallint, 30);
    item_priority := coalesce(nullif(item ->> 'priority', '')::smallint, 2);
    item_series_id := nullif(item ->> 'series_id', '')::uuid;
    target_student_id := nullif(item ->> 'student_id', '')::uuid;

    if item_type is null or item_date is null
       or char_length(item_title) not between 1 and 160
       or char_length(item_content) not between 1 and 2000
       or item_period not in ('morning', 'evening', 'flexible')
       or item_estimated_minutes not between 5 and 480
       or item_priority not between 1 and 3
       or (item_due_at is not null and item_scheduled_at is not null and item_due_at < item_scheduled_at) then
      raise exception 'Invalid task row in the publishing batch';
    end if;

    if target_student_id is not null and not exists (
      select 1 from public.halaqa_students
      where halaqa_id = p_halaqa_id and student_id = target_student_id
    ) then
      raise exception 'A target student is not enrolled in the halaqa';
    end if;

    insert into public.daily_assignments (
      halaqa_id, student_id, teacher_id, type, title, content, assignment_date,
      period, scheduled_at, due_at, estimated_minutes, priority, source,
      import_batch_id, series_id, is_published
    ) values (
      p_halaqa_id, target_student_id, halaqa_teacher_id, item_type, item_title, item_content, item_date,
      item_period, item_scheduled_at, item_due_at, item_estimated_minutes, item_priority, p_source,
      batch_id, item_series_id, true
    ) returning id into assignment_id;

    if target_student_id is not null then
      insert into public.assignment_submissions (assignment_id, student_id, status)
      values (assignment_id, target_student_id, 'pending');
      inserted_recipients := 1;
    else
      insert into public.assignment_submissions (assignment_id, student_id, status)
      select assignment_id, hs.student_id, 'pending'::public.submission_status
      from public.halaqa_students hs
      where hs.halaqa_id = p_halaqa_id;
      get diagnostics inserted_recipients = row_count;
      if inserted_recipients = 0 then raise exception 'The halaqa has no enrolled students'; end if;
    end if;

    assignment_count := assignment_count + 1;
    recipient_count := recipient_count + inserted_recipients;
  end loop;

  return jsonb_build_object(
    'batch_id', batch_id,
    'assignments_count', assignment_count,
    'recipients_count', recipient_count
  );
end;
$$;

revoke all on function public.publish_task_batch(uuid, jsonb, text, text, jsonb) from public;
grant execute on function public.publish_task_batch(uuid, jsonb, text, text, jsonb) to authenticated;

create or replace function public.get_student_task_feed(p_start_date date, p_end_date date)
returns jsonb
language plpgsql
stable
security definer
set search_path = pg_catalog, public
set row_security = off
as $$
declare
  result jsonb;
begin
  if public.current_user_role() <> 'student' then
    raise exception 'Only active students may load this task feed' using errcode = '42501';
  end if;
  if p_start_date is null or p_end_date is null or p_end_date < p_start_date or p_end_date - p_start_date > 45 then
    raise exception 'Invalid task date range';
  end if;

  select coalesce(jsonb_agg(to_jsonb(feed) order by feed.task_date, feed.due_at nulls last, feed.priority desc), '[]'::jsonb)
  into result
  from (
    select
      'quran'::text as source,
      da.id as task_id,
      s.id as submission_id,
      da.title,
      da.content,
      da.type::text as category,
      da.assignment_date as task_date,
      da.period,
      da.scheduled_at,
      da.due_at,
      da.estimated_minutes,
      da.priority,
      case
        when s.status = 'done' then 'done'
        when da.due_at is not null and da.due_at < now() then 'overdue'
        else 'pending'
      end as status,
      s.teacher_notes,
      case when s.status = 'done' then 10 else 0 end as points,
      null::uuid as classroom_id,
      h.name as context_name
    from public.assignment_submissions s
    join public.daily_assignments da on da.id = s.assignment_id
    left join public.halaqat h on h.id = da.halaqa_id
    where s.student_id = auth.uid()
      and da.is_published = true
      and da.assignment_date between p_start_date and p_end_date

    union all

    select
      'classroom'::text as source,
      ae.id as task_id,
      aes.id as submission_id,
      ae.title,
      coalesce(ae.description, 'واجب الفصل') as content,
      'classroom'::text as category,
      coalesce(ae.due_date::date, ae.created_at::date) as task_date,
      'flexible'::text as period,
      null::timestamptz as scheduled_at,
      ae.due_date as due_at,
      30::smallint as estimated_minutes,
      2::smallint as priority,
      case
        when aes.submitted_at is not null then 'done'
        when ae.due_date is not null and ae.due_date < now() then 'overdue'
        else 'pending'
      end as status,
      aes.teacher_feedback as teacher_notes,
      case when aes.submitted_at is not null then 15 else 0 end as points,
      c.id as classroom_id,
      c.name as context_name
    from public.assignments_extra ae
    join public.classrooms c on c.id = ae.classroom_id
    join public.classroom_students cs on cs.classroom_id = c.id and cs.student_id = auth.uid()
    left join public.assignment_extra_submissions aes
      on aes.assignment_extra_id = ae.id and aes.student_id = auth.uid()
    where coalesce(ae.due_date::date, ae.created_at::date) between p_start_date and p_end_date
  ) feed;

  return result;
end;
$$;

revoke all on function public.get_student_task_feed(date, date) from public;
grant execute on function public.get_student_task_feed(date, date) to authenticated;

create or replace function public.notify_new_quran_task()
returns trigger
language plpgsql
security definer
set search_path = pg_catalog, public
set row_security = off
as $$
declare
  assignment_title text;
begin
  select title into assignment_title
  from public.daily_assignments
  where id = new.assignment_id;

  insert into public.notifications (user_id, title, body, type)
  values (new.student_id, 'مهمة جديدة', coalesce(assignment_title, 'أضيفت مهمة جديدة إلى جدولك'), 'quran_task_created');
  return new;
end;
$$;

drop trigger if exists notify_new_quran_task on public.assignment_submissions;
create trigger notify_new_quran_task
  after insert on public.assignment_submissions
  for each row execute procedure public.notify_new_quran_task();

