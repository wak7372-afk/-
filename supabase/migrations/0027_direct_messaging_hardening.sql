-- Canonical direct-message contacts and relationship-bound message writes.

create or replace function public.list_my_direct_message_contacts()
returns jsonb
language sql
stable
security definer
set search_path = pg_catalog, public
set row_security = off
as $$
  with actor as (
    select id, role
    from public.users
    where id = auth.uid() and is_active = true and deleted_at is null
  ), eligible as (
    select
      student.id,
      student.full_name,
      student.username,
      student.role,
      circle.id as circle_id,
      circle.name as circle_name,
      circle.circle_type
    from actor
    join public.learning_circle_staff staff
      on actor.role = 'teacher'
      and staff.teacher_id = actor.id
      and staff.status = 'active'
    join public.learning_circles circle
      on circle.id = staff.circle_id and circle.status = 'active'
    join public.learning_circle_memberships membership
      on membership.circle_id = circle.id
      and membership.status in ('active', 'transfer_pending')
    join public.users student
      on student.id = membership.student_id
      and student.role = 'student'
      and student.is_active = true
      and student.deleted_at is null

    union all

    select
      teacher.id,
      teacher.full_name,
      teacher.username,
      teacher.role,
      circle.id as circle_id,
      circle.name as circle_name,
      circle.circle_type
    from actor
    join public.learning_circle_memberships membership
      on actor.role = 'student'
      and membership.student_id = actor.id
      and membership.status in ('active', 'transfer_pending')
    join public.learning_circles circle
      on circle.id = membership.circle_id and circle.status = 'active'
    join public.learning_circle_staff staff
      on staff.circle_id = circle.id and staff.status = 'active'
    join public.users teacher
      on teacher.id = staff.teacher_id
      and teacher.role = 'teacher'
      and teacher.is_active = true
      and teacher.deleted_at is null
  ), distinct_eligible as (
    select distinct id, full_name, username, role, circle_id, circle_name, circle_type
    from eligible
  ), contacts as (
    select
      id,
      max(full_name) as full_name,
      max(username) as username,
      max(role) as role,
      jsonb_agg(
        jsonb_build_object(
          'id', circle_id,
          'name', circle_name,
          'circle_type', circle_type
        ) order by circle_name
      ) as circles
    from distinct_eligible
    group by id
  )
  select coalesce(
    jsonb_agg(
      jsonb_build_object(
        'id', id,
        'full_name', full_name,
        'username', username,
        'role', role,
        'circles', circles
      ) order by full_name
    ),
    '[]'::jsonb
  )
  from contacts;
$$;

create or replace function public.can_direct_message(p_sender_id uuid, p_receiver_id uuid)
returns boolean
language sql
stable
security definer
set search_path = pg_catalog, public
set row_security = off
as $$
  select
    p_sender_id = auth.uid()
    and p_sender_id <> p_receiver_id
    and (
      public.is_admin()
      or exists (
        select 1
        from public.users sender
        join public.users receiver on receiver.id = p_receiver_id
        where sender.id = p_sender_id
          and sender.is_active = true and sender.deleted_at is null
          and receiver.is_active = true and receiver.deleted_at is null
          and (
            (
              sender.role = 'teacher' and receiver.role = 'student'
              and exists (
                select 1
                from public.learning_circle_staff staff
                join public.learning_circle_memberships membership
                  on membership.circle_id = staff.circle_id
                join public.learning_circles circle on circle.id = staff.circle_id
                where staff.teacher_id = sender.id and staff.status = 'active'
                  and membership.student_id = receiver.id
                  and membership.status in ('active', 'transfer_pending')
                  and circle.status = 'active'
              )
            )
            or
            (
              sender.role = 'student' and receiver.role = 'teacher'
              and exists (
                select 1
                from public.learning_circle_memberships membership
                join public.learning_circle_staff staff
                  on staff.circle_id = membership.circle_id
                join public.learning_circles circle on circle.id = membership.circle_id
                where membership.student_id = sender.id
                  and membership.status in ('active', 'transfer_pending')
                  and staff.teacher_id = receiver.id and staff.status = 'active'
                  and circle.status = 'active'
              )
            )
          )
      )
    );
$$;

drop policy if exists "Users read write their messages" on public.messages;
drop policy if exists "Participants read messages" on public.messages;
drop policy if exists "Participants send allowed messages" on public.messages;
drop policy if exists "Receivers mark messages read" on public.messages;
drop policy if exists "Admins delete messages" on public.messages;
drop policy if exists "Participants read their direct messages" on public.messages;
drop policy if exists "Participants send messages to related users" on public.messages;

create policy "Participants read their direct messages"
  on public.messages for select to authenticated
  using (
    sender_id = auth.uid()
    or receiver_id = auth.uid()
    or public.is_admin()
  );

create policy "Participants send messages to related users"
  on public.messages for insert to authenticated
  with check (
    sender_id = auth.uid()
    and public.can_direct_message(sender_id, receiver_id)
  );

revoke all on public.messages from anon, authenticated;
grant select, insert on public.messages to authenticated;

revoke all on function public.list_my_direct_message_contacts() from public;
grant execute on function public.list_my_direct_message_contacts() to authenticated;

revoke all on function public.can_direct_message(uuid, uuid) from public;
grant execute on function public.can_direct_message(uuid, uuid) to authenticated;
