-- RLS and server-side operations for the canonical learning-circle model.

create or replace function public.is_learning_circle_staff(
  p_circle_id uuid,
  p_teacher_id uuid default auth.uid()
)
returns boolean
language sql
stable
security definer
set search_path = pg_catalog, public
set row_security = off
as $$
  select exists (
    select 1
    from public.learning_circle_staff s
    join public.users u on u.id = s.teacher_id
    where s.circle_id = p_circle_id
      and s.teacher_id = p_teacher_id
      and s.status = 'active'
      and u.role = 'teacher'
      and u.is_active = true
  );
$$;

create or replace function public.is_learning_circle_member(
  p_circle_id uuid,
  p_student_id uuid default auth.uid()
)
returns boolean
language sql
stable
security definer
set search_path = pg_catalog, public
set row_security = off
as $$
  select exists (
    select 1
    from public.learning_circle_memberships m
    join public.users u on u.id = m.student_id
    where m.circle_id = p_circle_id
      and m.student_id = p_student_id
      and m.status in ('active', 'transfer_pending')
      and u.role = 'student'
      and u.is_active = true
  );
$$;

create or replace function public.can_access_learning_circle(p_circle_id uuid)
returns boolean
language sql
stable
security definer
set search_path = pg_catalog, public
set row_security = off
as $$
  select
    public.is_admin()
    or public.is_learning_circle_staff(p_circle_id, auth.uid())
    or public.is_learning_circle_member(p_circle_id, auth.uid());
$$;

create or replace function public.can_manage_learning_circle(p_circle_id uuid)
returns boolean
language sql
stable
security definer
set search_path = pg_catalog, public
set row_security = off
as $$
  select
    public.is_admin()
    or exists (
      select 1
      from public.learning_circle_staff s
      join public.users u on u.id = s.teacher_id
      where s.circle_id = p_circle_id
        and s.teacher_id = auth.uid()
        and s.staff_role = 'lead'
        and s.status = 'active'
        and u.role = 'teacher'
        and u.is_active = true
    );
$$;

create or replace function public.has_learning_circle_permission(
  p_circle_id uuid,
  p_permission text
)
returns boolean
language sql
stable
security definer
set search_path = pg_catalog, public
set row_security = off
as $$
  select
    public.is_admin()
    or exists (
      select 1
      from public.learning_circle_staff s
      join public.users u on u.id = s.teacher_id
      where s.circle_id = p_circle_id
        and s.teacher_id = auth.uid()
        and s.status = 'active'
        and u.role = 'teacher'
        and u.is_active = true
        and (
          s.staff_role = 'lead'
          or case p_permission
            when 'post_announcements' then s.can_post_announcements
            when 'manage_meet_link' then s.can_manage_meet_link
            when 'create_tasks' then s.can_create_tasks
            when 'review_submissions' then s.can_review_submissions
            when 'manage_discussions' then s.can_manage_discussions
            when 'track_students' then s.can_track_students
            else false
          end
        )
    );
$$;

create or replace function public.record_platform_audit(
  p_circle_id uuid,
  p_action text,
  p_entity_type text,
  p_entity_id text,
  p_before_data jsonb default null,
  p_after_data jsonb default null,
  p_metadata jsonb default '{}'::jsonb
)
returns void
language plpgsql
security definer
set search_path = pg_catalog, public
set row_security = off
as $$
begin
  insert into public.platform_audit_events (
    actor_id, circle_id, action, entity_type, entity_id,
    before_data, after_data, metadata
  ) values (
    auth.uid(), p_circle_id, p_action, p_entity_type, p_entity_id,
    p_before_data, p_after_data, coalesce(p_metadata, '{}'::jsonb)
  );
end;
$$;

create or replace function public.protect_platform_audit_event()
returns trigger
language plpgsql
set search_path = pg_catalog, public
as $$
begin
  raise exception 'Platform audit events are immutable' using errcode = '42501';
end;
$$;

drop trigger if exists protect_platform_audit_event on public.platform_audit_events;
create trigger protect_platform_audit_event
  before update or delete on public.platform_audit_events
  for each row execute procedure public.protect_platform_audit_event();

create or replace function public.create_learning_circle(
  p_name text,
  p_circle_type text,
  p_lead_teacher_id uuid,
  p_description text default null,
  p_subject_ids uuid[] default '{}'::uuid[]
)
returns uuid
language plpgsql
security definer
set search_path = pg_catalog, public
set row_security = off
as $$
declare
  new_circle_id uuid;
  normalized_name text := btrim(coalesce(p_name, ''));
  normalized_subject_ids uuid[] := coalesce(p_subject_ids, '{}'::uuid[]);
begin
  if not public.is_admin() then
    raise exception 'Only an active administrator may create learning circles' using errcode = '42501';
  end if;
  if p_circle_type not in ('quran', 'educational') then
    raise exception 'Invalid learning circle type';
  end if;
  if char_length(normalized_name) not between 2 and 160 then
    raise exception 'Learning circle name must contain between 2 and 160 characters';
  end if;
  if not exists (
    select 1 from public.users
    where id = p_lead_teacher_id and role = 'teacher' and is_active = true
  ) then
    raise exception 'Lead teacher must be an active teacher';
  end if;
  if p_circle_type = 'educational' and cardinality(normalized_subject_ids) = 0 then
    raise exception 'Educational circles require at least one subject';
  end if;
  if p_circle_type = 'quran' and cardinality(normalized_subject_ids) > 0 then
    raise exception 'Quran circles do not accept educational subjects';
  end if;
  if exists (
    select 1
    from unnest(normalized_subject_ids) sid
    left join public.subjects s on s.id = sid
    where s.id is null
  ) then
    raise exception 'One or more subjects do not exist';
  end if;

  insert into public.learning_circles (
    circle_type, name, description, status, created_by
  ) values (
    p_circle_type, normalized_name, nullif(btrim(coalesce(p_description, '')), ''), 'active', auth.uid()
  ) returning id into new_circle_id;

  insert into public.learning_circle_staff (
    circle_id, teacher_id, staff_role, status,
    can_post_announcements, can_manage_meet_link, can_create_tasks,
    can_review_submissions, can_manage_discussions, can_track_students,
    appointed_by
  ) values (
    new_circle_id, p_lead_teacher_id, 'lead', 'active',
    true, true, true, true, true, true, auth.uid()
  );

  insert into public.learning_circle_subjects (circle_id, subject_id, added_by)
  select new_circle_id, sid, auth.uid()
  from (select distinct unnest(normalized_subject_ids) as sid) selected;

  insert into public.learning_circle_settings (
    circle_id, students_can_create_topics, students_can_reply, updated_by
  ) values (
    new_circle_id,
    p_circle_type = 'educational',
    p_circle_type = 'educational',
    auth.uid()
  );

  perform public.record_platform_audit(
    new_circle_id,
    'circle.created',
    'learning_circle',
    new_circle_id::text,
    null,
    jsonb_build_object(
      'name', normalized_name,
      'circle_type', p_circle_type,
      'lead_teacher_id', p_lead_teacher_id
    )
  );

  return new_circle_id;
end;
$$;

create or replace function public.admin_set_learning_circle_staff(
  p_circle_id uuid,
  p_teacher_id uuid,
  p_staff_role text,
  p_active boolean default true
)
returns jsonb
language plpgsql
security definer
set search_path = pg_catalog, public
set row_security = off
as $$
declare
  current_staff public.learning_circle_staff%rowtype;
begin
  if not public.is_admin() then
    raise exception 'Only an active administrator may assign circle staff' using errcode = '42501';
  end if;
  if not exists (select 1 from public.learning_circles where id = p_circle_id and status <> 'archived') then
    raise exception 'Learning circle not found or archived';
  end if;
  if p_staff_role not in ('lead', 'assistant') then
    raise exception 'Invalid staff role';
  end if;
  if not exists (
    select 1 from public.users
    where id = p_teacher_id and role = 'teacher' and is_active = true
  ) then
    raise exception 'Assigned user must be an active teacher';
  end if;

  select * into current_staff
  from public.learning_circle_staff
  where circle_id = p_circle_id and teacher_id = p_teacher_id and status = 'active'
  limit 1;

  if not p_active then
    if current_staff.id is null then
      return jsonb_build_object('status', 'already_inactive');
    end if;
    if current_staff.staff_role = 'lead' then
      raise exception 'Assign another lead before ending the current lead';
    end if;

    update public.learning_circle_staff
    set status = 'ended', ended_at = now()
    where id = current_staff.id;

    perform public.record_platform_audit(
      p_circle_id, 'circle.staff_ended', 'learning_circle_staff', current_staff.id::text,
      to_jsonb(current_staff), null
    );
    return jsonb_build_object('status', 'ended', 'staff_id', current_staff.id);
  end if;

  if p_staff_role = 'lead' then
    update public.learning_circle_staff
    set status = 'ended', ended_at = now()
    where circle_id = p_circle_id
      and staff_role = 'lead'
      and status = 'active'
      and teacher_id <> p_teacher_id;

    if current_staff.id is not null then
      update public.learning_circle_staff
      set
        staff_role = 'lead',
        can_post_announcements = true,
        can_manage_meet_link = true,
        can_create_tasks = true,
        can_review_submissions = true,
        can_manage_discussions = true,
        can_track_students = true
      where id = current_staff.id;
    else
      insert into public.learning_circle_staff (
        circle_id, teacher_id, staff_role, status,
        can_post_announcements, can_manage_meet_link, can_create_tasks,
        can_review_submissions, can_manage_discussions, can_track_students,
        appointed_by
      ) values (
        p_circle_id, p_teacher_id, 'lead', 'active',
        true, true, true, true, true, true, auth.uid()
      ) returning * into current_staff;
    end if;
  else
    if current_staff.id is not null and current_staff.staff_role = 'lead' then
      raise exception 'Assign another lead before changing the current lead to assistant';
    end if;
    if current_staff.id is null then
      insert into public.learning_circle_staff (
        circle_id, teacher_id, staff_role, status, appointed_by
      ) values (
        p_circle_id, p_teacher_id, 'assistant', 'active', auth.uid()
      ) returning * into current_staff;
    end if;
  end if;

  select * into current_staff
  from public.learning_circle_staff
  where circle_id = p_circle_id and teacher_id = p_teacher_id and status = 'active'
  limit 1;

  perform public.record_platform_audit(
    p_circle_id,
    'circle.staff_assigned',
    'learning_circle_staff',
    current_staff.id::text,
    null,
    to_jsonb(current_staff)
  );

  return jsonb_build_object(
    'status', 'active',
    'staff_id', current_staff.id,
    'staff_role', current_staff.staff_role
  );
end;
$$;

create or replace function public.set_learning_circle_assistant_permissions(
  p_circle_id uuid,
  p_teacher_id uuid,
  p_permissions jsonb
)
returns jsonb
language plpgsql
security definer
set search_path = pg_catalog, public
set row_security = off
as $$
declare
  previous_staff public.learning_circle_staff%rowtype;
  updated_staff public.learning_circle_staff%rowtype;
begin
  if not public.can_manage_learning_circle(p_circle_id) then
    raise exception 'Only the lead teacher or administrator may set assistant permissions' using errcode = '42501';
  end if;
  if jsonb_typeof(p_permissions) <> 'object' then
    raise exception 'Permissions must be a JSON object';
  end if;

  select * into previous_staff
  from public.learning_circle_staff
  where circle_id = p_circle_id
    and teacher_id = p_teacher_id
    and staff_role = 'assistant'
    and status = 'active'
  for update;

  if previous_staff.id is null then
    raise exception 'Active assistant not found';
  end if;

  update public.learning_circle_staff
  set
    can_post_announcements = case when p_permissions ? 'post_announcements' then (p_permissions ->> 'post_announcements')::boolean else can_post_announcements end,
    can_manage_meet_link = case when p_permissions ? 'manage_meet_link' then (p_permissions ->> 'manage_meet_link')::boolean else can_manage_meet_link end,
    can_create_tasks = case when p_permissions ? 'create_tasks' then (p_permissions ->> 'create_tasks')::boolean else can_create_tasks end,
    can_review_submissions = case when p_permissions ? 'review_submissions' then (p_permissions ->> 'review_submissions')::boolean else can_review_submissions end,
    can_manage_discussions = case when p_permissions ? 'manage_discussions' then (p_permissions ->> 'manage_discussions')::boolean else can_manage_discussions end,
    can_track_students = case when p_permissions ? 'track_students' then (p_permissions ->> 'track_students')::boolean else can_track_students end
  where id = previous_staff.id
  returning * into updated_staff;

  perform public.record_platform_audit(
    p_circle_id,
    'circle.assistant_permissions_updated',
    'learning_circle_staff',
    updated_staff.id::text,
    to_jsonb(previous_staff),
    to_jsonb(updated_staff)
  );

  return to_jsonb(updated_staff) - array['created_at', 'updated_at'];
end;
$$;

create or replace function public.add_student_to_learning_circle(
  p_circle_id uuid,
  p_student_id uuid
)
returns jsonb
language plpgsql
security definer
set search_path = pg_catalog, public
set row_security = off
as $$
declare
  target_circle public.learning_circles%rowtype;
  existing_membership public.learning_circle_memberships%rowtype;
  other_quran_membership public.learning_circle_memberships%rowtype;
  pending_request_id uuid;
  new_membership_id uuid;
begin
  if not public.can_manage_learning_circle(p_circle_id) then
    raise exception 'Only the lead teacher or administrator may add students' using errcode = '42501';
  end if;

  select * into target_circle
  from public.learning_circles
  where id = p_circle_id and status = 'active'
  for update;
  if target_circle.id is null then raise exception 'Active learning circle not found'; end if;

  if not exists (
    select 1 from public.users
    where id = p_student_id and role = 'student' and is_active = true
  ) then
    raise exception 'Student must be an active student account';
  end if;

  select * into existing_membership
  from public.learning_circle_memberships
  where circle_id = p_circle_id
    and student_id = p_student_id
    and status in ('active', 'transfer_pending')
  limit 1;
  if existing_membership.id is not null then
    return jsonb_build_object('status', 'already_member', 'membership_id', existing_membership.id);
  end if;

  if target_circle.circle_type = 'quran' then
    select * into other_quran_membership
    from public.learning_circle_memberships
    where student_id = p_student_id
      and circle_type = 'quran'
      and status = 'active'
      and circle_id <> p_circle_id
    limit 1
    for update;

    if other_quran_membership.id is not null then
      select id into pending_request_id
      from public.learning_circle_transfer_requests
      where student_id = p_student_id and status = 'pending'
      limit 1;

      if pending_request_id is null then
        insert into public.learning_circle_transfer_requests (
          student_id, from_circle_id, to_circle_id, requested_by
        ) values (
          p_student_id, other_quran_membership.circle_id, p_circle_id, auth.uid()
        ) returning id into pending_request_id;

        perform public.record_platform_audit(
          p_circle_id,
          'circle.transfer_requested',
          'learning_circle_transfer_request',
          pending_request_id::text,
          null,
          jsonb_build_object(
            'student_id', p_student_id,
            'from_circle_id', other_quran_membership.circle_id,
            'to_circle_id', p_circle_id
          )
        );
      end if;

      return jsonb_build_object(
        'status', 'transfer_required',
        'transfer_request_id', pending_request_id,
        'from_circle_id', other_quran_membership.circle_id
      );
    end if;
  end if;

  insert into public.learning_circle_memberships (
    circle_id, student_id, circle_type, status, source, added_by
  ) values (
    p_circle_id, p_student_id, target_circle.circle_type, 'active', 'manual', auth.uid()
  ) returning id into new_membership_id;

  perform public.record_platform_audit(
    p_circle_id,
    'circle.student_added',
    'learning_circle_membership',
    new_membership_id::text,
    null,
    jsonb_build_object('student_id', p_student_id, 'circle_type', target_circle.circle_type)
  );

  return jsonb_build_object('status', 'added', 'membership_id', new_membership_id);
end;
$$;

create or replace function public.decide_learning_circle_transfer(
  p_request_id uuid,
  p_approve boolean,
  p_admin_notes text default null
)
returns jsonb
language plpgsql
security definer
set search_path = pg_catalog, public
set row_security = off
as $$
declare
  transfer_request public.learning_circle_transfer_requests%rowtype;
  new_membership_id uuid;
begin
  if not public.is_admin() then
    raise exception 'Only an active administrator may decide Quran transfers' using errcode = '42501';
  end if;

  select * into transfer_request
  from public.learning_circle_transfer_requests
  where id = p_request_id and status = 'pending'
  for update;
  if transfer_request.id is null then raise exception 'Pending transfer request not found'; end if;

  if p_approve then
    if not exists (
      select 1 from public.learning_circles
      where id = transfer_request.to_circle_id
        and circle_type = 'quran'
        and status = 'active'
    ) then
      raise exception 'Target Quran circle is not active';
    end if;

    update public.learning_circle_memberships
    set status = 'ended', ended_at = now(), ended_reason = 'transferred'
    where student_id = transfer_request.student_id
      and circle_type = 'quran'
      and status = 'active';

    insert into public.learning_circle_memberships (
      circle_id, student_id, circle_type, status, source, added_by
    ) values (
      transfer_request.to_circle_id,
      transfer_request.student_id,
      'quran',
      'active',
      'transfer',
      auth.uid()
    ) returning id into new_membership_id;

    update public.learning_circle_transfer_requests
    set status = 'approved', admin_notes = nullif(btrim(coalesce(p_admin_notes, '')), ''),
        decided_by = auth.uid(), decided_at = now()
    where id = p_request_id;
  else
    update public.learning_circle_transfer_requests
    set status = 'rejected', admin_notes = nullif(btrim(coalesce(p_admin_notes, '')), ''),
        decided_by = auth.uid(), decided_at = now()
    where id = p_request_id;
  end if;

  perform public.record_platform_audit(
    transfer_request.to_circle_id,
    case when p_approve then 'circle.transfer_approved' else 'circle.transfer_rejected' end,
    'learning_circle_transfer_request',
    p_request_id::text,
    to_jsonb(transfer_request),
    jsonb_build_object(
      'status', case when p_approve then 'approved' else 'rejected' end,
      'new_membership_id', new_membership_id,
      'admin_notes', nullif(btrim(coalesce(p_admin_notes, '')), '')
    )
  );

  return jsonb_build_object(
    'status', case when p_approve then 'approved' else 'rejected' end,
    'membership_id', new_membership_id
  );
end;
$$;

create or replace function public.update_learning_circle_meet_link(
  p_circle_id uuid,
  p_meet_link text
)
returns text
language plpgsql
security definer
set search_path = pg_catalog, public
set row_security = off
as $$
declare
  normalized_link text := nullif(btrim(coalesce(p_meet_link, '')), '');
  previous_link text;
begin
  if not public.has_learning_circle_permission(p_circle_id, 'manage_meet_link') then
    raise exception 'You do not have permission to manage the Meet link' using errcode = '42501';
  end if;
  if normalized_link is not null
     and lower(normalized_link) !~ '^https://meet\.google\.com/[a-z0-9_-]+([/?#].*)?$' then
    raise exception 'Enter a valid Google Meet link';
  end if;

  select meet_link into previous_link
  from public.learning_circles
  where id = p_circle_id and status = 'active'
  for update;
  if not found then raise exception 'Active learning circle not found'; end if;

  update public.learning_circles
  set meet_link = normalized_link
  where id = p_circle_id;

  perform public.record_platform_audit(
    p_circle_id,
    'circle.meet_link_updated',
    'learning_circle',
    p_circle_id::text,
    jsonb_build_object('meet_link', previous_link),
    jsonb_build_object('meet_link', normalized_link)
  );

  return normalized_link;
end;
$$;

create or replace function public.archive_learning_circle(p_circle_id uuid)
returns void
language plpgsql
security definer
set search_path = pg_catalog, public
set row_security = off
as $$
declare
  previous_circle public.learning_circles%rowtype;
begin
  if not public.is_admin() then
    raise exception 'Only an active administrator may archive learning circles' using errcode = '42501';
  end if;

  select * into previous_circle
  from public.learning_circles
  where id = p_circle_id and status <> 'archived'
  for update;
  if previous_circle.id is null then raise exception 'Active learning circle not found'; end if;

  update public.learning_circles
  set status = 'archived', archived_by = auth.uid(), archived_at = now()
  where id = p_circle_id;

  update public.learning_circle_staff
  set status = 'ended', ended_at = now()
  where circle_id = p_circle_id and status = 'active';

  update public.learning_circle_memberships
  set status = 'ended', ended_at = now(), ended_reason = 'circle_archived'
  where circle_id = p_circle_id and status in ('active', 'transfer_pending');

  update public.learning_circle_transfer_requests
  set status = 'cancelled', decided_by = auth.uid(), decided_at = now(), admin_notes = 'Circle archived'
  where status = 'pending' and (from_circle_id = p_circle_id or to_circle_id = p_circle_id);

  perform public.record_platform_audit(
    p_circle_id,
    'circle.archived',
    'learning_circle',
    p_circle_id::text,
    to_jsonb(previous_circle),
    jsonb_build_object('status', 'archived', 'archived_by', auth.uid(), 'archived_at', now())
  );
end;
$$;

create or replace function public.get_platform_time()
returns timestamptz
language sql
stable
security definer
set search_path = pg_catalog, public
as $$
  select now();
$$;

drop policy if exists "Participants view learning circles" on public.learning_circles;
create policy "Participants view learning circles"
  on public.learning_circles for select to authenticated
  using (public.can_access_learning_circle(id));

drop policy if exists "Participants view learning circle subjects" on public.learning_circle_subjects;
create policy "Participants view learning circle subjects"
  on public.learning_circle_subjects for select to authenticated
  using (public.can_access_learning_circle(circle_id));

drop policy if exists "Participants view learning circle staff" on public.learning_circle_staff;
create policy "Participants view learning circle staff"
  on public.learning_circle_staff for select to authenticated
  using (public.can_access_learning_circle(circle_id));

drop policy if exists "Staff and students view related memberships" on public.learning_circle_memberships;
create policy "Staff and students view related memberships"
  on public.learning_circle_memberships for select to authenticated
  using (
    student_id = auth.uid()
    or public.is_admin()
    or public.is_learning_circle_staff(circle_id, auth.uid())
  );

drop policy if exists "Related users view transfer requests" on public.learning_circle_transfer_requests;
create policy "Related users view transfer requests"
  on public.learning_circle_transfer_requests for select to authenticated
  using (
    student_id = auth.uid()
    or public.is_admin()
    or public.is_learning_circle_staff(from_circle_id, auth.uid())
    or public.is_learning_circle_staff(to_circle_id, auth.uid())
  );

drop policy if exists "Participants view learning circle settings" on public.learning_circle_settings;
create policy "Participants view learning circle settings"
  on public.learning_circle_settings for select to authenticated
  using (public.can_access_learning_circle(circle_id));

drop policy if exists "Managers view circle audit events" on public.platform_audit_events;
create policy "Managers view circle audit events"
  on public.platform_audit_events for select to authenticated
  using (public.is_admin() or (circle_id is not null and public.can_manage_learning_circle(circle_id)));

revoke all on public.learning_circles from authenticated;
revoke all on public.learning_circle_subjects from authenticated;
revoke all on public.learning_circle_staff from authenticated;
revoke all on public.learning_circle_memberships from authenticated;
revoke all on public.learning_circle_transfer_requests from authenticated;
revoke all on public.learning_circle_settings from authenticated;
revoke all on public.platform_audit_events from authenticated;

grant select on public.learning_circles to authenticated;
grant select on public.learning_circle_subjects to authenticated;
grant select on public.learning_circle_staff to authenticated;
grant select on public.learning_circle_memberships to authenticated;
grant select on public.learning_circle_transfer_requests to authenticated;
grant select on public.learning_circle_settings to authenticated;
grant select on public.platform_audit_events to authenticated;

revoke all on function public.record_platform_audit(uuid, text, text, text, jsonb, jsonb, jsonb) from public;

revoke all on function public.create_learning_circle(text, text, uuid, text, uuid[]) from public;
revoke all on function public.admin_set_learning_circle_staff(uuid, uuid, text, boolean) from public;
revoke all on function public.set_learning_circle_assistant_permissions(uuid, uuid, jsonb) from public;
revoke all on function public.add_student_to_learning_circle(uuid, uuid) from public;
revoke all on function public.decide_learning_circle_transfer(uuid, boolean, text) from public;
revoke all on function public.update_learning_circle_meet_link(uuid, text) from public;
revoke all on function public.archive_learning_circle(uuid) from public;
revoke all on function public.get_platform_time() from public;

grant execute on function public.is_learning_circle_staff(uuid, uuid) to authenticated;
grant execute on function public.is_learning_circle_member(uuid, uuid) to authenticated;
grant execute on function public.can_access_learning_circle(uuid) to authenticated;
grant execute on function public.can_manage_learning_circle(uuid) to authenticated;
grant execute on function public.has_learning_circle_permission(uuid, text) to authenticated;
grant execute on function public.create_learning_circle(text, text, uuid, text, uuid[]) to authenticated;
grant execute on function public.admin_set_learning_circle_staff(uuid, uuid, text, boolean) to authenticated;
grant execute on function public.set_learning_circle_assistant_permissions(uuid, uuid, jsonb) to authenticated;
grant execute on function public.add_student_to_learning_circle(uuid, uuid) to authenticated;
grant execute on function public.decide_learning_circle_transfer(uuid, boolean, text) to authenticated;
grant execute on function public.update_learning_circle_meet_link(uuid, text) to authenticated;
grant execute on function public.archive_learning_circle(uuid) to authenticated;
grant execute on function public.get_platform_time() to authenticated;
