\set ON_ERROR_STOP on

insert into auth.users (id, email, raw_user_meta_data, created_at, updated_at)
values
  ('30000000-0000-0000-0000-000000000001', 'legacy-teacher@example.test', '{"full_name":"Legacy Teacher","username":"legacy.teacher"}', now(), now()),
  ('30000000-0000-0000-0000-000000000002', 'legacy-student@example.test', '{"full_name":"Legacy Student","username":"legacy.student"}', now(), now());

update public.users
set role = case
  when id = '30000000-0000-0000-0000-000000000001' then 'teacher'::public.user_role
  else 'student'::public.user_role
end,
is_active = true
where id in (
  '30000000-0000-0000-0000-000000000001',
  '30000000-0000-0000-0000-000000000002'
);

insert into public.halaqat (id, name, teacher_id, created_at)
values (
  '40000000-0000-0000-0000-000000000001',
  'Legacy Quran Circle',
  '30000000-0000-0000-0000-000000000001',
  now()
);

insert into public.halaqa_students (id, halaqa_id, student_id, created_at)
values (
  '50000000-0000-0000-0000-000000000001',
  '40000000-0000-0000-0000-000000000001',
  '30000000-0000-0000-0000-000000000002',
  now()
);

insert into public.classrooms (id, subject_id, teacher_id, name, created_at)
select
  '40000000-0000-0000-0000-000000000002',
  id,
  '30000000-0000-0000-0000-000000000001',
  'Legacy Educational Circle',
  now()
from public.subjects
order by name
limit 1;

insert into public.classroom_students (id, classroom_id, student_id)
values (
  '50000000-0000-0000-0000-000000000002',
  '40000000-0000-0000-0000-000000000002',
  '30000000-0000-0000-0000-000000000002'
);
