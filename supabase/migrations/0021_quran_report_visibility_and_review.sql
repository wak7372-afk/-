-- Student plan discovery and teacher review for approved Quran reports.

create or replace function public.get_my_quran_report_overview()
returns jsonb
language plpgsql
stable
security definer
set search_path = pg_catalog, public
set row_security = off
as $$
declare
  today_value date := timezone('Asia/Muscat', now())::date;
  result jsonb;
begin
  if public.current_user_role() <> 'student' then
    raise exception 'Only active students may load Quran report overview' using errcode = '42501';
  end if;

  with student_assignments as (
    select a.report_date, a.status, a.effective_due_at
    from public.quran_report_assignments a
    where a.student_id = auth.uid()
      and a.status in ('pending', 'completed', 'exempted')
  )
  select jsonb_build_object(
    'server_now', now(),
    'total_count', count(*),
    'pending_count', count(*) filter (where status = 'pending'),
    'overdue_count', count(*) filter (where status = 'pending' and effective_due_at < now()),
    'first_report_date', min(report_date),
    'last_report_date', max(report_date),
    'next_report_date', min(report_date) filter (where status = 'pending' and report_date >= today_value),
    'focus_date', coalesce(
      min(report_date) filter (where status = 'pending' and effective_due_at < now()),
      min(report_date) filter (where report_date = today_value),
      min(report_date) filter (where status = 'pending' and report_date > today_value),
      max(report_date)
    )
  ) into result
  from student_assignments;

  return result;
end;
$$;

create or replace function public.get_quran_approved_report_plan(
  p_circle_id uuid,
  p_start_date date default null,
  p_end_date date default null
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
    raise exception 'Not allowed to review Quran reports for this circle' using errcode = '42501';
  end if;
  if p_start_date is not null and p_end_date is not null and p_end_date < p_start_date then
    raise exception 'Invalid Quran report review range';
  end if;
  if p_start_date is not null and p_end_date is not null and p_end_date - p_start_date > 366 then
    raise exception 'Quran report review range cannot exceed 366 days';
  end if;

  with report_stats as (
    select
      r.id,
      r.report_date,
      r.task_type,
      r.content,
      r.repetitions,
      r.notes,
      r.max_points,
      r.starts_at,
      r.due_at,
      r.created_at,
      count(a.id) filter (where a.status in ('pending', 'completed', 'exempted')) as assigned_count,
      count(a.id) filter (where a.status = 'pending') as pending_count,
      count(a.id) filter (where a.status = 'completed') as completed_count,
      count(a.id) filter (where a.status = 'exempted') as exempted_count
    from public.quran_reports r
    join public.quran_report_assignments a on a.report_id = r.id
    where r.circle_id = p_circle_id
      and (p_start_date is null or r.report_date >= p_start_date)
      and (p_end_date is null or r.report_date <= p_end_date)
    group by r.id
    having count(a.id) filter (where a.status in ('pending', 'completed', 'exempted')) > 0
  )
  select jsonb_build_object(
    'circle_id', p_circle_id,
    'date_from', min(report_date),
    'date_to', max(report_date),
    'reports', coalesce(jsonb_agg(to_jsonb(report_stats) order by report_date, case task_type when 'hifz' then 1 when 'tathbit' then 2 else 3 end), '[]'::jsonb)
  ) into result
  from report_stats;

  return result;
end;
$$;

revoke all on function public.get_my_quran_report_overview() from public, anon, authenticated;
revoke all on function public.get_quran_approved_report_plan(uuid, date, date) from public, anon, authenticated;

grant execute on function public.get_my_quran_report_overview() to authenticated, service_role;
grant execute on function public.get_quran_approved_report_plan(uuid, date, date) to authenticated, service_role;
