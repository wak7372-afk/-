\set ON_ERROR_STOP on

begin;

insert into auth.users (id, email, raw_user_meta_data, created_at, updated_at)
values
  ('80000000-0000-4000-8000-000000000001', 'workspace-admin@example.test', '{"full_name":"Workspace Admin","username":"workspace.admin"}', now(), now()),
  ('80000000-0000-4000-8000-000000000002', 'workspace-lead@example.test', '{"full_name":"Workspace Lead","username":"workspace.lead"}', now(), now()),
  ('80000000-0000-4000-8000-000000000003', 'workspace-assistant@example.test', '{"full_name":"Workspace Assistant","username":"workspace.assistant"}', now(), now()),
  ('80000000-0000-4000-8000-000000000004', 'workspace-quran@example.test', '{"full_name":"Quran Student","username":"workspace.quran"}', now(), now()),
  ('80000000-0000-4000-8000-000000000005', 'workspace-edu@example.test', '{"full_name":"Educational Student","username":"workspace.edu"}', now(), now()),
  ('80000000-0000-4000-8000-000000000006', 'workspace-outsider@example.test', '{"full_name":"Workspace Outsider","username":"workspace.outsider"}', now(), now());

update public.users
set role = case id
  when '80000000-0000-4000-8000-000000000001' then 'admin'::public.user_role
  when '80000000-0000-4000-8000-000000000002' then 'teacher'::public.user_role
  when '80000000-0000-4000-8000-000000000003' then 'teacher'::public.user_role
  else 'student'::public.user_role
end,
is_active = true
where id::text like '80000000-0000-4000-8000-00000000000%';

select id as subject_id from public.subjects order by name limit 1 \gset

set local role authenticated;
select set_config('request.jwt.claim.sub', '80000000-0000-4000-8000-000000000001', true);

select public.create_learning_circle(
  'Workspace Educational Circle', 'educational',
  '80000000-0000-4000-8000-000000000002', null, array[:'subject_id'::uuid]
);
select public.create_learning_circle(
  'Workspace Quran Circle', 'quran',
  '80000000-0000-4000-8000-000000000002'
);

select public.admin_set_learning_circle_staff(
  (select id from public.learning_circles where name = 'Workspace Educational Circle'),
  '80000000-0000-4000-8000-000000000003', 'assistant', true
);

select set_config('request.jwt.claim.sub', '80000000-0000-4000-8000-000000000002', true);
select public.add_student_to_learning_circle(
  (select id from public.learning_circles where name = 'Workspace Educational Circle'),
  '80000000-0000-4000-8000-000000000005'
);
select public.add_student_to_learning_circle(
  (select id from public.learning_circles where name = 'Workspace Quran Circle'),
  '80000000-0000-4000-8000-000000000004'
);
select public.add_student_to_learning_circle(
  (select id from public.learning_circles where name = 'Workspace Quran Circle'),
  '80000000-0000-4000-8000-000000000005'
);

select public.create_learning_circle_post(
  (select id from public.learning_circles where name = 'Workspace Quran Circle'),
  'announcement', 'إعلان حلقة القرآن', 'اختبار إعلان المعلم'
);
select public.update_learning_circle_workspace_settings(
  (select id from public.learning_circles where name = 'Workspace Quran Circle'),
  true, true
);

do $$
declare
  quran_settings public.learning_circle_settings%rowtype;
begin
  select * into quran_settings
  from public.learning_circle_settings
  where circle_id = (select id from public.learning_circles where name = 'Workspace Quran Circle');

  if quran_settings.students_can_create_topics or quran_settings.students_can_reply then
    raise exception 'Quran discussion settings must remain disabled';
  end if;
end;
$$;

select set_config('request.jwt.claim.sub', '80000000-0000-4000-8000-000000000003', true);
do $$
begin
  begin
    perform public.create_learning_circle_post(
      (select id from public.learning_circles where name = 'Workspace Educational Circle'),
      'announcement', 'إعلان غير مفوض', null
    );
    raise exception 'Assistant posted without delegation';
  exception when sqlstate '42501' then null;
  end;
end;
$$;

select set_config('request.jwt.claim.sub', '80000000-0000-4000-8000-000000000002', true);
select public.set_learning_circle_assistant_permissions(
  (select id from public.learning_circles where name = 'Workspace Educational Circle'),
  '80000000-0000-4000-8000-000000000003',
  '{"post_announcements":true,"manage_discussions":true}'::jsonb
);

select set_config('request.jwt.claim.sub', '80000000-0000-4000-8000-000000000003', true);
select public.create_learning_circle_post(
  (select id from public.learning_circles where name = 'Workspace Educational Circle'),
  'announcement', 'إعلان المساعد المفوض', 'نجح التفويض'
);

select set_config('request.jwt.claim.sub', '80000000-0000-4000-8000-000000000004', true);
do $$
declare
  workspace jsonb;
begin
  if jsonb_array_length(public.list_my_learning_circles()) <> 1 then
    raise exception 'Quran student should see exactly one circle';
  end if;

  workspace := public.get_learning_circle_workspace(
    (select id from public.learning_circles where name = 'Workspace Quran Circle')
  );
  if (workspace #>> '{people,students_count}')::integer <> 2 then
    raise exception 'Quran workspace should report the full student count';
  end if;
  if jsonb_array_length(workspace #> '{people,students}') <> 1 then
    raise exception 'Student workspace leaked classmate identities';
  end if;
  if workspace #>> '{people,students,0,student_id}' <> auth.uid()::text then
    raise exception 'Student workspace did not return the current membership';
  end if;
  begin
    perform public.create_learning_circle_post(
      (select id from public.learning_circles where name = 'Workspace Quran Circle'),
      'discussion', 'موضوع طالب القرآن', 'يجب منعه', null, true, false
    );
    raise exception 'Quran student created a discussion';
  exception when sqlstate '42501' then null;
  end;
  begin
    insert into public.learning_circle_posts (circle_id, post_type, title, author_id)
    values (
      (select id from public.learning_circles where name = 'Workspace Quran Circle'),
      'discussion', 'كتابة مباشرة', auth.uid()
    );
    raise exception 'Student wrote directly to workspace table';
  exception when sqlstate '42501' then null;
  end;
end;
$$;

select set_config('request.jwt.claim.sub', '80000000-0000-4000-8000-000000000005', true);
select public.create_learning_circle_post(
  (select id from public.learning_circles where name = 'Workspace Educational Circle'),
  'discussion', 'موضوع الطالب التعليمي', 'موضوع مسموح حسب الإعدادات', null, true, false
);
select public.reply_to_learning_circle_post(
  (select id from public.learning_circle_posts where title = 'موضوع الطالب التعليمي'),
  'رد الطالب التعليمي'
);

select set_config('request.jwt.claim.sub', '80000000-0000-4000-8000-000000000002', true);
select public.moderate_learning_circle_post(
  (select id from public.learning_circle_posts where title = 'موضوع الطالب التعليمي'),
  'close'
);

select set_config('request.jwt.claim.sub', '80000000-0000-4000-8000-000000000005', true);
do $$
begin
  begin
    perform public.reply_to_learning_circle_post(
      (select id from public.learning_circle_posts where title = 'موضوع الطالب التعليمي'),
      'رد بعد إغلاق الموضوع'
    );
    raise exception 'Student replied to a closed discussion';
  exception when others then
    if sqlerrm <> 'Replies are closed' then raise; end if;
  end;
end;
$$;

select set_config('request.jwt.claim.sub', '80000000-0000-4000-8000-000000000002', true);
select public.moderate_learning_circle_post(
  (select id from public.learning_circle_posts where title = 'موضوع الطالب التعليمي'),
  'reopen'
);
select public.remove_learning_circle_reply((
  select r.id
  from public.learning_circle_post_replies r
  join public.learning_circle_posts p on p.id = r.post_id
  where p.title = 'موضوع الطالب التعليمي' and r.body = 'رد الطالب التعليمي'
));

do $$
begin
  if not exists (
    select 1
    from public.learning_circle_post_replies r
    join public.learning_circle_posts p on p.id = r.post_id
    where p.title = 'موضوع الطالب التعليمي'
      and r.body = 'رد الطالب التعليمي'
      and r.status = 'removed'
  ) then
    raise exception 'Moderated reply was not marked as removed';
  end if;
end;
$$;

select public.update_learning_circle_workspace_settings(
  (select id from public.learning_circles where name = 'Workspace Educational Circle'),
  false, false
);

select set_config('request.jwt.claim.sub', '80000000-0000-4000-8000-000000000005', true);
do $$
begin
  begin
    perform public.create_learning_circle_post(
      (select id from public.learning_circles where name = 'Workspace Educational Circle'),
      'discussion', 'موضوع بعد الإغلاق', null
    );
    raise exception 'Educational student bypassed closed topic setting';
  exception when sqlstate '42501' then null;
  end;
end;
$$;

select set_config('request.jwt.claim.sub', '80000000-0000-4000-8000-000000000006', true);
do $$
begin
  begin
    perform public.get_learning_circle_workspace(
      (select id from public.learning_circles where name = 'Workspace Educational Circle')
    );
    raise exception 'Outsider opened a workspace';
  exception when sqlstate '42501' then null;
  end;
end;
$$;

reset role;

do $$
begin
  if not exists (select 1 from public.platform_audit_events where action = 'circle.post_created') then
    raise exception 'Post creation was not audited';
  end if;
  if not exists (select 1 from public.platform_audit_events where action = 'circle.reply_created') then
    raise exception 'Reply creation was not audited';
  end if;
  if not exists (select 1 from public.platform_audit_events where action = 'circle.workspace_settings_updated') then
    raise exception 'Workspace settings update was not audited';
  end if;
  if not exists (select 1 from public.platform_audit_events where action = 'circle.post_close') then
    raise exception 'Post closure was not audited';
  end if;
  if not exists (select 1 from public.platform_audit_events where action = 'circle.post_reopen') then
    raise exception 'Post reopening was not audited';
  end if;
  if not exists (select 1 from public.platform_audit_events where action = 'circle.reply_removed') then
    raise exception 'Reply removal was not audited';
  end if;
end;
$$;

rollback;

select 'learning circle workspace flow passed' as result;
