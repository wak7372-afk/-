-- Protected student and teacher operations for the canonical Quran report model.

create unique index if not exists quran_extension_one_pending_per_assignment_idx
  on public.quran_report_extension_items (assignment_id)
  where status = 'pending';

create or replace function public.can_review_quran_reports(p_circle_id uuid)
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
  ) and public.has_learning_circle_permission(p_circle_id, 'review_submissions');
$$;

create or replace function public.quran_report_completion_band(
  p_starts_at timestamptz,
  p_due_at timestamptz,
  p_completed_at timestamptz
)
returns text
language sql
immutable
set search_path = pg_catalog, public
as $$
  select case
    when p_starts_at is null or p_due_at is null or p_completed_at is null then null
    when p_completed_at > p_due_at then 'late'
    when p_completed_at <= p_starts_at + ((p_due_at - p_starts_at) / 3.0) then 'early'
    when p_completed_at <= p_starts_at + ((p_due_at - p_starts_at) * 2.0 / 3.0) then 'middle'
    else 'late_on_time'
  end;
$$;

create or replace function public.get_my_quran_reports(p_start_date date, p_end_date date)
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
    raise exception 'Only active students may load Quran reports' using errcode = '42501';
  end if;
  if p_start_date is null or p_end_date is null or p_end_date < p_start_date
     or p_end_date - p_start_date > 92 then
    raise exception 'Invalid Quran report date range';
  end if;

  select jsonb_build_object(
    'server_now', now(),
    'overdue_count', (
      select count(*)
      from public.quran_report_assignments overdue
      where overdue.student_id = auth.uid()
        and overdue.status = 'pending'
        and overdue.effective_due_at < now()
    ),
    'earned_points', coalesce((
      select sum(a.awarded_points)
      from public.quran_report_assignments a
      where a.student_id = auth.uid()
        and a.status = 'completed'
        and a.report_date between p_start_date and p_end_date
    ), 0),
    'assignments', coalesce((
      select jsonb_agg(to_jsonb(item) order by item.report_date desc, item.task_order)
      from (
        select
          a.id,
          a.report_id,
          a.circle_id,
          c.name as circle_name,
          a.report_date,
          a.task_type,
          case a.task_type when 'hifz' then 1 when 'tathbit' then 2 else 3 end as task_order,
          r.content,
          r.repetitions,
          r.notes,
          a.starts_at,
          a.original_due_at,
          a.effective_due_at,
          a.max_points,
          a.status,
          a.completed_at,
          a.awarded_points,
          public.quran_report_points_at(a.max_points, a.starts_at, a.effective_due_at, now()) as available_points,
          public.quran_report_completion_band(a.starts_at, a.effective_due_at, a.completed_at) as completion_band,
          (a.status = 'pending' and a.effective_due_at < now()) as is_overdue,
          (
            a.status = 'pending'
            and exists (
              select 1
              from public.quran_report_assignments blocker
              where blocker.student_id = a.student_id
                and blocker.status = 'pending'
                and blocker.effective_due_at < now()
                and blocker.report_date < a.report_date
            )
          ) as blocked_by_overdue,
          extension_state.status as extension_status,
          extension_state.requested_minutes as extension_requested_minutes,
          extension_state.requested_at as extension_requested_at
        from public.quran_report_assignments a
        join public.quran_reports r on r.id = a.report_id
        join public.learning_circles c on c.id = a.circle_id
        left join lateral (
          select request.status, request.requested_minutes, request.requested_at
          from public.quran_report_extension_items extension_item
          join public.quran_report_extension_requests request on request.id = extension_item.request_id
          where extension_item.assignment_id = a.id
          order by request.requested_at desc
          limit 1
        ) extension_state on true
        where a.student_id = auth.uid()
          and a.status in ('pending', 'completed', 'exempted')
          and a.report_date between p_start_date and p_end_date
      ) item
    ), '[]'::jsonb)
  ) into result;

  return result;
end;
$$;

create or replace function public.complete_quran_report_assignment(p_assignment_id uuid)
returns jsonb
language plpgsql
security definer
set search_path = pg_catalog, public
set row_security = off
as $$
declare
  assignment_record public.quran_report_assignments%rowtype;
  completed_at_value timestamptz := now();
  awarded_value numeric(5,2);
  band_value text;
begin
  if public.current_user_role() <> 'student' then
    raise exception 'Only active students may complete Quran reports' using errcode = '42501';
  end if;

  select * into assignment_record
  from public.quran_report_assignments
  where id = p_assignment_id
  for update;

  if assignment_record.id is null then raise exception 'Quran report assignment not found'; end if;
  if assignment_record.student_id <> auth.uid() then
    raise exception 'This Quran report does not belong to the current student' using errcode = '42501';
  end if;
  if assignment_record.status <> 'pending' then raise exception 'Only pending Quran reports may be completed'; end if;
  if completed_at_value < assignment_record.starts_at then raise exception 'The Quran report has not started yet'; end if;

  if exists (
    select 1
    from public.quran_report_assignments blocker
    where blocker.student_id = assignment_record.student_id
      and blocker.status = 'pending'
      and blocker.effective_due_at < completed_at_value
      and blocker.report_date < assignment_record.report_date
  ) then
    raise exception 'Complete overdue Quran reports before later reports';
  end if;

  awarded_value := public.quran_report_points_at(
    assignment_record.max_points,
    assignment_record.starts_at,
    assignment_record.effective_due_at,
    completed_at_value
  );
  band_value := public.quran_report_completion_band(
    assignment_record.starts_at,
    assignment_record.effective_due_at,
    completed_at_value
  );

  update public.quran_report_assignments
  set status = 'completed', completed_at = completed_at_value, awarded_points = awarded_value
  where id = assignment_record.id;

  insert into public.quran_report_assignment_events (
    assignment_id, actor_id, event_type, before_data, after_data, metadata
  ) values (
    assignment_record.id,
    auth.uid(),
    'completed',
    to_jsonb(assignment_record),
    jsonb_build_object('status', 'completed', 'completed_at', completed_at_value, 'awarded_points', awarded_value),
    jsonb_build_object('completion_band', band_value, 'on_time', completed_at_value <= assignment_record.effective_due_at)
  );

  return jsonb_build_object(
    'assignment_id', assignment_record.id,
    'status', 'completed',
    'completed_at', completed_at_value,
    'awarded_points', awarded_value,
    'completion_band', band_value,
    'on_time', completed_at_value <= assignment_record.effective_due_at
  );
end;
$$;

create or replace function public.request_quran_report_extension(
  p_assignment_ids uuid[],
  p_requested_minutes integer,
  p_reason text
)
returns jsonb
language plpgsql
security definer
set search_path = pg_catalog, public
set row_security = off
as $$
declare
  request_id_value uuid;
  circle_id_value uuid;
  requested_count integer;
  eligible_count integer;
  circle_count integer;
begin
  if public.current_user_role() <> 'student' then
    raise exception 'Only active students may request Quran report extensions' using errcode = '42501';
  end if;
  requested_count := coalesce(array_length(p_assignment_ids, 1), 0);
  if requested_count not between 1 and 20 then raise exception 'Select between 1 and 20 Quran reports'; end if;
  if p_requested_minutes not between 1 and 4320 then raise exception 'Extension duration must be between 1 minute and 72 hours'; end if;
  if char_length(btrim(coalesce(p_reason, ''))) not between 3 and 2000 then raise exception 'A clear extension reason is required'; end if;

  select count(distinct a.id), min(a.circle_id::text)::uuid, count(distinct a.circle_id)
  into eligible_count, circle_id_value, circle_count
  from public.quran_report_assignments a
  where a.id = any(p_assignment_ids)
    and a.student_id = auth.uid()
    and a.status = 'pending';

  if eligible_count <> requested_count or circle_count <> 1 then
    raise exception 'Selected reports must be pending and belong to one Quran circle';
  end if;
  if exists (
    select 1
    from public.quran_report_extension_items item
    where item.assignment_id = any(p_assignment_ids)
      and item.status = 'pending'
  ) then
    raise exception 'A pending extension request already includes one of these reports';
  end if;

  insert into public.quran_report_extension_requests (
    circle_id, student_id, requested_minutes, reason
  ) values (
    circle_id_value, auth.uid(), p_requested_minutes, btrim(p_reason)
  ) returning id into request_id_value;

  insert into public.quran_report_extension_items (request_id, assignment_id)
  select request_id_value, a.id
  from public.quran_report_assignments a
  where a.id = any(p_assignment_ids)
    and a.student_id = auth.uid()
    and a.status = 'pending';

  insert into public.quran_report_assignment_events (
    assignment_id, actor_id, event_type, after_data, metadata
  )
  select
    a.id,
    auth.uid(),
    'extension_requested',
    jsonb_build_object('request_id', request_id_value, 'requested_minutes', p_requested_minutes),
    jsonb_build_object('reason', btrim(p_reason))
  from public.quran_report_assignments a
  where a.id = any(p_assignment_ids);

  insert into public.notifications (user_id, title, body, type)
  select distinct
    staff.teacher_id,
    'طلب تمديد جديد',
    'أرسل طالب طلب تمديد لتقارير القرآن ويحتاج إلى قرارك.',
    'quran_extension_requested'
  from public.learning_circle_staff staff
  where staff.circle_id = circle_id_value
    and staff.status = 'active';

  perform public.record_platform_audit(
    circle_id_value,
    'quran_reports.extension_requested',
    'quran_report_extension_request',
    request_id_value::text,
    null,
    jsonb_build_object('student_id', auth.uid(), 'requested_minutes', p_requested_minutes, 'assignments', eligible_count),
    '{}'::jsonb
  );

  return jsonb_build_object('request_id', request_id_value, 'status', 'pending', 'items_count', eligible_count);
end;
$$;

create or replace function public.get_quran_teacher_console(p_circle_id uuid, p_report_date date)
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
    raise exception 'Not allowed to review Quran reports in this circle' using errcode = '42501';
  end if;
  if p_report_date is null then raise exception 'Report date is required'; end if;

  select jsonb_build_object(
    'report_date', p_report_date,
    'server_now', now(),
    'students', coalesce((
      select jsonb_agg(to_jsonb(student_row) order by student_row.full_name, student_row.username)
      from (
        select
          membership.student_id,
          membership.id as membership_id,
          student.full_name,
          student.username,
          (
            select count(*)
            from public.quran_report_assignments overdue
            where overdue.student_id = membership.student_id
              and overdue.circle_id = p_circle_id
              and overdue.status = 'pending'
              and overdue.effective_due_at < now()
          ) as overdue_count,
          coalesce((
            select jsonb_agg(jsonb_build_object(
              'id', a.id,
              'task_type', a.task_type,
              'content', r.content,
              'status', a.status,
              'starts_at', a.starts_at,
              'effective_due_at', a.effective_due_at,
              'completed_at', a.completed_at,
              'awarded_points', a.awarded_points,
              'max_points', a.max_points,
              'available_points', public.quran_report_points_at(a.max_points, a.starts_at, a.effective_due_at, now()),
              'completion_band', public.quran_report_completion_band(a.starts_at, a.effective_due_at, a.completed_at),
              'is_overdue', a.status = 'pending' and a.effective_due_at < now()
            ) order by case a.task_type when 'hifz' then 1 when 'tathbit' then 2 else 3 end)
            from public.quran_report_assignments a
            join public.quran_reports r on r.id = a.report_id
            where a.student_id = membership.student_id
              and a.circle_id = p_circle_id
              and a.report_date = p_report_date
              and a.status in ('pending', 'completed', 'exempted')
          ), '[]'::jsonb) as assignments
        from public.learning_circle_memberships membership
        join public.users student on student.id = membership.student_id
        where membership.circle_id = p_circle_id
          and membership.circle_type = 'quran'
          and membership.status = 'active'
          and student.role = 'student'
          and student.is_active = true
      ) student_row
    ), '[]'::jsonb)
  ) into result;

  return result;
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
  if p_limit not between 1 and 100 or p_offset < 0 then raise exception 'Invalid history page'; end if;
  if not exists (
    select 1 from public.learning_circle_memberships membership
    where membership.circle_id = p_circle_id and membership.student_id = p_student_id
  ) then raise exception 'Student is not related to this Quran circle'; end if;

  select jsonb_build_object(
    'student', jsonb_build_object('id', student.id, 'full_name', student.full_name, 'username', student.username),
    'total', (
      select count(*) from public.quran_report_assignments a
      where a.circle_id = p_circle_id and a.student_id = p_student_id
        and a.status in ('pending', 'completed', 'exempted')
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
          and a.status in ('pending', 'completed', 'exempted')
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

create or replace function public.get_quran_extension_queue(p_circle_id uuid, p_status text default 'pending')
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
    raise exception 'Not allowed to review Quran extension requests' using errcode = '42501';
  end if;
  if p_status not in ('pending', 'approved', 'partially_approved', 'rejected', 'all') then
    raise exception 'Invalid extension request status';
  end if;

  select coalesce(jsonb_agg(to_jsonb(request_row) order by request_row.requested_at desc), '[]'::jsonb)
  into result
  from (
    select
      request.id,
      request.student_id,
      student.full_name,
      student.username,
      request.requested_minutes,
      request.reason,
      request.status,
      request.requested_at,
      request.decided_at,
      coalesce((
        select jsonb_agg(jsonb_build_object(
          'assignment_id', item.assignment_id,
          'item_status', item.status,
          'decision_mode', item.decision_mode,
          'granted_minutes', item.granted_minutes,
          'approved_until', item.approved_until,
          'decision_note', item.decision_note,
          'report_date', a.report_date,
          'task_type', a.task_type,
          'content', report.content,
          'effective_due_at', a.effective_due_at
        ) order by a.report_date, case a.task_type when 'hifz' then 1 when 'tathbit' then 2 else 3 end)
        from public.quran_report_extension_items item
        join public.quran_report_assignments a on a.id = item.assignment_id
        join public.quran_reports report on report.id = a.report_id
        where item.request_id = request.id
      ), '[]'::jsonb) as items
    from public.quran_report_extension_requests request
    join public.users student on student.id = request.student_id
    where request.circle_id = p_circle_id
      and (p_status = 'all' or request.status = p_status)
  ) request_row;

  return result;
end;
$$;

create or replace function public.decide_quran_report_extension(p_request_id uuid, p_decisions jsonb)
returns jsonb
language plpgsql
security definer
set search_path = pg_catalog, public
set row_security = off
as $$
declare
  request_record public.quran_report_extension_requests%rowtype;
  item_record public.quran_report_extension_items%rowtype;
  assignment_record public.quran_report_assignments%rowtype;
  decision jsonb;
  action_value text;
  mode_value text;
  minutes_value integer;
  until_value timestamptz;
  base_value timestamptz;
  processed_count integer := 0;
  approved_count integer;
  rejected_count integer;
  pending_count integer;
  request_status_value text;
begin
  select * into request_record
  from public.quran_report_extension_requests
  where id = p_request_id
  for update;

  if request_record.id is null then raise exception 'Quran extension request not found'; end if;
  if not public.can_review_quran_reports(request_record.circle_id) then
    raise exception 'Not allowed to decide this Quran extension request' using errcode = '42501';
  end if;
  if request_record.status <> 'pending' then raise exception 'Only pending extension requests may be decided'; end if;
  if jsonb_typeof(p_decisions) <> 'array' or jsonb_array_length(p_decisions) = 0 then
    raise exception 'Extension decisions are required';
  end if;

  for decision in select value from jsonb_array_elements(p_decisions)
  loop
    select * into item_record
    from public.quran_report_extension_items
    where request_id = p_request_id
      and assignment_id = (decision ->> 'assignment_id')::uuid
    for update;
    if item_record.id is null or item_record.status <> 'pending' then
      raise exception 'Invalid or duplicate extension decision item';
    end if;

    select * into assignment_record
    from public.quran_report_assignments
    where id = item_record.assignment_id
    for update;
    if assignment_record.status <> 'pending' then raise exception 'Only pending Quran reports may be extended'; end if;

    action_value := lower(btrim(coalesce(decision ->> 'action', '')));
    if action_value = 'approve' then
      mode_value := lower(btrim(coalesce(decision ->> 'mode', '')));
      base_value := greatest(assignment_record.effective_due_at, now());
      if mode_value = 'duration' then
        begin minutes_value := (decision ->> 'minutes')::integer;
        exception when others then raise exception 'Invalid granted extension duration'; end;
        if minutes_value not between 1 and 4320 then raise exception 'Granted duration must be between 1 minute and 72 hours'; end if;
        until_value := base_value + make_interval(mins => minutes_value);
      elsif mode_value = 'until' then
        begin until_value := (decision ->> 'until')::timestamptz;
        exception when others then raise exception 'Invalid extension end time'; end;
        minutes_value := null;
        if until_value <= base_value or until_value > base_value + interval '72 hours' then
          raise exception 'Extension end time must be after the current deadline and within 72 hours';
        end if;
      else
        raise exception 'Extension approval mode must be duration or until';
      end if;

      update public.quran_report_extension_items
      set status = 'approved',
          decision_mode = mode_value,
          granted_minutes = minutes_value,
          approved_until = until_value,
          decision_note = nullif(btrim(coalesce(decision ->> 'note', '')), ''),
          decided_by = auth.uid(),
          decided_at = now()
      where id = item_record.id;

      update public.quran_report_assignments
      set effective_due_at = until_value
      where id = assignment_record.id;

      insert into public.quran_report_assignment_events (
        assignment_id, actor_id, event_type, before_data, after_data, metadata
      ) values (
        assignment_record.id,
        auth.uid(),
        'extension_approved',
        jsonb_build_object('effective_due_at', assignment_record.effective_due_at),
        jsonb_build_object('effective_due_at', until_value),
        jsonb_build_object('request_id', p_request_id, 'mode', mode_value, 'granted_minutes', minutes_value)
      );
    elsif action_value = 'reject' then
      update public.quran_report_extension_items
      set status = 'rejected',
          decision_note = nullif(btrim(coalesce(decision ->> 'note', '')), ''),
          decided_by = auth.uid(),
          decided_at = now()
      where id = item_record.id;

      insert into public.quran_report_assignment_events (
        assignment_id, actor_id, event_type, before_data, after_data, metadata
      ) values (
        assignment_record.id,
        auth.uid(),
        'extension_rejected',
        jsonb_build_object('effective_due_at', assignment_record.effective_due_at),
        jsonb_build_object('effective_due_at', assignment_record.effective_due_at),
        jsonb_build_object('request_id', p_request_id)
      );
    else
      raise exception 'Each extension item must be approved or rejected';
    end if;
    processed_count := processed_count + 1;
  end loop;

  select
    count(*) filter (where status = 'approved'),
    count(*) filter (where status = 'rejected'),
    count(*) filter (where status = 'pending')
  into approved_count, rejected_count, pending_count
  from public.quran_report_extension_items
  where request_id = p_request_id;

  if pending_count > 0 then raise exception 'Every requested report needs a decision'; end if;
  request_status_value := case
    when approved_count > 0 and rejected_count > 0 then 'partially_approved'
    when approved_count > 0 then 'approved'
    else 'rejected'
  end;

  update public.quran_report_extension_requests
  set status = request_status_value, decided_at = now()
  where id = p_request_id;

  insert into public.notifications (user_id, title, body, type)
  values (
    request_record.student_id,
    case when approved_count > 0 then 'تمت مراجعة طلب التمديد' else 'تم رفض طلب التمديد' end,
    case
      when request_status_value = 'approved' then 'تم قبول جميع التقارير المطلوبة في طلب التمديد.'
      when request_status_value = 'partially_approved' then 'تم قبول بعض التقارير ورفض بعضها في طلب التمديد.'
      else 'لم تتم الموافقة على تقارير طلب التمديد.'
    end,
    'quran_extension_decided'
  );

  perform public.record_platform_audit(
    request_record.circle_id,
    'quran_reports.extension_decided',
    'quran_report_extension_request',
    p_request_id::text,
    jsonb_build_object('status', 'pending'),
    jsonb_build_object('status', request_status_value, 'approved', approved_count, 'rejected', rejected_count),
    jsonb_build_object('processed', processed_count)
  );

  return jsonb_build_object(
    'request_id', p_request_id,
    'status', request_status_value,
    'approved_count', approved_count,
    'rejected_count', rejected_count
  );
end;
$$;

create or replace function public.exempt_quran_report_assignment(p_assignment_id uuid, p_reason text)
returns jsonb
language plpgsql
security definer
set search_path = pg_catalog, public
set row_security = off
as $$
declare
  assignment_record public.quran_report_assignments%rowtype;
begin
  select * into assignment_record
  from public.quran_report_assignments
  where id = p_assignment_id
  for update;

  if assignment_record.id is null then raise exception 'Quran report assignment not found'; end if;
  if not public.can_review_quran_reports(assignment_record.circle_id) then
    raise exception 'Not allowed to exempt this Quran report' using errcode = '42501';
  end if;
  if assignment_record.status <> 'pending' then raise exception 'Only pending Quran reports may be exempted'; end if;
  if char_length(btrim(coalesce(p_reason, ''))) not between 3 and 2000 then raise exception 'An exemption reason is required'; end if;

  update public.quran_report_assignments
  set status = 'exempted',
      exempted_by = auth.uid(),
      exempted_at = now(),
      exemption_reason = btrim(p_reason)
  where id = assignment_record.id;

  insert into public.quran_report_assignment_events (
    assignment_id, actor_id, event_type, before_data, after_data
  ) values (
    assignment_record.id,
    auth.uid(),
    'exempted',
    to_jsonb(assignment_record),
    jsonb_build_object('status', 'exempted', 'reason', btrim(p_reason))
  );

  insert into public.notifications (user_id, title, body, type)
  values (
    assignment_record.student_id,
    'إعفاء من تقرير',
    'أعفاك المعلم من أحد تقارير القرآن. يمكنك متابعة بقية تقاريرك.',
    'quran_report_exempted'
  );

  perform public.record_platform_audit(
    assignment_record.circle_id,
    'quran_reports.assignment_exempted',
    'quran_report_assignment',
    assignment_record.id::text,
    to_jsonb(assignment_record),
    jsonb_build_object('status', 'exempted', 'reason', btrim(p_reason)),
    '{}'::jsonb
  );

  return jsonb_build_object('assignment_id', assignment_record.id, 'status', 'exempted');
end;
$$;

revoke all on function public.can_review_quran_reports(uuid) from public;
revoke all on function public.quran_report_completion_band(timestamptz, timestamptz, timestamptz) from public;
revoke all on function public.get_my_quran_reports(date, date) from public;
revoke all on function public.complete_quran_report_assignment(uuid) from public;
revoke all on function public.request_quran_report_extension(uuid[], integer, text) from public;
revoke all on function public.get_quran_teacher_console(uuid, date) from public;
revoke all on function public.get_quran_student_history(uuid, uuid, integer, integer) from public;
revoke all on function public.get_quran_extension_queue(uuid, text) from public;
revoke all on function public.decide_quran_report_extension(uuid, jsonb) from public;
revoke all on function public.exempt_quran_report_assignment(uuid, text) from public;

grant execute on function public.can_review_quran_reports(uuid) to authenticated;
grant execute on function public.quran_report_completion_band(timestamptz, timestamptz, timestamptz) to authenticated;
grant execute on function public.get_my_quran_reports(date, date) to authenticated;
grant execute on function public.complete_quran_report_assignment(uuid) to authenticated;
grant execute on function public.request_quran_report_extension(uuid[], integer, text) to authenticated;
grant execute on function public.get_quran_teacher_console(uuid, date) to authenticated;
grant execute on function public.get_quran_student_history(uuid, uuid, integer, integer) to authenticated;
grant execute on function public.get_quran_extension_queue(uuid, text) to authenticated;
grant execute on function public.decide_quran_report_extension(uuid, jsonb) to authenticated;
grant execute on function public.exempt_quran_report_assignment(uuid, text) to authenticated;
