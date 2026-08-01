-- ========================================================
-- Production security hardening
-- ========================================================

-- Restrict profile discovery to actual educational relationships.
drop policy if exists "Users view only authorized profiles" on public.users;
create policy "Users view relationship profiles"
  on public.users for select
  using (
    id = auth.uid()
    or public.is_admin()
    or (
      public.current_user_role() = 'teacher'
      and role = 'student'
      and is_active = true
      and (
        exists (
          select 1
          from public.halaqa_students hs
          join public.halaqat h on h.id = hs.halaqa_id
          where h.teacher_id = auth.uid() and hs.student_id = users.id
        )
        or exists (
          select 1
          from public.classroom_students cs
          join public.classrooms c on c.id = cs.classroom_id
          where c.teacher_id = auth.uid() and cs.student_id = users.id
        )
      )
    )
    or (
      public.current_user_role() = 'student'
      and role = 'teacher'
      and is_active = true
      and (
        exists (
          select 1
          from public.halaqa_students hs
          join public.halaqat h on h.id = hs.halaqa_id
          where hs.student_id = auth.uid() and h.teacher_id = users.id
        )
        or exists (
          select 1
          from public.classroom_students cs
          join public.classrooms c on c.id = cs.classroom_id
          where cs.student_id = auth.uid() and c.teacher_id = users.id
        )
      )
    )
    or (
      public.current_user_role() = 'parent'
      and exists (
        select 1 from public.parent_student ps
        where ps.parent_id = auth.uid() and ps.student_id = users.id
      )
    )
  );

-- Students may view their enrollment, but only teachers/admins manage it.
drop policy if exists "Teachers manage students in own halaqat" on public.halaqa_students;
create policy "Teachers and admins manage halaqa students"
  on public.halaqa_students for all
  using (
    public.is_admin()
    or exists (
      select 1 from public.halaqat h
      where h.id = halaqa_id and h.teacher_id = auth.uid()
    )
  )
  with check (
    public.is_admin()
    or exists (
      select 1 from public.halaqat h
      where h.id = halaqa_id and h.teacher_id = auth.uid()
    )
  );
create policy "Students view own halaqa enrollment"
  on public.halaqa_students for select
  using (student_id = auth.uid());

drop policy if exists "Teachers manage classroom students" on public.classroom_students;
create policy "Teachers and admins manage classroom students"
  on public.classroom_students for all
  using (
    public.is_admin()
    or exists (
      select 1 from public.classrooms c
      where c.id = classroom_id and c.teacher_id = auth.uid()
    )
  )
  with check (
    public.is_admin()
    or exists (
      select 1 from public.classrooms c
      where c.id = classroom_id and c.teacher_id = auth.uid()
    )
  );
create policy "Students view own classroom enrollment"
  on public.classroom_students for select
  using (student_id = auth.uid());

-- Protect Quran submission ownership and teacher-only notes.
create or replace function public.protect_quran_submission_fields()
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
      new.teacher_notes := null;
    else
      new.assignment_id := old.assignment_id;
      new.student_id := old.student_id;
      new.teacher_notes := old.teacher_notes;
    end if;
  end if;
  return new;
end;
$$;

drop trigger if exists protect_quran_submission_fields on public.assignment_submissions;
create trigger protect_quran_submission_fields
  before insert or update on public.assignment_submissions
  for each row execute procedure public.protect_quran_submission_fields();

drop policy if exists "Students manage own submissions" on public.assignment_submissions;
create policy "Students view own Quran submissions"
  on public.assignment_submissions for select
  using (student_id = auth.uid());
create policy "Students create own Quran submissions"
  on public.assignment_submissions for insert
  with check (student_id = auth.uid());
create policy "Students update own Quran submissions"
  on public.assignment_submissions for update
  using (student_id = auth.uid())
  with check (student_id = auth.uid());

-- Protect manual grades and feedback from student changes.
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
    else
      new.assignment_extra_id := old.assignment_extra_id;
      new.student_id := old.student_id;
      new.grade := old.grade;
      new.teacher_feedback := old.teacher_feedback;
      new.graded_at := old.graded_at;
    end if;
  end if;
  return new;
end;
$$;

drop trigger if exists protect_extra_submission_grading on public.assignment_extra_submissions;
create trigger protect_extra_submission_grading
  before insert or update on public.assignment_extra_submissions
  for each row execute procedure public.protect_extra_submission_grading();

drop policy if exists "Students manage extra submissions" on public.assignment_extra_submissions;
create policy "Students view own extra submissions"
  on public.assignment_extra_submissions for select
  using (student_id = auth.uid());
create policy "Students create own extra submissions"
  on public.assignment_extra_submissions for insert
  with check (student_id = auth.uid());
create policy "Students update own extra submissions"
  on public.assignment_extra_submissions for update
  using (student_id = auth.uid())
  with check (student_id = auth.uid());

-- Quiz questions and answer keys are teacher-only. Students receive a safe RPC payload.
drop policy if exists "Teachers manage quiz questions and options" on public.quiz_questions;
create policy "Teachers manage own quiz questions"
  on public.quiz_questions for all
  using (
    public.is_admin()
    or exists (
      select 1
      from public.quizzes q
      join public.classrooms c on c.id = q.classroom_id
      where q.id = quiz_id and c.teacher_id = auth.uid()
    )
  )
  with check (
    public.is_admin()
    or exists (
      select 1
      from public.quizzes q
      join public.classrooms c on c.id = q.classroom_id
      where q.id = quiz_id and c.teacher_id = auth.uid()
    )
  );

drop policy if exists "Teachers manage options" on public.quiz_options;
create policy "Teachers manage own quiz options"
  on public.quiz_options for all
  using (
    public.is_admin()
    or exists (
      select 1
      from public.quiz_questions qq
      join public.quizzes q on q.id = qq.quiz_id
      join public.classrooms c on c.id = q.classroom_id
      where qq.id = question_id and c.teacher_id = auth.uid()
    )
  )
  with check (
    public.is_admin()
    or exists (
      select 1
      from public.quiz_questions qq
      join public.quizzes q on q.id = qq.quiz_id
      join public.classrooms c on c.id = q.classroom_id
      where qq.id = question_id and c.teacher_id = auth.uid()
    )
  );

create or replace function public.get_student_quiz(p_quiz_id uuid)
returns jsonb
language plpgsql
stable
security definer
set search_path = public
as $$
declare
  result jsonb;
begin
  if public.current_user_role() <> 'student' then
    raise exception 'Only active students may open a student quiz' using errcode = '42501';
  end if;

  if not exists (
    select 1
    from public.quizzes q
    join public.classroom_students cs on cs.classroom_id = q.classroom_id
    where q.id = p_quiz_id and cs.student_id = auth.uid()
  ) then
    raise exception 'Quiz is not assigned to this student' using errcode = '42501';
  end if;

  select jsonb_build_object(
    'id', q.id,
    'title', q.title,
    'questions', coalesce((
      select jsonb_agg(
        jsonb_build_object(
          'id', qq.id,
          'question_text', qq.question_text,
          'order_index', qq.order_index,
          'quiz_options', coalesce((
            select jsonb_agg(
              jsonb_build_object('id', qo.id, 'option_text', qo.option_text)
              order by qo.id
            )
            from public.quiz_options qo
            where qo.question_id = qq.id
          ), '[]'::jsonb)
        ) order by qq.order_index
      )
      from public.quiz_questions qq
      where qq.quiz_id = q.id
    ), '[]'::jsonb)
  ) into result
  from public.quizzes q
  where q.id = p_quiz_id;

  return result;
end;
$$;

create or replace function public.submit_quiz(p_quiz_id uuid, p_answers jsonb)
returns table(submission_id uuid, score numeric)
language plpgsql
security definer
set search_path = public
as $$
declare
  question_count integer;
  answer_count integer;
  valid_answer_count integer;
  calculated_score numeric;
  created_submission_id uuid;
begin
  if public.current_user_role() <> 'student' then
    raise exception 'Only active students may submit a quiz' using errcode = '42501';
  end if;

  if jsonb_typeof(p_answers) <> 'array' then
    raise exception 'Answers must be a JSON array';
  end if;

  if not exists (
    select 1
    from public.quizzes q
    join public.classroom_students cs on cs.classroom_id = q.classroom_id
    where q.id = p_quiz_id and cs.student_id = auth.uid()
  ) then
    raise exception 'Quiz is not assigned to this student' using errcode = '42501';
  end if;

  select count(*) into question_count
  from public.quiz_questions
  where quiz_id = p_quiz_id;
  if question_count = 0 then raise exception 'Quiz has no questions'; end if;

  select count(distinct answer ->> 'question_id') into answer_count
  from jsonb_array_elements(p_answers) answer;

  select count(*) into valid_answer_count
  from jsonb_array_elements(p_answers) answer
  join public.quiz_questions qq
    on qq.id = (answer ->> 'question_id')::uuid and qq.quiz_id = p_quiz_id
  join public.quiz_options qo
    on qo.id = (answer ->> 'selected_option_id')::uuid and qo.question_id = qq.id;

  if answer_count <> question_count or valid_answer_count <> question_count then
    raise exception 'Every quiz question requires one valid answer';
  end if;

  select round(100.0 * count(*) filter (where qo.is_correct) / question_count, 2)
  into calculated_score
  from jsonb_array_elements(p_answers) answer
  join public.quiz_options qo on qo.id = (answer ->> 'selected_option_id')::uuid;

  insert into public.quiz_submissions (quiz_id, student_id, score)
  values (p_quiz_id, auth.uid(), calculated_score)
  returning id into created_submission_id;

  insert into public.quiz_answers (quiz_submission_id, question_id, selected_option_id)
  select
    created_submission_id,
    (answer ->> 'question_id')::uuid,
    (answer ->> 'selected_option_id')::uuid
  from jsonb_array_elements(p_answers) answer;

  return query select created_submission_id, calculated_score;
end;
$$;

revoke all on function public.get_student_quiz(uuid) from public;
grant execute on function public.get_student_quiz(uuid) to authenticated;
revoke all on function public.submit_quiz(uuid, jsonb) from public;
grant execute on function public.submit_quiz(uuid, jsonb) to authenticated;

drop policy if exists "Students manage quiz submissions" on public.quiz_submissions;
create policy "Students view own quiz submissions"
  on public.quiz_submissions for select
  using (student_id = auth.uid());
create policy "Teachers view own classroom quiz submissions"
  on public.quiz_submissions for select
  using (
    public.is_admin()
    or exists (
      select 1
      from public.quizzes q
      join public.classrooms c on c.id = q.classroom_id
      where q.id = quiz_id and c.teacher_id = auth.uid()
    )
  );

drop policy if exists "Students submit quiz answers" on public.quiz_answers;
create policy "Students view own quiz answers"
  on public.quiz_answers for select
  using (
    exists (
      select 1 from public.quiz_submissions qs
      where qs.id = quiz_submission_id and qs.student_id = auth.uid()
    )
  );
create policy "Teachers view own classroom quiz answers"
  on public.quiz_answers for select
  using (
    public.is_admin()
    or exists (
      select 1
      from public.quiz_submissions qs
      join public.quizzes q on q.id = qs.quiz_id
      join public.classrooms c on c.id = q.classroom_id
      where qs.id = quiz_submission_id and c.teacher_id = auth.uid()
    )
  );

-- Attendance writes must match a teacher-owned session and enrolled student.
create or replace function public.can_manage_attendance(
  p_session_type public.session_type,
  p_session_ref_id uuid,
  p_student_id uuid
)
returns boolean
language sql
stable
security definer
set search_path = public
as $$
  select public.is_admin() or (
    public.current_user_role() = 'teacher'
    and (
      (
        p_session_type = 'halaqa'
        and exists (
          select 1
          from public.halaqat h
          join public.halaqa_students hs on hs.halaqa_id = h.id
          where h.id = p_session_ref_id
            and h.teacher_id = auth.uid()
            and hs.student_id = p_student_id
        )
      )
      or (
        p_session_type = 'classroom'
        and exists (
          select 1
          from public.classrooms c
          join public.classroom_students cs on cs.classroom_id = c.id
          where c.id = p_session_ref_id
            and c.teacher_id = auth.uid()
            and cs.student_id = p_student_id
        )
      )
    )
  );
$$;

revoke all on function public.can_manage_attendance(public.session_type, uuid, uuid) from public;
grant execute on function public.can_manage_attendance(public.session_type, uuid, uuid) to authenticated;

drop policy if exists "Teachers manage attendance" on public.attendance;
create policy "Teachers manage attendance for own sessions"
  on public.attendance for all
  using (public.can_manage_attendance(session_type, session_ref_id, student_id))
  with check (
    public.can_manage_attendance(session_type, session_ref_id, student_id)
    and (recorded_by = auth.uid() or public.is_admin())
  );

-- Messaging is limited to teacher/student educational relationships.
create or replace function public.can_users_message(p_sender_id uuid, p_receiver_id uuid)
returns boolean
language sql
stable
security definer
set search_path = public
as $$
  select public.is_admin() or exists (
    select 1
    from public.halaqa_students hs
    join public.halaqat h on h.id = hs.halaqa_id
    where (h.teacher_id = p_sender_id and hs.student_id = p_receiver_id)
       or (h.teacher_id = p_receiver_id and hs.student_id = p_sender_id)
  ) or exists (
    select 1
    from public.classroom_students cs
    join public.classrooms c on c.id = cs.classroom_id
    where (c.teacher_id = p_sender_id and cs.student_id = p_receiver_id)
       or (c.teacher_id = p_receiver_id and cs.student_id = p_sender_id)
  );
$$;

create or replace function public.protect_message_update()
returns trigger
language plpgsql
set search_path = public
as $$
begin
  if not public.is_admin() then
    if auth.uid() <> old.receiver_id then
      raise exception 'Only the receiver may mark a message as read' using errcode = '42501';
    end if;
    new.sender_id := old.sender_id;
    new.receiver_id := old.receiver_id;
    new.content := old.content;
    new.created_at := old.created_at;
  end if;
  return new;
end;
$$;

drop trigger if exists protect_message_update on public.messages;
create trigger protect_message_update
  before update on public.messages
  for each row execute procedure public.protect_message_update();

drop policy if exists "Users read write their messages" on public.messages;
create policy "Participants read messages"
  on public.messages for select
  using (sender_id = auth.uid() or receiver_id = auth.uid() or public.is_admin());
create policy "Participants send allowed messages"
  on public.messages for insert
  with check (
    sender_id = auth.uid()
    and receiver_id <> auth.uid()
    and public.can_users_message(sender_id, receiver_id)
  );
create policy "Receivers mark messages read"
  on public.messages for update
  using (receiver_id = auth.uid() or public.is_admin())
  with check (receiver_id = auth.uid() or public.is_admin());
create policy "Admins delete messages"
  on public.messages for delete
  using (public.is_admin());

-- Users may read notifications and only change the read flag.
create or replace function public.protect_notification_update()
returns trigger
language plpgsql
set search_path = public
as $$
begin
  if not public.is_admin() then
    new.user_id := old.user_id;
    new.title := old.title;
    new.body := old.body;
    new.type := old.type;
    new.created_at := old.created_at;
  end if;
  return new;
end;
$$;

drop trigger if exists protect_notification_update on public.notifications;
create trigger protect_notification_update
  before update on public.notifications
  for each row execute procedure public.protect_notification_update();

drop policy if exists "Users manage their notifications" on public.notifications;
create policy "Users read own notifications"
  on public.notifications for select
  using (user_id = auth.uid() or public.is_admin());
create policy "Users mark own notifications read"
  on public.notifications for update
  using (user_id = auth.uid() or public.is_admin())
  with check (user_id = auth.uid() or public.is_admin());
create policy "Admins create notifications"
  on public.notifications for insert
  with check (public.is_admin());
create policy "Admins delete notifications"
  on public.notifications for delete
  using (public.is_admin());
