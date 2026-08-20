-- Student-requested Quran plan shifts, reviewed by the lead teacher or an administrator.

create table if not exists public.quran_plan_shift_requests (
  id uuid primary key default gen_random_uuid(),
  circle_id uuid not null references public.learning_circles(id) on delete cascade,
  student_id uuid not null references public.users(id) on delete cascade,
  requested_from_date date not null,
  reason text not null,
  status text not null default 'pending' check (status in ('pending', 'approved', 'rejected')),
  decision_target_date date,
  shift_days integer,
  decision_note text,
  decision_result jsonb,
  decided_by uuid references public.users(id) on delete set null,
  requested_at timestamptz not null default now(),
  decided_at timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  constraint quran_plan_shift_request_reason check (char_length(btrim(reason)) between 3 and 2000),
  constraint quran_plan_shift_request_decision check (
    (status = 'pending' and decision_target_date is null and shift_days is null and decided_at is null)
    or
    (status = 'approved' and decision_target_date is not null and shift_days between 1 and 365 and decided_at is not null)
    or
    (status = 'rejected' and decision_target_date is null and shift_days is null and decided_at is not null)
  )
);

create unique index if not exists quran_plan_shift_one_pending_idx
  on public.quran_plan_shift_requests (circle_id, student_id)
  where status = 'pending';

create index if not exists quran_plan_shift_queue_idx
  on public.quran_plan_shift_requests (circle_id, status, requested_at desc);

drop trigger if exists touch_quran_plan_shift_requests on public.quran_plan_shift_requests;
create trigger touch_quran_plan_shift_requests
  before update on public.quran_plan_shift_requests
  for each row execute function public.touch_quran_report_record();

alter table public.quran_plan_shift_requests enable row level security;
revoke all on public.quran_plan_shift_requests from anon, authenticated;

create or replace function public.request_quran_plan_shift(
  p_from_date date,
  p_reason text
)
returns jsonb
language plpgsql
security definer
set search_path = pg_catalog, public
set row_security = off
as $$
declare
  reason_value text := btrim(coalesce(p_reason, ''));
  circle_record record;
  request_record public.quran_plan_shift_requests%rowtype;
  overdue_count integer;
begin
  if auth.uid() is null or not exists (
    select 1 from public.users u
    where u.id = auth.uid() and u.role = 'student' and u.is_active = true
  ) then
    raise exception 'Only active students may request a Quran plan shift' using errcode = '42501';
  end if;
  if p_from_date is null then
    raise exception 'An overdue report date is required';
  end if;
  if char_length(reason_value) not between 3 and 2000 then
    raise exception 'A clear Quran plan shift reason is required';
  end if;

  select c.id, c.name
  into circle_record
  from public.learning_circle_memberships m
  join public.learning_circles c on c.id = m.circle_id
  where m.student_id = auth.uid()
    and m.circle_type = 'quran'
    and m.status = 'active'
    and c.circle_type = 'quran'
    and c.status = 'active'
  order by m.joined_at desc
  limit 1;

  if circle_record.id is null then
    raise exception 'Student is not an active member of a Quran circle';
  end if;

  select count(*) into overdue_count
  from public.quran_report_assignments a
  where a.circle_id = circle_record.id
    and a.student_id = auth.uid()
    and a.report_date = p_from_date
    and a.status = 'pending'
    and a.effective_due_at < now();

  if overdue_count = 0 then
    raise exception 'The selected date does not contain an overdue Quran report';
  end if;

  if exists (
    select 1
    from public.quran_report_extension_items item
    join public.quran_report_assignments assignment on assignment.id = item.assignment_id
    where item.status = 'pending'
      and assignment.circle_id = circle_record.id
      and assignment.student_id = auth.uid()
      and assignment.report_date >= p_from_date
      and assignment.status = 'pending'
  ) then
    raise exception 'Resolve pending Quran extension requests before requesting a plan shift';
  end if;

  insert into public.quran_plan_shift_requests (
    circle_id, student_id, requested_from_date, reason
  ) values (
    circle_record.id, auth.uid(), p_from_date, reason_value
  )
  returning * into request_record;

  insert into public.notifications (user_id, title, body, type)
  select distinct s.teacher_id,
    'طلب ترحيل تقارير',
    'أرسل طالب طلباً لترحيل خطته القرآنية ابتداءً من ' || p_from_date::text || '.',
    'quran_plan_shift_requested'
  from public.learning_circle_staff s
  where s.circle_id = circle_record.id
    and s.staff_role = 'lead'
    and s.status = 'active';

  perform public.record_platform_audit(
    circle_record.id,
    'quran_reports.plan_shift_requested',
    'quran_plan_shift_request',
    request_record.id::text,
    null,
    to_jsonb(request_record),
    jsonb_build_object('student_id', auth.uid(), 'overdue_count', overdue_count)
  );

  return to_jsonb(request_record) || jsonb_build_object('circle_name', circle_record.name);
exception
  when unique_violation then
    raise exception 'A Quran plan shift request is already pending' using errcode = '23505';
end;
$$;

create or replace function public.get_my_quran_plan_shift_requests()
returns jsonb
language plpgsql
stable
security definer
set search_path = pg_catalog, public
set row_security = off
as $$
declare
  circle_record record;
begin
  if auth.uid() is null or not exists (
    select 1 from public.users u
    where u.id = auth.uid() and u.role = 'student' and u.is_active = true
  ) then
    raise exception 'Only active students may view Quran plan shift requests' using errcode = '42501';
  end if;

  select c.id, c.name
  into circle_record
  from public.learning_circle_memberships m
  join public.learning_circles c on c.id = m.circle_id
  where m.student_id = auth.uid()
    and m.circle_type = 'quran'
    and m.status = 'active'
    and c.circle_type = 'quran'
    and c.status = 'active'
  order by m.joined_at desc
  limit 1;

  if circle_record.id is null then
    return jsonb_build_object('circle_id', null, 'circle_name', null, 'eligible_dates', '[]'::jsonb, 'requests', '[]'::jsonb);
  end if;

  return jsonb_build_object(
    'circle_id', circle_record.id,
    'circle_name', circle_record.name,
    'eligible_dates', coalesce((
      select jsonb_agg(jsonb_build_object(
        'report_date', grouped.report_date,
        'overdue_count', grouped.overdue_count,
        'first_due_at', grouped.first_due_at
      ) order by grouped.report_date)
      from (
        select a.report_date, count(*)::integer as overdue_count, min(a.effective_due_at) as first_due_at
        from public.quran_report_assignments a
        where a.circle_id = circle_record.id
          and a.student_id = auth.uid()
          and a.status = 'pending'
          and a.effective_due_at < now()
        group by a.report_date
      ) grouped
    ), '[]'::jsonb),
    'requests', coalesce((
      select jsonb_agg(to_jsonb(request_row) order by request_row.requested_at desc)
      from (
        select r.id, r.requested_from_date, r.reason, r.status,
          r.decision_target_date, r.shift_days, r.decision_note,
          r.requested_at, r.decided_at
        from public.quran_plan_shift_requests r
        where r.circle_id = circle_record.id
          and r.student_id = auth.uid()
        order by r.requested_at desc
        limit 20
      ) request_row
    ), '[]'::jsonb)
  );
end;
$$;

create or replace function public.get_quran_plan_shift_queue(
  p_circle_id uuid,
  p_status text default 'pending'
)
returns jsonb
language plpgsql
stable
security definer
set search_path = pg_catalog, public
set row_security = off
as $$
declare
  status_value text := lower(btrim(coalesce(p_status, 'pending')));
begin
  if not public.can_manage_quran_student_plan(p_circle_id) then
    raise exception 'Only the lead teacher or administrator may review Quran plan shift requests'
      using errcode = '42501';
  end if;
  if status_value not in ('pending', 'approved', 'rejected', 'all') then
    raise exception 'Invalid Quran plan shift request status';
  end if;

  return coalesce((
    select jsonb_agg(to_jsonb(queue_row) order by (queue_row.status = 'pending') desc, queue_row.requested_at asc)
    from (
      select r.id, r.circle_id, r.student_id, u.full_name, u.username,
        r.requested_from_date, r.reason, r.status, r.decision_target_date,
        r.shift_days, r.decision_note, r.requested_at, r.decided_at,
        (select count(*)::integer from public.quran_report_assignments a
          where a.circle_id = r.circle_id and a.student_id = r.student_id
            and a.status = 'pending' and a.report_date >= r.requested_from_date) as pending_report_count,
        (select count(*)::integer from public.quran_report_assignments a
          where a.circle_id = r.circle_id and a.student_id = r.student_id
            and a.status = 'pending' and a.effective_due_at < now()) as overdue_report_count,
        (select min(a.report_date) from public.quran_report_assignments a
          where a.circle_id = r.circle_id and a.student_id = r.student_id
            and a.status = 'pending' and a.report_date >= r.requested_from_date) as current_start,
        (select max(a.report_date) from public.quran_report_assignments a
          where a.circle_id = r.circle_id and a.student_id = r.student_id
            and a.status = 'pending' and a.report_date >= r.requested_from_date) as current_end,
        (select count(distinct item.assignment_id)::integer
          from public.quran_report_extension_items item
          join public.quran_report_assignments a on a.id = item.assignment_id
          where item.status = 'pending' and a.circle_id = r.circle_id
            and a.student_id = r.student_id and a.status = 'pending'
            and a.report_date >= r.requested_from_date) as pending_extension_count
      from public.quran_plan_shift_requests r
      join public.users u on u.id = r.student_id
      where r.circle_id = p_circle_id
        and (status_value = 'all' or r.status = status_value)
    ) queue_row
  ), '[]'::jsonb);
end;
$$;

create or replace function public.decide_quran_plan_shift_request(
  p_request_id uuid,
  p_decision text,
  p_target_date date,
  p_note text default null
)
returns jsonb
language plpgsql
security definer
set search_path = pg_catalog, public
set row_security = off
as $$
declare
  request_record public.quran_plan_shift_requests%rowtype;
  updated_record public.quran_plan_shift_requests%rowtype;
  decision_value text := lower(btrim(coalesce(p_decision, '')));
  note_value text := nullif(btrim(coalesce(p_note, '')), '');
  delta_days integer;
  adjustment_result jsonb;
begin
  select * into request_record
  from public.quran_plan_shift_requests r
  where r.id = p_request_id
  for update;

  if request_record.id is null then
    raise exception 'Quran plan shift request was not found';
  end if;
  if not public.can_manage_quran_student_plan(request_record.circle_id) then
    raise exception 'Only the lead teacher or administrator may decide Quran plan shift requests'
      using errcode = '42501';
  end if;
  if request_record.status <> 'pending' then
    raise exception 'Quran plan shift request has already been decided';
  end if;
  if decision_value not in ('approve', 'reject') then
    raise exception 'Invalid Quran plan shift decision';
  end if;
  if note_value is not null and char_length(note_value) > 2000 then
    raise exception 'Quran plan shift decision note is too long';
  end if;

  if decision_value = 'approve' then
    if p_target_date is null or p_target_date <= request_record.requested_from_date then
      raise exception 'The new Quran plan date must be after the requested overdue date';
    end if;
    delta_days := p_target_date - request_record.requested_from_date;
    if delta_days not between 1 and 365 then
      raise exception 'Quran plan shift days must be between 1 and 365';
    end if;

    adjustment_result := public.adjust_quran_student_plan(
      request_record.circle_id,
      request_record.student_id,
      'shift',
      request_record.requested_from_date,
      null,
      delta_days,
      'طلب الطالب: ' || request_record.reason || case when note_value is null then '' else ' | قرار المعلم: ' || note_value end,
      false
    );

    update public.quran_plan_shift_requests
    set status = 'approved', decision_target_date = p_target_date,
        shift_days = delta_days, decision_note = note_value,
        decision_result = adjustment_result, decided_by = auth.uid(), decided_at = now()
    where id = request_record.id
    returning * into updated_record;
  else
    update public.quran_plan_shift_requests
    set status = 'rejected', decision_note = note_value,
        decided_by = auth.uid(), decided_at = now()
    where id = request_record.id
    returning * into updated_record;

    insert into public.notifications (user_id, title, body, type)
    values (
      request_record.student_id,
      'قرار طلب ترحيل التقارير',
      'لم يُعتمد طلب ترحيل التقارير.' || case when note_value is null then '' else ' ملاحظة المعلم: ' || note_value end,
      'quran_plan_shift_rejected'
    );
  end if;

  perform public.record_platform_audit(
    request_record.circle_id,
    'quran_reports.plan_shift_' || case when decision_value = 'approve' then 'approved' else 'rejected' end,
    'quran_plan_shift_request',
    request_record.id::text,
    to_jsonb(request_record),
    to_jsonb(updated_record),
    coalesce(adjustment_result, '{}'::jsonb) || jsonb_build_object('decision_note', note_value)
  );

  return to_jsonb(updated_record);
end;
$$;

revoke all on function public.request_quran_plan_shift(date, text) from public, anon, authenticated;
revoke all on function public.get_my_quran_plan_shift_requests() from public, anon, authenticated;
revoke all on function public.get_quran_plan_shift_queue(uuid, text) from public, anon, authenticated;
revoke all on function public.decide_quran_plan_shift_request(uuid, text, date, text) from public, anon, authenticated;

grant execute on function public.request_quran_plan_shift(date, text) to authenticated, service_role;
grant execute on function public.get_my_quran_plan_shift_requests() to authenticated, service_role;
grant execute on function public.get_quran_plan_shift_queue(uuid, text) to authenticated, service_role;
grant execute on function public.decide_quran_plan_shift_request(uuid, text, date, text) to authenticated, service_role;
