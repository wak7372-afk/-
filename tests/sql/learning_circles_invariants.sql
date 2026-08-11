\set ON_ERROR_STOP on

begin;

insert into auth.users (id, email, raw_user_meta_data, created_at, updated_at)
values
  ('10000000-0000-0000-0000-000000000001', 'schema-admin@example.test', '{"full_name":"Schema Admin","username":"schema.admin"}', now(), now()),
  ('10000000-0000-0000-0000-000000000002', 'schema-teacher-a@example.test', '{"full_name":"Teacher A","username":"schema.teacher.a"}', now(), now()),
  ('10000000-0000-0000-0000-000000000003', 'schema-teacher-b@example.test', '{"full_name":"Teacher B","username":"schema.teacher.b"}', now(), now()),
  ('10000000-0000-0000-0000-000000000004', 'schema-student@example.test', '{"full_name":"Student","username":"schema.student"}', now(), now());

update public.users
set role = case id
  when '10000000-0000-0000-0000-000000000001' then 'admin'::public.user_role
  when '10000000-0000-0000-0000-000000000002' then 'teacher'::public.user_role
  when '10000000-0000-0000-0000-000000000003' then 'teacher'::public.user_role
  else 'student'::public.user_role
end,
is_active = true
where id::text like '10000000-0000-0000-0000-00000000000%';

insert into public.learning_circles (id, circle_type, name, created_by)
values
  ('20000000-0000-0000-0000-000000000001', 'quran', 'Quran Circle A', '10000000-0000-0000-0000-000000000001'),
  ('20000000-0000-0000-0000-000000000002', 'quran', 'Quran Circle B', '10000000-0000-0000-0000-000000000001'),
  ('20000000-0000-0000-0000-000000000003', 'educational', 'Educational Circle A', '10000000-0000-0000-0000-000000000001'),
  ('20000000-0000-0000-0000-000000000004', 'educational', 'Educational Circle B', '10000000-0000-0000-0000-000000000001');

insert into public.learning_circle_staff (
  circle_id, teacher_id, staff_role, appointed_by,
  can_post_announcements, can_manage_meet_link, can_create_tasks,
  can_review_submissions, can_manage_discussions, can_track_students
)
values (
  '20000000-0000-0000-0000-000000000001',
  '10000000-0000-0000-0000-000000000002',
  'lead',
  '10000000-0000-0000-0000-000000000001',
  true, true, true, true, true, true
);

do $$
begin
  begin
    insert into public.learning_circle_staff (
      circle_id, teacher_id, staff_role, appointed_by,
      can_post_announcements, can_manage_meet_link, can_create_tasks,
      can_review_submissions, can_manage_discussions, can_track_students
    ) values (
      '20000000-0000-0000-0000-000000000001',
      '10000000-0000-0000-0000-000000000003',
      'lead',
      '10000000-0000-0000-0000-000000000001',
      true, true, true, true, true, true
    );
    raise exception 'Expected the one-active-lead constraint to reject a second lead';
  exception when unique_violation then
    null;
  end;
end;
$$;

insert into public.learning_circle_memberships (
  circle_id, student_id, circle_type, status, source, added_by
)
values (
  '20000000-0000-0000-0000-000000000001',
  '10000000-0000-0000-0000-000000000004',
  'educational',
  'active',
  'manual',
  '10000000-0000-0000-0000-000000000001'
);

do $$
begin
  if not exists (
    select 1 from public.learning_circle_memberships
    where student_id = '10000000-0000-0000-0000-000000000004'
      and circle_type = 'quran'
  ) then
    raise exception 'Membership trigger did not derive the Quran circle type';
  end if;

  begin
    insert into public.learning_circle_memberships (
      circle_id, student_id, circle_type, status, source, added_by
    ) values (
      '20000000-0000-0000-0000-000000000002',
      '10000000-0000-0000-0000-000000000004',
      'quran',
      'active',
      'manual',
      '10000000-0000-0000-0000-000000000001'
    );
    raise exception 'Expected the one-active-Quran-circle constraint to reject a second membership';
  exception when unique_violation then
    null;
  end;
end;
$$;

insert into public.learning_circle_memberships (
  circle_id, student_id, circle_type, status, source, added_by
)
values
  (
    '20000000-0000-0000-0000-000000000003',
    '10000000-0000-0000-0000-000000000004',
    'educational', 'active', 'manual',
    '10000000-0000-0000-0000-000000000001'
  ),
  (
    '20000000-0000-0000-0000-000000000004',
    '10000000-0000-0000-0000-000000000004',
    'educational', 'active', 'manual',
    '10000000-0000-0000-0000-000000000001'
  );

do $$
declare
  educational_count integer;
begin
  select count(*) into educational_count
  from public.learning_circle_memberships
  where student_id = '10000000-0000-0000-0000-000000000004'
    and circle_type = 'educational'
    and status = 'active';

  if educational_count <> 2 then
    raise exception 'Expected two active educational memberships, got %', educational_count;
  end if;
end;
$$;

rollback;

select 'learning circle invariants passed' as result;
