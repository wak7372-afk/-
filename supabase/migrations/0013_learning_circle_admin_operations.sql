-- Complete the administrator circle-management contract without granting
-- direct write access to the canonical learning-circle tables.

-- Subjects are shared reference data and already have a permissive SELECT RLS
-- policy. The explicit grant makes that policy reachable through PostgREST.
grant select on public.subjects to authenticated;

create or replace function public.update_learning_circle_details(
  p_circle_id uuid,
  p_name text,
  p_description text default null,
  p_subject_ids uuid[] default '{}'::uuid[]
)
returns jsonb
language plpgsql
security definer
set search_path = pg_catalog, public
set row_security = off
as $$
declare
  current_circle public.learning_circles%rowtype;
  normalized_name text := btrim(coalesce(p_name, ''));
  normalized_subject_ids uuid[] := coalesce(p_subject_ids, '{}'::uuid[]);
  previous_subject_ids uuid[];
  updated_circle public.learning_circles%rowtype;
begin
  if not public.is_admin() then
    raise exception 'Only an active administrator may update learning circles' using errcode = '42501';
  end if;

  select * into current_circle
  from public.learning_circles
  where id = p_circle_id and status <> 'archived'
  for update;

  if current_circle.id is null then
    raise exception 'Learning circle not found or archived';
  end if;
  if char_length(normalized_name) not between 2 and 160 then
    raise exception 'Learning circle name must contain between 2 and 160 characters';
  end if;
  if current_circle.circle_type = 'educational' and cardinality(normalized_subject_ids) = 0 then
    raise exception 'Educational circles require at least one subject';
  end if;
  if current_circle.circle_type = 'quran' and cardinality(normalized_subject_ids) > 0 then
    raise exception 'Quran circles do not accept educational subjects';
  end if;
  if exists (
    select 1
    from unnest(normalized_subject_ids) sid
    left join public.subjects subject on subject.id = sid
    where subject.id is null
  ) then
    raise exception 'One or more subjects do not exist';
  end if;

  select coalesce(array_agg(subject_id order by subject_id), '{}'::uuid[])
  into previous_subject_ids
  from public.learning_circle_subjects
  where circle_id = p_circle_id;

  update public.learning_circles
  set
    name = normalized_name,
    description = nullif(btrim(coalesce(p_description, '')), '')
  where id = p_circle_id
  returning * into updated_circle;

  delete from public.learning_circle_subjects
  where circle_id = p_circle_id;

  insert into public.learning_circle_subjects (circle_id, subject_id, added_by)
  select p_circle_id, selected.subject_id, auth.uid()
  from (
    select distinct unnest(normalized_subject_ids) as subject_id
  ) selected;

  perform public.record_platform_audit(
    p_circle_id,
    'circle.details_updated',
    'learning_circle',
    p_circle_id::text,
    jsonb_build_object(
      'name', current_circle.name,
      'description', current_circle.description,
      'subject_ids', previous_subject_ids
    ),
    jsonb_build_object(
      'name', updated_circle.name,
      'description', updated_circle.description,
      'subject_ids', normalized_subject_ids
    )
  );

  return jsonb_build_object(
    'id', updated_circle.id,
    'name', updated_circle.name,
    'description', updated_circle.description,
    'subject_ids', normalized_subject_ids
  );
end;
$$;

create or replace function public.end_learning_circle_membership(
  p_membership_id uuid,
  p_reason text default null
)
returns jsonb
language plpgsql
security definer
set search_path = pg_catalog, public
set row_security = off
as $$
declare
  current_membership public.learning_circle_memberships%rowtype;
  normalized_reason text := nullif(btrim(coalesce(p_reason, '')), '');
  cancelled_transfer_count integer := 0;
begin
  select * into current_membership
  from public.learning_circle_memberships
  where id = p_membership_id
  for update;

  if current_membership.id is null then
    raise exception 'Learning circle membership not found';
  end if;
  if not public.can_manage_learning_circle(current_membership.circle_id) then
    raise exception 'Only the lead teacher or administrator may end student memberships' using errcode = '42501';
  end if;
  if current_membership.status = 'ended' then
    return jsonb_build_object('status', 'already_ended', 'membership_id', current_membership.id);
  end if;

  update public.learning_circle_memberships
  set
    status = 'ended',
    ended_at = now(),
    ended_reason = coalesce(normalized_reason, 'removed_by_manager')
  where id = current_membership.id;

  if current_membership.circle_type = 'quran' then
    update public.learning_circle_transfer_requests
    set
      status = 'cancelled',
      decided_by = auth.uid(),
      decided_at = now(),
      admin_notes = 'Membership ended before transfer decision'
    where student_id = current_membership.student_id
      and status = 'pending'
      and (
        from_circle_id = current_membership.circle_id
        or to_circle_id = current_membership.circle_id
      );
    get diagnostics cancelled_transfer_count = row_count;
  end if;

  perform public.record_platform_audit(
    current_membership.circle_id,
    'circle.student_removed',
    'learning_circle_membership',
    current_membership.id::text,
    to_jsonb(current_membership),
    jsonb_build_object(
      'status', 'ended',
      'reason', coalesce(normalized_reason, 'removed_by_manager'),
      'cancelled_transfer_count', cancelled_transfer_count
    )
  );

  return jsonb_build_object(
    'status', 'ended',
    'membership_id', current_membership.id,
    'cancelled_transfer_count', cancelled_transfer_count
  );
end;
$$;

revoke all on function public.update_learning_circle_details(uuid, text, text, uuid[]) from public;
revoke all on function public.end_learning_circle_membership(uuid, text) from public;

grant execute on function public.update_learning_circle_details(uuid, text, text, uuid[]) to authenticated;
grant execute on function public.end_learning_circle_membership(uuid, text) to authenticated;
