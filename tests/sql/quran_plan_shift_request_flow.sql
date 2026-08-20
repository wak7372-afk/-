\set ON_ERROR_STOP on

begin;

insert into auth.users (id, email, raw_user_meta_data, created_at, updated_at)
values
  ('6a000000-0000-4000-8000-000000000001', 'shift-admin@example.test', '{"full_name":"Shift Admin","username":"shift.admin"}', now(), now()),
  ('6a000000-0000-4000-8000-000000000002', 'shift-teacher@example.test', '{"full_name":"Shift Teacher","username":"shift.teacher"}', now(), now()),
  ('6a000000-0000-4000-8000-000000000003', 'shift-student@example.test', '{"full_name":"Shift Student","username":"shift.student"}', now(), now()),
  ('6a000000-0000-4000-8000-000000000004', 'shift-control@example.test', '{"full_name":"Control Student","username":"shift.control"}', now(), now());

update public.users
set role = case id
  when '6a000000-0000-4000-8000-000000000001' then 'admin'::public.user_role
  when '6a000000-0000-4000-8000-000000000002' then 'teacher'::public.user_role
  else 'student'::public.user_role
end,
is_active = true
where id::text like '6a000000-0000-4000-8000-00000000000%';

set local role authenticated;
select set_config('request.jwt.claim.sub', '6a000000-0000-4000-8000-000000000001', true);

select public.create_learning_circle(
  'Shift Request Quran Circle', 'quran', '6a000000-0000-4000-8000-000000000002'
);
select public.add_student_to_learning_circle(
  (select id from public.learning_circles where name = 'Shift Request Quran Circle'),
  '6a000000-0000-4000-8000-000000000003'
);
select public.add_student_to_learning_circle(
  (select id from public.learning_circles where name = 'Shift Request Quran Circle'),
  '6a000000-0000-4000-8000-000000000004'
);

reset role;

insert into public.quran_reports (
  circle_id, report_date, task_type, content, repetitions, max_points,
  starts_at, due_at, created_by
)
select circle.id, plan.report_date, plan.task_type, plan.content, 3, 4,
  plan.starts_at, plan.due_at, '6a000000-0000-4000-8000-000000000002'
from public.learning_circles circle
cross join (values
  (current_date - 2, 'hifz'::text, 'Shift overdue report', now() - interval '3 days', now() - interval '1 day'),
  (current_date - 1, 'hifz'::text, 'Shift second report', now() - interval '2 days', now() + interval '1 day'),
  (current_date, 'hifz'::text, 'Shift third report', now() - interval '1 day', now() + interval '2 days')
) plan(report_date, task_type, content, starts_at, due_at)
where circle.name = 'Shift Request Quran Circle';

insert into public.quran_report_assignments (
  report_id, circle_id, membership_id, student_id, report_date, task_type,
  starts_at, original_due_at, effective_due_at, max_points
)
select report.id, report.circle_id, membership.id, membership.student_id,
  report.report_date, report.task_type, report.starts_at, report.due_at, report.due_at, report.max_points
from public.quran_reports report
join public.learning_circle_memberships membership
  on membership.circle_id = report.circle_id
 and membership.student_id in (
   '6a000000-0000-4000-8000-000000000003',
   '6a000000-0000-4000-8000-000000000004'
 )
where report.content like 'Shift % report';

set local role authenticated;
select set_config('request.jwt.claim.sub', '6a000000-0000-4000-8000-000000000003', true);

do $$
declare
  overview jsonb;
  request_result jsonb;
begin
  select public.get_my_quran_plan_shift_requests() into overview;
  if jsonb_array_length(overview -> 'eligible_dates') <> 1 then
    raise exception 'Expected one eligible overdue date: %', overview;
  end if;

  select public.request_quran_plan_shift(current_date - 2, 'A documented student absence') into request_result;
  if request_result ->> 'status' <> 'pending' then
    raise exception 'Shift request was not created as pending: %', request_result;
  end if;
end;
$$;

select set_config('request.jwt.claim.sub', '6a000000-0000-4000-8000-000000000002', true);

do $$
declare
  circle_value uuid := (select id from public.learning_circles where name = 'Shift Request Quran Circle');
  queue jsonb;
  decision jsonb;
begin
  select public.get_quran_plan_shift_queue(circle_value, 'pending') into queue;
  if jsonb_array_length(queue) <> 1 or (queue #>> '{0,pending_report_count}')::integer <> 3 then
    raise exception 'Lead teacher queue is incorrect: %', queue;
  end if;

  select public.decide_quran_plan_shift_request(
    (queue #>> '{0,id}')::uuid,
    'approve',
    current_date,
    'Approved after reviewing the student record'
  ) into decision;

  if decision ->> 'status' <> 'approved' or (decision ->> 'shift_days')::integer <> 2 then
    raise exception 'Shift request decision is incorrect: %', decision;
  end if;
end;
$$;

reset role;

do $$
declare
  shifted_dates date[];
  control_dates date[];
begin
  select array_agg(report_date order by report_date) into shifted_dates
  from public.quran_report_assignments
  where student_id = '6a000000-0000-4000-8000-000000000003';

  select array_agg(report_date order by report_date) into control_dates
  from public.quran_report_assignments
  where student_id = '6a000000-0000-4000-8000-000000000004';

  if shifted_dates <> array[current_date, current_date + 1, current_date + 2] then
    raise exception 'Requested student dates were not shifted correctly: %', shifted_dates;
  end if;
  if control_dates <> array[current_date - 2, current_date - 1, current_date] then
    raise exception 'Another student plan was changed: %', control_dates;
  end if;
  if (select count(*) from public.quran_report_assignment_events where event_type = 'rescheduled') <> 3 then
    raise exception 'Expected three immutable reschedule events';
  end if;
end;
$$;

rollback;

select 'Quran plan shift request flow passed' as result;
