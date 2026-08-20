-- Teacher/admin Quran-circle performance analytics. A student-day is complete
-- only when every required assignment for that day is completed or exempted.

create or replace function public.get_quran_circle_performance(
  p_circle_id uuid,
  p_as_of date default null
)
returns jsonb
language plpgsql
stable
security definer
set search_path = pg_catalog, public
set row_security = off
as $$
declare
  as_of_date date := coalesce(p_as_of, (now() at time zone 'Asia/Muscat')::date);
  result jsonb;
begin
  if not public.can_review_quran_reports(p_circle_id) then
    raise exception 'Not allowed to review Quran circle performance' using errcode = '42501';
  end if;
  if not exists (
    select 1 from public.learning_circles
    where id = p_circle_id and circle_type = 'quran' and status = 'active'
  ) then raise exception 'Active Quran circle not found'; end if;

  with active_students as (
    select membership.student_id, student.full_name, student.username
    from public.learning_circle_memberships membership
    join public.users student on student.id = membership.student_id
    where membership.circle_id = p_circle_id
      and membership.circle_type = 'quran'
      and membership.status = 'active'
      and student.role = 'student'
      and student.is_active = true
      and student.deleted_at is null
  ), all_assignments as (
    select
      assignment.*,
      report.content,
      report.repetitions,
      assignment.status = 'completed' and assignment.completed_at <= assignment.effective_due_at as completed_on_time,
      assignment.status = 'completed' and assignment.completed_at > assignment.effective_due_at as completed_late,
      assignment.status = 'pending' and assignment.effective_due_at < now() as is_overdue
    from public.quran_report_assignments assignment
    join public.quran_reports report on report.id = assignment.report_id
    join active_students student on student.student_id = assignment.student_id
    where assignment.circle_id = p_circle_id
      and assignment.status in ('pending', 'completed', 'exempted')
  ), assignments as (
    select * from all_assignments
    where report_date between as_of_date - 59 and as_of_date
  ), student_days as (
    select
      student_id,
      report_date,
      count(*)::integer as required_count,
      count(*) filter (where status = 'completed')::integer as completed_count,
      count(*) filter (where status = 'exempted')::integer as exempted_count,
      count(*) filter (where status = 'pending')::integer as pending_count,
      count(*) filter (where completed_on_time)::integer as on_time_count,
      count(*) filter (where completed_late)::integer as late_count,
      count(*) filter (where is_overdue)::integer as overdue_count,
      coalesce(sum(awarded_points) filter (where status = 'completed'), 0) as earned_points,
      coalesce(sum(max_points) filter (where status = 'completed'), 0) as completed_max_points,
      count(*) filter (where status = 'pending') = 0
        and count(*) filter (where status = 'completed') > 0 as is_complete,
      count(*) filter (where status = 'pending') = 0
        and count(*) filter (where status = 'completed') > 0
        and count(*) filter (where completed_late) = 0 as is_on_time
    from assignments
    group by student_id, report_date
  ), periods(period_key, phase, date_from, date_to) as (
    values
      ('today', 'current', as_of_date, as_of_date),
      ('today', 'previous', as_of_date - 1, as_of_date - 1),
      ('week', 'current', as_of_date - 6, as_of_date),
      ('week', 'previous', as_of_date - 13, as_of_date - 7),
      ('month', 'current', as_of_date - 29, as_of_date),
      ('month', 'previous', as_of_date - 59, as_of_date - 30)
  ), period_metrics as (
    select
      period.period_key,
      period.phase,
      count(day.student_id)::integer as expected_student_days,
      count(day.student_id) filter (where day.is_complete)::integer as completed_student_days,
      count(day.student_id) filter (where day.is_on_time)::integer as on_time_student_days,
      count(day.student_id) filter (where day.late_count > 0)::integer as late_student_days,
      count(day.student_id) filter (where day.overdue_count > 0)::integer as overdue_student_days,
      coalesce(sum(day.earned_points), 0) as earned_points,
      coalesce(sum(day.completed_max_points), 0) as completed_max_points,
      case when count(day.student_id) = 0 then 0
        else round(100.0 * count(day.student_id) filter (where day.is_complete) / count(day.student_id), 1)
      end as completion_rate,
      case when count(day.student_id) filter (where day.is_complete) = 0 then 0
        else round(100.0 * count(day.student_id) filter (where day.is_on_time)
          / count(day.student_id) filter (where day.is_complete), 1)
      end as on_time_rate
    from periods period
    left join student_days day on day.report_date between period.date_from and period.date_to
    group by period.period_key, period.phase
  ), comparison_rows as (
    select
      current.period_key,
      to_jsonb(current) - 'period_key' - 'phase' as current_metrics,
      to_jsonb(previous) - 'period_key' - 'phase' as previous_metrics,
      current.completion_rate - previous.completion_rate as completion_rate_delta,
      current.on_time_rate - previous.on_time_rate as on_time_rate_delta,
      current.completed_student_days - previous.completed_student_days as completed_delta
    from period_metrics current
    join period_metrics previous using (period_key)
    where current.phase = 'current' and previous.phase = 'previous'
  ), chart_days as (
    select generate_series(as_of_date - 13, as_of_date, interval '1 day')::date as report_date
  ), daily_chart as (
    select
      chart.report_date,
      count(day.student_id)::integer as expected_students,
      count(day.student_id) filter (where day.is_complete)::integer as completed_students,
      count(day.student_id) filter (where day.is_on_time)::integer as on_time_students,
      count(day.student_id) filter (where day.late_count > 0)::integer as late_students,
      count(day.student_id) filter (where day.overdue_count > 0)::integer as overdue_students,
      case when count(day.student_id) = 0 then 0
        else round(100.0 * count(day.student_id) filter (where day.is_complete) / count(day.student_id), 1)
      end as completion_rate
    from chart_days chart
    left join student_days day on day.report_date = chart.report_date
    group by chart.report_date
  )
  select jsonb_build_object(
    'circle_id', p_circle_id,
    'as_of', as_of_date,
    'generated_at', now(),
    'active_students', (select count(*) from active_students),
    'comparisons', coalesce((
      select jsonb_object_agg(
        comparison.period_key,
        jsonb_build_object(
          'current', comparison.current_metrics,
          'previous', comparison.previous_metrics,
          'completion_rate_delta', comparison.completion_rate_delta,
          'on_time_rate_delta', comparison.on_time_rate_delta,
          'completed_delta', comparison.completed_delta
        )
      ) from comparison_rows comparison
    ), '{}'::jsonb),
    'daily_chart', coalesce((
      select jsonb_agg(to_jsonb(chart) order by chart.report_date) from daily_chart chart
    ), '[]'::jsonb),
    'task_distribution', coalesce((
      select jsonb_object_agg(task.task_type, to_jsonb(task) - 'task_type')
      from (
        select
          assignment.task_type,
          count(*)::integer as assigned_count,
          count(*) filter (where assignment.status = 'completed')::integer as completed_count,
          coalesce(sum(assignment.awarded_points) filter (where assignment.status = 'completed'), 0) as earned_points
        from assignments assignment
        where assignment.report_date between as_of_date - 29 and as_of_date
        group by assignment.task_type
      ) task
    ), '{}'::jsonb),
    'students', coalesce((
      select jsonb_agg(
        jsonb_build_object(
          'student_id', student.student_id,
          'full_name', student.full_name,
          'username', student.username,
          'last_report_date', (
            select max(assignment.report_date) from all_assignments assignment
            where assignment.student_id = student.student_id and assignment.status = 'completed'
          ),
          'latest_progress', coalesce((
            select jsonb_object_agg(progress.task_type, to_jsonb(progress) - 'task_type')
            from (
              select distinct on (assignment.task_type)
                assignment.task_type, assignment.report_date, assignment.content,
                assignment.repetitions, assignment.completed_at,
                assignment.awarded_points, assignment.max_points
              from all_assignments assignment
              where assignment.student_id = student.student_id and assignment.status = 'completed'
              order by assignment.task_type, assignment.report_date desc, assignment.completed_at desc
            ) progress
          ), '{}'::jsonb),
          'overdue_count', (
            select count(*) from all_assignments assignment
            where assignment.student_id = student.student_id and assignment.is_overdue
          ),
          'completion_rate_7', coalesce((
            select round(100.0 * count(*) filter (where day.is_complete) / nullif(count(*), 0), 1)
            from student_days day where day.student_id = student.student_id
              and day.report_date between as_of_date - 6 and as_of_date
          ), 0),
          'previous_completion_rate_7', coalesce((
            select round(100.0 * count(*) filter (where day.is_complete) / nullif(count(*), 0), 1)
            from student_days day where day.student_id = student.student_id
              and day.report_date between as_of_date - 13 and as_of_date - 7
          ), 0),
          'on_time_rate_7', coalesce((
            select round(100.0 * count(*) filter (where day.is_on_time)
              / nullif(count(*) filter (where day.is_complete), 0), 1)
            from student_days day where day.student_id = student.student_id
              and day.report_date between as_of_date - 6 and as_of_date
          ), 0),
          'completion_rate_30', coalesce((
            select round(100.0 * count(*) filter (where day.is_complete) / nullif(count(*), 0), 1)
            from student_days day where day.student_id = student.student_id
              and day.report_date between as_of_date - 29 and as_of_date
          ), 0)
        )
        order by
          (select count(*) from all_assignments assignment where assignment.student_id = student.student_id and assignment.is_overdue) desc,
          student.full_name
      ) from active_students student
    ), '[]'::jsonb)
  ) into result;

  return result;
end;
$$;

revoke all on function public.get_quran_circle_performance(uuid, date) from public, anon, authenticated;
grant execute on function public.get_quran_circle_performance(uuid, date) to authenticated, service_role;
