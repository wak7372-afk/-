-- Canonical Quran daily-report model. Legacy daily_assignments remain intact.

alter table public.learning_circle_settings
  add column if not exists quran_report_start_time time not null default '00:00',
  add column if not exists quran_report_due_time time not null default '23:00',
  add column if not exists quran_daily_summary_time time not null default '23:05';

alter table public.learning_circle_settings
  add constraint learning_circle_settings_quran_report_window_check
  check (
    quran_report_due_time > quran_report_start_time
    and quran_daily_summary_time > quran_report_due_time
  );

create table if not exists public.quran_report_import_batches (
  id uuid primary key default gen_random_uuid(),
  circle_id uuid not null references public.learning_circles(id) on delete cascade,
  created_by uuid not null references public.users(id) on delete restrict,
  source text not null default 'excel' check (source in ('excel', 'manual')),
  file_name text not null check (char_length(btrim(file_name)) between 1 and 255),
  file_size_bytes bigint not null check (file_size_bytes between 1 and 10485760),
  file_sha256 text not null check (file_sha256 ~ '^[0-9a-f]{64}$'),
  storage_path text check (storage_path is null or char_length(storage_path) between 10 and 1200),
  status text not null default 'staged'
    check (status in ('staged', 'approved', 'approved_with_skips', 'cancelled', 'failed')),
  audience_mode text not null check (audience_mode in ('all', 'selected')),
  row_count integer not null default 0 check (row_count between 0 and 5000),
  valid_row_count integer not null default 0 check (valid_row_count between 0 and 5000),
  error_row_count integer not null default 0 check (error_row_count between 0 and 5000),
  recipient_count integer not null default 0 check (recipient_count between 0 and 10000),
  date_from date,
  date_to date,
  approved_by uuid references public.users(id) on delete restrict,
  approved_at timestamptz,
  failure_summary text check (failure_summary is null or char_length(failure_summary) <= 3000),
  metadata jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  constraint quran_report_import_date_range check (
    date_from is null or date_to is null or date_to >= date_from
  ),
  constraint quran_report_import_approval check (
    (status in ('approved', 'approved_with_skips') and approved_by is not null and approved_at is not null)
    or (status not in ('approved', 'approved_with_skips') and approved_by is null and approved_at is null)
  )
);

create index if not exists quran_report_import_batches_circle_created_idx
  on public.quran_report_import_batches (circle_id, created_at desc);
create index if not exists quran_report_import_batches_hash_idx
  on public.quran_report_import_batches (circle_id, file_sha256, created_at desc);

create table if not exists public.quran_report_import_recipients (
  batch_id uuid not null references public.quran_report_import_batches(id) on delete cascade,
  membership_id uuid not null references public.learning_circle_memberships(id) on delete restrict,
  student_id uuid not null references public.users(id) on delete restrict,
  created_at timestamptz not null default now(),
  primary key (batch_id, student_id),
  unique (batch_id, membership_id)
);

create index if not exists quran_report_import_recipients_student_idx
  on public.quran_report_import_recipients (student_id, batch_id);

create table if not exists public.quran_report_import_rows (
  id uuid primary key default gen_random_uuid(),
  batch_id uuid not null references public.quran_report_import_batches(id) on delete cascade,
  source_sheet text not null default 'Sheet1' check (char_length(source_sheet) between 1 and 255),
  source_row integer not null check (source_row between 1 and 1000000),
  report_date date,
  task_type text check (task_type is null or task_type in ('hifz', 'tathbit', 'murajaa')),
  content text check (content is null or char_length(content) between 1 and 2000),
  repetitions smallint check (repetitions is null or repetitions between 1 and 100),
  notes text check (notes is null or char_length(notes) <= 3000),
  max_points numeric(5,2),
  validation_status text not null check (validation_status in ('valid', 'error')),
  validation_messages jsonb not null default '[]'::jsonb
    check (jsonb_typeof(validation_messages) = 'array'),
  source_payload jsonb not null default '{}'::jsonb,
  fingerprint text,
  created_at timestamptz not null default now(),
  constraint quran_report_import_row_validity check (
    validation_status = 'error'
    or (
      report_date is not null and task_type is not null and content is not null
      and max_points = case task_type when 'hifz' then 4.00 else 3.00 end
    )
  )
);

create index if not exists quran_report_import_rows_batch_idx
  on public.quran_report_import_rows (batch_id, source_row, task_type);
create index if not exists quran_report_import_rows_schedule_idx
  on public.quran_report_import_rows (batch_id, report_date, task_type)
  where validation_status = 'valid';

create table if not exists public.quran_reports (
  id uuid primary key default gen_random_uuid(),
  circle_id uuid not null references public.learning_circles(id) on delete cascade,
  import_batch_id uuid references public.quran_report_import_batches(id) on delete set null,
  import_row_id uuid references public.quran_report_import_rows(id) on delete set null,
  report_date date not null,
  task_type text not null check (task_type in ('hifz', 'tathbit', 'murajaa')),
  content text not null check (char_length(btrim(content)) between 1 and 2000),
  repetitions smallint check (repetitions is null or repetitions between 1 and 100),
  notes text check (notes is null or char_length(notes) <= 3000),
  max_points numeric(5,2) not null,
  starts_at timestamptz not null,
  due_at timestamptz not null,
  status text not null default 'published' check (status in ('published', 'cancelled')),
  current_version integer not null default 1 check (current_version >= 1),
  created_by uuid not null references public.users(id) on delete restrict,
  cancelled_by uuid references public.users(id) on delete restrict,
  cancelled_at timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  constraint quran_report_points_by_type check (
    max_points = case task_type when 'hifz' then 4.00 else 3.00 end
  ),
  constraint quran_report_time_order check (due_at > starts_at),
  constraint quran_report_cancel_check check (
    (status = 'published' and cancelled_by is null and cancelled_at is null)
    or (status = 'cancelled' and cancelled_by is not null and cancelled_at is not null)
  )
);

create index if not exists quran_reports_circle_date_idx
  on public.quran_reports (circle_id, report_date, task_type);
create index if not exists quran_reports_batch_idx
  on public.quran_reports (import_batch_id, report_date);

create table if not exists public.quran_report_assignments (
  id uuid primary key default gen_random_uuid(),
  report_id uuid not null references public.quran_reports(id) on delete restrict,
  circle_id uuid not null references public.learning_circles(id) on delete cascade,
  membership_id uuid not null references public.learning_circle_memberships(id) on delete restrict,
  student_id uuid not null references public.users(id) on delete restrict,
  report_date date not null,
  task_type text not null check (task_type in ('hifz', 'tathbit', 'murajaa')),
  starts_at timestamptz not null,
  original_due_at timestamptz not null,
  effective_due_at timestamptz not null,
  max_points numeric(5,2) not null,
  status text not null default 'pending'
    check (status in ('pending', 'completed', 'exempted', 'replaced', 'cancelled')),
  completed_at timestamptz,
  awarded_points numeric(5,2),
  exempted_by uuid references public.users(id) on delete restrict,
  exempted_at timestamptz,
  exemption_reason text check (exemption_reason is null or char_length(exemption_reason) <= 2000),
  replaced_by_assignment_id uuid references public.quran_report_assignments(id) on delete restrict,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  constraint quran_report_assignment_time_order check (
    original_due_at > starts_at and effective_due_at >= original_due_at
  ),
  constraint quran_report_assignment_points check (
    max_points = case task_type when 'hifz' then 4.00 else 3.00 end
    and (awarded_points is null or awarded_points between 0 and max_points)
  ),
  constraint quran_report_assignment_state check (
    (status = 'completed' and completed_at is not null and awarded_points is not null
      and exempted_by is null and exempted_at is null and exemption_reason is null)
    or (status = 'exempted' and completed_at is null and awarded_points is null
      and exempted_by is not null and exempted_at is not null)
    or (status in ('pending', 'replaced', 'cancelled') and completed_at is null
      and awarded_points is null and exempted_by is null and exempted_at is null
      and exemption_reason is null)
  )
);

create unique index if not exists quran_report_one_active_assignment_idx
  on public.quran_report_assignments (student_id, report_date, task_type)
  where status in ('pending', 'completed', 'exempted');
create index if not exists quran_report_assignments_student_date_idx
  on public.quran_report_assignments (student_id, report_date desc, task_type);
create index if not exists quran_report_assignments_circle_date_idx
  on public.quran_report_assignments (circle_id, report_date, status);
create index if not exists quran_report_assignments_report_idx
  on public.quran_report_assignments (report_id, status);

create table if not exists public.quran_report_versions (
  id bigint generated always as identity primary key,
  report_id uuid not null references public.quran_reports(id) on delete cascade,
  version_number integer not null check (version_number >= 1),
  change_type text not null check (change_type in ('created', 'edited', 'cancelled')),
  snapshot jsonb not null,
  change_reason text check (change_reason is null or char_length(change_reason) <= 2000),
  changed_by uuid not null references public.users(id) on delete restrict,
  changed_at timestamptz not null default now(),
  unique (report_id, version_number)
);

create table if not exists public.quran_report_assignment_events (
  id bigint generated always as identity primary key,
  assignment_id uuid not null references public.quran_report_assignments(id) on delete cascade,
  actor_id uuid references public.users(id) on delete set null,
  event_type text not null check (event_type in (
    'assigned', 'completed', 'exempted', 'replaced', 'cancelled',
    'extension_requested', 'extension_approved', 'extension_rejected'
  )),
  before_data jsonb,
  after_data jsonb,
  metadata jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default now()
);

create index if not exists quran_report_assignment_events_assignment_idx
  on public.quran_report_assignment_events (assignment_id, created_at);

create table if not exists public.quran_report_extension_requests (
  id uuid primary key default gen_random_uuid(),
  circle_id uuid not null references public.learning_circles(id) on delete cascade,
  student_id uuid not null references public.users(id) on delete restrict,
  requested_minutes integer not null check (requested_minutes between 1 and 4320),
  reason text not null check (char_length(btrim(reason)) between 3 and 2000),
  status text not null default 'pending'
    check (status in ('pending', 'approved', 'partially_approved', 'rejected', 'cancelled')),
  requested_at timestamptz not null default now(),
  decided_at timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  constraint quran_report_extension_request_decision check (
    (status = 'pending' and decided_at is null)
    or (status <> 'pending' and decided_at is not null)
  )
);

create table if not exists public.quran_report_extension_items (
  id uuid primary key default gen_random_uuid(),
  request_id uuid not null references public.quran_report_extension_requests(id) on delete cascade,
  assignment_id uuid not null references public.quran_report_assignments(id) on delete restrict,
  status text not null default 'pending' check (status in ('pending', 'approved', 'rejected')),
  decision_mode text check (decision_mode is null or decision_mode in ('duration', 'until')),
  granted_minutes integer check (granted_minutes is null or granted_minutes between 1 and 4320),
  approved_until timestamptz,
  decision_note text check (decision_note is null or char_length(decision_note) <= 2000),
  decided_by uuid references public.users(id) on delete restrict,
  decided_at timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (request_id, assignment_id),
  constraint quran_report_extension_item_decision check (
    (status = 'pending' and decision_mode is null and granted_minutes is null
      and approved_until is null and decided_by is null and decided_at is null)
    or (status = 'rejected' and decision_mode is null and granted_minutes is null
      and approved_until is null and decided_by is not null and decided_at is not null)
    or (status = 'approved' and decision_mode is not null and approved_until is not null
      and decided_by is not null and decided_at is not null
      and ((decision_mode = 'duration' and granted_minutes is not null)
        or (decision_mode = 'until' and granted_minutes is null)))
  )
);

create index if not exists quran_report_extension_requests_circle_status_idx
  on public.quran_report_extension_requests (circle_id, status, requested_at);

create table if not exists public.quran_daily_summaries (
  id uuid primary key default gen_random_uuid(),
  circle_id uuid not null references public.learning_circles(id) on delete cascade,
  summary_date date not null,
  post_id uuid references public.learning_circle_posts(id) on delete set null,
  status text not null default 'pending' check (status in ('pending', 'published', 'updated', 'failed')),
  snapshot jsonb not null default '{}'::jsonb,
  generated_at timestamptz,
  last_error text check (last_error is null or char_length(last_error) <= 3000),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (circle_id, summary_date)
);

create or replace function public.touch_quran_report_record()
returns trigger
language plpgsql
set search_path = pg_catalog, public
as $$
begin
  new.updated_at := now();
  return new;
end;
$$;

create or replace function public.protect_quran_report_history()
returns trigger
language plpgsql
set search_path = pg_catalog, public
as $$
begin
  raise exception 'Quran report history is immutable' using errcode = '42501';
end;
$$;

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
  elsif new.report_id <> old.report_id
     or new.circle_id <> old.circle_id
     or new.membership_id <> old.membership_id
     or new.student_id <> old.student_id
     or new.report_date <> old.report_date
     or new.task_type <> old.task_type
     or new.starts_at <> old.starts_at
     or new.original_due_at <> old.original_due_at
     or new.max_points <> old.max_points then
    raise exception 'Quran report assignment identity fields are immutable';
  end if;

  return new;
end;
$$;

create or replace function public.quran_report_points_at(
  p_max_points numeric,
  p_starts_at timestamptz,
  p_due_at timestamptz,
  p_at timestamptz
)
returns numeric
language sql
immutable
set search_path = pg_catalog, public
as $$
  select case
    when p_max_points is null or p_starts_at is null or p_due_at is null or p_at is null then null
    when p_due_at <= p_starts_at then 0.00::numeric
    when p_at <= p_starts_at then round(p_max_points, 2)
    when p_at >= p_due_at then 0.00::numeric
    else round(
      p_max_points
      * extract(epoch from (p_due_at - p_at))::numeric
      / extract(epoch from (p_due_at - p_starts_at))::numeric,
      2
    )
  end;
$$;

drop trigger if exists touch_quran_report_import_batches on public.quran_report_import_batches;
create trigger touch_quran_report_import_batches
  before update on public.quran_report_import_batches
  for each row execute procedure public.touch_quran_report_record();

drop trigger if exists touch_quran_reports on public.quran_reports;
create trigger touch_quran_reports
  before update on public.quran_reports
  for each row execute procedure public.touch_quran_report_record();

drop trigger if exists touch_quran_report_assignments on public.quran_report_assignments;
create trigger touch_quran_report_assignments
  before update on public.quran_report_assignments
  for each row execute procedure public.touch_quran_report_record();

drop trigger if exists validate_quran_report_assignment on public.quran_report_assignments;
create trigger validate_quran_report_assignment
  before insert or update on public.quran_report_assignments
  for each row execute procedure public.validate_quran_report_assignment();

drop trigger if exists touch_quran_report_extension_requests on public.quran_report_extension_requests;
create trigger touch_quran_report_extension_requests
  before update on public.quran_report_extension_requests
  for each row execute procedure public.touch_quran_report_record();

drop trigger if exists touch_quran_report_extension_items on public.quran_report_extension_items;
create trigger touch_quran_report_extension_items
  before update on public.quran_report_extension_items
  for each row execute procedure public.touch_quran_report_record();

drop trigger if exists touch_quran_daily_summaries on public.quran_daily_summaries;
create trigger touch_quran_daily_summaries
  before update on public.quran_daily_summaries
  for each row execute procedure public.touch_quran_report_record();

drop trigger if exists protect_quran_report_versions on public.quran_report_versions;
create trigger protect_quran_report_versions
  before update or delete on public.quran_report_versions
  for each row execute procedure public.protect_quran_report_history();

drop trigger if exists protect_quran_report_assignment_events on public.quran_report_assignment_events;
create trigger protect_quran_report_assignment_events
  before update or delete on public.quran_report_assignment_events
  for each row execute procedure public.protect_quran_report_history();

alter table public.quran_report_import_batches enable row level security;
alter table public.quran_report_import_recipients enable row level security;
alter table public.quran_report_import_rows enable row level security;
alter table public.quran_reports enable row level security;
alter table public.quran_report_assignments enable row level security;
alter table public.quran_report_versions enable row level security;
alter table public.quran_report_assignment_events enable row level security;
alter table public.quran_report_extension_requests enable row level security;
alter table public.quran_report_extension_items enable row level security;
alter table public.quran_daily_summaries enable row level security;

revoke all on public.quran_report_import_batches from anon, authenticated;
revoke all on public.quran_report_import_recipients from anon, authenticated;
revoke all on public.quran_report_import_rows from anon, authenticated;
revoke all on public.quran_reports from anon, authenticated;
revoke all on public.quran_report_assignments from anon, authenticated;
revoke all on public.quran_report_versions from anon, authenticated;
revoke all on public.quran_report_assignment_events from anon, authenticated;
revoke all on public.quran_report_extension_requests from anon, authenticated;
revoke all on public.quran_report_extension_items from anon, authenticated;
revoke all on public.quran_daily_summaries from anon, authenticated;
