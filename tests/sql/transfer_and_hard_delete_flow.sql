\set ON_ERROR_STOP on

begin;

insert into auth.users (id, email, raw_user_meta_data, created_at, updated_at)
values
  ('68000000-0000-0000-0000-000000000001', 'delete-admin@example.test', '{"full_name":"Delete Admin","username":"delete.admin"}', now(), now()),
  ('68000000-0000-0000-0000-000000000002', 'delete-teacher@example.test', '{"full_name":"Delete Teacher","username":"delete.teacher"}', now(), now()),
  ('68000000-0000-0000-0000-000000000003', 'delete-student@example.test', '{"full_name":"Delete Student","username":"delete.student"}', now(), now());

update public.users
set role = case id
  when '68000000-0000-0000-0000-000000000001' then 'admin'::public.user_role
  when '68000000-0000-0000-0000-000000000002' then 'teacher'::public.user_role
  else 'student'::public.user_role
end,
is_active = true
where id::text like '68000000-0000-0000-0000-00000000000%';

set local role authenticated;
select set_config('request.jwt.claim.sub', '68000000-0000-0000-0000-000000000001', true);

select public.create_learning_circle(
  'Transfer Source Circle', 'quran', '68000000-0000-0000-0000-000000000002'
);
select public.create_learning_circle(
  'Transfer Destination Circle', 'quran', '68000000-0000-0000-0000-000000000002'
);

select public.add_student_to_learning_circle(
  (select id from public.learning_circles where name = 'Transfer Source Circle'),
  '68000000-0000-0000-0000-000000000003'
);

reset role;

insert into public.quran_reports (
  circle_id, report_date, task_type, content, repetitions, notes, max_points,
  starts_at, due_at, created_by
)
select
  circle.id, current_date - 2, 'hifz', 'سورة البقرة 1-5', 3, 'سجل مكتمل', 4,
  date_trunc('day', now()) - interval '2 days',
  date_trunc('day', now()) - interval '1 day 1 hour',
  '68000000-0000-0000-0000-000000000002'
from public.learning_circles circle
where circle.name = 'Transfer Source Circle';

insert into public.quran_report_assignments (
  report_id, circle_id, membership_id, student_id, report_date, task_type,
  starts_at, original_due_at, effective_due_at, max_points
)
select
  report.id, report.circle_id, membership.id,
  '68000000-0000-0000-0000-000000000003', report.report_date, report.task_type,
  report.starts_at, report.due_at, report.due_at, report.max_points
from public.quran_reports report
join public.learning_circle_memberships membership
  on membership.circle_id = report.circle_id
 and membership.student_id = '68000000-0000-0000-0000-000000000003'
where report.content = 'سورة البقرة 1-5';

update public.quran_report_assignments
set status = 'completed', completed_at = effective_due_at - interval '2 hours', awarded_points = 3.50
where student_id = '68000000-0000-0000-0000-000000000003';

set local role authenticated;
select set_config('request.jwt.claim.sub', '68000000-0000-0000-0000-000000000001', true);

select public.add_student_to_learning_circle(
  (select id from public.learning_circles where name = 'Transfer Destination Circle'),
  '68000000-0000-0000-0000-000000000003'
);

select public.decide_learning_circle_transfer(
  (select id from public.learning_circle_transfer_requests where status = 'pending'),
  true,
  'Move the complete student record'
);

reset role;

do $$
declare
  source_id uuid;
  destination_id uuid;
begin
  select id into source_id from public.learning_circles where name = 'Transfer Source Circle';
  select id into destination_id from public.learning_circles where name = 'Transfer Destination Circle';

  if not exists (
    select 1 from public.quran_report_assignments assignment
    join public.quran_reports report on report.id = assignment.report_id
    join public.learning_circle_memberships membership on membership.id = assignment.membership_id
    where assignment.student_id = '68000000-0000-0000-0000-000000000003'
      and assignment.circle_id = destination_id
      and report.circle_id = destination_id
      and membership.circle_id = destination_id
      and assignment.status = 'completed'
      and assignment.awarded_points = 3.50
  ) then
    raise exception 'Completed Quran history did not move to the destination circle';
  end if;

  perform public.hard_delete_learning_circle(
    source_id,
    '68000000-0000-0000-0000-000000000001',
    'Transfer Source Circle'
  );

  if exists (select 1 from public.learning_circles where id = source_id) then
    raise exception 'Source circle was not permanently deleted';
  end if;

  if not exists (
    select 1 from public.quran_report_assignments
    where student_id = '68000000-0000-0000-0000-000000000003'
      and circle_id = destination_id and status = 'completed'
  ) then
    raise exception 'Deleting the old circle deleted the transferred student history';
  end if;
end;
$$;

select public.prepare_account_hard_delete(
  '68000000-0000-0000-0000-000000000003',
  '68000000-0000-0000-0000-000000000001',
  'delete.student'
);

delete from public.users where id = '68000000-0000-0000-0000-000000000003';

do $$
begin
  if exists (
    select 1 from public.quran_report_assignments
    where student_id = '68000000-0000-0000-0000-000000000003'
  ) then
    raise exception 'Student-specific Quran history remains after hard-delete preparation';
  end if;
  if exists (
    select 1 from public.users
    where id = '68000000-0000-0000-0000-000000000003'
  ) then
    raise exception 'Student profile survived a requested hard account deletion';
  end if;
end;
$$;

rollback;

select 'transfer and hard delete flow passed' as result;
