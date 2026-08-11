\set ON_ERROR_STOP on

begin;

insert into auth.users (id, email, raw_user_meta_data, created_at, updated_at)
values
  ('91000000-0000-4000-8000-000000000001', 'quran-admin@example.test', '{"full_name":"Quran Admin","username":"quran.admin"}', now(), now()),
  ('91000000-0000-4000-8000-000000000002', 'quran-lead@example.test', '{"full_name":"Quran Lead","username":"quran.lead"}', now(), now()),
  ('91000000-0000-4000-8000-000000000003', 'quran-assistant@example.test', '{"full_name":"Quran Assistant","username":"quran.assistant"}', now(), now()),
  ('91000000-0000-4000-8000-000000000004', 'quran-student-one@example.test', '{"full_name":"Quran Student One","username":"quran.student1"}', now(), now()),
  ('91000000-0000-4000-8000-000000000005', 'quran-student-two@example.test', '{"full_name":"Quran Student Two","username":"quran.student2"}', now(), now()),
  ('91000000-0000-4000-8000-000000000006', 'quran-outsider@example.test', '{"full_name":"Quran Outsider","username":"quran.outsider"}', now(), now());

update public.users
set role = case id
  when '91000000-0000-4000-8000-000000000001' then 'admin'::public.user_role
  when '91000000-0000-4000-8000-000000000002' then 'teacher'::public.user_role
  when '91000000-0000-4000-8000-000000000003' then 'teacher'::public.user_role
  else 'student'::public.user_role
end,
is_active = true
where id::text like '91000000-0000-4000-8000-00000000000%';

set local role authenticated;
select set_config('request.jwt.claim.sub', '91000000-0000-4000-8000-000000000001', true);

select public.create_learning_circle(
  'Quran Reports Flow Circle', 'quran',
  '91000000-0000-4000-8000-000000000002'
);

select public.admin_set_learning_circle_staff(
  (select id from public.learning_circles where name = 'Quran Reports Flow Circle'),
  '91000000-0000-4000-8000-000000000003', 'assistant', true
);

select set_config('request.jwt.claim.sub', '91000000-0000-4000-8000-000000000002', true);
select public.add_student_to_learning_circle(
  (select id from public.learning_circles where name = 'Quran Reports Flow Circle'),
  '91000000-0000-4000-8000-000000000004'
);
select public.add_student_to_learning_circle(
  (select id from public.learning_circles where name = 'Quran Reports Flow Circle'),
  '91000000-0000-4000-8000-000000000005'
);

create temporary table quran_reports_test_batches (
  name text primary key,
  batch_id uuid not null
);

insert into quran_reports_test_batches (name, batch_id)
select 'staged', (public.stage_quran_report_import(
  (select id from public.learning_circles where name = 'Quran Reports Flow Circle'),
  'daily-plan.xlsx', 10219, repeat('a', 64),
  '[
    {"source_sheet":"ورقة1","source_row":3,"date":"2026-12-08","type":"hifz","content":"سورة النبأ الآيات 1-4","repetitions":3},
    {"source_sheet":"ورقة1","source_row":3,"date":"2026-12-08","type":"tathbit","content":"سورة النبأ الآيات 1-4","repetitions":2},
    {"source_sheet":"ورقة1","source_row":3,"date":"2026-12-08","type":"murajaa","content":"الصفحات 596-604","repetitions":3}
  ]'::jsonb,
  'all'
) ->> 'batch_id')::uuid;

do $$
declare
  preview jsonb;
begin
  preview := public.get_quran_report_import_preview(
    (select batch_id from quran_reports_test_batches where name = 'staged')
  );
  if (preview #>> '{batch,valid_row_count}')::integer <> 3 then
    raise exception 'Expected three valid Quran report rows';
  end if;
  if jsonb_array_length(preview -> 'recipients') <> 2 then
    raise exception 'All audience did not snapshot two active students';
  end if;
  if (preview ->> 'conflict_count')::integer <> 0 then
    raise exception 'Fresh import unexpectedly has conflicts';
  end if;
end;
$$;

select public.approve_quran_report_import(
  (select batch_id from quran_reports_test_batches where name = 'staged'),
  'reject'
);

do $$
declare
  start_at timestamptz := public.quran_report_local_timestamp('2026-12-08', '00:00', 'Asia/Muscat');
  end_at timestamptz := public.quran_report_local_timestamp('2026-12-08', '23:00', 'Asia/Muscat');
begin
  if (select count(*) from public.quran_reports where import_batch_id = (select batch_id from quran_reports_test_batches where name = 'staged')) <> 3 then
    raise exception 'Approval did not create three shared reports';
  end if;
  if (select count(*) from public.quran_report_assignments a join public.quran_reports r on r.id = a.report_id where r.import_batch_id = (select batch_id from quran_reports_test_batches where name = 'staged')) <> 6 then
    raise exception 'Approval did not create six student assignments';
  end if;
  if public.quran_report_points_at(4, start_at, end_at, start_at) <> 4.00 then
    raise exception 'Hifz start score must be four points';
  end if;
  if public.quran_report_points_at(4, start_at, end_at, start_at + interval '11 hours 30 minutes') <> 2.00 then
    raise exception 'Hifz midpoint score must be two points';
  end if;
  if public.quran_report_points_at(3, start_at, end_at, start_at + interval '11 hours 30 minutes') <> 1.50 then
    raise exception 'Three-point task midpoint score must be 1.50';
  end if;
  if public.quran_report_points_at(3, start_at, end_at, end_at) <> 0.00 then
    raise exception 'Score at the deadline must be zero';
  end if;
end;
$$;

insert into quran_reports_test_batches (name, batch_id)
select 'replacement', (public.stage_quran_report_import(
  (select id from public.learning_circles where name = 'Quran Reports Flow Circle'),
  'replacement.xlsx', 8000, repeat('b', 64),
  '[{"source_sheet":"ورقة1","source_row":3,"date":"2026-12-08","type":"hifz","content":"سورة النبأ الآيات 1-6","repetitions":4}]'::jsonb,
  'selected',
  array['91000000-0000-4000-8000-000000000004'::uuid]
) ->> 'batch_id')::uuid;

do $$
begin
  if ((public.get_quran_report_import_preview(
    (select batch_id from quran_reports_test_batches where name = 'replacement')
  )) ->> 'conflict_count')::integer <> 1 then
    raise exception 'Expected one selected-student conflict';
  end if;
  begin
    perform public.approve_quran_report_import(
      (select batch_id from quran_reports_test_batches where name = 'replacement'),
      'reject'
    );
    raise exception 'Conflicting import was approved without a strategy';
  exception when others then
    if sqlerrm <> 'The import conflicts with existing student plans' then raise; end if;
  end;
end;
$$;

select public.approve_quran_report_import(
  (select batch_id from quran_reports_test_batches where name = 'replacement'),
  'replace'
);

do $$
begin
  if (select count(*) from public.quran_report_assignments where student_id = '91000000-0000-4000-8000-000000000004' and report_date = '2026-12-08' and task_type = 'hifz' and status = 'pending') <> 1 then
    raise exception 'Replacement did not preserve one active student task';
  end if;
  if (select count(*) from public.quran_report_assignments where student_id = '91000000-0000-4000-8000-000000000004' and report_date = '2026-12-08' and task_type = 'hifz' and status = 'replaced') <> 1 then
    raise exception 'Replacement did not retain the prior assignment history';
  end if;
end;
$$;

select set_config('request.jwt.claim.sub', '91000000-0000-4000-8000-000000000003', true);
do $$
begin
  begin
    perform public.stage_quran_report_import(
      (select id from public.learning_circles where name = 'Quran Reports Flow Circle'),
      'assistant-denied.xlsx', 100, repeat('c', 64),
      '[{"source_row":1,"date":"2026-12-09","type":"hifz","content":"مهمة"}]'::jsonb,
      'all'
    );
    raise exception 'Assistant staged reports without create_tasks permission';
  exception when sqlstate '42501' then null;
  end;
end;
$$;

select set_config('request.jwt.claim.sub', '91000000-0000-4000-8000-000000000002', true);
select public.set_learning_circle_assistant_permissions(
  (select id from public.learning_circles where name = 'Quran Reports Flow Circle'),
  '91000000-0000-4000-8000-000000000003',
  '{"create_tasks":true}'::jsonb
);

select set_config('request.jwt.claim.sub', '91000000-0000-4000-8000-000000000003', true);
select public.stage_quran_report_import(
  (select id from public.learning_circles where name = 'Quran Reports Flow Circle'),
  'assistant-allowed.xlsx', 100, repeat('d', 64),
  '[{"source_row":1,"date":"2026-12-09","type":"hifz","content":"مهمة المساعد"}]'::jsonb,
  'selected',
  array['91000000-0000-4000-8000-000000000005'::uuid]
);

select set_config('request.jwt.claim.sub', '91000000-0000-4000-8000-000000000002', true);
insert into quran_reports_test_batches (name, batch_id)
select 'operations', (public.stage_quran_report_import(
  (select id from public.learning_circles where name = 'Quran Reports Flow Circle'),
  'operations.xlsx', 1200, repeat('e', 64),
  jsonb_build_array(
    jsonb_build_object('source_row', 1, 'date', (current_date - 1)::text, 'type', 'hifz', 'content', 'تقرير متأخر'),
    jsonb_build_object('source_row', 2, 'date', current_date::text, 'type', 'hifz', 'content', 'تقرير اليوم'),
    jsonb_build_object('source_row', 2, 'date', current_date::text, 'type', 'tathbit', 'content', 'تثبيت اليوم')
  ),
  'selected',
  array['91000000-0000-4000-8000-000000000004'::uuid]
) ->> 'batch_id')::uuid;

select public.approve_quran_report_import(
  (select batch_id from quran_reports_test_batches where name = 'operations'),
  'reject'
);

select set_config('request.jwt.claim.sub', '91000000-0000-4000-8000-000000000004', true);
do $$
declare
  today_assignment uuid;
begin
  select id into today_assignment
  from public.quran_report_assignments
  where student_id = auth.uid() and report_date = current_date and task_type = 'hifz' and status = 'pending';
  begin
    perform public.complete_quran_report_assignment(today_assignment);
    raise exception 'Student completed a later report while an older report was overdue';
  exception when others then
    if sqlerrm <> 'Complete overdue Quran reports before later reports' then raise; end if;
  end;
end;
$$;

create temporary table quran_extension_test (request_id uuid primary key, assignment_id uuid not null);
insert into quran_extension_test (request_id, assignment_id)
select
  (result ->> 'request_id')::uuid,
  assignment_id
from (
  select
    assignment.id as assignment_id,
    public.request_quran_report_extension(
      array[assignment.id], 60, 'عذر واضح لاختبار طلب التمديد'
    ) as result
  from public.quran_report_assignments assignment
  where assignment.student_id = auth.uid()
    and assignment.report_date = current_date - 1
    and assignment.task_type = 'hifz'
    and assignment.status = 'pending'
) requested;

select set_config('request.jwt.claim.sub', '91000000-0000-4000-8000-000000000002', true);
select public.decide_quran_report_extension(
  (select request_id from quran_extension_test),
  jsonb_build_array(jsonb_build_object(
    'assignment_id', (select assignment_id from quran_extension_test),
    'action', 'approve',
    'mode', 'duration',
    'minutes', 60,
    'note', 'تم قبول العذر'
  ))
);

select set_config('request.jwt.claim.sub', '91000000-0000-4000-8000-000000000004', true);
select public.complete_quran_report_assignment(
  (select id from public.quran_report_assignments
   where student_id = auth.uid() and report_date = current_date and task_type = 'hifz' and status = 'pending')
);
select public.complete_quran_report_assignment((select assignment_id from quran_extension_test));

do $$
declare
  feed jsonb;
begin
  feed := public.get_my_quran_reports(current_date - 2, current_date + 1);
  if jsonb_array_length(feed -> 'assignments') <> 3 then
    raise exception 'Student Quran report feed did not return all active assignments';
  end if;
  if (select count(*) from public.quran_report_assignments where student_id = auth.uid() and status = 'completed' and report_date in (current_date - 1, current_date)) <> 2 then
    raise exception 'Protected completion did not persist both completed reports';
  end if;
end;
$$;

select set_config('request.jwt.claim.sub', '91000000-0000-4000-8000-000000000002', true);
select public.exempt_quran_report_assignment(
  (select id from public.quran_report_assignments
   where student_id = '91000000-0000-4000-8000-000000000004'
     and report_date = current_date and task_type = 'tathbit' and status = 'pending'),
  'إعفاء معتمد لاختبار فك التعثر'
);

do $$
declare
  console_data jsonb;
  history_data jsonb;
  queue_data jsonb;
begin
  console_data := public.get_quran_teacher_console(
    (select id from public.learning_circles where name = 'Quran Reports Flow Circle'), current_date
  );
  if jsonb_array_length(console_data -> 'students') <> 2 then
    raise exception 'Teacher console did not include all active students';
  end if;
  history_data := public.get_quran_student_history(
    (select id from public.learning_circles where name = 'Quran Reports Flow Circle'),
    '91000000-0000-4000-8000-000000000004', 60, 0
  );
  if (history_data ->> 'total')::integer < 3 then
    raise exception 'Teacher student history is incomplete';
  end if;
  queue_data := public.get_quran_extension_queue(
    (select id from public.learning_circles where name = 'Quran Reports Flow Circle'), 'approved'
  );
  if jsonb_array_length(queue_data) <> 1 then
    raise exception 'Approved extension request is missing from the queue';
  end if;
end;
$$;

select set_config('request.jwt.claim.sub', '91000000-0000-4000-8000-000000000003', true);
do $$
begin
  begin
    perform public.get_quran_teacher_console(
      (select id from public.learning_circles where name = 'Quran Reports Flow Circle'), current_date
    );
    raise exception 'Assistant reviewed Quran reports without review_submissions permission';
  exception when sqlstate '42501' then null;
  end;
end;
$$;

select set_config('request.jwt.claim.sub', '91000000-0000-4000-8000-000000000002', true);
select public.set_learning_circle_assistant_permissions(
  (select id from public.learning_circles where name = 'Quran Reports Flow Circle'),
  '91000000-0000-4000-8000-000000000003',
  '{"create_tasks":true,"review_submissions":true}'::jsonb
);

select set_config('request.jwt.claim.sub', '91000000-0000-4000-8000-000000000003', true);
select public.get_quran_teacher_console(
  (select id from public.learning_circles where name = 'Quran Reports Flow Circle'), current_date
);

select set_config('request.jwt.claim.sub', '91000000-0000-4000-8000-000000000004', true);
do $$
begin
  begin
    insert into public.quran_report_assignments (
      report_id, circle_id, membership_id, student_id, report_date, task_type,
      starts_at, original_due_at, effective_due_at, max_points
    ) select
      r.id, r.circle_id, m.id, auth.uid(), r.report_date, r.task_type,
      r.starts_at, r.due_at, r.due_at, r.max_points
    from public.quran_reports r
    join public.learning_circle_memberships m on m.circle_id = r.circle_id and m.student_id = auth.uid()
    limit 1;
    raise exception 'Student wrote directly to Quran report assignments';
  exception when sqlstate '42501' then null;
  end;
end;
$$;

reset role;

-- Daily summary publication: on-time, late, incomplete, extended, and exempted.
insert into auth.users (id, email, raw_user_meta_data, created_at, updated_at)
select
  format('92000000-0000-4000-8000-%s', lpad(student_number::text, 12, '0'))::uuid,
  format('summary-student-%s@example.test', student_number),
  jsonb_build_object(
    'full_name', format('Summary Student %s', student_number),
    'username', format('summary.student%s', student_number)
  ),
  now(),
  now()
from generate_series(7, 11) student_number;

update public.users
set role = 'student', is_active = true
where id::text like '92000000-0000-4000-8000-%';

insert into public.learning_circles (
  id, circle_type, name, description, status, created_by
) values (
  '93000000-0000-4000-8000-000000000001',
  'quran',
  'Quran Daily Summary Flow Circle',
  'Daily summary integration fixture',
  'active',
  '91000000-0000-4000-8000-000000000001'
);

insert into public.learning_circle_memberships (
  circle_id, student_id, circle_type, status, source, added_by
)
select
  '93000000-0000-4000-8000-000000000001',
  user_profile.id,
  'quran',
  'active',
  'manual',
  '91000000-0000-4000-8000-000000000001'
from public.users user_profile
where user_profile.id::text like '92000000-0000-4000-8000-%';

insert into public.quran_reports (
  id, circle_id, report_date, task_type, content, max_points,
  starts_at, due_at, status, created_by
) values (
  '94000000-0000-4000-8000-000000000001',
  '93000000-0000-4000-8000-000000000001',
  (now() at time zone 'Asia/Muscat')::date - 1,
  'hifz',
  'تقرير اختبار الملخص اليومي',
  4.00,
  now() - interval '12 hours',
  now() - interval '1 hour',
  'published',
  '91000000-0000-4000-8000-000000000002'
);

insert into public.quran_report_assignments (
  report_id, circle_id, membership_id, student_id, report_date, task_type,
  starts_at, original_due_at, effective_due_at, max_points,
  status, completed_at, awarded_points, exempted_by, exempted_at, exemption_reason
)
select
  '94000000-0000-4000-8000-000000000001',
  membership.circle_id,
  membership.id,
  membership.student_id,
  (now() at time zone 'Asia/Muscat')::date - 1,
  'hifz',
  now() - interval '12 hours',
  now() - interval '1 hour',
  case
    when membership.student_id = '92000000-0000-4000-8000-000000000010' then now() + interval '2 hours'
    else now() - interval '1 hour'
  end,
  4.00,
  case
    when membership.student_id in (
      '92000000-0000-4000-8000-000000000007',
      '92000000-0000-4000-8000-000000000008'
    ) then 'completed'
    when membership.student_id = '92000000-0000-4000-8000-000000000011' then 'exempted'
    else 'pending'
  end,
  case
    when membership.student_id = '92000000-0000-4000-8000-000000000007' then now() - interval '2 hours'
    when membership.student_id = '92000000-0000-4000-8000-000000000008' then now() - interval '30 minutes'
    else null
  end,
  case
    when membership.student_id = '92000000-0000-4000-8000-000000000007' then 2.50
    when membership.student_id = '92000000-0000-4000-8000-000000000008' then 0.00
    else null
  end,
  case when membership.student_id = '92000000-0000-4000-8000-000000000011'
    then '91000000-0000-4000-8000-000000000002'::uuid else null end,
  case when membership.student_id = '92000000-0000-4000-8000-000000000011'
    then now() else null end,
  case when membership.student_id = '92000000-0000-4000-8000-000000000011'
    then 'إعفاء كامل لاختبار الملخص' else null end
from public.learning_circle_memberships membership
where membership.circle_id = '93000000-0000-4000-8000-000000000001';

do $$
declare
  snapshot jsonb;
begin
  snapshot := public.get_quran_daily_summary_snapshot(
    '93000000-0000-4000-8000-000000000001',
    (now() at time zone 'Asia/Muscat')::date - 1,
    now()
  );
  if (snapshot #>> '{counts,on_time}')::integer <> 1 then raise exception 'Expected one on-time student'; end if;
  if (snapshot #>> '{counts,late}')::integer <> 1 then raise exception 'Expected one late student'; end if;
  if (snapshot #>> '{counts,incomplete}')::integer <> 1 then raise exception 'Expected one incomplete student'; end if;
  if (snapshot #>> '{counts,extended}')::integer <> 1 then raise exception 'Expected one student within an approved extension'; end if;
  if (snapshot #>> '{counts,exempted}')::integer <> 1 then raise exception 'Expected one fully exempted student'; end if;
end;
$$;

set local role authenticated;
select set_config('request.jwt.claim.sub', '91000000-0000-4000-8000-000000000002', true);
do $$
begin
  begin
    perform public.publish_quran_daily_summaries(
      (now() at time zone 'Asia/Muscat')::date - 1,
      '93000000-0000-4000-8000-000000000001'
    );
    raise exception 'Teacher manually published the Quran daily summary';
  exception when sqlstate '42501' then null;
  end;
end;
$$;

select set_config('request.jwt.claim.sub', '91000000-0000-4000-8000-000000000001', true);
select public.publish_quran_daily_summaries(
  (now() at time zone 'Asia/Muscat')::date - 1,
  '93000000-0000-4000-8000-000000000001'
);
select public.publish_quran_daily_summaries(
  (now() at time zone 'Asia/Muscat')::date - 1,
  '93000000-0000-4000-8000-000000000001'
);
reset role;

do $$
declare
  post_body_value text;
begin
  if (
    select count(*) from public.learning_circle_posts
    where circle_id = '93000000-0000-4000-8000-000000000001'
      and system_key = format('quran-daily-summary:%s', (now() at time zone 'Asia/Muscat')::date - 1)
  ) <> 1 then
    raise exception 'Daily summary publication was not idempotent';
  end if;
  if (
    select count(*) from public.quran_daily_summary_runs
    where circle_id = '93000000-0000-4000-8000-000000000001'
      and summary_date = (now() at time zone 'Asia/Muscat')::date - 1
  ) <> 1 then
    raise exception 'Daily summary run ledger did not retain one immutable run';
  end if;

  select body into post_body_value
  from public.learning_circle_posts
  where circle_id = '93000000-0000-4000-8000-000000000001'
    and system_key = format('quran-daily-summary:%s', (now() at time zone 'Asia/Muscat')::date - 1);
  if post_body_value not like '%المنجزون في الوقت%'
     or post_body_value not like '%المنجزون بعد المهلة%'
     or post_body_value not like '%ضمن مهلة معتمدة%'
     or post_body_value not like '%غير المنجزين%'
     or post_body_value not like '%المعفون من تقارير اليوم%' then
    raise exception 'Published summary is missing one or more approved groups';
  end if;
  if not exists (
    select 1 from public.platform_audit_events
    where action = 'quran_reports.daily_summary_published'
      and circle_id = '93000000-0000-4000-8000-000000000001'
  ) then
    raise exception 'Daily summary publication was not audited';
  end if;
  if not exists (
    select 1 from cron.job
    where jobname = 'quran-daily-summary-muscat-2305'
      and schedule = '5 19 * * *'
  ) then
    raise exception 'Daily summary cron schedule is missing or incorrect';
  end if;
end;
$$;

do $$
begin
  if not exists (select 1 from public.platform_audit_events where action = 'quran_reports.import_staged') then
    raise exception 'Import staging was not audited';
  end if;
  if not exists (select 1 from public.platform_audit_events where action = 'quran_reports.import_approved') then
    raise exception 'Import approval was not audited';
  end if;
end;
$$;

rollback;

select 'Quran reports import flow passed' as result;
