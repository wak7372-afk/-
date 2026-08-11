\set ON_ERROR_STOP on

begin;

insert into auth.users (id, email, raw_user_meta_data, created_at, updated_at)
values
  ('70000000-0000-0000-0000-000000000001', 'ops-admin@example.test', '{"full_name":"Ops Admin","username":"ops.admin"}', now(), now()),
  ('70000000-0000-0000-0000-000000000002', 'ops-lead@example.test', '{"full_name":"Ops Lead","username":"ops.lead"}', now(), now()),
  ('70000000-0000-0000-0000-000000000003', 'ops-student@example.test', '{"full_name":"Ops Student","username":"ops.student"}', now(), now());

update public.users
set role = case id
  when '70000000-0000-0000-0000-000000000001' then 'admin'::public.user_role
  when '70000000-0000-0000-0000-000000000002' then 'teacher'::public.user_role
  else 'student'::public.user_role
end,
is_active = true
where id::text like '70000000-0000-0000-0000-00000000000%';

set local role authenticated;
select set_config('request.jwt.claim.sub', '70000000-0000-0000-0000-000000000001', true);

select public.create_learning_circle(
  'Operations Circle',
  'educational',
  '70000000-0000-0000-0000-000000000002',
  'Before update',
  array[(select id from public.subjects order by name limit 1)]
);

select public.update_learning_circle_details(
  (select id from public.learning_circles where name = 'Operations Circle'),
  'Updated Operations Circle',
  'After update',
  array[(select id from public.subjects order by name offset 1 limit 1)]
);

select public.add_student_to_learning_circle(
  (select id from public.learning_circles where name = 'Updated Operations Circle'),
  '70000000-0000-0000-0000-000000000003'
);

do $$
declare
  target_circle_id uuid;
begin
  select id into target_circle_id
  from public.learning_circles
  where name = 'Updated Operations Circle'
    and description = 'After update';

  if target_circle_id is null then
    raise exception 'Administrator update did not persist';
  end if;

  if (select count(*) from public.learning_circle_subjects where circle_id = target_circle_id) <> 1 then
    raise exception 'Administrator update did not replace subjects atomically';
  end if;
end;
$$;

select set_config('request.jwt.claim.sub', '70000000-0000-0000-0000-000000000002', true);

select public.end_learning_circle_membership(
  (
    select id
    from public.learning_circle_memberships
    where student_id = '70000000-0000-0000-0000-000000000003'
      and status = 'active'
  ),
  'completed_program'
);

do $$
begin
  if not exists (
    select 1
    from public.learning_circle_memberships
    where student_id = '70000000-0000-0000-0000-000000000003'
      and status = 'ended'
      and ended_reason = 'completed_program'
  ) then
    raise exception 'Lead teacher did not end the membership';
  end if;
end;
$$;

select set_config('request.jwt.claim.sub', '70000000-0000-0000-0000-000000000003', true);

do $$
declare
  target_circle_id uuid;
begin
  select id into target_circle_id
  from public.learning_circles
  where name = 'Updated Operations Circle';

  begin
    perform public.update_learning_circle_details(
      target_circle_id,
      'Forbidden Student Update',
      null,
      array[(select id from public.subjects order by name limit 1)]
    );
    raise exception 'Student updated learning circle details';
  exception when sqlstate '42501' then
    null;
  end;
end;
$$;

reset role;

do $$
begin
  if not exists (select 1 from public.platform_audit_events where action = 'circle.details_updated') then
    raise exception 'Circle details update was not audited';
  end if;
  if not exists (select 1 from public.platform_audit_events where action = 'circle.student_removed') then
    raise exception 'Membership end was not audited';
  end if;
end;
$$;

rollback;

select 'learning circle administrator operations flow passed' as result;
