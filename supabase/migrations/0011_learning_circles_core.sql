-- Canonical learning-circle model. Legacy halaqat/classrooms remain intact
-- during the compatibility migration and are backfilled into this model.

create table if not exists public.learning_circles (
  id uuid primary key default gen_random_uuid(),
  circle_type text not null check (circle_type in ('quran', 'educational')),
  name text not null check (char_length(btrim(name)) between 2 and 160),
  description text check (description is null or char_length(description) <= 5000),
  status text not null default 'active' check (status in ('draft', 'active', 'archived')),
  meet_link text check (meet_link is null or char_length(meet_link) <= 1000),
  created_by uuid not null references public.users(id) on delete restrict,
  archived_by uuid references public.users(id) on delete restrict,
  archived_at timestamptz,
  legacy_halaqa_id uuid unique references public.halaqat(id) on delete restrict,
  legacy_classroom_id uuid unique references public.classrooms(id) on delete restrict,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  constraint learning_circles_single_legacy_source check (
    legacy_halaqa_id is null or legacy_classroom_id is null
  ),
  constraint learning_circles_archive_consistency check (
    (status = 'archived' and archived_at is not null)
    or (status <> 'archived' and archived_at is null and archived_by is null)
  )
);

create table if not exists public.learning_circle_subjects (
  circle_id uuid not null references public.learning_circles(id) on delete cascade,
  subject_id uuid not null references public.subjects(id) on delete restrict,
  added_by uuid not null references public.users(id) on delete restrict,
  created_at timestamptz not null default now(),
  primary key (circle_id, subject_id)
);

create table if not exists public.learning_circle_staff (
  id uuid primary key default gen_random_uuid(),
  circle_id uuid not null references public.learning_circles(id) on delete cascade,
  teacher_id uuid not null references public.users(id) on delete restrict,
  staff_role text not null check (staff_role in ('lead', 'assistant')),
  status text not null default 'active' check (status in ('active', 'ended')),
  can_post_announcements boolean not null default false,
  can_manage_meet_link boolean not null default false,
  can_create_tasks boolean not null default false,
  can_review_submissions boolean not null default false,
  can_manage_discussions boolean not null default false,
  can_track_students boolean not null default true,
  appointed_by uuid not null references public.users(id) on delete restrict,
  started_at timestamptz not null default now(),
  ended_at timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  constraint learning_circle_staff_end_consistency check (
    (status = 'active' and ended_at is null)
    or (status = 'ended' and ended_at is not null)
  ),
  constraint learning_circle_lead_permissions check (
    staff_role <> 'lead'
    or (
      can_post_announcements and can_manage_meet_link and can_create_tasks
      and can_review_submissions and can_manage_discussions and can_track_students
    )
  )
);

create unique index if not exists learning_circle_one_active_lead_idx
  on public.learning_circle_staff (circle_id)
  where status = 'active' and staff_role = 'lead';

create unique index if not exists learning_circle_active_staff_idx
  on public.learning_circle_staff (circle_id, teacher_id)
  where status = 'active';

create table if not exists public.learning_circle_memberships (
  id uuid primary key default gen_random_uuid(),
  circle_id uuid not null references public.learning_circles(id) on delete cascade,
  student_id uuid not null references public.users(id) on delete restrict,
  circle_type text not null check (circle_type in ('quran', 'educational')),
  status text not null default 'active' check (status in ('active', 'transfer_pending', 'ended')),
  source text not null default 'manual' check (source in ('manual', 'legacy', 'transfer')),
  added_by uuid not null references public.users(id) on delete restrict,
  joined_at timestamptz not null default now(),
  ended_at timestamptz,
  ended_reason text check (ended_reason is null or char_length(ended_reason) <= 1000),
  legacy_halaqa_student_id uuid unique references public.halaqa_students(id) on delete restrict,
  legacy_classroom_student_id uuid unique references public.classroom_students(id) on delete restrict,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  constraint learning_circle_membership_single_legacy_source check (
    legacy_halaqa_student_id is null or legacy_classroom_student_id is null
  ),
  constraint learning_circle_membership_end_consistency check (
    (status = 'ended' and ended_at is not null)
    or (status <> 'ended' and ended_at is null)
  )
);

create table if not exists public.learning_circle_transfer_requests (
  id uuid primary key default gen_random_uuid(),
  student_id uuid not null references public.users(id) on delete restrict,
  from_circle_id uuid not null references public.learning_circles(id) on delete restrict,
  to_circle_id uuid not null references public.learning_circles(id) on delete restrict,
  requested_by uuid not null references public.users(id) on delete restrict,
  status text not null default 'pending' check (status in ('pending', 'approved', 'rejected', 'cancelled')),
  reason text check (reason is null or char_length(reason) <= 2000),
  admin_notes text check (admin_notes is null or char_length(admin_notes) <= 2000),
  decided_by uuid references public.users(id) on delete restrict,
  requested_at timestamptz not null default now(),
  decided_at timestamptz,
  constraint learning_circle_transfer_distinct check (from_circle_id <> to_circle_id),
  constraint learning_circle_transfer_decision_consistency check (
    (status = 'pending' and decided_by is null and decided_at is null)
    or (status <> 'pending' and decided_by is not null and decided_at is not null)
  )
);

create unique index if not exists learning_circle_one_pending_transfer_idx
  on public.learning_circle_transfer_requests (student_id)
  where status = 'pending';

create table if not exists public.learning_circle_settings (
  circle_id uuid primary key references public.learning_circles(id) on delete cascade,
  students_can_create_topics boolean not null default false,
  students_can_reply boolean not null default false,
  timezone text not null default 'Asia/Muscat' check (char_length(timezone) between 3 and 64),
  morning_due_time time not null default '18:00',
  morning_close_time time not null default '23:00',
  evening_due_time time not null default '23:00',
  evening_close_time time not null default '06:00',
  excuse_window_hours smallint not null default 72 check (excuse_window_hours between 1 and 720),
  updated_by uuid not null references public.users(id) on delete restrict,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create table if not exists public.platform_audit_events (
  id bigint generated always as identity primary key,
  actor_id uuid references public.users(id) on delete set null,
  circle_id uuid references public.learning_circles(id) on delete set null,
  action text not null check (char_length(action) between 3 and 120),
  entity_type text not null check (char_length(entity_type) between 2 and 80),
  entity_id text,
  before_data jsonb,
  after_data jsonb,
  metadata jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default now()
);

create index if not exists platform_audit_events_circle_created_idx
  on public.platform_audit_events (circle_id, created_at desc);
create index if not exists platform_audit_events_actor_created_idx
  on public.platform_audit_events (actor_id, created_at desc);

create or replace function public.sync_learning_circle_membership()
returns trigger
language plpgsql
set search_path = pg_catalog, public
as $$
declare
  resolved_circle_type text;
begin
  select circle_type into resolved_circle_type
  from public.learning_circles
  where id = new.circle_id;

  if resolved_circle_type is null then
    raise exception 'Learning circle not found';
  end if;

  new.circle_type := resolved_circle_type;
  new.updated_at := now();

  if new.status = 'ended' and new.ended_at is null then
    new.ended_at := now();
  elsif new.status <> 'ended' then
    new.ended_at := null;
    new.ended_reason := null;
  end if;

  return new;
end;
$$;

drop trigger if exists sync_learning_circle_membership on public.learning_circle_memberships;
create trigger sync_learning_circle_membership
  before insert or update on public.learning_circle_memberships
  for each row execute procedure public.sync_learning_circle_membership();

create or replace function public.touch_learning_circle_record()
returns trigger
language plpgsql
set search_path = pg_catalog, public
as $$
begin
  new.updated_at := now();
  return new;
end;
$$;

drop trigger if exists touch_learning_circles on public.learning_circles;
create trigger touch_learning_circles
  before update on public.learning_circles
  for each row execute procedure public.touch_learning_circle_record();

drop trigger if exists touch_learning_circle_staff on public.learning_circle_staff;
create trigger touch_learning_circle_staff
  before update on public.learning_circle_staff
  for each row execute procedure public.touch_learning_circle_record();

drop trigger if exists touch_learning_circle_settings on public.learning_circle_settings;
create trigger touch_learning_circle_settings
  before update on public.learning_circle_settings
  for each row execute procedure public.touch_learning_circle_record();

-- Backfill legacy Quran circles and educational classrooms using their UUIDs.
insert into public.learning_circles (
  id, circle_type, name, status, created_by, legacy_halaqa_id, created_at, updated_at
)
select h.id, 'quran', h.name, 'active', h.teacher_id, h.id, h.created_at, h.created_at
from public.halaqat h
on conflict (id) do nothing;

insert into public.learning_circles (
  id, circle_type, name, status, created_by, legacy_classroom_id, created_at, updated_at
)
select c.id, 'educational', c.name, 'active', c.teacher_id, c.id, c.created_at, c.created_at
from public.classrooms c
on conflict (id) do nothing;

insert into public.learning_circle_subjects (circle_id, subject_id, added_by, created_at)
select c.id, c.subject_id, c.teacher_id, c.created_at
from public.classrooms c
join public.learning_circles lc on lc.id = c.id
on conflict (circle_id, subject_id) do nothing;

insert into public.learning_circle_staff (
  circle_id, teacher_id, staff_role, status,
  can_post_announcements, can_manage_meet_link, can_create_tasks,
  can_review_submissions, can_manage_discussions, can_track_students,
  appointed_by, started_at, created_at, updated_at
)
select
  h.id, h.teacher_id, 'lead', 'active', true, true, true, true, true, true,
  h.teacher_id, h.created_at, h.created_at, h.created_at
from public.halaqat h
join public.learning_circles lc on lc.id = h.id
where not exists (
  select 1 from public.learning_circle_staff s
  where s.circle_id = h.id and s.teacher_id = h.teacher_id and s.status = 'active'
);

insert into public.learning_circle_staff (
  circle_id, teacher_id, staff_role, status,
  can_post_announcements, can_manage_meet_link, can_create_tasks,
  can_review_submissions, can_manage_discussions, can_track_students,
  appointed_by, started_at, created_at, updated_at
)
select
  c.id, c.teacher_id, 'lead', 'active', true, true, true, true, true, true,
  c.teacher_id, c.created_at, c.created_at, c.created_at
from public.classrooms c
join public.learning_circles lc on lc.id = c.id
where not exists (
  select 1 from public.learning_circle_staff s
  where s.circle_id = c.id and s.teacher_id = c.teacher_id and s.status = 'active'
);

insert into public.learning_circle_memberships (
  circle_id, student_id, circle_type, status, source, added_by, joined_at,
  legacy_halaqa_student_id, created_at, updated_at
)
select
  hs.halaqa_id, hs.student_id, 'quran', 'active', 'legacy', h.teacher_id,
  hs.created_at, hs.id, hs.created_at, hs.created_at
from public.halaqa_students hs
join public.halaqat h on h.id = hs.halaqa_id
join public.learning_circles lc on lc.id = hs.halaqa_id
where not exists (
  select 1 from public.learning_circle_memberships m
  where m.legacy_halaqa_student_id = hs.id
);

insert into public.learning_circle_memberships (
  circle_id, student_id, circle_type, status, source, added_by, joined_at,
  legacy_classroom_student_id, created_at, updated_at
)
select
  cs.classroom_id, cs.student_id, 'educational', 'active', 'legacy', c.teacher_id,
  c.created_at, cs.id, c.created_at, c.created_at
from public.classroom_students cs
join public.classrooms c on c.id = cs.classroom_id
join public.learning_circles lc on lc.id = cs.classroom_id
where not exists (
  select 1 from public.learning_circle_memberships m
  where m.legacy_classroom_student_id = cs.id
);

do $$
begin
  if exists (
    select student_id
    from public.learning_circle_memberships
    where circle_type = 'quran' and status = 'active'
    group by student_id
    having count(*) > 1
  ) then
    raise exception 'Existing data contains students in multiple active Quran circles';
  end if;
end;
$$;

create unique index if not exists learning_circle_active_member_idx
  on public.learning_circle_memberships (circle_id, student_id)
  where status in ('active', 'transfer_pending');

create unique index if not exists learning_circle_one_active_quran_student_idx
  on public.learning_circle_memberships (student_id)
  where circle_type = 'quran' and status = 'active';

insert into public.learning_circle_settings (
  circle_id, students_can_create_topics, students_can_reply, updated_by, created_at, updated_at
)
select
  lc.id,
  lc.circle_type = 'educational',
  lc.circle_type = 'educational',
  lc.created_by,
  lc.created_at,
  lc.created_at
from public.learning_circles lc
on conflict (circle_id) do nothing;

alter table public.learning_circles enable row level security;
alter table public.learning_circle_subjects enable row level security;
alter table public.learning_circle_staff enable row level security;
alter table public.learning_circle_memberships enable row level security;
alter table public.learning_circle_transfer_requests enable row level security;
alter table public.learning_circle_settings enable row level security;
alter table public.platform_audit_events enable row level security;

revoke all on public.learning_circles from anon;
revoke all on public.learning_circle_subjects from anon;
revoke all on public.learning_circle_staff from anon;
revoke all on public.learning_circle_memberships from anon;
revoke all on public.learning_circle_transfer_requests from anon;
revoke all on public.learning_circle_settings from anon;
revoke all on public.platform_audit_events from anon;
