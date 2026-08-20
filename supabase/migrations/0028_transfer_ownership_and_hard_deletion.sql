-- Student-owned history follows an approved Quran-circle transfer. Permanent
-- deletion is performed through resumable, administrator-only server jobs.

create table if not exists public.platform_deletion_jobs (
  id uuid primary key default gen_random_uuid(),
  deletion_type text not null check (deletion_type in ('account', 'circle')),
  target_id uuid,
  confirmation_label text,
  requested_by uuid references public.users(id) on delete set null,
  storage_bucket text not null default 'circle-files',
  storage_paths text[] not null default '{}'::text[],
  status text not null default 'db_deleted'
    check (status in ('db_deleted', 'cleanup_failed', 'complete')),
  last_error text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  completed_at timestamptz
);

create index if not exists platform_deletion_jobs_status_idx
  on public.platform_deletion_jobs (status, created_at);

alter table public.platform_deletion_jobs enable row level security;
revoke all on public.platform_deletion_jobs from public, anon, authenticated;

create or replace function public.protect_platform_audit_event()
returns trigger
language plpgsql
set search_path = pg_catalog, public
as $$
begin
  if current_setting('app.allow_hard_delete', true) = 'on'
     and tg_op = 'UPDATE'
     and (to_jsonb(new) - 'actor_id' - 'circle_id') = (to_jsonb(old) - 'actor_id' - 'circle_id')
     and (new.actor_id = old.actor_id or (old.actor_id is not null and new.actor_id is null))
     and (new.circle_id = old.circle_id or (old.circle_id is not null and new.circle_id is null)) then
    return new;
  end if;
  raise exception 'Platform audit events are immutable' using errcode = '42501';
end;
$$;

create or replace function public.protect_quran_report_history()
returns trigger
language plpgsql
set search_path = pg_catalog, public
as $$
begin
  if current_setting('app.allow_hard_delete', true) = 'on' and tg_op = 'DELETE' then
    return old;
  end if;
  raise exception 'Quran report history is immutable' using errcode = '42501';
end;
$$;

create or replace function public.prevent_quran_daily_summary_run_changes()
returns trigger
language plpgsql
set search_path = pg_catalog, public
as $$
begin
  if current_setting('app.allow_hard_delete', true) = 'on' and tg_op = 'DELETE' then
    return old;
  end if;
  raise exception 'Quran daily summary runs are immutable';
end;
$$;

alter table public.quran_report_assignment_events
  drop constraint if exists quran_report_assignment_events_event_type_check;

alter table public.quran_report_assignment_events
  add constraint quran_report_assignment_events_event_type_check check (event_type in (
    'assigned', 'completed', 'exempted', 'replaced', 'cancelled',
    'extension_requested', 'extension_approved', 'extension_rejected',
    'rescheduled', 'skipped', 'report_updated', 'report_cancelled', 'transferred'
  ));

create or replace function public.validate_quran_report_assignment()
returns trigger
language plpgsql
set search_path = pg_catalog, public
as $$
declare
  report_record public.quran_reports%rowtype;
  membership_record public.learning_circle_memberships%rowtype;
  internal_transfer boolean := current_setting('app.quran_circle_transfer', true) = 'on';
begin
  select * into report_record
  from public.quran_reports
  where id = new.report_id;
  if report_record.id is null then raise exception 'Quran report not found'; end if;

  select * into membership_record
  from public.learning_circle_memberships
  where id = new.membership_id;
  if membership_record.id is null
     or membership_record.circle_id <> report_record.circle_id
     or membership_record.student_id <> new.student_id
     or membership_record.circle_type <> 'quran' then
    raise exception 'Quran report assignment membership does not match the report and student';
  end if;

  if tg_op = 'INSERT' then
    if report_record.status <> 'published' or membership_record.status <> 'active' then
      raise exception 'Quran reports may only be assigned to active memberships';
    end if;
    new.circle_id := report_record.circle_id;
    new.report_date := report_record.report_date;
    new.task_type := report_record.task_type;
    new.starts_at := report_record.starts_at;
    new.original_due_at := report_record.due_at;
    new.effective_due_at := coalesce(new.effective_due_at, report_record.due_at);
    new.max_points := report_record.max_points;
  elsif internal_transfer then
    if new.student_id <> old.student_id
       or new.report_date <> old.report_date
       or new.task_type <> old.task_type
       or new.starts_at <> old.starts_at
       or new.original_due_at <> old.original_due_at
       or new.max_points <> old.max_points then
      raise exception 'Quran transfer may not change the assignment plan or scoring';
    end if;
  elsif new.report_id <> old.report_id
     or new.circle_id <> old.circle_id
     or new.membership_id <> old.membership_id
     or new.student_id <> old.student_id
     or new.task_type <> old.task_type
     or new.max_points <> old.max_points then
    raise exception 'Quran report assignment ownership and scoring fields are immutable';
  end if;

  if report_record.circle_id <> new.circle_id
     or report_record.task_type <> new.task_type
     or report_record.max_points <> new.max_points then
    raise exception 'Quran report assignment does not match the target report';
  end if;

  return new;
end;
$$;

create or replace function public.move_quran_student_history(
  p_student_id uuid,
  p_from_circle_id uuid,
  p_to_circle_id uuid,
  p_new_membership_id uuid,
  p_actor_id uuid
)
returns jsonb
language plpgsql
security definer
set search_path = pg_catalog, public
set row_security = off
as $$
declare
  source_report public.quran_reports%rowtype;
  cloned_report public.quran_reports%rowtype;
  new_report_id uuid;
  moved_for_report integer;
  moved_assignments integer := 0;
  cloned_reports integer := 0;
begin
  if not exists (
    select 1 from public.learning_circle_memberships membership
    where membership.id = p_new_membership_id
      and membership.circle_id = p_to_circle_id
      and membership.student_id = p_student_id
      and membership.circle_type = 'quran'
      and membership.status = 'active'
  ) then
    raise exception 'TRANSFER_MEMBERSHIP_INVALID';
  end if;

  perform pg_catalog.set_config('app.quran_circle_transfer', 'on', true);

  for source_report in
    select distinct report.*
    from public.quran_reports report
    join public.quran_report_assignments assignment on assignment.report_id = report.id
    where assignment.student_id = p_student_id
      and assignment.circle_id = p_from_circle_id
    order by report.report_date, report.task_type, report.id
  loop
    new_report_id := gen_random_uuid();
    insert into public.quran_reports (
      id, circle_id, import_batch_id, import_row_id, report_date, task_type,
      content, repetitions, notes, max_points, starts_at, due_at, status,
      current_version, created_by, cancelled_by, cancelled_at, created_at,
      updated_at, root_report_id, supersedes_report_id
    ) values (
      new_report_id, p_to_circle_id, null, null, source_report.report_date,
      source_report.task_type, source_report.content, source_report.repetitions,
      source_report.notes, source_report.max_points, source_report.starts_at,
      source_report.due_at, source_report.status, 1, p_actor_id,
      case when source_report.status = 'cancelled' then p_actor_id else null end,
      source_report.cancelled_at, source_report.created_at, now(),
      new_report_id, null
    ) returning * into cloned_report;

    insert into public.quran_report_versions (
      report_id, version_number, change_type, snapshot, change_reason, changed_by
    ) values (
      cloned_report.id,
      1,
      case when cloned_report.status = 'cancelled' then 'cancelled' else 'created' end,
      to_jsonb(cloned_report),
      'نُقل سجل الطالب معه إلى حلقة قرآنية جديدة',
      p_actor_id
    );

    update public.quran_report_assignments
    set report_id = cloned_report.id,
        circle_id = p_to_circle_id,
        membership_id = p_new_membership_id,
        updated_at = now()
    where student_id = p_student_id
      and circle_id = p_from_circle_id
      and report_id = source_report.id;
    get diagnostics moved_for_report = row_count;

    insert into public.quran_report_assignment_events (
      assignment_id, actor_id, event_type, before_data, after_data, metadata
    )
    select
      assignment.id,
      p_actor_id,
      'transferred',
      jsonb_build_object('circle_id', p_from_circle_id, 'report_id', source_report.id),
      jsonb_build_object('circle_id', p_to_circle_id, 'report_id', cloned_report.id),
      jsonb_build_object('reason', 'quran_circle_transfer')
    from public.quran_report_assignments assignment
    where assignment.student_id = p_student_id
      and assignment.circle_id = p_to_circle_id
      and assignment.report_id = cloned_report.id;

    moved_assignments := moved_assignments + moved_for_report;
    cloned_reports := cloned_reports + 1;
  end loop;

  update public.quran_report_extension_requests request
  set circle_id = p_to_circle_id,
      updated_at = now()
  where request.student_id = p_student_id
    and request.circle_id = p_from_circle_id;

  update public.quran_report_import_recipients recipient
  set membership_id = p_new_membership_id
  where recipient.student_id = p_student_id
    and exists (
      select 1
      from public.learning_circle_memberships old_membership
      where old_membership.id = recipient.membership_id
        and old_membership.circle_id = p_from_circle_id
    );

  return jsonb_build_object(
    'moved_assignments', moved_assignments,
    'cloned_reports', cloned_reports,
    'from_circle_id', p_from_circle_id,
    'to_circle_id', p_to_circle_id
  );
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
  history_result jsonb := '{}'::jsonb;
begin
  if not public.is_admin() then
    raise exception 'Only an active administrator may decide Quran transfers' using errcode = '42501';
  end if;

  select * into transfer_request
  from public.learning_circle_transfer_requests
  where id = p_request_id and status = 'pending'
  for update;
  if transfer_request.id is null then raise exception 'Pending transfer request not found'; end if;

  perform pg_catalog.pg_advisory_xact_lock(pg_catalog.hashtextextended(transfer_request.student_id::text, 0));

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
    set status = 'ended', ended_at = now(), ended_reason = 'transferred', updated_at = now()
    where student_id = transfer_request.student_id
      and circle_type = 'quran'
      and status = 'active';

    insert into public.learning_circle_memberships (
      circle_id, student_id, circle_type, status, source, added_by
    ) values (
      transfer_request.to_circle_id, transfer_request.student_id,
      'quran', 'active', 'transfer', auth.uid()
    ) returning id into new_membership_id;

    history_result := public.move_quran_student_history(
      transfer_request.student_id,
      transfer_request.from_circle_id,
      transfer_request.to_circle_id,
      new_membership_id,
      auth.uid()
    );

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
      'history', history_result,
      'admin_notes', nullif(btrim(coalesce(p_admin_notes, '')), '')
    )
  );

  return jsonb_build_object(
    'status', case when p_approve then 'approved' else 'rejected' end,
    'membership_id', new_membership_id,
    'history', history_result
  );
end;
$$;

create or replace function public.get_account_hard_delete_impact(p_target_id uuid)
returns jsonb
language plpgsql
stable
security definer
set search_path = pg_catalog, public
set row_security = off
as $$
declare
  result jsonb;
begin
  if not public.is_admin() then raise exception 'ADMIN_REQUIRED' using errcode = '42501'; end if;
  if p_target_id = auth.uid() then raise exception 'PROTECTED_ACCOUNT'; end if;
  if exists (select 1 from public.users where id = p_target_id and role = 'admin') then
    raise exception 'PROTECTED_ACCOUNT';
  end if;

  select jsonb_build_object(
    'memberships', (select count(*) from public.learning_circle_memberships where student_id = p_target_id),
    'staff_roles', (select count(*) from public.learning_circle_staff where teacher_id = p_target_id),
    'quran_assignments', (select count(*) from public.quran_report_assignments where student_id = p_target_id),
    'completed_quran_assignments', (select count(*) from public.quran_report_assignments where student_id = p_target_id and status = 'completed'),
    'messages', (select count(*) from public.messages where sender_id = p_target_id or receiver_id = p_target_id),
    'uploaded_files', (select count(*) from public.learning_circle_files where uploaded_by = p_target_id),
    'classroom_submissions', (select count(*) from public.assignment_submissions where student_id = p_target_id),
    'quiz_submissions', (select count(*) from public.quiz_submissions where student_id = p_target_id)
  ) into result;
  return result;
end;
$$;

create or replace function public.prepare_account_hard_delete(
  p_target_id uuid,
  p_actor_id uuid,
  p_confirmation text
)
returns jsonb
language plpgsql
security definer
set search_path = pg_catalog, public
set row_security = off
as $$
declare
  target_record public.users%rowtype;
  actor_role public.user_role;
  file_paths text[] := '{}'::text[];
  job_id uuid;
begin
  select role into actor_role from public.users
  where id = p_actor_id and is_active = true and deleted_at is null;
  if actor_role is distinct from 'admin'::public.user_role then raise exception 'ADMIN_REQUIRED'; end if;
  if p_target_id = p_actor_id then raise exception 'PROTECTED_ACCOUNT'; end if;

  select * into target_record from public.users where id = p_target_id for update;
  if target_record.id is null then raise exception 'ACCOUNT_NOT_FOUND'; end if;
  if target_record.role = 'admin'::public.user_role then raise exception 'PROTECTED_ACCOUNT'; end if;
  if lower(regexp_replace(btrim(coalesce(p_confirmation, '')), '^@+', '')) <> lower(target_record.username) then
    raise exception 'CONFIRMATION_MISMATCH';
  end if;

  perform pg_catalog.set_config('app.allow_hard_delete', 'on', true);
  select coalesce(array_agg(storage_path order by storage_path), '{}'::text[])
  into file_paths from public.learning_circle_files where uploaded_by = p_target_id;

  update public.admin_audit_logs set actor_id = p_actor_id where actor_id = p_target_id;
  update public.attendance set recorded_by = p_actor_id where recorded_by = p_target_id;
  update public.ai_reports set teacher_id = p_actor_id where teacher_id = p_target_id;
  update public.classrooms set teacher_id = p_actor_id where teacher_id = p_target_id;
  update public.halaqat set teacher_id = p_actor_id where teacher_id = p_target_id;
  update public.daily_assignments set teacher_id = p_actor_id where teacher_id = p_target_id;
  update public.task_import_batches set created_by = p_actor_id where created_by = p_target_id;
  update public.learning_circles set created_by = p_actor_id where created_by = p_target_id;
  update public.learning_circles set archived_by = p_actor_id where archived_by = p_target_id;
  update public.learning_circle_memberships set added_by = p_actor_id where added_by = p_target_id;
  update public.learning_circle_staff set appointed_by = p_actor_id where appointed_by = p_target_id;
  update public.learning_circle_subjects set added_by = p_actor_id where added_by = p_target_id;
  update public.learning_circle_settings set updated_by = p_actor_id where updated_by = p_target_id;
  update public.learning_circle_transfer_requests set requested_by = p_actor_id where requested_by = p_target_id;
  update public.learning_circle_transfer_requests set decided_by = p_actor_id where decided_by = p_target_id;
  update public.learning_circle_posts set archived_by = p_actor_id where archived_by = p_target_id;
  update public.learning_circle_post_replies set removed_by = p_actor_id where removed_by = p_target_id and author_id <> p_target_id;
  update public.learning_circle_files set removed_by = p_actor_id where removed_by = p_target_id and uploaded_by <> p_target_id;
  update public.quran_report_import_batches set created_by = p_actor_id where created_by = p_target_id;
  update public.quran_report_import_batches set approved_by = p_actor_id where approved_by = p_target_id;
  update public.quran_reports set created_by = p_actor_id where created_by = p_target_id;
  update public.quran_reports set cancelled_by = p_actor_id where cancelled_by = p_target_id;
  update public.quran_report_versions set changed_by = p_actor_id where changed_by = p_target_id;
  update public.quran_report_assignments set exempted_by = p_actor_id where exempted_by = p_target_id;
  update public.quran_report_extension_items set decided_by = p_actor_id where decided_by = p_target_id;
  update public.platform_audit_events set actor_id = null where actor_id = p_target_id;

  delete from public.quran_report_extension_requests where student_id = p_target_id;
  delete from public.quran_report_import_recipients where student_id = p_target_id;
  update public.quran_report_assignments assignment
  set replaced_by_assignment_id = null
  where assignment.replaced_by_assignment_id in (
    select target_assignment.id from public.quran_report_assignments target_assignment
    where target_assignment.student_id = p_target_id
  );
  delete from public.quran_report_assignments where student_id = p_target_id;
  delete from public.learning_circle_transfer_requests where student_id = p_target_id;
  delete from public.learning_circle_memberships where student_id = p_target_id;
  delete from public.learning_circle_staff where teacher_id = p_target_id;
  delete from public.learning_circle_post_replies where author_id = p_target_id;
  delete from public.learning_circle_files where uploaded_by = p_target_id;
  delete from public.parent_student where parent_id = p_target_id or student_id = p_target_id;

  update public.users
  set is_active = false, deleted_at = coalesce(deleted_at, now()),
      deleted_by = p_actor_id, updated_at = now()
  where id = p_target_id;

  insert into public.platform_deletion_jobs (
    deletion_type, target_id, confirmation_label, requested_by, storage_paths, status
  ) values (
    'account', p_target_id, target_record.username, p_actor_id, file_paths, 'db_deleted'
  ) returning id into job_id;

  insert into public.admin_audit_logs (actor_id, target_user_id, action, metadata)
  values (p_actor_id, p_target_id, 'account.hard_delete_started', jsonb_build_object('job_id', job_id));

  return jsonb_build_object('job_id', job_id, 'storage_paths', to_jsonb(file_paths));
end;
$$;

create or replace function public.get_circle_hard_delete_impact(p_circle_id uuid)
returns jsonb
language plpgsql
stable
security definer
set search_path = pg_catalog, public
set row_security = off
as $$
begin
  if not public.is_admin() then raise exception 'ADMIN_REQUIRED' using errcode = '42501'; end if;
  if not exists (select 1 from public.learning_circles where id = p_circle_id) then
    raise exception 'CIRCLE_NOT_FOUND';
  end if;
  return jsonb_build_object(
    'active_students', (select count(*) from public.learning_circle_memberships where circle_id = p_circle_id and status = 'active'),
    'staff', (select count(*) from public.learning_circle_staff where circle_id = p_circle_id),
    'quran_assignments', (select count(*) from public.quran_report_assignments where circle_id = p_circle_id),
    'completed_quran_assignments', (select count(*) from public.quran_report_assignments where circle_id = p_circle_id and status = 'completed'),
    'posts', (select count(*) from public.learning_circle_posts where circle_id = p_circle_id),
    'files', (select count(*) from public.learning_circle_files where circle_id = p_circle_id),
    'pending_transfers', (
      select count(*) from public.learning_circle_transfer_requests
      where status = 'pending' and (from_circle_id = p_circle_id or to_circle_id = p_circle_id)
    )
  );
end;
$$;

create or replace function public.hard_delete_learning_circle(
  p_circle_id uuid,
  p_actor_id uuid,
  p_confirmation text
)
returns jsonb
language plpgsql
security definer
set search_path = pg_catalog, public
set row_security = off
as $$
declare
  circle_record public.learning_circles%rowtype;
  actor_role public.user_role;
  file_paths text[] := '{}'::text[];
  job_id uuid;
  impact jsonb;
begin
  select role into actor_role from public.users
  where id = p_actor_id and is_active = true and deleted_at is null;
  if actor_role is distinct from 'admin'::public.user_role then raise exception 'ADMIN_REQUIRED'; end if;

  select * into circle_record from public.learning_circles where id = p_circle_id for update;
  if circle_record.id is null then raise exception 'CIRCLE_NOT_FOUND'; end if;
  if btrim(coalesce(p_confirmation, '')) <> btrim(circle_record.name) then
    raise exception 'CONFIRMATION_MISMATCH';
  end if;

  perform pg_catalog.set_config('app.allow_hard_delete', 'on', true);
  select coalesce(array_agg(storage_path order by storage_path), '{}'::text[])
  into file_paths from public.learning_circle_files where circle_id = p_circle_id;

  impact := jsonb_build_object(
    'active_students', (select count(*) from public.learning_circle_memberships where circle_id = p_circle_id and status = 'active'),
    'quran_assignments', (select count(*) from public.quran_report_assignments where circle_id = p_circle_id),
    'files', cardinality(file_paths)
  );

  insert into public.platform_deletion_jobs (
    deletion_type, target_id, confirmation_label, requested_by, storage_paths, status
  ) values (
    'circle', p_circle_id, circle_record.name, p_actor_id, file_paths, 'db_deleted'
  ) returning id into job_id;

  delete from public.learning_circle_transfer_requests
  where from_circle_id = p_circle_id or to_circle_id = p_circle_id;
  delete from public.quran_daily_summary_runs where circle_id = p_circle_id;
  delete from public.quran_report_extension_requests where circle_id = p_circle_id;
  update public.quran_report_assignments assignment
  set replaced_by_assignment_id = null
  where assignment.replaced_by_assignment_id in (
    select target_assignment.id from public.quran_report_assignments target_assignment
    where target_assignment.circle_id = p_circle_id
  );
  delete from public.quran_report_assignments where circle_id = p_circle_id;
  update public.quran_reports set supersedes_report_id = null where circle_id = p_circle_id;
  delete from public.quran_reports where circle_id = p_circle_id;
  delete from public.quran_report_import_batches where circle_id = p_circle_id;
  delete from public.learning_circles where id = p_circle_id;

  insert into public.platform_audit_events (
    actor_id, circle_id, action, entity_type, entity_id, metadata
  ) values (
    p_actor_id, null, 'circle.hard_deleted', 'learning_circle', null,
    jsonb_build_object('job_id', job_id, 'circle_type', circle_record.circle_type, 'impact', impact)
  );

  return jsonb_build_object(
    'job_id', job_id,
    'storage_paths', to_jsonb(file_paths),
    'impact', impact
  );
end;
$$;

create or replace function public.complete_platform_deletion_job(
  p_job_id uuid,
  p_actor_id uuid,
  p_success boolean,
  p_error text default null
)
returns void
language plpgsql
security definer
set search_path = pg_catalog, public
set row_security = off
as $$
begin
  if not exists (
    select 1 from public.users
    where id = p_actor_id and role = 'admin' and is_active = true and deleted_at is null
  ) then raise exception 'ADMIN_REQUIRED'; end if;

  update public.platform_deletion_jobs
  set status = case when p_success then 'complete' else 'cleanup_failed' end,
      last_error = case when p_success then null else left(coalesce(p_error, 'cleanup failed'), 2000) end,
      target_id = case when p_success then null else target_id end,
      confirmation_label = case when p_success then null else confirmation_label end,
      storage_paths = case when p_success then '{}'::text[] else storage_paths end,
      completed_at = case when p_success then now() else null end,
      updated_at = now()
  where id = p_job_id and requested_by = p_actor_id;
end;
$$;

revoke all on function public.move_quran_student_history(uuid, uuid, uuid, uuid, uuid) from public, anon, authenticated;
revoke all on function public.get_account_hard_delete_impact(uuid) from public, anon;
revoke all on function public.prepare_account_hard_delete(uuid, uuid, text) from public, anon, authenticated;
revoke all on function public.get_circle_hard_delete_impact(uuid) from public, anon;
revoke all on function public.hard_delete_learning_circle(uuid, uuid, text) from public, anon, authenticated;
revoke all on function public.complete_platform_deletion_job(uuid, uuid, boolean, text) from public, anon, authenticated;

grant execute on function public.get_account_hard_delete_impact(uuid) to authenticated;
grant execute on function public.get_circle_hard_delete_impact(uuid) to authenticated;
grant execute on function public.prepare_account_hard_delete(uuid, uuid, text) to service_role;
grant execute on function public.hard_delete_learning_circle(uuid, uuid, text) to service_role;
grant execute on function public.complete_platform_deletion_job(uuid, uuid, boolean, text) to service_role;
