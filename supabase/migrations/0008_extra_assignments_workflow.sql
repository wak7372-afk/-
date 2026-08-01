-- Complete and harden the classroom assignment workflow.

alter table public.assignments_extra
  add constraint assignments_extra_title_length
  check (char_length(title) between 1 and 200) not valid;

alter table public.assignments_extra
  add constraint assignments_extra_description_length
  check (description is null or char_length(description) <= 5000) not valid;

alter table public.assignment_extra_submissions
  add constraint extra_submission_content_length
  check (content is null or char_length(content) <= 10000) not valid;

alter table public.assignment_extra_submissions
  add constraint extra_submission_file_url_length
  check (file_url is null or char_length(file_url) <= 1000) not valid;

alter table public.assignment_extra_submissions
  add constraint extra_submission_grade_range
  check (grade is null or (grade >= 0 and grade <= 100)) not valid;

create or replace function public.protect_extra_submission_grading()
returns trigger
language plpgsql
set search_path = public
as $$
begin
  if public.current_user_role() = 'student' then
    if tg_op = 'INSERT' then
      if new.student_id <> auth.uid() then
        raise exception 'Students may submit only for their own account' using errcode = '42501';
      end if;
      new.grade := null;
      new.teacher_feedback := null;
      new.graded_at := null;
      new.submitted_at := now();
    else
      if old.graded_at is not null then
        raise exception 'A graded submission cannot be changed' using errcode = '42501';
      end if;
      new.assignment_extra_id := old.assignment_extra_id;
      new.student_id := old.student_id;
      new.grade := old.grade;
      new.teacher_feedback := old.teacher_feedback;
      new.graded_at := old.graded_at;
      new.submitted_at := now();
    end if;
  end if;
  return new;
end;
$$;

drop policy if exists "Students view own extra submissions" on public.assignment_extra_submissions;
drop policy if exists "Students create own extra submissions" on public.assignment_extra_submissions;
drop policy if exists "Students update own extra submissions" on public.assignment_extra_submissions;

create policy "Students view enrolled extra submissions"
  on public.assignment_extra_submissions for select
  using (
    student_id = auth.uid()
    and exists (
      select 1
      from public.assignments_extra ae
      join public.classroom_students cs on cs.classroom_id = ae.classroom_id
      where ae.id = assignment_extra_id and cs.student_id = auth.uid()
    )
  );

create policy "Students create enrolled extra submissions"
  on public.assignment_extra_submissions for insert
  with check (
    student_id = auth.uid()
    and exists (
      select 1
      from public.assignments_extra ae
      join public.classroom_students cs on cs.classroom_id = ae.classroom_id
      where ae.id = assignment_extra_id and cs.student_id = auth.uid()
    )
  );

create policy "Students update ungraded enrolled submissions"
  on public.assignment_extra_submissions for update
  using (
    student_id = auth.uid()
    and graded_at is null
    and exists (
      select 1
      from public.assignments_extra ae
      join public.classroom_students cs on cs.classroom_id = ae.classroom_id
      where ae.id = assignment_extra_id and cs.student_id = auth.uid()
    )
  )
  with check (student_id = auth.uid());

insert into storage.buckets (id, name, public, file_size_limit, allowed_mime_types)
values (
  'assignment-submissions',
  'assignment-submissions',
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
on conflict (id) do update
set public = excluded.public,
    file_size_limit = excluded.file_size_limit,
    allowed_mime_types = excluded.allowed_mime_types;

drop policy if exists "Students upload own assignment files" on storage.objects;
create policy "Students upload own assignment files"
  on storage.objects for insert to authenticated
  with check (
    bucket_id = 'assignment-submissions'
    and (storage.foldername(name))[1] = auth.uid()::text
    and exists (
      select 1
      from public.assignments_extra ae
      join public.classroom_students cs on cs.classroom_id = ae.classroom_id
      where ae.id::text = (storage.foldername(name))[2]
        and cs.student_id = auth.uid()
    )
    and not exists (
      select 1
      from public.assignment_extra_submissions aes
      where aes.assignment_extra_id::text = (storage.foldername(name))[2]
        and aes.student_id = auth.uid()
        and aes.graded_at is not null
    )
  );

drop policy if exists "Participants read assignment files" on storage.objects;
create policy "Participants read assignment files"
  on storage.objects for select to authenticated
  using (
    bucket_id = 'assignment-submissions'
    and (
      (storage.foldername(name))[1] = auth.uid()::text
      or public.is_admin()
      or exists (
        select 1
        from public.assignments_extra ae
        join public.classrooms c on c.id = ae.classroom_id
        where ae.id::text = (storage.foldername(name))[2]
          and c.teacher_id = auth.uid()
      )
    )
  );

drop policy if exists "Students replace own assignment files" on storage.objects;
create policy "Students replace own assignment files"
  on storage.objects for update to authenticated
  using (
    bucket_id = 'assignment-submissions'
    and (storage.foldername(name))[1] = auth.uid()::text
    and not exists (
      select 1 from public.assignment_extra_submissions aes
      where aes.student_id = auth.uid() and aes.file_url = name
    )
  )
  with check (
    bucket_id = 'assignment-submissions'
    and (storage.foldername(name))[1] = auth.uid()::text
  );

drop policy if exists "Students remove own assignment files" on storage.objects;
create policy "Students remove own assignment files"
  on storage.objects for delete to authenticated
  using (
    bucket_id = 'assignment-submissions'
    and (storage.foldername(name))[1] = auth.uid()::text
    and not exists (
      select 1 from public.assignment_extra_submissions aes
      where aes.student_id = auth.uid() and aes.file_url = name
    )
  );

create or replace function public.notify_new_extra_assignment()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
begin
  insert into public.notifications (user_id, title, body, type)
  select
    cs.student_id,
    'واجب جديد',
    new.title,
    'assignment_created'
  from public.classroom_students cs
  where cs.classroom_id = new.classroom_id;
  return new;
end;
$$;

drop trigger if exists notify_new_extra_assignment on public.assignments_extra;
create trigger notify_new_extra_assignment
  after insert on public.assignments_extra
  for each row execute procedure public.notify_new_extra_assignment();

create or replace function public.notify_graded_extra_assignment()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
declare
  assignment_title text;
begin
  if new.graded_at is not null
     and (old.graded_at is distinct from new.graded_at or old.grade is distinct from new.grade) then
    select title into assignment_title
    from public.assignments_extra
    where id = new.assignment_extra_id;

    insert into public.notifications (user_id, title, body, type)
    values (
      new.student_id,
      'تم تقييم الواجب',
      coalesce(assignment_title, 'تم تحديث درجة واجبك'),
      'assignment_graded'
    );
  end if;
  return new;
end;
$$;

drop trigger if exists notify_graded_extra_assignment on public.assignment_extra_submissions;
create trigger notify_graded_extra_assignment
  after update on public.assignment_extra_submissions
  for each row execute procedure public.notify_graded_extra_assignment();
