-- Safe management of approved Quran reports while preserving completed history.

alter table public.quran_reports
  add column if not exists root_report_id uuid,
  add column if not exists supersedes_report_id uuid references public.quran_reports(id) on delete restrict;

update public.quran_reports
set root_report_id = id
where root_report_id is null;

alter table public.quran_reports
  alter column root_report_id set not null;

alter table public.quran_reports
  add constraint quran_reports_root_report_fk
  foreign key (root_report_id) references public.quran_reports(id) on delete restrict;

create index if not exists quran_reports_root_version_idx
  on public.quran_reports (root_report_id, created_at);

create or replace function public.set_quran_report_lineage()
returns trigger
language plpgsql
set search_path = pg_catalog, public
as $$
begin
  if new.root_report_id is null then new.root_report_id := new.id; end if;
  return new;
end;
$$;

drop trigger if exists set_quran_report_lineage on public.quran_reports;
create trigger set_quran_report_lineage
  before insert on public.quran_reports
  for each row execute procedure public.set_quran_report_lineage();

alter table public.quran_report_assignment_events
  drop constraint if exists quran_report_assignment_events_event_type_check;

alter table public.quran_report_assignment_events
  add constraint quran_report_assignment_events_event_type_check check (event_type in (
    'assigned', 'completed', 'exempted', 'replaced', 'cancelled',
    'extension_requested', 'extension_approved', 'extension_rejected',
    'rescheduled', 'skipped', 'report_updated', 'report_cancelled'
  ));

create or replace function public.validate_quran_report_assignment()
returns trigger
language plpgsql
set search_path = pg_catalog, public
as $$
declare
  report_record public.quran_reports%rowtype;
  membership_record public.learning_circle_memberships%rowtype;
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
  else
    if new.circle_id <> old.circle_id
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
  end if;

  return new;
end;
$$;

create or replace function public.get_quran_report_management_details(p_report_id uuid)
returns jsonb
language plpgsql
stable
security definer
set search_path = pg_catalog, public
set row_security = off
as $$
declare
  report_record public.quran_reports%rowtype;
  result jsonb;
begin
  select * into report_record
  from public.quran_reports
  where id = p_report_id;
  if report_record.id is null then raise exception 'Quran report not found'; end if;
  if not public.can_manage_quran_student_plan(report_record.circle_id) then
    raise exception 'Only the lead teacher or administrator may manage an approved Quran report'
      using errcode = '42501';
  end if;

  select jsonb_build_object(
    'report', to_jsonb(report_record),
    'assignments', coalesce((
      select jsonb_agg(to_jsonb(item) order by item.full_name, item.username)
      from (
        select
          a.id, a.student_id, u.full_name, u.username, a.status,
          a.report_date, a.starts_at, a.effective_due_at,
          a.completed_at, a.awarded_points, a.exemption_reason
        from public.quran_report_assignments a
        join public.users u on u.id = a.student_id
        where a.report_id = report_record.id
        order by u.full_name, u.username
      ) item
    ), '[]'::jsonb),
    'versions', coalesce((
      select jsonb_agg(to_jsonb(item) order by item.changed_at desc, item.version_number desc)
      from (
        select
          v.id, v.report_id, v.version_number, v.change_type,
          v.snapshot, v.change_reason, v.changed_at,
          changer.full_name as changed_by_name
        from public.quran_report_versions v
        join public.quran_reports lineage on lineage.id = v.report_id
        join public.users changer on changer.id = v.changed_by
        where lineage.root_report_id = report_record.root_report_id
        order by v.changed_at desc, v.version_number desc
      ) item
    ), '[]'::jsonb)
  ) into result;

  return result;
end;
$$;

create or replace function public.manage_quran_approved_report(
  p_report_id uuid,
  p_action text,
  p_report_date date,
  p_content text,
  p_repetitions integer,
  p_notes text,
  p_reason text,
  p_dry_run boolean
)
returns jsonb
language plpgsql
security definer
set search_path = pg_catalog, public
set row_security = off
as $$
declare
  report_record public.quran_reports%rowtype;
  updated_report public.quran_reports%rowtype;
  assignment_record public.quran_report_assignments%rowtype;
  updated_assignment public.quran_report_assignments%rowtype;
  action_value text := lower(btrim(coalesce(p_action, '')));
  content_value text := btrim(coalesce(p_content, ''));
  notes_value text := nullif(btrim(coalesce(p_notes, '')), '');
  reason_value text := btrim(coalesce(p_reason, ''));
  pending_count integer := 0;
  completed_count integer := 0;
  exempted_count integer := 0;
  historical_count integer := 0;
  conflict_count integer := 0;
  pending_extension_count integer := 0;
  delta_days integer := 0;
  split_required boolean := false;
  has_changes boolean := false;
  successor_id uuid;
  target_report_id uuid;
  result jsonb;
begin
  select * into report_record
  from public.quran_reports
  where id = p_report_id
  for update;
  if report_record.id is null then raise exception 'Quran report not found'; end if;
  if not public.can_manage_quran_student_plan(report_record.circle_id) then
    raise exception 'Only the lead teacher or administrator may manage an approved Quran report'
      using errcode = '42501';
  end if;
  if report_record.status <> 'published' then
    raise exception 'Only published Quran reports may be managed';
  end if;
  if action_value not in ('edit', 'cancel') then raise exception 'Invalid approved Quran report action'; end if;
  if p_dry_run is null then raise exception 'Approved report management mode is required'; end if;
  if char_length(reason_value) not between 3 and 2000 then
    raise exception 'A clear approved report change reason is required';
  end if;

  perform pg_catalog.pg_advisory_xact_lock(pg_catalog.hashtextextended(report_record.root_report_id::text, 0));

  select
    count(*) filter (where status = 'pending'),
    count(*) filter (where status = 'completed'),
    count(*) filter (where status = 'exempted'),
    count(*) filter (where status <> 'pending')
  into pending_count, completed_count, exempted_count, historical_count
  from public.quran_report_assignments
  where report_id = report_record.id;

  split_required := action_value = 'edit' and historical_count > 0;

  if action_value = 'edit' then
    if p_report_date is null then raise exception 'A Quran report date is required'; end if;
    if char_length(content_value) not between 1 and 2000 then raise exception 'Invalid Quran report content'; end if;
    if p_repetitions is not null and p_repetitions not between 1 and 100 then raise exception 'Invalid Quran report repetitions'; end if;
    if notes_value is not null and char_length(notes_value) > 3000 then raise exception 'Invalid Quran report notes'; end if;
    if pending_count = 0 then raise exception 'An approved Quran report without pending students cannot be edited'; end if;

    delta_days := p_report_date - report_record.report_date;
    has_changes := p_report_date <> report_record.report_date
      or content_value <> report_record.content
      or p_repetitions is distinct from report_record.repetitions::integer
      or notes_value is distinct from report_record.notes;
    if not has_changes then raise exception 'No approved Quran report changes were provided'; end if;

    select count(*) into conflict_count
    from public.quran_report_assignments moving
    join public.quran_report_assignments existing
      on existing.student_id = moving.student_id
     and existing.report_date = p_report_date
     and existing.task_type = moving.task_type
     and existing.status in ('pending', 'completed', 'exempted')
     and existing.id <> moving.id
    where moving.report_id = report_record.id
      and moving.status = 'pending';
  end if;

  select count(distinct item.assignment_id) into pending_extension_count
  from public.quran_report_extension_items item
  join public.quran_report_assignments assignment on assignment.id = item.assignment_id
  where item.status = 'pending'
    and assignment.report_id = report_record.id
    and assignment.status = 'pending';

  result := jsonb_build_object(
    'report_id', report_record.id,
    'action', action_value,
    'task_type', report_record.task_type,
    'current_date', report_record.report_date,
    'new_date', case when action_value = 'edit' then p_report_date else report_record.report_date end,
    'pending_count', pending_count,
    'completed_count', completed_count,
    'exempted_count', exempted_count,
    'historical_count', historical_count,
    'conflict_count', conflict_count,
    'pending_extension_count', pending_extension_count,
    'split_required', split_required,
    'has_changes', has_changes,
    'can_apply', pending_count > 0
      and conflict_count = 0
      and pending_extension_count = 0
      and (action_value = 'cancel' or has_changes),
    'dry_run', p_dry_run
  );

  if p_dry_run then return result; end if;
  if pending_count = 0 then raise exception 'Approved Quran report has no pending students'; end if;
  if conflict_count > 0 then raise exception 'Approved Quran report edit conflicts with student plans'; end if;
  if pending_extension_count > 0 then raise exception 'Approved Quran report has pending extension requests'; end if;

  if action_value = 'cancel' then
    insert into public.notifications (user_id, title, body, type)
    select distinct student_id, 'إلغاء تقرير قرآن', 'ألغى المعلم تقريراً معتمداً من خطتك.', 'quran_report_cancelled'
    from public.quran_report_assignments
    where report_id = report_record.id and status = 'pending';

    for assignment_record in
      select * from public.quran_report_assignments
      where report_id = report_record.id and status = 'pending'
      order by student_id for update
    loop
      update public.quran_report_assignments
      set status = 'cancelled'
      where id = assignment_record.id
      returning * into updated_assignment;

      insert into public.quran_report_assignment_events (
        assignment_id, actor_id, event_type, before_data, after_data, metadata
      ) values (
        assignment_record.id, auth.uid(), 'report_cancelled',
        to_jsonb(assignment_record), to_jsonb(updated_assignment),
        jsonb_build_object('reason', reason_value, 'report_id', report_record.id)
      );
    end loop;

    update public.quran_reports
    set status = 'cancelled', cancelled_by = auth.uid(), cancelled_at = now(),
        current_version = current_version + 1
    where id = report_record.id
    returning * into updated_report;

    insert into public.quran_report_versions (
      report_id, version_number, change_type, snapshot, change_reason, changed_by
    ) values (
      updated_report.id, updated_report.current_version, 'cancelled',
      to_jsonb(updated_report), reason_value, auth.uid()
    );

    target_report_id := updated_report.id;
  elsif split_required then
    insert into public.quran_reports (
      circle_id, import_batch_id, import_row_id, report_date, task_type,
      content, repetitions, notes, max_points, starts_at, due_at,
      current_version, created_by, root_report_id, supersedes_report_id
    ) values (
      report_record.circle_id, report_record.import_batch_id, report_record.import_row_id,
      p_report_date, report_record.task_type, content_value, p_repetitions,
      notes_value, report_record.max_points,
      report_record.starts_at + make_interval(days => delta_days),
      report_record.due_at + make_interval(days => delta_days),
      1, auth.uid(), report_record.root_report_id, report_record.id
    ) returning id into successor_id;

    insert into public.quran_report_versions (
      report_id, version_number, change_type, snapshot, change_reason, changed_by
    )
    select id, 1, 'created', to_jsonb(r), reason_value, auth.uid()
    from public.quran_reports r where id = successor_id;

    for assignment_record in
      select * from public.quran_report_assignments
      where report_id = report_record.id and status = 'pending'
      order by
        case when delta_days > 0 then report_date end desc,
        case when delta_days < 0 then report_date end asc,
        student_id
      for update
    loop
      update public.quran_report_assignments
      set report_id = successor_id,
          report_date = assignment_record.report_date + delta_days,
          starts_at = assignment_record.starts_at + make_interval(days => delta_days),
          original_due_at = assignment_record.original_due_at + make_interval(days => delta_days),
          effective_due_at = assignment_record.effective_due_at + make_interval(days => delta_days)
      where id = assignment_record.id
      returning * into updated_assignment;

      insert into public.quran_report_assignment_events (
        assignment_id, actor_id, event_type, before_data, after_data, metadata
      ) values (
        assignment_record.id, auth.uid(), 'report_updated',
        to_jsonb(assignment_record), to_jsonb(updated_assignment),
        jsonb_build_object('reason', reason_value, 'old_report_id', report_record.id, 'new_report_id', successor_id)
      );
    end loop;

    update public.quran_reports
    set status = 'cancelled', cancelled_by = auth.uid(), cancelled_at = now(),
        current_version = current_version + 1
    where id = report_record.id
    returning * into updated_report;

    insert into public.quran_report_versions (
      report_id, version_number, change_type, snapshot, change_reason, changed_by
    ) values (
      updated_report.id, updated_report.current_version, 'cancelled',
      to_jsonb(updated_report), reason_value, auth.uid()
    );

    target_report_id := successor_id;
  else
    update public.quran_reports
    set report_date = p_report_date,
        content = content_value,
        repetitions = p_repetitions,
        notes = notes_value,
        starts_at = starts_at + make_interval(days => delta_days),
        due_at = due_at + make_interval(days => delta_days),
        current_version = current_version + 1
    where id = report_record.id
    returning * into updated_report;

    for assignment_record in
      select * from public.quran_report_assignments
      where report_id = report_record.id and status = 'pending'
      order by
        case when delta_days > 0 then report_date end desc,
        case when delta_days < 0 then report_date end asc,
        student_id
      for update
    loop
      update public.quran_report_assignments
      set report_date = assignment_record.report_date + delta_days,
          starts_at = assignment_record.starts_at + make_interval(days => delta_days),
          original_due_at = assignment_record.original_due_at + make_interval(days => delta_days),
          effective_due_at = assignment_record.effective_due_at + make_interval(days => delta_days)
      where id = assignment_record.id
      returning * into updated_assignment;

      insert into public.quran_report_assignment_events (
        assignment_id, actor_id, event_type, before_data, after_data, metadata
      ) values (
        assignment_record.id, auth.uid(), 'report_updated',
        to_jsonb(assignment_record), to_jsonb(updated_assignment),
        jsonb_build_object('reason', reason_value, 'report_id', report_record.id)
      );
    end loop;

    insert into public.quran_report_versions (
      report_id, version_number, change_type, snapshot, change_reason, changed_by
    ) values (
      updated_report.id, updated_report.current_version, 'edited',
      to_jsonb(updated_report), reason_value, auth.uid()
    );

    target_report_id := updated_report.id;
  end if;

  if action_value = 'edit' then
    insert into public.notifications (user_id, title, body, type)
    select distinct student_id, 'تحديث تقرير قرآن', 'عدّل المعلم أحد تقارير القرآن المعلقة في خطتك.', 'quran_report_updated'
    from public.quran_report_assignments
    where report_id = target_report_id and status = 'pending';
  end if;

  perform public.record_platform_audit(
    report_record.circle_id,
    case when action_value = 'edit' then 'quran_reports.approved_report_edited' else 'quran_reports.approved_report_cancelled' end,
    'quran_report', report_record.id::text,
    to_jsonb(report_record),
    jsonb_build_object('target_report_id', target_report_id, 'action', action_value),
    result || jsonb_build_object('reason', reason_value)
  );

  return result || jsonb_build_object(
    'dry_run', false,
    'target_report_id', target_report_id,
    'successor_report_id', successor_id,
    'applied_at', now()
  );
end;
$$;

create or replace function public.get_quran_approved_report_plan(
  p_circle_id uuid,
  p_start_date date default null,
  p_end_date date default null
)
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
  if not public.can_review_quran_reports(p_circle_id) then
    raise exception 'Not allowed to review Quran reports for this circle' using errcode = '42501';
  end if;
  if p_start_date is not null and p_end_date is not null and p_end_date < p_start_date then
    raise exception 'Invalid Quran report review range';
  end if;
  if p_start_date is not null and p_end_date is not null and p_end_date - p_start_date > 366 then
    raise exception 'Quran report review range cannot exceed 366 days';
  end if;

  with report_stats as (
    select
      r.id, r.root_report_id, r.supersedes_report_id, r.status, r.current_version,
      r.report_date, r.task_type, r.content, r.repetitions, r.notes,
      r.max_points, r.starts_at, r.due_at, r.created_at,
      count(a.id) filter (where a.status in ('pending', 'completed', 'exempted')) as assigned_count,
      count(a.id) filter (where a.status = 'pending') as pending_count,
      count(a.id) filter (where a.status = 'completed') as completed_count,
      count(a.id) filter (where a.status = 'exempted') as exempted_count,
      count(a.id) filter (where a.status = 'cancelled') as cancelled_count
    from public.quran_reports r
    join public.quran_report_assignments a on a.report_id = r.id
    where r.circle_id = p_circle_id
      and (p_start_date is null or r.report_date >= p_start_date)
      and (p_end_date is null or r.report_date <= p_end_date)
    group by r.id
    having count(a.id) filter (where a.status in ('pending', 'completed', 'exempted', 'cancelled')) > 0
  )
  select jsonb_build_object(
    'circle_id', p_circle_id,
    'date_from', min(report_date),
    'date_to', max(report_date),
    'reports', coalesce(jsonb_agg(to_jsonb(report_stats) order by report_date, case task_type when 'hifz' then 1 when 'tathbit' then 2 else 3 end, created_at), '[]'::jsonb)
  ) into result
  from report_stats;

  return result;
end;
$$;

revoke all on function public.set_quran_report_lineage() from public, anon, authenticated;
revoke all on function public.get_quran_report_management_details(uuid) from public, anon, authenticated;
revoke all on function public.manage_quran_approved_report(uuid, text, date, text, integer, text, text, boolean) from public, anon, authenticated;
revoke all on function public.get_quran_approved_report_plan(uuid, date, date) from public, anon, authenticated;

grant execute on function public.get_quran_report_management_details(uuid) to authenticated, service_role;
grant execute on function public.manage_quran_approved_report(uuid, text, date, text, integer, text, text, boolean) to authenticated, service_role;
grant execute on function public.get_quran_approved_report_plan(uuid, date, date) to authenticated, service_role;
