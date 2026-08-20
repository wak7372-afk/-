\set ON_ERROR_STOP on

begin;

insert into auth.users (id, email, raw_user_meta_data, created_at, updated_at)
values
  ('69000000-0000-4000-8000-000000000001', 'performance-admin@example.test', '{"full_name":"Performance Admin","username":"performance.admin"}', now(), now()),
  ('69000000-0000-4000-8000-000000000002', 'performance-teacher@example.test', '{"full_name":"Performance Teacher","username":"performance.teacher"}', now(), now()),
  ('69000000-0000-4000-8000-000000000003', 'performance-student@example.test', '{"full_name":"Performance Student","username":"performance.student"}', now(), now());

update public.users
set role = case id
  when '69000000-0000-4000-8000-000000000001' then 'admin'::public.user_role
  when '69000000-0000-4000-8000-000000000002' then 'teacher'::public.user_role
  else 'student'::public.user_role
end,
is_active = true
where id::text like '69000000-0000-4000-8000-00000000000%';

set local role authenticated;
select set_config('request.jwt.claim.sub', '69000000-0000-4000-8000-000000000001', true);

select public.create_learning_circle(
  'Performance Quran Circle', 'quran', '69000000-0000-4000-8000-000000000002'
);
select public.add_student_to_learning_circle(
  (select id from public.learning_circles where name = 'Performance Quran Circle'),
  '69000000-0000-4000-8000-000000000003'
);

reset role;

insert into public.quran_reports (
  circle_id, report_date, task_type, content, repetitions, max_points,
  starts_at, due_at, created_by
)
select circle.id, plan.report_date, plan.task_type, plan.content, 3, plan.max_points,
  plan.starts_at, plan.due_at, '69000000-0000-4000-8000-000000000002'
from public.learning_circles circle
cross join (values
  (current_date, 'hifz'::text, 'حفظ اليوم', 4::numeric, now() - interval '2 hours', now() + interval '2 hours'),
  (current_date - 1, 'murajaa'::text, 'مراجعة الأمس', 3::numeric, now() - interval '1 day 2 hours', now() - interval '12 hours')
) plan(report_date, task_type, content, max_points, starts_at, due_at)
where circle.name = 'Performance Quran Circle';

insert into public.quran_report_assignments (
  report_id, circle_id, membership_id, student_id, report_date, task_type,
  starts_at, original_due_at, effective_due_at, max_points
)
select report.id, report.circle_id, membership.id,
  '69000000-0000-4000-8000-000000000003', report.report_date, report.task_type,
  report.starts_at, report.due_at, report.due_at, report.max_points
from public.quran_reports report
join public.learning_circle_memberships membership
  on membership.circle_id = report.circle_id
 and membership.student_id = '69000000-0000-4000-8000-000000000003'
where report.content in ('حفظ اليوم', 'مراجعة الأمس');

update public.quran_report_assignments
set status = 'completed', completed_at = now(), awarded_points = 3.5
where task_type = 'hifz';

set local role authenticated;
select set_config('request.jwt.claim.sub', '69000000-0000-4000-8000-000000000001', true);

do $$
declare
  performance jsonb;
begin
  select public.get_quran_circle_performance(
    (select id from public.learning_circles where name = 'Performance Quran Circle'),
    current_date
  ) into performance;

  if (performance ->> 'active_students')::integer <> 1 then
    raise exception 'Performance active student count is incorrect: %', performance;
  end if;
  if (performance #>> '{comparisons,today,current,completed_student_days}')::integer <> 1 then
    raise exception 'Today completion count is incorrect: %', performance;
  end if;
  if (performance #>> '{comparisons,today,previous,overdue_student_days}')::integer <> 1 then
    raise exception 'Previous overdue count is incorrect: %', performance;
  end if;
  if (performance #>> '{comparisons,today,completion_rate_delta}')::numeric <> 100 then
    raise exception 'Today comparison delta is incorrect: %', performance;
  end if;
  if performance #>> '{students,0,latest_progress,hifz,content}' <> 'حفظ اليوم' then
    raise exception 'Latest student progress is missing: %', performance;
  end if;
end;
$$;

rollback;

select 'Quran circle performance flow passed' as result;
