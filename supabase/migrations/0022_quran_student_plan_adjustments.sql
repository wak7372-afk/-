-- Lead-teacher and administrator operations for adjusting an individual Quran plan.

alter table public.quran_report_assignment_events
  drop constraint if exists quran_report_assignment_events_event_type_check;

alter table public.quran_report_assignment_events
  add constraint quran_report_assignment_events_event_type_check check (event_type in (
    'assigned', 'completed', 'exempted', 'replaced', 'cancelled',
    'extension_requested', 'extension_approved', 'extension_rejected',
    'rescheduled', 'skipped'
  ));

create or replace function public.can_manage_quran_student_plan(p_circle_id uuid)
returns boolean
language sql
stable
security definer
set search_path = pg_catalog, public
set row_security = off
as $$
  select exists (
    select 1
    from public.learning_circles c
    where c.id = p_circle_id
      and c.circle_type = 'quran'
      and c.status = 'active'
  ) and (
    public.is_admin()
    or exists (
      select 1
      from public.learning_circle_staff s
      join public.users u on u.id = s.teacher_id
      where s.circle_id = p_circle_id
        and s.teacher_id = auth.uid()
        and s.staff_role = 'lead'
        and s.status = 'active'
        and u.role = 'teacher'
        and u.is_active = true
    )
  );
$$;

create or replace function public.adjust_quran_student_plan(
  p_circle_id uuid,
  p_student_id uuid,
  p_action text,
  p_from_date date,
  p_target_date date,
  p_days integer,
  p_reason text,
  p_dry_run boolean
)
returns jsonb
language plpgsql
security definer
set search_path = pg_catalog, public
set row_security = off
as $$
declare
  action_value text := lower(btrim(coalesce(p_action, '')));
  reason_value text := btrim(coalesce(p_reason, ''));
  delta_days integer;
  moved_count integer := 0;
  skipped_count integer := 0;
  conflict_count integer := 0;
  pending_extension_count integer := 0;
  current_start date;
  current_end date;
  new_start date;
  new_end date;
  assignment_record public.quran_report_assignments%rowtype;
  updated_record public.quran_report_assignments%rowtype;
  result jsonb;
begin
  if not public.can_manage_quran_student_plan(p_circle_id) then
    raise exception 'Only the lead teacher or administrator may adjust a Quran student plan'
      using errcode = '42501';
  end if;
  if action_value not in ('shift', 'advance') then
    raise exception 'Invalid Quran student plan action';
  end if;
  if p_from_date is null then
    raise exception 'A plan start date is required';
  end if;
  if char_length(reason_value) not between 3 and 2000 then
    raise exception 'A clear adjustment reason is required';
  end if;
  if not exists (
    select 1
    from public.learning_circle_memberships m
    join public.users u on u.id = m.student_id
    where m.circle_id = p_circle_id
      and m.student_id = p_student_id
      and m.circle_type = 'quran'
      and m.status = 'active'
      and u.role = 'student'
      and u.is_active = true
  ) then
    raise exception 'Student is not an active member of this Quran circle';
  end if;
  if p_dry_run is null then
    raise exception 'Plan adjustment mode is required';
  end if;
  if not p_dry_run then
    perform pg_catalog.pg_advisory_xact_lock(pg_catalog.hashtextextended(p_student_id::text, 0));
  end if;

  if action_value = 'shift' then
    if coalesce(p_days, 0) not between 1 and 365 then
      raise exception 'Shift days must be between 1 and 365';
    end if;
    delta_days := p_days;
  else
    if p_target_date is null then
      raise exception 'A new plan start date is required';
    end if;
    delta_days := p_target_date - p_from_date;
    if abs(delta_days) > 3650 then
      raise exception 'Plan adjustment exceeds the allowed date range';
    end if;
  end if;

  select count(*), min(a.report_date), max(a.report_date)
  into moved_count, current_start, current_end
  from public.quran_report_assignments a
  where a.circle_id = p_circle_id
    and a.student_id = p_student_id
    and a.status = 'pending'
    and a.report_date >= p_from_date;

  if action_value = 'advance' then
    select count(*) into skipped_count
    from public.quran_report_assignments a
    where a.circle_id = p_circle_id
      and a.student_id = p_student_id
      and a.status = 'pending'
      and a.report_date < p_from_date;
  end if;

  if moved_count = 0 then
    raise exception 'No pending Quran reports were found from the selected date';
  end if;

  new_start := current_start + delta_days;
  new_end := current_end + delta_days;

  with moving as (
    select a.id, a.report_date, a.task_type
    from public.quran_report_assignments a
    where a.circle_id = p_circle_id
      and a.student_id = p_student_id
      and a.status = 'pending'
      and a.report_date >= p_from_date
  ), affected as (
    select id from moving
    union all
    select a.id
    from public.quran_report_assignments a
    where action_value = 'advance'
      and a.circle_id = p_circle_id
      and a.student_id = p_student_id
      and a.status = 'pending'
      and a.report_date < p_from_date
  )
  select count(*) into conflict_count
  from moving m
  join public.quran_report_assignments existing
    on existing.student_id = p_student_id
   and existing.report_date = m.report_date + delta_days
   and existing.task_type = m.task_type
   and existing.status in ('pending', 'completed', 'exempted')
  where not exists (select 1 from affected a where a.id = existing.id);

  select count(distinct item.assignment_id) into pending_extension_count
  from public.quran_report_extension_items item
  join public.quran_report_assignments assignment on assignment.id = item.assignment_id
  where item.status = 'pending'
    and assignment.circle_id = p_circle_id
    and assignment.student_id = p_student_id
    and assignment.status = 'pending'
    and (
      assignment.report_date >= p_from_date
      or (action_value = 'advance' and assignment.report_date < p_from_date)
    );

  result := jsonb_build_object(
    'action', action_value,
    'student_id', p_student_id,
    'from_date', p_from_date,
    'target_date', case when action_value = 'advance' then p_target_date else p_from_date + delta_days end,
    'shift_days', delta_days,
    'moved_count', moved_count,
    'skipped_count', skipped_count,
    'current_start', current_start,
    'current_end', current_end,
    'new_start', new_start,
    'new_end', new_end,
    'conflict_count', conflict_count,
    'pending_extension_count', pending_extension_count,
    'can_apply', conflict_count = 0 and pending_extension_count = 0,
    'dry_run', p_dry_run
  );

  if p_dry_run then
    return result;
  end if;
  if conflict_count > 0 then
    raise exception 'Quran plan adjustment conflicts with existing student reports';
  end if;
  if pending_extension_count > 0 then
    raise exception 'Quran plan adjustment has pending extension requests';
  end if;

  if action_value = 'advance' then
    for assignment_record in
      select *
      from public.quran_report_assignments a
      where a.circle_id = p_circle_id
        and a.student_id = p_student_id
        and a.status = 'pending'
        and a.report_date < p_from_date
      order by a.report_date, a.task_type, a.id
      for update
    loop
      update public.quran_report_assignments
      set status = 'replaced', updated_at = now()
      where id = assignment_record.id
      returning * into updated_record;

      insert into public.quran_report_assignment_events (
        assignment_id, actor_id, event_type, before_data, after_data, metadata
      ) values (
        assignment_record.id,
        auth.uid(),
        'skipped',
        to_jsonb(assignment_record),
        to_jsonb(updated_record),
        jsonb_build_object(
          'action', action_value,
          'reason', reason_value,
          'selected_plan_date', p_from_date,
          'new_start_date', p_target_date
        )
      );
    end loop;
  end if;

  if delta_days <> 0 then
    for assignment_record in
      select *
      from public.quran_report_assignments a
      where a.circle_id = p_circle_id
        and a.student_id = p_student_id
        and a.status = 'pending'
        and a.report_date >= p_from_date
      order by
        case when delta_days > 0 then a.report_date end desc,
        case when delta_days < 0 then a.report_date end asc,
        a.task_type,
        a.id
      for update
    loop
      update public.quran_report_assignments
      set report_date = assignment_record.report_date + delta_days,
          starts_at = assignment_record.starts_at + make_interval(days => delta_days),
          original_due_at = assignment_record.original_due_at + make_interval(days => delta_days),
          effective_due_at = assignment_record.effective_due_at + make_interval(days => delta_days),
          updated_at = now()
      where id = assignment_record.id
      returning * into updated_record;

      insert into public.quran_report_assignment_events (
        assignment_id, actor_id, event_type, before_data, after_data, metadata
      ) values (
        assignment_record.id,
        auth.uid(),
        'rescheduled',
        to_jsonb(assignment_record),
        to_jsonb(updated_record),
        jsonb_build_object(
          'action', action_value,
          'reason', reason_value,
          'shift_days', delta_days
        )
      );
    end loop;
  end if;

  insert into public.notifications (user_id, title, body, type)
  values (
    p_student_id,
    'تحديث خطة تقارير القرآن',
    case
      when action_value = 'shift' then 'قام المعلم بزحزحة تقاريرك القادمة وإعادة ضبط تواريخها.'
      else 'قام المعلم بتحديث نقطة البداية في خطتك وإعادة ترتيب تقاريرك القادمة.'
    end,
    'quran_plan_adjusted'
  );

  perform public.record_platform_audit(
    p_circle_id,
    'quran_reports.student_plan_adjusted',
    'student_quran_plan',
    p_student_id::text,
    jsonb_build_object('start', current_start, 'end', current_end),
    jsonb_build_object('start', new_start, 'end', new_end),
    result || jsonb_build_object('reason', reason_value)
  );

  return result || jsonb_build_object('dry_run', false, 'applied_at', now());
end;
$$;

create or replace function public.get_quran_student_history(
  p_circle_id uuid,
  p_student_id uuid,
  p_limit integer default 60,
  p_offset integer default 0
)
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
  if not public.can_review_quran_reports(p_circle_id) then
    raise exception 'Not allowed to review Quran student history' using errcode = '42501';
  end if;
  if p_limit not between 1 and 100 or p_offset < 0 then
    raise exception 'Invalid history page';
  end if;
  if not exists (
    select 1
    from public.learning_circle_memberships membership
    where membership.circle_id = p_circle_id
      and membership.student_id = p_student_id
  ) then
    raise exception 'Student is not related to this Quran circle';
  end if;

  select jsonb_build_object(
    'student', jsonb_build_object(
      'id', student.id,
      'full_name', student.full_name,
      'username', student.username
    ),
    'total', (
      select count(*)
      from public.quran_report_assignments a
      where a.circle_id = p_circle_id
        and a.student_id = p_student_id
        and a.status in ('pending', 'completed', 'exempted', 'replaced')
    ),
    'assignments', coalesce((
      select jsonb_agg(to_jsonb(history_row) order by history_row.report_date desc, history_row.task_order)
      from (
        select
          a.id,
          a.report_date,
          a.task_type,
          case a.task_type when 'hifz' then 1 when 'tathbit' then 2 else 3 end as task_order,
          r.content,
          r.repetitions,
          a.status,
          a.starts_at,
          a.original_due_at,
          a.effective_due_at,
          a.completed_at,
          a.awarded_points,
          a.max_points,
          public.quran_report_completion_band(a.starts_at, a.effective_due_at, a.completed_at) as completion_band,
          (a.status = 'pending' and a.effective_due_at < now()) as is_overdue,
          a.exemption_reason
        from public.quran_report_assignments a
        join public.quran_reports r on r.id = a.report_id
        where a.circle_id = p_circle_id
          and a.student_id = p_student_id
          and a.status in ('pending', 'completed', 'exempted', 'replaced')
        order by a.report_date desc, task_order
        limit p_limit offset p_offset
      ) history_row
    ), '[]'::jsonb)
  ) into result
  from public.users student
  where student.id = p_student_id;

  return result;
end;
$$;

revoke all on function public.can_manage_quran_student_plan(uuid) from public, anon, authenticated;
revoke all on function public.adjust_quran_student_plan(uuid, uuid, text, date, date, integer, text, boolean) from public, anon, authenticated;
revoke all on function public.get_quran_student_history(uuid, uuid, integer, integer) from public, anon, authenticated;

grant execute on function public.can_manage_quran_student_plan(uuid) to authenticated, service_role;
grant execute on function public.adjust_quran_student_plan(uuid, uuid, text, date, date, integer, text, boolean) to authenticated, service_role;
grant execute on function public.get_quran_student_history(uuid, uuid, integer, integer) to authenticated, service_role;
