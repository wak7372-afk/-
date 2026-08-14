-- Operational Quran student accounting and teacher-facing analytics.

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

  with active_students as (
    select
      membership.student_id,
      membership.id as membership_id,
      membership.joined_at,
      student.full_name,
      student.username
    from public.learning_circle_memberships membership
    join public.users student on student.id = membership.student_id
    where membership.circle_id = p_circle_id
      and membership.circle_type = 'quran'
      and membership.status = 'active'
      and student.role = 'student'
      and student.is_active = true
  ), daily_assignments as (
    select
      a.*,
      report.content,
      report.repetitions,
      public.quran_report_completion_band(a.starts_at, a.effective_due_at, a.completed_at) as completion_band
    from public.quran_report_assignments a
    join public.quran_reports report on report.id = a.report_id
    where a.circle_id = p_circle_id
      and a.report_date = p_report_date
      and a.status in ('pending', 'completed', 'exempted')
  ), student_rollup as (
    select
      student.student_id,
      student.membership_id,
      student.joined_at,
      student.full_name,
      student.username,
      count(assignment.id)::integer as report_count,
      count(assignment.id) filter (where assignment.status = 'completed')::integer as completed_count,
      count(assignment.id) filter (where assignment.status = 'exempted')::integer as exempted_count,
      count(assignment.id) filter (where assignment.status = 'pending')::integer as pending_count,
      count(assignment.id) filter (
        where assignment.status = 'pending' and assignment.effective_due_at < now()
      )::integer as overdue_today_count,
      count(assignment.id) filter (
        where assignment.status = 'completed' and assignment.completed_at > assignment.effective_due_at
      )::integer as late_completion_count,
      max(case assignment.completion_band
        when 'late' then 4 when 'late_on_time' then 3 when 'middle' then 2 when 'early' then 1 else 0
      end)::integer as worst_completion_rank,
      min(assignment.effective_due_at) filter (where assignment.status = 'pending') as next_due_at,
      bool_or(assignment.effective_due_at > assignment.original_due_at) as has_extension
    from active_students student
    left join daily_assignments assignment on assignment.student_id = student.student_id
    group by student.student_id, student.membership_id, student.joined_at, student.full_name, student.username
  ), classified as (
    select
      rollup.*,
      case
        when report_count = 0 then 'no_reports'
        when overdue_today_count > 0 then 'overdue'
        when pending_count > 0 and completed_count > 0 then 'partial'
        when pending_count > 0 then 'pending'
        when completed_count = 0 and exempted_count > 0 then 'exempted'
        when late_completion_count > 0 then 'completed_late'
        else 'completed'
      end as daily_state,
      case worst_completion_rank
        when 4 then 'late' when 3 then 'late_on_time' when 2 then 'middle' when 1 then 'early' else null
      end as overall_completion_band,
      (
        select count(*)::integer
        from public.quran_report_assignments overdue
        where overdue.student_id = rollup.student_id
          and overdue.circle_id = p_circle_id
          and overdue.status = 'pending'
          and overdue.effective_due_at < now()
      ) as overdue_count
    from student_rollup rollup
  )
  select jsonb_build_object(
    'circle_id', p_circle_id,
    'report_date', p_report_date,
    'server_now', now(),
    'summary', jsonb_build_object(
      'student_count', count(*),
      'completed_students', count(*) filter (where daily_state in ('completed', 'completed_late')),
      'completed_on_time_students', count(*) filter (where daily_state = 'completed'),
      'completed_late_students', count(*) filter (where daily_state = 'completed_late'),
      'attention_students', count(*) filter (where daily_state in ('overdue', 'partial', 'pending')),
      'overdue_students', count(*) filter (where daily_state = 'overdue'),
      'pending_students', count(*) filter (where daily_state in ('partial', 'pending')),
      'exempted_students', count(*) filter (where daily_state = 'exempted'),
      'no_report_students', count(*) filter (where daily_state = 'no_reports'),
      'early_students', count(*) filter (where overall_completion_band = 'early'),
      'middle_students', count(*) filter (where overall_completion_band = 'middle'),
      'late_on_time_students', count(*) filter (where overall_completion_band = 'late_on_time')
    ),
    'students', coalesce(jsonb_agg(
      jsonb_build_object(
        'student_id', classified.student_id,
        'membership_id', classified.membership_id,
        'joined_at', classified.joined_at,
        'full_name', classified.full_name,
        'username', classified.username,
        'daily_state', classified.daily_state,
        'overall_completion_band', classified.overall_completion_band,
        'report_count', classified.report_count,
        'completed_count', classified.completed_count,
        'pending_count', classified.pending_count,
        'exempted_count', classified.exempted_count,
        'overdue_count', classified.overdue_count,
        'overdue_today_count', classified.overdue_today_count,
        'next_due_at', classified.next_due_at,
        'has_extension', classified.has_extension,
        'assignments', coalesce((
          select jsonb_agg(jsonb_build_object(
            'id', assignment.id,
            'report_date', assignment.report_date,
            'task_type', assignment.task_type,
            'content', assignment.content,
            'repetitions', assignment.repetitions,
            'status', assignment.status,
            'starts_at', assignment.starts_at,
            'original_due_at', assignment.original_due_at,
            'effective_due_at', assignment.effective_due_at,
            'deadline_extended', assignment.effective_due_at > assignment.original_due_at,
            'extension_minutes', greatest(0, floor(extract(epoch from assignment.effective_due_at - assignment.original_due_at) / 60))::integer,
            'remaining_seconds', greatest(0, floor(extract(epoch from assignment.effective_due_at - now())))::bigint,
            'completed_at', assignment.completed_at,
            'awarded_points', assignment.awarded_points,
            'max_points', assignment.max_points,
            'available_points', public.quran_report_points_at(assignment.max_points, assignment.starts_at, assignment.effective_due_at, now()),
            'completion_band', assignment.completion_band,
            'is_overdue', assignment.status = 'pending' and assignment.effective_due_at < now(),
            'exemption_reason', assignment.exemption_reason
          ) order by case assignment.task_type when 'hifz' then 1 when 'tathbit' then 2 else 3 end)
          from daily_assignments assignment
          where assignment.student_id = classified.student_id
        ), '[]'::jsonb)
      ) order by
        case classified.daily_state
          when 'overdue' then 1 when 'partial' then 2 when 'pending' then 3
          when 'completed_late' then 4 when 'completed' then 5 when 'exempted' then 6 else 7
        end,
        classified.full_name,
        classified.username
    ), '[]'::jsonb)
  ) into result
  from classified;

  return result;
end;
$$;

create or replace function public.get_quran_student_history(
  p_circle_id uuid,
  p_student_id uuid,
  p_limit integer default 100,
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
  today_value date := (now() at time zone 'Asia/Muscat')::date;
begin
  if not public.can_review_quran_reports(p_circle_id) then
    raise exception 'Not allowed to review Quran student history' using errcode = '42501';
  end if;
  if p_limit not between 1 and 200 or p_offset < 0 then raise exception 'Invalid history page'; end if;
  if not exists (
    select 1 from public.learning_circle_memberships membership
    where membership.circle_id = p_circle_id
      and membership.student_id = p_student_id
      and membership.circle_type = 'quran'
  ) then raise exception 'Student is not related to this Quran circle'; end if;

  select jsonb_build_object(
    'student', jsonb_build_object(
      'id', student.id,
      'full_name', student.full_name,
      'username', student.username,
      'circle_id', circle.id,
      'circle_name', circle.name,
      'membership_id', membership.id,
      'joined_at', membership.joined_at,
      'membership_status', membership.status
    ),
    'total', (
      select count(*) from public.quran_report_assignments assignment
      where assignment.circle_id = p_circle_id
        and assignment.student_id = p_student_id
        and assignment.status in ('pending', 'completed', 'exempted', 'replaced')
    ),
    'overdue_count', (
      select count(*) from public.quran_report_assignments assignment
      where assignment.circle_id = p_circle_id
        and assignment.student_id = p_student_id
        and assignment.status = 'pending'
        and assignment.effective_due_at < now()
    ),
    'analytics', jsonb_build_object(
      'periods', coalesce((
        select jsonb_object_agg(stats.period_days::text, to_jsonb(stats) - 'period_days')
        from (
          select
            period.period_days,
            count(assignment.id)::integer as report_count,
            count(assignment.id) filter (where assignment.status = 'completed')::integer as completed_count,
            count(assignment.id) filter (
              where assignment.status = 'completed' and assignment.completed_at <= assignment.effective_due_at
            )::integer as on_time_count,
            count(assignment.id) filter (
              where assignment.status = 'completed' and assignment.completed_at > assignment.effective_due_at
            )::integer as late_count,
            count(assignment.id) filter (
              where assignment.status = 'pending' and assignment.effective_due_at < now()
            )::integer as overdue_count,
            count(assignment.id) filter (where assignment.status = 'exempted')::integer as exempted_count,
            coalesce(sum(assignment.awarded_points) filter (where assignment.status = 'completed'), 0) as earned_points,
            coalesce(sum(assignment.max_points) filter (where assignment.status = 'completed'), 0) as completed_max_points,
            case when count(assignment.id) filter (where assignment.status in ('completed', 'pending')) = 0 then 0
              else round(100.0 * count(assignment.id) filter (where assignment.status = 'completed')
                / count(assignment.id) filter (where assignment.status in ('completed', 'pending')), 1)
            end as completion_rate,
            case when count(assignment.id) filter (where assignment.status = 'completed') = 0 then 0
              else round(100.0 * count(assignment.id) filter (
                where assignment.status = 'completed' and assignment.completed_at <= assignment.effective_due_at
              ) / count(assignment.id) filter (where assignment.status = 'completed'), 1)
            end as on_time_rate
          from (values (7), (30), (90)) period(period_days)
          left join public.quran_report_assignments assignment
            on assignment.circle_id = p_circle_id
           and assignment.student_id = p_student_id
           and assignment.status in ('pending', 'completed', 'exempted')
           and assignment.report_date between today_value - (period.period_days - 1) and today_value
          group by period.period_days
        ) stats
      ), '{}'::jsonb),
      'latest_progress', coalesce((
        select jsonb_object_agg(progress.task_type, to_jsonb(progress) - 'task_type')
        from (
          select distinct on (assignment.task_type)
            assignment.task_type,
            assignment.report_date,
            report.content,
            report.repetitions,
            assignment.completed_at,
            assignment.awarded_points,
            assignment.max_points
          from public.quran_report_assignments assignment
          join public.quran_reports report on report.id = assignment.report_id
          where assignment.circle_id = p_circle_id
            and assignment.student_id = p_student_id
            and assignment.status = 'completed'
          order by assignment.task_type, assignment.report_date desc, assignment.completed_at desc
        ) progress
      ), '{}'::jsonb)
    ),
    'assignments', coalesce((
      select jsonb_agg(to_jsonb(history_row) order by history_row.report_date desc, history_row.task_order)
      from (
        select
          assignment.id,
          assignment.report_date,
          assignment.task_type,
          case assignment.task_type when 'hifz' then 1 when 'tathbit' then 2 else 3 end as task_order,
          report.content,
          report.repetitions,
          assignment.status,
          assignment.starts_at,
          assignment.original_due_at,
          assignment.effective_due_at,
          assignment.effective_due_at > assignment.original_due_at as deadline_extended,
          greatest(0, floor(extract(epoch from assignment.effective_due_at - assignment.original_due_at) / 60))::integer as extension_minutes,
          assignment.completed_at,
          assignment.awarded_points,
          assignment.max_points,
          public.quran_report_completion_band(assignment.starts_at, assignment.effective_due_at, assignment.completed_at) as completion_band,
          assignment.status = 'pending' and assignment.effective_due_at < now() as is_overdue,
          assignment.exemption_reason,
          (select count(*) from public.quran_report_assignment_events event where event.assignment_id = assignment.id) as event_count
        from public.quran_report_assignments assignment
        join public.quran_reports report on report.id = assignment.report_id
        where assignment.circle_id = p_circle_id
          and assignment.student_id = p_student_id
          and assignment.status in ('pending', 'completed', 'exempted', 'replaced')
        order by assignment.report_date desc, task_order
        limit p_limit offset p_offset
      ) history_row
    ), '[]'::jsonb),
    'recent_events', coalesce((
      select jsonb_agg(to_jsonb(event_row) order by event_row.created_at desc)
      from (
        select
          event.id,
          event.assignment_id,
          event.event_type,
          event.metadata,
          event.created_at,
          actor.full_name as actor_name,
          assignment.report_date,
          assignment.task_type,
          report.content
        from public.quran_report_assignment_events event
        join public.quran_report_assignments assignment on assignment.id = event.assignment_id
        join public.quran_reports report on report.id = assignment.report_id
        left join public.users actor on actor.id = event.actor_id
        where assignment.circle_id = p_circle_id
          and assignment.student_id = p_student_id
          and event.event_type in (
            'completed', 'exempted', 'extension_requested', 'extension_approved',
            'extension_rejected', 'rescheduled', 'skipped', 'report_updated', 'report_cancelled'
          )
        order by event.created_at desc
        limit 30
      ) event_row
    ), '[]'::jsonb)
  ) into result
  from public.users student
  join public.learning_circle_memberships membership
    on membership.student_id = student.id and membership.circle_id = p_circle_id
  join public.learning_circles circle on circle.id = membership.circle_id
  where student.id = p_student_id;

  return result;
end;
$$;

revoke all on function public.get_quran_teacher_console(uuid, date) from public, anon, authenticated;
revoke all on function public.get_quran_student_history(uuid, uuid, integer, integer) from public, anon, authenticated;

grant execute on function public.get_quran_teacher_console(uuid, date) to authenticated, service_role;
grant execute on function public.get_quran_student_history(uuid, uuid, integer, integer) to authenticated, service_role;
