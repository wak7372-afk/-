-- RLS and atomic server operations for Quran report imports.

create or replace function public.can_manage_quran_reports(p_circle_id uuid)
returns boolean
language sql
stable
security definer
set search_path = pg_catalog, public
set row_security = off
as $$
  select exists (
    select 1
    from public.learning_circles c
    where c.id = p_circle_id
      and c.circle_type = 'quran'
      and c.status = 'active'
  ) and public.has_learning_circle_permission(p_circle_id, 'create_tasks');
$$;

create or replace function public.can_view_quran_report(p_report_id uuid)
returns boolean
language sql
stable
security definer
set search_path = pg_catalog, public
set row_security = off
as $$
  select exists (
    select 1
    from public.quran_reports r
    where r.id = p_report_id
      and (
        public.is_admin()
        or public.is_learning_circle_staff(r.circle_id, auth.uid())
        or exists (
          select 1
          from public.quran_report_assignments a
          where a.report_id = r.id
            and a.student_id = auth.uid()
            and a.status in ('pending', 'completed', 'exempted')
        )
      )
  );
$$;

create or replace function public.can_view_quran_assignment(p_assignment_id uuid)
returns boolean
language sql
stable
security definer
set search_path = pg_catalog, public
set row_security = off
as $$
  select exists (
    select 1
    from public.quran_report_assignments a
    where a.id = p_assignment_id
      and (
        a.student_id = auth.uid()
        or public.is_admin()
        or public.is_learning_circle_staff(a.circle_id, auth.uid())
      )
  );
$$;

create or replace function public.quran_report_local_timestamp(
  p_date date,
  p_time time,
  p_timezone text
)
returns timestamptz
language sql
stable
set search_path = pg_catalog, public
as $$
  select (p_date + p_time) at time zone p_timezone;
$$;

create or replace function public.stage_quran_report_import(
  p_circle_id uuid,
  p_file_name text,
  p_file_size_bytes bigint,
  p_file_sha256 text,
  p_rows jsonb,
  p_audience_mode text,
  p_student_ids uuid[] default null,
  p_storage_path text default null,
  p_metadata jsonb default '{}'::jsonb
)
returns jsonb
language plpgsql
security definer
set search_path = pg_catalog, public
set row_security = off
as $$
declare
  v_batch_id uuid;
  item jsonb;
  item_date date;
  item_type text;
  item_content text;
  item_repetitions smallint;
  item_notes text;
  item_sheet text;
  item_row integer;
  item_points numeric(5,2);
  item_status text;
  item_messages jsonb;
  item_fingerprint text;
  v_requested_students integer := 0;
  v_recipient_count integer := 0;
  v_row_count integer;
  v_valid_count integer;
  v_error_count integer;
  v_conflict_count bigint;
  v_date_from date;
  v_date_to date;
begin
  if not public.can_manage_quran_reports(p_circle_id) then
    raise exception 'Only authorized Quran-circle staff may stage reports' using errcode = '42501';
  end if;

  if char_length(btrim(coalesce(p_file_name, ''))) not between 1 and 255 then
    raise exception 'Invalid Excel file name';
  end if;
  if p_file_size_bytes not between 1 and 10485760 then
    raise exception 'Excel file size must be between 1 byte and 10 MB';
  end if;
  if lower(coalesce(p_file_sha256, '')) !~ '^[0-9a-f]{64}$' then
    raise exception 'A valid SHA-256 file fingerprint is required';
  end if;
  if jsonb_typeof(p_rows) <> 'array'
     or jsonb_array_length(p_rows) not between 1 and 5000 then
    raise exception 'Report rows must contain between 1 and 5000 items';
  end if;
  if p_audience_mode not in ('all', 'selected') then
    raise exception 'Invalid report audience mode';
  end if;
  if p_storage_path is not null and (
    public.learning_circle_id_from_storage_path(p_storage_path) is distinct from p_circle_id
    or split_part(p_storage_path, '/', 2) <> auth.uid()::text
    or not exists (
      select 1
      from storage.objects object
      where object.bucket_id = 'quran-report-imports'
        and object.name = p_storage_path
        and object.owner_id = auth.uid()::text
    )
  ) then
    raise exception 'The stored Excel file does not belong to this actor and Quran circle' using errcode = '42501';
  end if;

  insert into public.quran_report_import_batches (
    circle_id, created_by, file_name, file_size_bytes, file_sha256,
    storage_path, audience_mode, row_count, metadata
  ) values (
    p_circle_id, auth.uid(), btrim(p_file_name), p_file_size_bytes,
    lower(p_file_sha256), nullif(btrim(coalesce(p_storage_path, '')), ''),
    p_audience_mode, jsonb_array_length(p_rows), coalesce(p_metadata, '{}'::jsonb)
  ) returning id into v_batch_id;

  if p_audience_mode = 'all' then
    insert into public.quran_report_import_recipients (batch_id, membership_id, student_id)
    select v_batch_id, m.id, m.student_id
    from public.learning_circle_memberships m
    join public.users u on u.id = m.student_id
    where m.circle_id = p_circle_id
      and m.circle_type = 'quran'
      and m.status = 'active'
      and u.role = 'student'
      and u.is_active = true;
  else
    if p_student_ids is null or coalesce(array_length(p_student_ids, 1), 0) = 0 then
      raise exception 'At least one student must be selected';
    end if;

    select count(distinct requested_id)
    into v_requested_students
    from unnest(p_student_ids) as requested(requested_id);

    insert into public.quran_report_import_recipients (batch_id, membership_id, student_id)
    select v_batch_id, m.id, m.student_id
    from public.learning_circle_memberships m
    join public.users u on u.id = m.student_id
    where m.circle_id = p_circle_id
      and m.circle_type = 'quran'
      and m.status = 'active'
      and u.role = 'student'
      and u.is_active = true
      and m.student_id = any(p_student_ids);
  end if;

  select count(*) into v_recipient_count
  from public.quran_report_import_recipients r
  where r.batch_id = v_batch_id;

  if v_recipient_count = 0 then
    raise exception 'The Quran circle has no eligible selected students';
  end if;
  if p_audience_mode = 'selected' and v_recipient_count <> v_requested_students then
    raise exception 'One or more selected students are not active members of this Quran circle';
  end if;
  if v_recipient_count::bigint * jsonb_array_length(p_rows)::bigint > 250000 then
    raise exception 'The import would create more than 250000 student tasks';
  end if;

  for item in select value from jsonb_array_elements(p_rows)
  loop
    item_date := null;
    item_type := null;
    item_repetitions := null;
    item_messages := '[]'::jsonb;
    item_sheet := left(coalesce(nullif(btrim(item ->> 'source_sheet'), ''), 'Sheet1'), 255);

    begin
      item_row := coalesce(nullif(item ->> 'source_row', '')::integer, 1);
      if item_row not between 1 and 1000000 then raise exception 'out of range'; end if;
    exception when others then
      item_row := 1;
      item_messages := item_messages || jsonb_build_array('invalid_source_row');
    end;

    begin
      item_date := nullif(item ->> 'date', '')::date;
    exception when others then
      item_messages := item_messages || jsonb_build_array('invalid_date');
    end;
    if item_date is null then
      item_messages := item_messages || jsonb_build_array('missing_date');
    end if;

    item_type := case lower(btrim(coalesce(item ->> 'type', '')))
      when 'hifz' then 'hifz'
      when 'حفظ' then 'hifz'
      when 'tathbit' then 'tathbit'
      when 'تثبيت' then 'tathbit'
      when 'murajaa' then 'murajaa'
      when 'مراجعة' then 'murajaa'
      else null
    end;
    if item_type is null then
      item_messages := item_messages || jsonb_build_array('invalid_type');
    end if;

    item_content := nullif(btrim(coalesce(item ->> 'content', '')), '');
    if item_content is null or char_length(item_content) > 2000 then
      item_messages := item_messages || jsonb_build_array('invalid_content');
      item_content := null;
    end if;

    if nullif(btrim(coalesce(item ->> 'repetitions', '')), '') is not null then
      begin
        item_repetitions := (item ->> 'repetitions')::smallint;
        if item_repetitions not between 1 and 100 then raise exception 'out of range'; end if;
      exception when others then
        item_repetitions := null;
        item_messages := item_messages || jsonb_build_array('invalid_repetitions');
      end;
    end if;

    item_notes := nullif(btrim(coalesce(item ->> 'notes', '')), '');
    if item_notes is not null and char_length(item_notes) > 3000 then
      item_notes := null;
      item_messages := item_messages || jsonb_build_array('invalid_notes');
    end if;

    item_points := case item_type when 'hifz' then 4.00 when 'tathbit' then 3.00 when 'murajaa' then 3.00 else null end;
    item_status := case when jsonb_array_length(item_messages) = 0 then 'valid' else 'error' end;
    item_fingerprint := case when item_status = 'valid' then md5(
      item_date::text || '|' || item_type || '|' || item_content || '|'
      || coalesce(item_repetitions::text, '') || '|' || coalesce(item_notes, '')
    ) else null end;

    insert into public.quran_report_import_rows (
      batch_id, source_sheet, source_row, report_date, task_type, content,
      repetitions, notes, max_points, validation_status, validation_messages,
      source_payload, fingerprint
    ) values (
      v_batch_id, item_sheet, item_row, item_date, item_type, item_content,
      item_repetitions, item_notes, item_points, item_status, item_messages,
      item, item_fingerprint
    );
  end loop;

  with duplicate_rows as (
    select report_date, task_type
    from public.quran_report_import_rows
    where batch_id = v_batch_id
      and validation_status = 'valid'
    group by report_date, task_type
    having count(*) > 1
  )
  update public.quran_report_import_rows r
  set validation_status = 'error',
      validation_messages = r.validation_messages || jsonb_build_array('duplicate_date_and_type')
  from duplicate_rows d
  where r.batch_id = v_batch_id
    and r.report_date = d.report_date
    and r.task_type = d.task_type;

  select
    count(*),
    count(*) filter (where validation_status = 'valid'),
    count(*) filter (where validation_status = 'error'),
    min(report_date) filter (where validation_status = 'valid'),
    max(report_date) filter (where validation_status = 'valid')
  into v_row_count, v_valid_count, v_error_count, v_date_from, v_date_to
  from public.quran_report_import_rows
  where batch_id = v_batch_id;

  select count(*) into v_conflict_count
  from public.quran_report_import_rows r
  cross join public.quran_report_import_recipients recipient
  join public.quran_report_assignments a
    on a.student_id = recipient.student_id
   and a.report_date = r.report_date
   and a.task_type = r.task_type
   and a.status in ('pending', 'completed', 'exempted')
  where r.batch_id = v_batch_id
    and recipient.batch_id = v_batch_id
    and r.validation_status = 'valid';

  update public.quran_report_import_batches
  set valid_row_count = v_valid_count,
      error_row_count = v_error_count,
      recipient_count = v_recipient_count,
      date_from = v_date_from,
      date_to = v_date_to
  where id = v_batch_id;

  perform public.record_platform_audit(
    p_circle_id, 'quran_reports.import_staged', 'quran_report_import_batch', v_batch_id::text,
    null,
    jsonb_build_object(
      'rows', v_row_count, 'valid_rows', v_valid_count, 'error_rows', v_error_count,
      'recipients', v_recipient_count, 'conflicts', v_conflict_count
    ),
    jsonb_build_object('file_name', btrim(p_file_name), 'audience_mode', p_audience_mode)
  );

  return jsonb_build_object(
    'batch_id', v_batch_id,
    'row_count', v_row_count,
    'valid_row_count', v_valid_count,
    'error_row_count', v_error_count,
    'recipient_count', v_recipient_count,
    'conflict_count', v_conflict_count,
    'date_from', v_date_from,
    'date_to', v_date_to
  );
end;
$$;

create or replace function public.cancel_quran_report_import(p_batch_id uuid)
returns void
language plpgsql
security definer
set search_path = pg_catalog, public
set row_security = off
as $$
declare
  batch_record public.quran_report_import_batches%rowtype;
begin
  select * into batch_record
  from public.quran_report_import_batches
  where id = p_batch_id
  for update;

  if batch_record.id is null then raise exception 'Quran report import batch not found'; end if;
  if not public.can_manage_quran_reports(batch_record.circle_id) then
    raise exception 'Not allowed to cancel this Quran report import' using errcode = '42501';
  end if;
  if batch_record.status <> 'staged' then
    raise exception 'Only staged Quran report imports may be cancelled';
  end if;

  update public.quran_report_import_batches
  set status = 'cancelled'
  where id = p_batch_id;

  perform public.record_platform_audit(
    batch_record.circle_id, 'quran_reports.import_cancelled',
    'quran_report_import_batch', p_batch_id::text,
    jsonb_build_object('status', 'staged'),
    jsonb_build_object('status', 'cancelled')
  );
end;
$$;

create or replace function public.get_quran_report_import_preview(p_batch_id uuid)
returns jsonb
language plpgsql
stable
security definer
set search_path = pg_catalog, public
set row_security = off
as $$
declare
  batch_record public.quran_report_import_batches%rowtype;
  result jsonb;
begin
  select * into batch_record
  from public.quran_report_import_batches
  where id = p_batch_id;

  if batch_record.id is null then raise exception 'Quran report import batch not found'; end if;
  if not public.can_manage_quran_reports(batch_record.circle_id) then
    raise exception 'Not allowed to preview this Quran report import' using errcode = '42501';
  end if;

  select jsonb_build_object(
    'batch', to_jsonb(batch_record),
    'rows', coalesce((
      select jsonb_agg(to_jsonb(r) order by r.report_date nulls last, r.source_sheet, r.source_row, r.task_type)
      from public.quran_report_import_rows r
      where r.batch_id = p_batch_id
    ), '[]'::jsonb),
    'recipients', coalesce((
      select jsonb_agg(jsonb_build_object(
        'student_id', recipient.student_id,
        'membership_id', recipient.membership_id,
        'username', u.username,
        'full_name', u.full_name
      ) order by u.full_name, u.username)
      from public.quran_report_import_recipients recipient
      join public.users u on u.id = recipient.student_id
      where recipient.batch_id = p_batch_id
    ), '[]'::jsonb),
    'conflict_count', (
      select count(*)
      from public.quran_report_import_rows r
      cross join public.quran_report_import_recipients recipient
      join public.quran_report_assignments a
        on a.student_id = recipient.student_id
       and a.report_date = r.report_date
       and a.task_type = r.task_type
       and a.status in ('pending', 'completed', 'exempted')
      where r.batch_id = p_batch_id
        and recipient.batch_id = p_batch_id
        and r.validation_status = 'valid'
    ),
    'conflicts', coalesce((
      select jsonb_agg(to_jsonb(conflict_row) order by conflict_row.report_date, conflict_row.full_name)
      from (
        select
          a.id as existing_assignment_id,
          a.student_id,
          u.username,
          u.full_name,
          r.report_date,
          r.task_type,
          a.status as existing_status,
          existing_report.content as existing_content,
          r.content as incoming_content
        from public.quran_report_import_rows r
        cross join public.quran_report_import_recipients recipient
        join public.users u on u.id = recipient.student_id
        join public.quran_report_assignments a
          on a.student_id = recipient.student_id
         and a.report_date = r.report_date
         and a.task_type = r.task_type
         and a.status in ('pending', 'completed', 'exempted')
        join public.quran_reports existing_report on existing_report.id = a.report_id
        where r.batch_id = p_batch_id
          and recipient.batch_id = p_batch_id
          and r.validation_status = 'valid'
        limit 500
      ) conflict_row
    ), '[]'::jsonb)
  ) into result;

  return result;
end;
$$;

create or replace function public.approve_quran_report_import(
  p_batch_id uuid,
  p_conflict_strategy text default 'reject'
)
returns jsonb
language plpgsql
security definer
set search_path = pg_catalog, public
set row_security = off
as $$
declare
  batch_record public.quran_report_import_batches%rowtype;
  settings_record public.learning_circle_settings%rowtype;
  row_record public.quran_report_import_rows%rowtype;
  recipient_record public.quran_report_import_recipients%rowtype;
  existing_assignment public.quran_report_assignments%rowtype;
  v_report_id uuid;
  v_assignment_id uuid;
  v_starts_at timestamptz;
  v_due_at timestamptz;
  v_report_count integer := 0;
  v_assignment_count integer := 0;
  v_replaced_count integer := 0;
  v_skipped_count integer := 0;
  v_conflict_count integer := 0;
begin
  if p_conflict_strategy not in ('reject', 'replace', 'skip') then
    raise exception 'Invalid conflict strategy';
  end if;

  select * into batch_record
  from public.quran_report_import_batches
  where id = p_batch_id
  for update;

  if batch_record.id is null then raise exception 'Quran report import batch not found'; end if;
  if not public.can_manage_quran_reports(batch_record.circle_id) then
    raise exception 'Not allowed to approve this Quran report import' using errcode = '42501';
  end if;
  if batch_record.status <> 'staged' then
    raise exception 'Only staged Quran report imports may be approved';
  end if;
  if batch_record.error_row_count > 0 or batch_record.valid_row_count = 0 then
    raise exception 'The import contains validation errors';
  end if;

  select * into settings_record
  from public.learning_circle_settings
  where circle_id = batch_record.circle_id;
  if settings_record.circle_id is null then raise exception 'Quran circle settings not found'; end if;

  select count(*) into v_conflict_count
  from public.quran_report_import_rows r
  cross join public.quran_report_import_recipients recipient
  join public.quran_report_assignments a
    on a.student_id = recipient.student_id
   and a.report_date = r.report_date
   and a.task_type = r.task_type
   and a.status in ('pending', 'completed', 'exempted')
  where r.batch_id = p_batch_id
    and recipient.batch_id = p_batch_id
    and r.validation_status = 'valid';

  if v_conflict_count > 0 and p_conflict_strategy = 'reject' then
    raise exception 'The import conflicts with existing student plans';
  end if;
  if p_conflict_strategy = 'replace' and exists (
    select 1
    from public.quran_report_import_rows r
    cross join public.quran_report_import_recipients recipient
    join public.quran_report_assignments a
      on a.student_id = recipient.student_id
     and a.report_date = r.report_date
     and a.task_type = r.task_type
     and a.status in ('completed', 'exempted')
    where r.batch_id = p_batch_id
      and recipient.batch_id = p_batch_id
      and r.validation_status = 'valid'
  ) then
    raise exception 'Completed or exempted reports cannot be replaced';
  end if;

  for row_record in
    select * from public.quran_report_import_rows
    where batch_id = p_batch_id and validation_status = 'valid'
    order by report_date, source_sheet, source_row, task_type
  loop
    v_starts_at := public.quran_report_local_timestamp(
      row_record.report_date,
      settings_record.quran_report_start_time,
      settings_record.timezone
    );
    v_due_at := public.quran_report_local_timestamp(
      row_record.report_date,
      settings_record.quran_report_due_time,
      settings_record.timezone
    );
    v_report_id := null;

    for recipient_record in
      select * from public.quran_report_import_recipients
      where batch_id = p_batch_id
      order by student_id
    loop
      existing_assignment := null;
      select * into existing_assignment
      from public.quran_report_assignments a
      where a.student_id = recipient_record.student_id
        and a.report_date = row_record.report_date
        and a.task_type = row_record.task_type
        and a.status in ('pending', 'completed', 'exempted')
      for update;

      if existing_assignment.id is not null and p_conflict_strategy = 'skip' then
        v_skipped_count := v_skipped_count + 1;
        continue;
      end if;

      if v_report_id is null then
        insert into public.quran_reports (
          circle_id, import_batch_id, import_row_id, report_date, task_type,
          content, repetitions, notes, max_points, starts_at, due_at, created_by
        ) values (
          batch_record.circle_id, p_batch_id, row_record.id, row_record.report_date,
          row_record.task_type, row_record.content, row_record.repetitions,
          row_record.notes, row_record.max_points, v_starts_at, v_due_at, auth.uid()
        ) returning id into v_report_id;

        insert into public.quran_report_versions (
          report_id, version_number, change_type, snapshot, changed_by
        ) values (
          v_report_id, 1, 'created', jsonb_build_object(
            'report_date', row_record.report_date,
            'task_type', row_record.task_type,
            'content', row_record.content,
            'repetitions', row_record.repetitions,
            'notes', row_record.notes,
            'max_points', row_record.max_points,
            'starts_at', v_starts_at,
            'due_at', v_due_at
          ), auth.uid()
        );
        v_report_count := v_report_count + 1;
      end if;

      if existing_assignment.id is not null then
        update public.quran_report_assignments
        set status = 'replaced'
        where id = existing_assignment.id;
        v_replaced_count := v_replaced_count + 1;
      end if;

      insert into public.quran_report_assignments (
        report_id, circle_id, membership_id, student_id, report_date, task_type,
        starts_at, original_due_at, effective_due_at, max_points
      ) values (
        v_report_id, batch_record.circle_id, recipient_record.membership_id,
        recipient_record.student_id, row_record.report_date, row_record.task_type,
        v_starts_at, v_due_at, v_due_at, row_record.max_points
      ) returning id into v_assignment_id;

      if existing_assignment.id is not null then
        update public.quran_report_assignments
        set replaced_by_assignment_id = v_assignment_id
        where id = existing_assignment.id;

        insert into public.quran_report_assignment_events (
          assignment_id, actor_id, event_type, before_data, after_data
        ) values (
          existing_assignment.id, auth.uid(), 'replaced',
          to_jsonb(existing_assignment),
          jsonb_build_object('status', 'replaced', 'replaced_by_assignment_id', v_assignment_id)
        );
      end if;

      insert into public.quran_report_assignment_events (
        assignment_id, actor_id, event_type, after_data,
        metadata
      ) values (
        v_assignment_id, auth.uid(), 'assigned',
        jsonb_build_object(
          'report_id', v_report_id, 'student_id', recipient_record.student_id,
          'report_date', row_record.report_date, 'task_type', row_record.task_type,
          'max_points', row_record.max_points
        ),
        jsonb_build_object('import_batch_id', p_batch_id)
      );
      v_assignment_count := v_assignment_count + 1;
    end loop;
  end loop;

  if v_assignment_count = 0 then
    raise exception 'The import did not create any student reports';
  end if;

  update public.quran_report_import_batches
  set status = case when v_skipped_count > 0 then 'approved_with_skips' else 'approved' end,
      approved_by = auth.uid(),
      approved_at = now()
  where id = p_batch_id;

  insert into public.notifications (user_id, title, body, type)
  select distinct
    a.student_id,
    'تقارير قرآن جديدة',
    'أضيفت تقارير قرآن جديدة إلى خطتك اليومية.',
    'quran_reports_published'
  from public.quran_report_assignments a
  join public.quran_reports r on r.id = a.report_id
  where r.import_batch_id = p_batch_id
    and a.status = 'pending';

  perform public.record_platform_audit(
    batch_record.circle_id, 'quran_reports.import_approved',
    'quran_report_import_batch', p_batch_id::text,
    jsonb_build_object('status', 'staged'),
    jsonb_build_object(
      'status', case when v_skipped_count > 0 then 'approved_with_skips' else 'approved' end,
      'reports', v_report_count, 'assignments', v_assignment_count,
      'replaced', v_replaced_count, 'skipped', v_skipped_count
    ),
    jsonb_build_object('conflict_strategy', p_conflict_strategy)
  );

  return jsonb_build_object(
    'batch_id', p_batch_id,
    'status', case when v_skipped_count > 0 then 'approved_with_skips' else 'approved' end,
    'reports_count', v_report_count,
    'assignments_count', v_assignment_count,
    'replaced_count', v_replaced_count,
    'skipped_count', v_skipped_count
  );
end;
$$;

drop policy if exists "Managers view Quran report imports" on public.quran_report_import_batches;
create policy "Managers view Quran report imports"
  on public.quran_report_import_batches for select to authenticated
  using (public.can_manage_quran_reports(circle_id));

drop policy if exists "Managers view Quran report recipients" on public.quran_report_import_recipients;
create policy "Managers view Quran report recipients"
  on public.quran_report_import_recipients for select to authenticated
  using (exists (
    select 1 from public.quran_report_import_batches b
    where b.id = batch_id and public.can_manage_quran_reports(b.circle_id)
  ));

drop policy if exists "Managers view Quran report import rows" on public.quran_report_import_rows;
create policy "Managers view Quran report import rows"
  on public.quran_report_import_rows for select to authenticated
  using (exists (
    select 1 from public.quran_report_import_batches b
    where b.id = batch_id and public.can_manage_quran_reports(b.circle_id)
  ));

drop policy if exists "Participants view assigned Quran reports" on public.quran_reports;
create policy "Participants view assigned Quran reports"
  on public.quran_reports for select to authenticated
  using (public.can_view_quran_report(id));

drop policy if exists "Participants view Quran report assignments" on public.quran_report_assignments;
create policy "Participants view Quran report assignments"
  on public.quran_report_assignments for select to authenticated
  using (
    student_id = auth.uid()
    or public.is_admin()
    or public.is_learning_circle_staff(circle_id, auth.uid())
  );

drop policy if exists "Managers view Quran report versions" on public.quran_report_versions;
create policy "Managers view Quran report versions"
  on public.quran_report_versions for select to authenticated
  using (exists (
    select 1 from public.quran_reports r
    where r.id = report_id
      and (public.is_admin() or public.is_learning_circle_staff(r.circle_id, auth.uid()))
  ));

drop policy if exists "Participants view Quran report events" on public.quran_report_assignment_events;
create policy "Participants view Quran report events"
  on public.quran_report_assignment_events for select to authenticated
  using (public.can_view_quran_assignment(assignment_id));

drop policy if exists "Related users view Quran extension requests" on public.quran_report_extension_requests;
create policy "Related users view Quran extension requests"
  on public.quran_report_extension_requests for select to authenticated
  using (
    student_id = auth.uid()
    or public.is_admin()
    or public.is_learning_circle_staff(circle_id, auth.uid())
  );

drop policy if exists "Related users view Quran extension items" on public.quran_report_extension_items;
create policy "Related users view Quran extension items"
  on public.quran_report_extension_items for select to authenticated
  using (exists (
    select 1 from public.quran_report_extension_requests request
    where request.id = request_id
      and (
        request.student_id = auth.uid()
        or public.is_admin()
        or public.is_learning_circle_staff(request.circle_id, auth.uid())
      )
  ));

drop policy if exists "Participants view Quran daily summaries" on public.quran_daily_summaries;
create policy "Participants view Quran daily summaries"
  on public.quran_daily_summaries for select to authenticated
  using (public.can_access_learning_circle(circle_id));

insert into storage.buckets (id, name, public, file_size_limit, allowed_mime_types)
values (
  'quran-report-imports',
  'quran-report-imports',
  false,
  10485760,
  array[
    'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
    'application/vnd.ms-excel',
    'text/csv',
    'application/csv'
  ]::text[]
)
on conflict (id) do update set
  public = excluded.public,
  file_size_limit = excluded.file_size_limit,
  allowed_mime_types = excluded.allowed_mime_types;

drop policy if exists "Quran report managers read import files" on storage.objects;
create policy "Quran report managers read import files"
  on storage.objects for select to authenticated
  using (
    bucket_id = 'quran-report-imports'
    and public.can_manage_quran_reports(public.learning_circle_id_from_storage_path(name))
  );

drop policy if exists "Quran report managers upload own import files" on storage.objects;
create policy "Quran report managers upload own import files"
  on storage.objects for insert to authenticated
  with check (
    bucket_id = 'quran-report-imports'
    and public.can_manage_quran_reports(public.learning_circle_id_from_storage_path(name))
    and split_part(name, '/', 2) = auth.uid()::text
    and owner_id = auth.uid()::text
  );

drop policy if exists "Quran report managers remove own import files" on storage.objects;
create policy "Quran report managers remove own import files"
  on storage.objects for delete to authenticated
  using (
    bucket_id = 'quran-report-imports'
    and public.can_manage_quran_reports(public.learning_circle_id_from_storage_path(name))
    and owner_id = auth.uid()::text
  );

grant select on public.quran_report_import_batches to authenticated;
grant select on public.quran_report_import_recipients to authenticated;
grant select on public.quran_report_import_rows to authenticated;
grant select on public.quran_reports to authenticated;
grant select on public.quran_report_assignments to authenticated;
grant select on public.quran_report_versions to authenticated;
grant select on public.quran_report_assignment_events to authenticated;
grant select on public.quran_report_extension_requests to authenticated;
grant select on public.quran_report_extension_items to authenticated;
grant select on public.quran_daily_summaries to authenticated;

revoke all on function public.can_manage_quran_reports(uuid) from public;
revoke all on function public.can_view_quran_report(uuid) from public;
revoke all on function public.can_view_quran_assignment(uuid) from public;
revoke all on function public.quran_report_local_timestamp(date, time, text) from public;
revoke all on function public.quran_report_points_at(numeric, timestamptz, timestamptz, timestamptz) from public;
revoke all on function public.stage_quran_report_import(uuid, text, bigint, text, jsonb, text, uuid[], text, jsonb) from public;
revoke all on function public.get_quran_report_import_preview(uuid) from public;
revoke all on function public.approve_quran_report_import(uuid, text) from public;
revoke all on function public.cancel_quran_report_import(uuid) from public;

grant execute on function public.can_manage_quran_reports(uuid) to authenticated;
grant execute on function public.can_view_quran_report(uuid) to authenticated;
grant execute on function public.can_view_quran_assignment(uuid) to authenticated;
grant execute on function public.quran_report_local_timestamp(date, time, text) to authenticated;
grant execute on function public.quran_report_points_at(numeric, timestamptz, timestamptz, timestamptz) to authenticated;
grant execute on function public.stage_quran_report_import(uuid, text, bigint, text, jsonb, text, uuid[], text, jsonb) to authenticated;
grant execute on function public.get_quran_report_import_preview(uuid) to authenticated;
grant execute on function public.approve_quran_report_import(uuid, text) to authenticated;
grant execute on function public.cancel_quran_report_import(uuid) to authenticated;
