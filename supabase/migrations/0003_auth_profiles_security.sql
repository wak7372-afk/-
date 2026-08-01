-- ========================================================
-- Secure self-registration and profile lifecycle
-- ========================================================

alter table public.users
  add column if not exists updated_at timestamptz not null default now();

alter table public.users
  add column if not exists family_link_code text;

update public.users
set family_link_code = upper(substr(md5(gen_random_uuid()::text || clock_timestamp()::text), 1, 10))
where role = 'student' and family_link_code is null;

create unique index if not exists users_family_link_code_uidx
  on public.users (family_link_code)
  where family_link_code is not null;

-- Keep privilege checks active-only and avoid search_path ambiguity.
create or replace function public.is_admin()
returns boolean
language sql
stable
security definer
set search_path = public
as $$
  select exists (
    select 1
    from public.users
    where id = auth.uid()
      and role = 'admin'
      and is_active = true
  );
$$;

-- Create a pending profile for every new Auth user. Self-registration is limited
-- to student/parent; teacher/admin accounts remain an administrator action.
create or replace function public.handle_new_auth_user()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
declare
  requested_role public.user_role;
  metadata_role text;
begin
  metadata_role := coalesce(new.raw_user_meta_data ->> 'requested_role', 'student');
  requested_role := case
    when metadata_role = 'parent' then 'parent'::public.user_role
    else 'student'::public.user_role
  end;

  insert into public.users (
    id,
    full_name,
    email,
    phone,
    role,
    is_active,
    family_link_code,
    updated_at
  ) values (
    new.id,
    coalesce(nullif(trim(new.raw_user_meta_data ->> 'full_name'), ''), split_part(new.email, '@', 1)),
    lower(new.email),
    nullif(trim(new.raw_user_meta_data ->> 'phone'), ''),
    requested_role,
    false,
    case when requested_role = 'student' then upper(substr(md5(gen_random_uuid()::text || clock_timestamp()::text), 1, 10)) else null end,
    now()
  )
  on conflict (id) do nothing;

  return new;
end;
$$;

drop trigger if exists on_auth_user_created on auth.users;
create trigger on_auth_user_created
  after insert on auth.users
  for each row execute procedure public.handle_new_auth_user();

-- Users may edit public profile fields, but only an active administrator can
-- change roles, activation state, or the identity email.
create or replace function public.protect_user_privileged_fields()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
begin
  if auth.uid() = old.id and not public.is_admin() then
    new.role := old.role;
    new.is_active := old.is_active;
    new.email := old.email;
  end if;

  new.updated_at := now();
  return new;
end;
$$;

drop trigger if exists protect_user_privileged_fields on public.users;
create trigger protect_user_privileged_fields
  before update on public.users
  for each row execute procedure public.protect_user_privileged_fields();

-- Role helper is security-definer to avoid recursive user-table policies.
create or replace function public.current_user_role()
returns public.user_role
language sql
stable
security definer
set search_path = public
as $$
  select role from public.users where id = auth.uid() and is_active = true;
$$;

-- Replace broad profile select/insert/update policies with explicit checks.
drop policy if exists "Users can view their own record or admins view all" on public.users;
create policy "Users view only authorized profiles"
  on public.users for select
  using (
    id = auth.uid()
    or public.is_admin()
    or (
      public.current_user_role() = 'teacher'
      and role in ('student', 'teacher')
      and is_active = true
    )
    or (
      public.current_user_role() = 'parent'
      and exists (
        select 1 from public.parent_student ps
        where ps.parent_id = auth.uid() and ps.student_id = users.id
      )
    )
  );

drop policy if exists "Users insert own profile during registration" on public.users;
create policy "Users insert safe own pending profile"
  on public.users for insert
  with check (
    public.is_admin()
    or (
      id = auth.uid()
      and role in ('student', 'parent')
      and is_active = false
      and lower(email) = lower(coalesce(auth.jwt() ->> 'email', ''))
    )
  );

drop policy if exists "Users update own profile or admins update any" on public.users;
create policy "Users edit own profile or admins edit any"
  on public.users for update
  using (id = auth.uid() or public.is_admin())
  with check (id = auth.uid() or public.is_admin());

-- Prevent unauthenticated access even if a future policy is accidentally broad.
revoke all on public.users from anon;
grant select, insert, update on public.users to authenticated;

-- Parents may read academic records only for explicitly linked children.
create policy "Parents view linked daily assignments"
  on public.daily_assignments for select
  using (
    student_id is not null
    and exists (
      select 1 from public.parent_student ps
      where ps.parent_id = auth.uid() and ps.student_id = daily_assignments.student_id
    )
  );

create policy "Parents view linked Quran submissions"
  on public.assignment_submissions for select
  using (
    exists (
      select 1 from public.parent_student ps
      where ps.parent_id = auth.uid() and ps.student_id = assignment_submissions.student_id
    )
  );

create policy "Parents view linked quiz submissions"
  on public.quiz_submissions for select
  using (
    exists (
      select 1 from public.parent_student ps
      where ps.parent_id = auth.uid() and ps.student_id = quiz_submissions.student_id
    )
  );

create policy "Parents view linked quizzes"
  on public.quizzes for select
  using (
    exists (
      select 1
      from public.classroom_students cs
      join public.parent_student ps on ps.student_id = cs.student_id
      where ps.parent_id = auth.uid() and cs.classroom_id = quizzes.classroom_id
    )
  );

create policy "Parents view linked extra submissions"
  on public.assignment_extra_submissions for select
  using (
    exists (
      select 1 from public.parent_student ps
      where ps.parent_id = auth.uid() and ps.student_id = assignment_extra_submissions.student_id
    )
  );

-- Parents link a child only with the private code shown in the student's dashboard.
create or replace function public.link_child_by_code(p_code text)
returns uuid
language plpgsql
security definer
set search_path = public
as $$
declare
  child_id uuid;
begin
  if public.current_user_role() <> 'parent' then
    raise exception 'Only an active parent account can link a child';
  end if;

  select id into child_id
  from public.users
  where role = 'student'
    and is_active = true
    and family_link_code = upper(trim(p_code))
  limit 1;

  if child_id is null then
    raise exception 'Invalid child link code';
  end if;

  insert into public.parent_student (parent_id, student_id)
  values (auth.uid(), child_id)
  on conflict (parent_id, student_id) do nothing;

  return child_id;
end;
$$;

revoke all on function public.link_child_by_code(text) from public;
grant execute on function public.link_child_by_code(text) to authenticated;

drop policy if exists "Parents and Admins manage links" on public.parent_student;
create policy "Families view their own links"
  on public.parent_student for select
  using (parent_id = auth.uid() or student_id = auth.uid() or public.is_admin());
create policy "Parents remove own links"
  on public.parent_student for delete
  using (parent_id = auth.uid() or public.is_admin());
create policy "Admins manage family links"
  on public.parent_student for insert
  with check (public.is_admin());
create policy "Admins update family links"
  on public.parent_student for update
  using (public.is_admin())
  with check (public.is_admin());

-- Support the attendance upsert used by the teacher interface.
create unique index if not exists attendance_session_student_date_uidx
  on public.attendance (session_type, session_ref_id, student_id, attendance_date);

-- Assignment attachments bucket and least-privilege storage policies.
insert into storage.buckets (id, name, public, file_size_limit, allowed_mime_types)
values (
  'assignment-files',
  'assignment-files',
  false,
  10485760,
  array[
    'application/pdf',
    'application/msword',
    'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
    'image/jpeg',
    'image/png',
    'text/plain'
  ]
)
on conflict (id) do update set
  public = excluded.public,
  file_size_limit = excluded.file_size_limit,
  allowed_mime_types = excluded.allowed_mime_types;

drop policy if exists "Students upload own assignment files" on storage.objects;
create policy "Students upload own assignment files"
  on storage.objects for insert to authenticated
  with check (
    bucket_id = 'assignment-files'
    and (storage.foldername(name))[1] = auth.uid()::text
  );

drop policy if exists "Owners and assigned teachers read assignment files" on storage.objects;
create policy "Owners and assigned teachers read assignment files"
  on storage.objects for select to authenticated
  using (
    bucket_id = 'assignment-files'
    and (
      (storage.foldername(name))[1] = auth.uid()::text
      or public.is_admin()
      or exists (
        select 1
        from public.assignment_extra_submissions aes
        join public.assignments_extra ae on ae.id = aes.assignment_extra_id
        join public.classrooms c on c.id = ae.classroom_id
        where aes.student_id::text = (storage.foldername(storage.objects.name))[1]
          and c.teacher_id = auth.uid()
      )
    )
  );

drop policy if exists "Students update own assignment files" on storage.objects;
create policy "Students update own assignment files"
  on storage.objects for update to authenticated
  using (
    bucket_id = 'assignment-files'
    and (storage.foldername(name))[1] = auth.uid()::text
  )
  with check (
    bucket_id = 'assignment-files'
    and (storage.foldername(name))[1] = auth.uid()::text
  );

drop policy if exists "Students delete own assignment files" on storage.objects;
create policy "Students delete own assignment files"
  on storage.objects for delete to authenticated
  using (
    bucket_id = 'assignment-files'
    and (storage.foldername(name))[1] = auth.uid()::text
  );
