\set ON_ERROR_STOP on

begin;

insert into auth.users (id, email, raw_user_meta_data, created_at, updated_at)
values
  ('60000000-0000-0000-0000-000000000001', 'rls-admin@example.test', '{"full_name":"RLS Admin","username":"rls.admin"}', now(), now()),
  ('60000000-0000-0000-0000-000000000002', 'rls-lead@example.test', '{"full_name":"RLS Lead","username":"rls.lead"}', now(), now()),
  ('60000000-0000-0000-0000-000000000003', 'rls-assistant@example.test', '{"full_name":"RLS Assistant","username":"rls.assistant"}', now(), now()),
  ('60000000-0000-0000-0000-000000000004', 'rls-student@example.test', '{"full_name":"RLS Student","username":"rls.student"}', now(), now()),
  ('60000000-0000-0000-0000-000000000005', 'rls-outsider@example.test', '{"full_name":"RLS Outsider","username":"rls.outsider"}', now(), now());

update public.users
set role = case id
  when '60000000-0000-0000-0000-000000000001' then 'admin'::public.user_role
  when '60000000-0000-0000-0000-000000000002' then 'teacher'::public.user_role
  when '60000000-0000-0000-0000-000000000003' then 'teacher'::public.user_role
  else 'student'::public.user_role
end,
is_active = true
where id::text like '60000000-0000-0000-0000-00000000000%';

select id as subject_id
from public.subjects
order by name
limit 1
\gset

set local role authenticated;
select set_config('request.jwt.claim.sub', '60000000-0000-0000-0000-000000000001', true);

select public.create_learning_circle(
  'Secure Educational Circle',
  'educational',
  '60000000-0000-0000-0000-000000000002',
  null,
  array[:'subject_id'::uuid]
);

select public.create_learning_circle(
  'Secure Quran Circle A',
  'quran',
  '60000000-0000-0000-0000-000000000002'
);

select public.create_learning_circle(
  'Secure Quran Circle B',
  'quran',
  '60000000-0000-0000-0000-000000000002'
);

select public.admin_set_learning_circle_staff(
  (select id from public.learning_circles where name = 'Secure Educational Circle'),
  '60000000-0000-0000-0000-000000000003',
  'assistant',
  true
);

select set_config('request.jwt.claim.sub', '60000000-0000-0000-0000-000000000003', true);

do $$
declare
  target_circle_id uuid;
begin
  select id into target_circle_id
  from public.learning_circles
  where name = 'Secure Educational Circle';

  if target_circle_id is null then
    raise exception 'Assistant must be able to read an assigned circle';
  end if;

  begin
    perform public.update_learning_circle_meet_link(
      target_circle_id,
      'https://meet.google.com/abc-defg-hij'
    );
    raise exception 'Assistant changed Meet link without delegated permission';
  exception when sqlstate '42501' then
    null;
  end;

  begin
    update public.learning_circles set name = 'Direct write must fail' where id = target_circle_id;
    raise exception 'Authenticated assistant wrote directly to a protected table';
  exception when sqlstate '42501' then
    null;
  end;
end;
$$;

select set_config('request.jwt.claim.sub', '60000000-0000-0000-0000-000000000002', true);

select public.set_learning_circle_assistant_permissions(
  (select id from public.learning_circles where name = 'Secure Educational Circle'),
  '60000000-0000-0000-0000-000000000003',
  '{"manage_meet_link":true,"post_announcements":true}'::jsonb
);

select public.add_student_to_learning_circle(
  (select id from public.learning_circles where name = 'Secure Educational Circle'),
  '60000000-0000-0000-0000-000000000004'
);

select public.add_student_to_learning_circle(
  (select id from public.learning_circles where name = 'Secure Quran Circle A'),
  '60000000-0000-0000-0000-000000000004'
);

select public.add_student_to_learning_circle(
  (select id from public.learning_circles where name = 'Secure Quran Circle B'),
  '60000000-0000-0000-0000-000000000004'
);

select set_config('request.jwt.claim.sub', '60000000-0000-0000-0000-000000000003', true);

select public.update_learning_circle_meet_link(
  (select id from public.learning_circles where name = 'Secure Educational Circle'),
  'https://meet.google.com/abc-defg-hij'
);

select set_config('request.jwt.claim.sub', '60000000-0000-0000-0000-000000000004', true);

do $$
begin
  if (select count(*) from public.learning_circles) <> 2 then
    raise exception 'Student must see only the educational circle and current Quran circle';
  end if;

  begin
    perform public.create_learning_circle(
      'Forbidden Circle',
      'quran',
      '60000000-0000-0000-0000-000000000002'
    );
    raise exception 'Student created a learning circle';
  exception when sqlstate '42501' then
    null;
  end;
end;
$$;

select set_config('request.jwt.claim.sub', '60000000-0000-0000-0000-000000000005', true);

do $$
begin
  if (select count(*) from public.learning_circles) <> 0 then
    raise exception 'Unrelated student can see learning circles';
  end if;
end;
$$;

select set_config('request.jwt.claim.sub', '60000000-0000-0000-0000-000000000001', true);

do $$
declare
  pending_transfer_id uuid;
begin
  select id into pending_transfer_id
  from public.learning_circle_transfer_requests
  where student_id = '60000000-0000-0000-0000-000000000004'
    and status = 'pending';

  if pending_transfer_id is null then
    raise exception 'Expected a pending Quran transfer request';
  end if;

  perform public.decide_learning_circle_transfer(pending_transfer_id, true, 'Approved by schema test');

  if not exists (
    select 1
    from public.learning_circle_memberships m
    join public.learning_circles c on c.id = m.circle_id
    where m.student_id = '60000000-0000-0000-0000-000000000004'
      and m.status = 'active'
      and m.circle_type = 'quran'
      and c.name = 'Secure Quran Circle B'
  ) then
    raise exception 'Approved transfer did not activate the target Quran membership';
  end if;

  if (
    select count(*) from public.learning_circle_memberships
    where student_id = '60000000-0000-0000-0000-000000000004'
      and circle_type = 'quran' and status = 'active'
  ) <> 1 then
    raise exception 'Transfer left more than one active Quran membership';
  end if;
end;
$$;

reset role;

do $$
begin
  begin
    update public.platform_audit_events set action = 'tampered' where true;
    raise exception 'Audit events were mutable';
  exception when sqlstate '42501' then
    null;
  end;
end;
$$;

rollback;

select 'learning circle security flow passed' as result;
