-- ========================================================
-- مخطط قاعدة البيانات لنظام "ذات خيل" لإدارة مركز القرآن الكريم
-- ========================================================

-- ==== 1. ENUM TYPES ====
create type user_role as enum ('admin', 'teacher', 'student', 'parent');
create type assignment_type as enum ('hifz', 'murajaa');
create type submission_status as enum ('pending', 'done');
create type extra_assignment_type as enum ('text', 'file');
create type attendance_status as enum ('present', 'absent', 'excused');
create type session_type as enum ('halaqa', 'classroom');

-- ==== 2. USERS TABLE ====
create table public.users (
  id uuid primary key references auth.users(id) on delete cascade,
  full_name text not null,
  email text unique not null,
  phone text,
  role user_role not null,
  is_active boolean not null default false,
  avatar_url text,
  created_at timestamptz not null default now()
);

-- ==== 3. PARENT - STUDENT LINK ====
create table public.parent_student (
  id uuid primary key default gen_random_uuid(),
  parent_id uuid not null references public.users(id) on delete cascade,
  student_id uuid not null references public.users(id) on delete cascade,
  created_at timestamptz not null default now(),
  unique(parent_id, student_id)
);

-- ==== 4. HALAQAT (حلقات القرآن) ====
create table public.halaqat (
  id uuid primary key default gen_random_uuid(),
  name text not null,
  teacher_id uuid not null references public.users(id) on delete cascade,
  created_at timestamptz not null default now()
);

create table public.halaqa_students (
  id uuid primary key default gen_random_uuid(),
  halaqa_id uuid not null references public.halaqat(id) on delete cascade,
  student_id uuid not null references public.users(id) on delete cascade,
  created_at timestamptz not null default now(),
  unique(halaqa_id, student_id)
);

-- ==== 5. DAILY ASSIGNMENTS (المقررات اليومية) ====
create table public.daily_assignments (
  id uuid primary key default gen_random_uuid(),
  halaqa_id uuid references public.halaqat(id) on delete cascade,
  student_id uuid references public.users(id) on delete cascade,
  teacher_id uuid not null references public.users(id) on delete cascade,
  type assignment_type not null,
  content text not null,
  assignment_date date not null,
  created_at timestamptz not null default now()
);

create table public.assignment_submissions (
  id uuid primary key default gen_random_uuid(),
  assignment_id uuid not null references public.daily_assignments(id) on delete cascade,
  student_id uuid not null references public.users(id) on delete cascade,
  status submission_status not null default 'pending',
  teacher_notes text,
  submitted_at timestamptz,
  created_at timestamptz not null default now(),
  unique(assignment_id, student_id)
);

-- ==== 6. SUBJECTS & CLASSROOMS (المواد والفصول الافتراضية) ====
create table public.subjects (
  id uuid primary key default gen_random_uuid(),
  name text not null unique
);

create table public.classrooms (
  id uuid primary key default gen_random_uuid(),
  subject_id uuid not null references public.subjects(id),
  teacher_id uuid not null references public.users(id) on delete cascade,
  name text not null,
  created_at timestamptz not null default now()
);

create table public.classroom_students (
  id uuid primary key default gen_random_uuid(),
  classroom_id uuid not null references public.classrooms(id) on delete cascade,
  student_id uuid not null references public.users(id) on delete cascade,
  unique(classroom_id, student_id)
);

create table public.lessons (
  id uuid primary key default gen_random_uuid(),
  classroom_id uuid not null references public.classrooms(id) on delete cascade,
  title text not null,
  content text,
  meet_link text,
  scheduled_at timestamptz,
  created_at timestamptz not null default now()
);

-- ==== 7. EXTRA ASSIGNMENTS & QUIZZES ====
create table public.assignments_extra (
  id uuid primary key default gen_random_uuid(),
  classroom_id uuid not null references public.classrooms(id) on delete cascade,
  lesson_id uuid references public.lessons(id) on delete set null,
  title text not null,
  description text,
  type extra_assignment_type not null,
  due_date timestamptz,
  created_at timestamptz not null default now()
);

create table public.assignment_extra_submissions (
  id uuid primary key default gen_random_uuid(),
  assignment_extra_id uuid not null references public.assignments_extra(id) on delete cascade,
  student_id uuid not null references public.users(id) on delete cascade,
  content text,
  file_url text,
  grade numeric,
  teacher_feedback text,
  submitted_at timestamptz,
  graded_at timestamptz,
  unique(assignment_extra_id, student_id)
);

create table public.quizzes (
  id uuid primary key default gen_random_uuid(),
  classroom_id uuid not null references public.classrooms(id) on delete cascade,
  lesson_id uuid references public.lessons(id) on delete set null,
  title text not null,
  created_at timestamptz not null default now()
);

create table public.quiz_questions (
  id uuid primary key default gen_random_uuid(),
  quiz_id uuid not null references public.quizzes(id) on delete cascade,
  question_text text not null,
  order_index int not null default 0
);

create table public.quiz_options (
  id uuid primary key default gen_random_uuid(),
  question_id uuid not null references public.quiz_questions(id) on delete cascade,
  option_text text not null,
  is_correct boolean not null default false
);

create table public.quiz_submissions (
  id uuid primary key default gen_random_uuid(),
  quiz_id uuid not null references public.quizzes(id) on delete cascade,
  student_id uuid not null references public.users(id) on delete cascade,
  score numeric,
  submitted_at timestamptz not null default now(),
  unique(quiz_id, student_id)
);

create table public.quiz_answers (
  id uuid primary key default gen_random_uuid(),
  quiz_submission_id uuid not null references public.quiz_submissions(id) on delete cascade,
  question_id uuid not null references public.quiz_questions(id) on delete cascade,
  selected_option_id uuid references public.quiz_options(id)
);

-- ==== 8. ATTENDANCE (الحضور والغياب) ====
create table public.attendance (
  id uuid primary key default gen_random_uuid(),
  session_type session_type not null,
  session_ref_id uuid not null,
  student_id uuid not null references public.users(id) on delete cascade,
  status attendance_status not null,
  attendance_date date not null,
  recorded_by uuid not null references public.users(id),
  created_at timestamptz not null default now(),
  unique(session_type, session_ref_id, student_id, attendance_date)
);

-- ==== 9. MESSAGES & NOTIFICATIONS ====
create table public.messages (
  id uuid primary key default gen_random_uuid(),
  sender_id uuid not null references public.users(id) on delete cascade,
  receiver_id uuid not null references public.users(id) on delete cascade,
  content text not null,
  is_read boolean not null default false,
  created_at timestamptz not null default now()
);

create table public.notifications (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references public.users(id) on delete cascade,
  title text not null,
  body text,
  type text,
  is_read boolean not null default false,
  created_at timestamptz not null default now()
);

-- ==== 10. AI REPORTS ====
create table public.ai_reports (
  id uuid primary key default gen_random_uuid(),
  teacher_id uuid not null references public.users(id) on delete cascade,
  halaqa_id uuid references public.halaqat(id) on delete set null,
  report_text text not null,
  raw_data jsonb,
  created_at timestamptz not null default now()
);

-- ==== SEED INITIAL SUBJECTS ====
insert into public.subjects (name) values ('فقه'), ('عقيدة'), ('سيرة')
on conflict (name) do nothing;

-- ========================================================
-- ROW LEVEL SECURITY (RLS) POLICIES
-- ========================================================

alter table public.users enable row level security;
alter table public.parent_student enable row level security;
alter table public.halaqat enable row level security;
alter table public.halaqa_students enable row level security;
alter table public.daily_assignments enable row level security;
alter table public.assignment_submissions enable row level security;
alter table public.subjects enable row level security;
alter table public.classrooms enable row level security;
alter table public.classroom_students enable row level security;
alter table public.lessons enable row level security;
alter table public.assignments_extra enable row level security;
alter table public.assignment_extra_submissions enable row level security;
alter table public.quizzes enable row level security;
alter table public.quiz_questions enable row level security;
alter table public.quiz_options enable row level security;
alter table public.quiz_submissions enable row level security;
alter table public.quiz_answers enable row level security;
alter table public.attendance enable row level security;
alter table public.messages enable row level security;
alter table public.notifications enable row level security;
alter table public.ai_reports enable row level security;

-- Admin Helper Function
create or replace function public.is_admin()
returns boolean as $$
  select exists (
    select 1 from public.users
    where id = auth.uid() and role = 'admin'
  );
$$ language sql security definer;

-- USERS POLICIES
create policy "Users can view their own record or admins view all"
  on public.users for select
  using (id = auth.uid() or public.is_admin() or exists(
    select 1 from public.users u where u.id = auth.uid() and u.role in ('teacher', 'parent')
  ));

create policy "Users update own profile or admins update any"
  on public.users for update
  using (id = auth.uid() or public.is_admin());

create policy "Users insert own profile during registration"
  on public.users for insert
  with check (id = auth.uid() or public.is_admin());

-- HALAQAT POLICIES
create policy "Teachers manage own halaqat or admins read"
  on public.halaqat for all
  using (teacher_id = auth.uid() or public.is_admin());

create policy "Students view joined halaqat"
  on public.halaqat for select
  using (exists (
    select 1 from public.halaqa_students hs
    where hs.halaqa_id = id and hs.student_id = auth.uid()
  ));

-- HALAQA STUDENTS POLICIES
create policy "Teachers manage students in own halaqat"
  on public.halaqa_students for all
  using (exists (
    select 1 from public.halaqat h
    where h.id = halaqa_id and h.teacher_id = auth.uid()
  ) or public.is_admin() or student_id = auth.uid());

-- DAILY ASSIGNMENTS POLICIES
create policy "Teachers create/manage daily assignments"
  on public.daily_assignments for all
  using (teacher_id = auth.uid() or public.is_admin());

create policy "Students view their assigned daily assignments"
  on public.daily_assignments for select
  using (
    student_id = auth.uid() or
    exists (
      select 1 from public.halaqa_students hs
      where hs.halaqa_id = daily_assignments.halaqa_id and hs.student_id = auth.uid()
    )
  );

-- ASSIGNMENT SUBMISSIONS POLICIES
create policy "Students manage own submissions"
  on public.assignment_submissions for all
  using (student_id = auth.uid() or public.is_admin());

create policy "Teachers manage submissions for assigned students"
  on public.assignment_submissions for select
  using (exists (
    select 1 from public.daily_assignments da
    where da.id = assignment_id and da.teacher_id = auth.uid()
  ));

create policy "Teachers update submissions notes"
  on public.assignment_submissions for update
  using (exists (
    select 1 from public.daily_assignments da
    where da.id = assignment_id and da.teacher_id = auth.uid()
  ));

-- SUBJECTS & CLASSROOMS POLICIES
create policy "Everyone can view subjects"
  on public.subjects for select using (true);

create policy "Teachers manage own classrooms"
  on public.classrooms for all
  using (teacher_id = auth.uid() or public.is_admin());

create policy "Students view joined classrooms"
  on public.classrooms for select
  using (exists (
    select 1 from public.classroom_students cs
    where cs.classroom_id = id and cs.student_id = auth.uid()
  ));

create policy "Teachers manage classroom students"
  on public.classroom_students for all
  using (exists (
    select 1 from public.classrooms c
    where c.id = classroom_id and c.teacher_id = auth.uid()
  ) or public.is_admin() or student_id = auth.uid());

create policy "Teachers manage lessons"
  on public.lessons for all
  using (exists (
    select 1 from public.classrooms c
    where c.id = classroom_id and c.teacher_id = auth.uid()
  ) or public.is_admin());

create policy "Students view classroom lessons"
  on public.lessons for select
  using (exists (
    select 1 from public.classroom_students cs
    where cs.classroom_id = lessons.classroom_id and cs.student_id = auth.uid()
  ));

-- EXTRA ASSIGNMENTS & QUIZZES POLICIES
create policy "Teachers manage extra assignments"
  on public.assignments_extra for all
  using (exists (
    select 1 from public.classrooms c
    where c.id = classroom_id and c.teacher_id = auth.uid()
  ) or public.is_admin());

create policy "Students view extra assignments"
  on public.assignments_extra for select
  using (exists (
    select 1 from public.classroom_students cs
    where cs.classroom_id = assignments_extra.classroom_id and cs.student_id = auth.uid()
  ));

create policy "Students manage extra submissions"
  on public.assignment_extra_submissions for all
  using (student_id = auth.uid() or public.is_admin());

create policy "Teachers view and grade extra submissions"
  on public.assignment_extra_submissions for all
  using (exists (
    select 1 from public.assignments_extra ae
    join public.classrooms c on c.id = ae.classroom_id
    where ae.id = assignment_extra_id and c.teacher_id = auth.uid()
  ));

create policy "Teachers manage quizzes"
  on public.quizzes for all
  using (exists (
    select 1 from public.classrooms c
    where c.id = classroom_id and c.teacher_id = auth.uid()
  ) or public.is_admin());

create policy "Students view quizzes"
  on public.quizzes for select
  using (exists (
    select 1 from public.classroom_students cs
    where cs.classroom_id = quizzes.classroom_id and cs.student_id = auth.uid()
  ));

create policy "Teachers manage quiz questions and options"
  on public.quiz_questions for all using (true);
create policy "Teachers manage options"
  on public.quiz_options for all using (true);

create policy "Students manage quiz submissions"
  on public.quiz_submissions for all
  using (student_id = auth.uid() or public.is_admin());

create policy "Students submit quiz answers"
  on public.quiz_answers for all using (true);

-- ATTENDANCE POLICIES
create policy "Teachers manage attendance"
  on public.attendance for all
  using (recorded_by = auth.uid() or public.is_admin());

create policy "Students and Parents view attendance"
  on public.attendance for select
  using (student_id = auth.uid() or exists (
    select 1 from public.parent_student ps
    where ps.parent_id = auth.uid() and ps.student_id = attendance.student_id
  ));

-- MESSAGES POLICIES
create policy "Users read write their messages"
  on public.messages for all
  using (sender_id = auth.uid() or receiver_id = auth.uid() or public.is_admin());

-- NOTIFICATIONS POLICIES
create policy "Users manage their notifications"
  on public.notifications for all
  using (user_id = auth.uid() or public.is_admin());

-- AI REPORTS POLICIES
create policy "Teachers manage AI reports"
  on public.ai_reports for all
  using (teacher_id = auth.uid() or public.is_admin());

-- PARENT STUDENT POLICIES
create policy "Parents and Admins manage links"
  on public.parent_student for all
  using (parent_id = auth.uid() or student_id = auth.uid() or public.is_admin());

-- Realtime publication setup
alter publication supabase_realtime add table public.messages;
alter publication supabase_realtime add table public.notifications;
