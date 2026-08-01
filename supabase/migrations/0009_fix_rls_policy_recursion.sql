-- Break cross-table RLS dependency cycles while preserving relationship checks.

create or replace function public.is_admin()
returns boolean
language sql
stable
security definer
set search_path = pg_catalog, public
set row_security = off
as $$
  select exists (
    select 1
    from public.users
    where id = auth.uid()
      and role = 'admin'
      and is_active = true
  );
$$;

create or replace function public.current_user_role()
returns public.user_role
language sql
stable
security definer
set search_path = pg_catalog, public
set row_security = off
as $$
  select role
  from public.users
  where id = auth.uid() and is_active = true;
$$;

create or replace function public.can_view_user_profile(p_target_id uuid)
returns boolean
language sql
stable
security definer
set search_path = pg_catalog, public
set row_security = off
as $$
  select
    p_target_id = auth.uid()
    or exists (
      select 1
      from public.users actor
      join public.users target on target.id = p_target_id
      where actor.id = auth.uid()
        and actor.is_active = true
        and (
          actor.role = 'admin'
          or (
            actor.role = 'teacher'
            and target.role = 'student'
            and target.is_active = true
            and (
              exists (
                select 1
                from public.halaqa_students hs
                join public.halaqat h on h.id = hs.halaqa_id
                where h.teacher_id = actor.id and hs.student_id = target.id
              )
              or exists (
                select 1
                from public.classroom_students cs
                join public.classrooms c on c.id = cs.classroom_id
                where c.teacher_id = actor.id and cs.student_id = target.id
              )
            )
          )
          or (
            actor.role = 'student'
            and target.role = 'teacher'
            and target.is_active = true
            and (
              exists (
                select 1
                from public.halaqa_students hs
                join public.halaqat h on h.id = hs.halaqa_id
                where hs.student_id = actor.id and h.teacher_id = target.id
              )
              or exists (
                select 1
                from public.classroom_students cs
                join public.classrooms c on c.id = cs.classroom_id
                where cs.student_id = actor.id and c.teacher_id = target.id
              )
            )
          )
          or (
            actor.role = 'parent'
            and target.role = 'student'
            and exists (
              select 1
              from public.parent_student ps
              where ps.parent_id = actor.id and ps.student_id = target.id
            )
          )
        )
    );
$$;

create or replace function public.teacher_owns_halaqa(p_halaqa_id uuid)
returns boolean
language sql
stable
security definer
set search_path = pg_catalog, public
set row_security = off
as $$
  select public.is_admin() or exists (
    select 1 from public.halaqat
    where id = p_halaqa_id and teacher_id = auth.uid()
  );
$$;

create or replace function public.is_halaqa_student(p_halaqa_id uuid, p_student_id uuid)
returns boolean
language sql
stable
security definer
set search_path = pg_catalog, public
set row_security = off
as $$
  select exists (
    select 1 from public.halaqa_students
    where halaqa_id = p_halaqa_id and student_id = p_student_id
  );
$$;

create or replace function public.teacher_owns_classroom(p_classroom_id uuid)
returns boolean
language sql
stable
security definer
set search_path = pg_catalog, public
set row_security = off
as $$
  select public.is_admin() or exists (
    select 1 from public.classrooms
    where id = p_classroom_id and teacher_id = auth.uid()
  );
$$;

create or replace function public.is_classroom_student(p_classroom_id uuid, p_student_id uuid)
returns boolean
language sql
stable
security definer
set search_path = pg_catalog, public
set row_security = off
as $$
  select exists (
    select 1 from public.classroom_students
    where classroom_id = p_classroom_id and student_id = p_student_id
  );
$$;

revoke all on function public.can_view_user_profile(uuid) from public;
revoke all on function public.teacher_owns_halaqa(uuid) from public;
revoke all on function public.is_halaqa_student(uuid, uuid) from public;
revoke all on function public.teacher_owns_classroom(uuid) from public;
revoke all on function public.is_classroom_student(uuid, uuid) from public;
grant execute on function public.can_view_user_profile(uuid) to authenticated;
grant execute on function public.teacher_owns_halaqa(uuid) to authenticated;
grant execute on function public.is_halaqa_student(uuid, uuid) to authenticated;
grant execute on function public.teacher_owns_classroom(uuid) to authenticated;
grant execute on function public.is_classroom_student(uuid, uuid) to authenticated;

drop policy if exists "Users view relationship profiles" on public.users;
create policy "Users view relationship profiles"
  on public.users for select
  using (public.can_view_user_profile(id));

drop policy if exists "Teachers manage own halaqat or admins read" on public.halaqat;
drop policy if exists "Students view joined halaqat" on public.halaqat;
create policy "Teachers and admins manage halaqat"
  on public.halaqat for all
  using (teacher_id = auth.uid() or public.is_admin())
  with check (teacher_id = auth.uid() or public.is_admin());
create policy "Students view joined halaqat"
  on public.halaqat for select
  using (public.is_halaqa_student(id, auth.uid()));

drop policy if exists "Teachers manage students in own halaqat" on public.halaqa_students;
drop policy if exists "Teachers and admins manage halaqa students" on public.halaqa_students;
drop policy if exists "Students view own halaqa enrollment" on public.halaqa_students;
create policy "Teachers and admins manage halaqa students"
  on public.halaqa_students for all
  using (public.teacher_owns_halaqa(halaqa_id))
  with check (public.teacher_owns_halaqa(halaqa_id));
create policy "Students view own halaqa enrollment"
  on public.halaqa_students for select
  using (student_id = auth.uid());

drop policy if exists "Teachers manage own classrooms" on public.classrooms;
drop policy if exists "Students view joined classrooms" on public.classrooms;
create policy "Teachers and admins manage classrooms"
  on public.classrooms for all
  using (teacher_id = auth.uid() or public.is_admin())
  with check (teacher_id = auth.uid() or public.is_admin());
create policy "Students view joined classrooms"
  on public.classrooms for select
  using (public.is_classroom_student(id, auth.uid()));

drop policy if exists "Teachers manage classroom students" on public.classroom_students;
drop policy if exists "Teachers and admins manage classroom students" on public.classroom_students;
drop policy if exists "Students view own classroom enrollment" on public.classroom_students;
create policy "Teachers and admins manage classroom students"
  on public.classroom_students for all
  using (public.teacher_owns_classroom(classroom_id))
  with check (public.teacher_owns_classroom(classroom_id));
create policy "Students view own classroom enrollment"
  on public.classroom_students for select
  using (student_id = auth.uid());
