-- Unified, role-aware workspace for Quran and educational learning circles.

create table if not exists public.learning_circle_posts (
  id uuid primary key default gen_random_uuid(),
  circle_id uuid not null references public.learning_circles(id) on delete cascade,
  post_type text not null check (post_type in ('announcement', 'meeting', 'resource', 'discussion', 'system')),
  title text not null check (char_length(btrim(title)) between 2 and 200),
  body text check (body is null or char_length(body) <= 10000),
  external_url text check (external_url is null or char_length(external_url) <= 1000),
  author_id uuid references public.users(id) on delete set null,
  status text not null default 'published' check (status in ('published', 'archived')),
  replies_enabled boolean not null default false,
  is_pinned boolean not null default false,
  system_key text check (system_key is null or char_length(system_key) between 3 and 160),
  published_at timestamptz not null default now(),
  archived_by uuid references public.users(id) on delete restrict,
  archived_at timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  constraint learning_circle_post_author_check check (post_type = 'system' or author_id is not null),
  constraint learning_circle_post_archive_check check (
    (status = 'published' and archived_by is null and archived_at is null)
    or (status = 'archived' and archived_by is not null and archived_at is not null)
  )
);

create unique index if not exists learning_circle_post_system_key_idx
  on public.learning_circle_posts (circle_id, system_key)
  where system_key is not null;

create index if not exists learning_circle_posts_feed_idx
  on public.learning_circle_posts (circle_id, is_pinned desc, published_at desc);

create table if not exists public.learning_circle_post_replies (
  id uuid primary key default gen_random_uuid(),
  post_id uuid not null references public.learning_circle_posts(id) on delete cascade,
  author_id uuid not null references public.users(id) on delete restrict,
  body text not null check (char_length(btrim(body)) between 1 and 5000),
  status text not null default 'published' check (status in ('published', 'removed')),
  removed_by uuid references public.users(id) on delete restrict,
  removed_at timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  constraint learning_circle_reply_remove_check check (
    (status = 'published' and removed_by is null and removed_at is null)
    or (status = 'removed' and removed_by is not null and removed_at is not null)
  )
);

create index if not exists learning_circle_post_replies_post_idx
  on public.learning_circle_post_replies (post_id, created_at);

create table if not exists public.learning_circle_files (
  id uuid primary key default gen_random_uuid(),
  circle_id uuid not null references public.learning_circles(id) on delete cascade,
  post_id uuid references public.learning_circle_posts(id) on delete set null,
  title text not null check (char_length(btrim(title)) between 1 and 200),
  description text check (description is null or char_length(description) <= 3000),
  storage_path text not null unique check (char_length(storage_path) between 10 and 1200),
  original_name text not null check (char_length(original_name) between 1 and 255),
  mime_type text not null check (char_length(mime_type) between 3 and 160),
  size_bytes bigint not null check (size_bytes between 1 and 20971520),
  uploaded_by uuid not null references public.users(id) on delete restrict,
  status text not null default 'active' check (status in ('active', 'removed')),
  removed_by uuid references public.users(id) on delete restrict,
  removed_at timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  constraint learning_circle_file_remove_check check (
    (status = 'active' and removed_by is null and removed_at is null)
    or (status = 'removed' and removed_by is not null and removed_at is not null)
  )
);

create index if not exists learning_circle_files_circle_idx
  on public.learning_circle_files (circle_id, created_at desc);

create or replace function public.touch_learning_circle_workspace_record()
returns trigger
language plpgsql
set search_path = pg_catalog, public
as $$
begin
  new.updated_at := now();
  return new;
end;
$$;

drop trigger if exists touch_learning_circle_posts on public.learning_circle_posts;
create trigger touch_learning_circle_posts
  before update on public.learning_circle_posts
  for each row execute procedure public.touch_learning_circle_workspace_record();

drop trigger if exists touch_learning_circle_post_replies on public.learning_circle_post_replies;
create trigger touch_learning_circle_post_replies
  before update on public.learning_circle_post_replies
  for each row execute procedure public.touch_learning_circle_workspace_record();

drop trigger if exists touch_learning_circle_files on public.learning_circle_files;
create trigger touch_learning_circle_files
  before update on public.learning_circle_files
  for each row execute procedure public.touch_learning_circle_workspace_record();

create or replace function public.learning_circle_id_from_storage_path(p_name text)
returns uuid
language plpgsql
stable
security definer
set search_path = pg_catalog, public
set row_security = off
as $$
declare
  candidate text := split_part(coalesce(p_name, ''), '/', 1);
begin
  if candidate !~* '^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$' then
    return null;
  end if;
  return candidate::uuid;
exception when others then
  return null;
end;
$$;

create or replace function public.get_learning_circle_permissions(p_circle_id uuid)
returns jsonb
language plpgsql
stable
security definer
set search_path = pg_catalog, public
set row_security = off
as $$
declare
  circle_record public.learning_circles%rowtype;
  settings_record public.learning_circle_settings%rowtype;
  staff_record public.learning_circle_staff%rowtype;
  actor_role public.user_role;
  admin_access boolean := false;
  member_access boolean := false;
  staff_access boolean := false;
  lead_access boolean := false;
begin
  select * into circle_record from public.learning_circles where id = p_circle_id;
  if circle_record.id is null then
    return '{}'::jsonb;
  end if;

  select role into actor_role from public.users where id = auth.uid() and is_active = true;
  admin_access := actor_role = 'admin';

  select * into staff_record
  from public.learning_circle_staff
  where circle_id = p_circle_id and teacher_id = auth.uid() and status = 'active'
  limit 1;

  staff_access := staff_record.id is not null;
  lead_access := staff_access and staff_record.staff_role = 'lead';
  member_access := public.is_learning_circle_member(p_circle_id, auth.uid());
  select * into settings_record from public.learning_circle_settings where circle_id = p_circle_id;

  return jsonb_build_object(
    'role', actor_role,
    'can_access', admin_access or staff_access or member_access,
    'is_admin', admin_access,
    'is_staff', staff_access,
    'is_lead', lead_access,
    'is_student', member_access,
    'staff_role', case when staff_access then staff_record.staff_role else null end,
    'can_post_announcements', admin_access or lead_access or coalesce(staff_record.can_post_announcements, false),
    'can_manage_meet_link', admin_access or lead_access or coalesce(staff_record.can_manage_meet_link, false),
    'can_create_tasks', admin_access or lead_access or coalesce(staff_record.can_create_tasks, false),
    'can_review_submissions', admin_access or lead_access or coalesce(staff_record.can_review_submissions, false),
    'can_manage_discussions', admin_access or lead_access or coalesce(staff_record.can_manage_discussions, false),
    'can_track_students', admin_access or lead_access or coalesce(staff_record.can_track_students, false),
    'can_manage_people', admin_access or lead_access,
    'can_manage_settings', admin_access or lead_access or coalesce(staff_record.can_manage_discussions, false),
    'can_upload_files', admin_access or lead_access or coalesce(staff_record.can_post_announcements, false),
    'can_create_topics',
      admin_access or lead_access or coalesce(staff_record.can_manage_discussions, false)
      or (
        member_access and circle_record.circle_type = 'educational'
        and coalesce(settings_record.students_can_create_topics, false)
      ),
    'can_reply',
      admin_access or staff_access
      or (
        member_access and circle_record.circle_type = 'educational'
        and coalesce(settings_record.students_can_reply, false)
      )
  );
end;
$$;

create or replace function public.list_my_learning_circles()
returns jsonb
language sql
stable
security definer
set search_path = pg_catalog, public
set row_security = off
as $$
  select coalesce(jsonb_agg(circle_item order by circle_item ->> 'name'), '[]'::jsonb)
  from (
    select jsonb_build_object(
      'id', lc.id,
      'name', lc.name,
      'description', lc.description,
      'circle_type', lc.circle_type,
      'status', lc.status,
      'meet_link', lc.meet_link,
      'subjects', coalesce((
        select jsonb_agg(jsonb_build_object('id', s.id, 'name', s.name) order by s.name)
        from public.learning_circle_subjects lcs
        join public.subjects s on s.id = lcs.subject_id
        where lcs.circle_id = lc.id
      ), '[]'::jsonb),
      'lead_teacher', (
        select jsonb_build_object('id', u.id, 'full_name', u.full_name, 'username', u.username)
        from public.learning_circle_staff lcf
        join public.users u on u.id = lcf.teacher_id
        where lcf.circle_id = lc.id and lcf.staff_role = 'lead' and lcf.status = 'active'
        limit 1
      ),
      'participant_role', case
        when public.is_admin() then 'admin'
        when exists (
          select 1 from public.learning_circle_staff s
          where s.circle_id = lc.id and s.teacher_id = auth.uid() and s.status = 'active' and s.staff_role = 'lead'
        ) then 'lead'
        when exists (
          select 1 from public.learning_circle_staff s
          where s.circle_id = lc.id and s.teacher_id = auth.uid() and s.status = 'active'
        ) then 'assistant'
        else 'student'
      end,
      'students_count', (
        select count(*) from public.learning_circle_memberships m
        where m.circle_id = lc.id and m.status in ('active', 'transfer_pending')
      ),
      'posts_count', (
        select count(*) from public.learning_circle_posts p
        where p.circle_id = lc.id and p.status = 'published'
      ),
      'latest_post_at', (
        select max(p.published_at) from public.learning_circle_posts p
        where p.circle_id = lc.id and p.status = 'published'
      )
    ) as circle_item
    from public.learning_circles lc
    where public.can_access_learning_circle(lc.id)
      and (lc.status <> 'archived' or public.is_admin())
  ) visible_circles;
$$;

create or replace function public.get_learning_circle_workspace(p_circle_id uuid)
returns jsonb
language plpgsql
stable
security definer
set search_path = pg_catalog, public
set row_security = off
as $$
declare
  circle_record public.learning_circles%rowtype;
  permissions jsonb;
  show_all_students boolean := false;
begin
  if not public.can_access_learning_circle(p_circle_id) then
    raise exception 'Learning circle access denied' using errcode = '42501';
  end if;

  select * into circle_record from public.learning_circles where id = p_circle_id;
  if circle_record.id is null then
    raise exception 'Learning circle not found';
  end if;

  permissions := public.get_learning_circle_permissions(p_circle_id);
  show_all_students := coalesce((permissions ->> 'is_admin')::boolean, false)
    or coalesce((permissions ->> 'is_staff')::boolean, false);

  return jsonb_build_object(
    'circle', jsonb_build_object(
      'id', circle_record.id,
      'name', circle_record.name,
      'description', circle_record.description,
      'circle_type', circle_record.circle_type,
      'status', circle_record.status,
      'meet_link', circle_record.meet_link,
      'created_at', circle_record.created_at,
      'subjects', coalesce((
        select jsonb_agg(jsonb_build_object('id', s.id, 'name', s.name) order by s.name)
        from public.learning_circle_subjects lcs
        join public.subjects s on s.id = lcs.subject_id
        where lcs.circle_id = p_circle_id
      ), '[]'::jsonb)
    ),
    'settings', coalesce((
      select to_jsonb(settings_row) - array['updated_by']
      from public.learning_circle_settings settings_row
      where settings_row.circle_id = p_circle_id
    ), '{}'::jsonb),
    'permissions', permissions,
    'people', jsonb_build_object(
      'staff', coalesce((
        select jsonb_agg(jsonb_build_object(
          'id', s.id,
          'teacher_id', s.teacher_id,
          'staff_role', s.staff_role,
          'full_name', u.full_name,
          'username', u.username,
          'permissions', jsonb_build_object(
            'post_announcements', s.can_post_announcements,
            'manage_meet_link', s.can_manage_meet_link,
            'create_tasks', s.can_create_tasks,
            'review_submissions', s.can_review_submissions,
            'manage_discussions', s.can_manage_discussions,
            'track_students', s.can_track_students
          )
        ) order by (s.staff_role = 'lead') desc, u.full_name)
        from public.learning_circle_staff s
        join public.users u on u.id = s.teacher_id
        where s.circle_id = p_circle_id and s.status = 'active'
      ), '[]'::jsonb),
      'students', coalesce((
        select jsonb_agg(jsonb_build_object(
          'membership_id', m.id,
          'student_id', m.student_id,
          'full_name', u.full_name,
          'username', u.username,
          'joined_at', m.joined_at,
          'status', m.status
        ) order by u.full_name)
        from public.learning_circle_memberships m
        join public.users u on u.id = m.student_id
        where m.circle_id = p_circle_id
          and m.status in ('active', 'transfer_pending')
          and (show_all_students or m.student_id = auth.uid())
      ), '[]'::jsonb),
      'students_count', (
        select count(*) from public.learning_circle_memberships m
        where m.circle_id = p_circle_id and m.status in ('active', 'transfer_pending')
      )
    ),
    'posts', coalesce((
      select jsonb_agg(jsonb_build_object(
        'id', p.id,
        'post_type', p.post_type,
        'title', p.title,
        'body', p.body,
        'external_url', p.external_url,
        'status', p.status,
        'replies_enabled', p.replies_enabled,
        'is_pinned', p.is_pinned,
        'published_at', p.published_at,
        'author', case when p.author_id is null then null else jsonb_build_object(
          'id', author.id, 'full_name', author.full_name, 'role', author.role
        ) end,
        'replies', coalesce((
          select jsonb_agg(jsonb_build_object(
            'id', r.id,
            'body', r.body,
            'status', r.status,
            'created_at', r.created_at,
            'author', jsonb_build_object('id', ru.id, 'full_name', ru.full_name, 'role', ru.role)
          ) order by r.created_at)
          from public.learning_circle_post_replies r
          join public.users ru on ru.id = r.author_id
          where r.post_id = p.id
            and (r.status = 'published' or coalesce((permissions ->> 'can_manage_discussions')::boolean, false))
        ), '[]'::jsonb)
      ) order by p.is_pinned desc, p.published_at desc)
      from public.learning_circle_posts p
      left join public.users author on author.id = p.author_id
      where p.circle_id = p_circle_id
        and (p.status = 'published' or coalesce((permissions ->> 'can_manage_discussions')::boolean, false))
    ), '[]'::jsonb),
    'files', coalesce((
      select jsonb_agg(jsonb_build_object(
        'id', f.id,
        'post_id', f.post_id,
        'title', f.title,
        'description', f.description,
        'storage_path', f.storage_path,
        'original_name', f.original_name,
        'mime_type', f.mime_type,
        'size_bytes', f.size_bytes,
        'status', f.status,
        'created_at', f.created_at,
        'uploader', jsonb_build_object('id', uploader.id, 'full_name', uploader.full_name)
      ) order by f.created_at desc)
      from public.learning_circle_files f
      join public.users uploader on uploader.id = f.uploaded_by
      where f.circle_id = p_circle_id
        and (f.status = 'active' or coalesce((permissions ->> 'can_manage_settings')::boolean, false))
    ), '[]'::jsonb)
  );
end;
$$;

create or replace function public.create_learning_circle_post(
  p_circle_id uuid,
  p_post_type text,
  p_title text,
  p_body text default null,
  p_external_url text default null,
  p_replies_enabled boolean default false,
  p_is_pinned boolean default false
)
returns uuid
language plpgsql
security definer
set search_path = pg_catalog, public
set row_security = off
as $$
declare
  circle_record public.learning_circles%rowtype;
  settings_record public.learning_circle_settings%rowtype;
  new_post_id uuid;
  normalized_title text := btrim(coalesce(p_title, ''));
  normalized_body text := nullif(btrim(coalesce(p_body, '')), '');
  normalized_url text := nullif(btrim(coalesce(p_external_url, '')), '');
  allow_create boolean := false;
  effective_replies boolean := coalesce(p_replies_enabled, false);
begin
  select * into circle_record from public.learning_circles where id = p_circle_id and status = 'active';
  if circle_record.id is null then raise exception 'Learning circle not found or inactive'; end if;
  if p_post_type not in ('announcement', 'meeting', 'resource', 'discussion') then
    raise exception 'Unsupported post type';
  end if;
  if char_length(normalized_title) not between 2 and 200 then raise exception 'Post title must contain between 2 and 200 characters'; end if;
  if normalized_body is not null and char_length(normalized_body) > 10000 then raise exception 'Post body is too long'; end if;

  select * into settings_record from public.learning_circle_settings where circle_id = p_circle_id;

  if p_post_type in ('announcement', 'meeting', 'resource') then
    allow_create := public.has_learning_circle_permission(p_circle_id, 'post_announcements');
  else
    allow_create := public.has_learning_circle_permission(p_circle_id, 'manage_discussions')
      or (
        circle_record.circle_type = 'educational'
        and public.is_learning_circle_member(p_circle_id, auth.uid())
        and coalesce(settings_record.students_can_create_topics, false)
      );
  end if;

  if not allow_create then raise exception 'Not allowed to create this post' using errcode = '42501'; end if;

  if p_post_type = 'meeting' then
    normalized_url := coalesce(normalized_url, circle_record.meet_link);
    if normalized_url is null or normalized_url !~* '^https://meet\.google\.com/[a-z0-9_-]+([/?#].*)?$' then
      raise exception 'A valid Google Meet link is required';
    end if;
  elsif normalized_url is not null and normalized_url !~* '^https://[^[:space:]]+$' then
    raise exception 'External URL must use HTTPS';
  end if;

  if circle_record.circle_type = 'quran' then effective_replies := false; end if;
  if p_post_type <> 'discussion' then effective_replies := false; end if;

  insert into public.learning_circle_posts (
    circle_id, post_type, title, body, external_url, author_id, replies_enabled, is_pinned
  ) values (
    p_circle_id, p_post_type, normalized_title, normalized_body, normalized_url,
    auth.uid(), effective_replies,
    coalesce(p_is_pinned, false) and public.can_manage_learning_circle(p_circle_id)
  ) returning id into new_post_id;

  insert into public.notifications (user_id, title, body, type)
  select m.student_id, normalized_title, left(coalesce(normalized_body, ''), 500), 'circle_post'
  from public.learning_circle_memberships m
  where m.circle_id = p_circle_id and m.status in ('active', 'transfer_pending') and m.student_id <> auth.uid();

  perform public.record_platform_audit(
    p_circle_id, 'circle.post_created', 'learning_circle_post', new_post_id::text,
    null, jsonb_build_object('post_type', p_post_type, 'title', normalized_title)
  );
  return new_post_id;
end;
$$;

create or replace function public.moderate_learning_circle_post(p_post_id uuid, p_action text)
returns jsonb
language plpgsql
security definer
set search_path = pg_catalog, public
set row_security = off
as $$
declare
  previous_post public.learning_circle_posts%rowtype;
  updated_post public.learning_circle_posts%rowtype;
  allowed boolean := false;
begin
  select * into previous_post from public.learning_circle_posts where id = p_post_id for update;
  if previous_post.id is null then raise exception 'Post not found'; end if;

  allowed := case when previous_post.post_type = 'discussion'
    then public.has_learning_circle_permission(previous_post.circle_id, 'manage_discussions')
    else public.has_learning_circle_permission(previous_post.circle_id, 'post_announcements')
  end;
  if not allowed then raise exception 'Not allowed to moderate this post' using errcode = '42501'; end if;
  if p_action not in ('close', 'reopen', 'pin', 'unpin', 'archive') then raise exception 'Unsupported moderation action'; end if;

  update public.learning_circle_posts
  set
    replies_enabled = case when p_action = 'close' then false when p_action = 'reopen' then true else replies_enabled end,
    is_pinned = case when p_action = 'pin' then true when p_action = 'unpin' then false else is_pinned end,
    status = case when p_action = 'archive' then 'archived' else status end,
    archived_by = case when p_action = 'archive' then auth.uid() else archived_by end,
    archived_at = case when p_action = 'archive' then now() else archived_at end
  where id = p_post_id
  returning * into updated_post;

  perform public.record_platform_audit(
    previous_post.circle_id, 'circle.post_' || p_action, 'learning_circle_post', p_post_id::text,
    to_jsonb(previous_post), to_jsonb(updated_post)
  );
  return to_jsonb(updated_post) - array['body'];
end;
$$;

create or replace function public.reply_to_learning_circle_post(p_post_id uuid, p_body text)
returns uuid
language plpgsql
security definer
set search_path = pg_catalog, public
set row_security = off
as $$
declare
  post_record public.learning_circle_posts%rowtype;
  circle_record public.learning_circles%rowtype;
  settings_record public.learning_circle_settings%rowtype;
  normalized_body text := btrim(coalesce(p_body, ''));
  allow_reply boolean := false;
  new_reply_id uuid;
begin
  select * into post_record from public.learning_circle_posts where id = p_post_id and status = 'published';
  if post_record.id is null then raise exception 'Post not found or archived'; end if;
  if not post_record.replies_enabled then raise exception 'Replies are closed'; end if;
  if char_length(normalized_body) not between 1 and 5000 then raise exception 'Reply must contain between 1 and 5000 characters'; end if;

  select * into circle_record from public.learning_circles where id = post_record.circle_id;
  select * into settings_record from public.learning_circle_settings where circle_id = post_record.circle_id;
  allow_reply := public.is_learning_circle_staff(post_record.circle_id, auth.uid()) or public.is_admin()
    or (
      circle_record.circle_type = 'educational'
      and public.is_learning_circle_member(post_record.circle_id, auth.uid())
      and coalesce(settings_record.students_can_reply, false)
    );
  if not allow_reply then raise exception 'Not allowed to reply' using errcode = '42501'; end if;

  insert into public.learning_circle_post_replies (post_id, author_id, body)
  values (p_post_id, auth.uid(), normalized_body)
  returning id into new_reply_id;

  perform public.record_platform_audit(
    post_record.circle_id, 'circle.reply_created', 'learning_circle_post_reply', new_reply_id::text,
    null, jsonb_build_object('post_id', p_post_id)
  );
  return new_reply_id;
end;
$$;

create or replace function public.remove_learning_circle_reply(p_reply_id uuid)
returns void
language plpgsql
security definer
set search_path = pg_catalog, public
set row_security = off
as $$
declare
  previous_reply public.learning_circle_post_replies%rowtype;
  circle_id_value uuid;
begin
  select r.* into previous_reply
  from public.learning_circle_post_replies r
  join public.learning_circle_posts p on p.id = r.post_id
  where r.id = p_reply_id
  for update of r;

  select p.circle_id into circle_id_value
  from public.learning_circle_post_replies r
  join public.learning_circle_posts p on p.id = r.post_id
  where r.id = p_reply_id;

  if previous_reply.id is null then raise exception 'Reply not found'; end if;
  if not public.has_learning_circle_permission(circle_id_value, 'manage_discussions') then
    raise exception 'Not allowed to remove replies' using errcode = '42501';
  end if;

  update public.learning_circle_post_replies
  set status = 'removed', removed_by = auth.uid(), removed_at = now()
  where id = p_reply_id;

  perform public.record_platform_audit(
    circle_id_value, 'circle.reply_removed', 'learning_circle_post_reply', p_reply_id::text,
    to_jsonb(previous_reply), jsonb_build_object('status', 'removed')
  );
end;
$$;

create or replace function public.update_learning_circle_workspace_settings(
  p_circle_id uuid,
  p_students_can_create_topics boolean,
  p_students_can_reply boolean
)
returns jsonb
language plpgsql
security definer
set search_path = pg_catalog, public
set row_security = off
as $$
declare
  circle_record public.learning_circles%rowtype;
  previous_settings public.learning_circle_settings%rowtype;
  updated_settings public.learning_circle_settings%rowtype;
begin
  if not (
    public.can_manage_learning_circle(p_circle_id)
    or public.has_learning_circle_permission(p_circle_id, 'manage_discussions')
  ) then raise exception 'Not allowed to update workspace settings' using errcode = '42501'; end if;

  select * into circle_record from public.learning_circles where id = p_circle_id and status = 'active';
  if circle_record.id is null then raise exception 'Learning circle not found or inactive'; end if;
  select * into previous_settings from public.learning_circle_settings where circle_id = p_circle_id for update;

  update public.learning_circle_settings
  set
    students_can_create_topics = case when circle_record.circle_type = 'quran' then false else coalesce(p_students_can_create_topics, false) end,
    students_can_reply = case when circle_record.circle_type = 'quran' then false else coalesce(p_students_can_reply, false) end,
    updated_by = auth.uid()
  where circle_id = p_circle_id
  returning * into updated_settings;

  perform public.record_platform_audit(
    p_circle_id, 'circle.workspace_settings_updated', 'learning_circle_settings', p_circle_id::text,
    to_jsonb(previous_settings), to_jsonb(updated_settings)
  );
  return to_jsonb(updated_settings) - array['updated_by'];
end;
$$;

create or replace function public.register_learning_circle_file(
  p_circle_id uuid,
  p_storage_path text,
  p_original_name text,
  p_title text,
  p_description text,
  p_mime_type text,
  p_size_bytes bigint,
  p_post_id uuid default null
)
returns uuid
language plpgsql
security definer
set search_path = pg_catalog, public, storage
set row_security = off
as $$
declare
  new_file_id uuid;
  allowed_mime_types text[] := array[
    'application/pdf',
    'application/msword',
    'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
    'application/vnd.ms-excel',
    'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
    'application/vnd.ms-powerpoint',
    'application/vnd.openxmlformats-officedocument.presentationml.presentation',
    'image/jpeg', 'image/png', 'image/webp', 'text/plain',
    'audio/mpeg', 'audio/mp4', 'audio/ogg', 'audio/webm'
  ];
begin
  if not public.has_learning_circle_permission(p_circle_id, 'post_announcements') then
    raise exception 'Not allowed to upload circle files' using errcode = '42501';
  end if;
  if public.learning_circle_id_from_storage_path(p_storage_path) is distinct from p_circle_id then
    raise exception 'Storage path does not belong to the circle';
  end if;
  if split_part(p_storage_path, '/', 2) <> auth.uid()::text then
    raise exception 'Storage path does not belong to the uploader';
  end if;
  if p_mime_type <> all(allowed_mime_types) then raise exception 'Unsupported file type'; end if;
  if p_size_bytes not between 1 and 20971520 then raise exception 'File size must be between 1 byte and 20 MB'; end if;
  if not exists (select 1 from storage.objects where bucket_id = 'circle-files' and name = p_storage_path) then
    raise exception 'Uploaded object was not found';
  end if;
  if p_post_id is not null and not exists (
    select 1 from public.learning_circle_posts where id = p_post_id and circle_id = p_circle_id
  ) then raise exception 'Post does not belong to the circle'; end if;

  insert into public.learning_circle_files (
    circle_id, post_id, title, description, storage_path, original_name,
    mime_type, size_bytes, uploaded_by
  ) values (
    p_circle_id, p_post_id, btrim(p_title), nullif(btrim(coalesce(p_description, '')), ''),
    p_storage_path, btrim(p_original_name), p_mime_type, p_size_bytes, auth.uid()
  ) returning id into new_file_id;

  perform public.record_platform_audit(
    p_circle_id, 'circle.file_registered', 'learning_circle_file', new_file_id::text,
    null, jsonb_build_object('original_name', p_original_name, 'mime_type', p_mime_type, 'size_bytes', p_size_bytes)
  );
  return new_file_id;
end;
$$;

create or replace function public.remove_learning_circle_file(p_file_id uuid)
returns text
language plpgsql
security definer
set search_path = pg_catalog, public
set row_security = off
as $$
declare
  previous_file public.learning_circle_files%rowtype;
begin
  select * into previous_file from public.learning_circle_files where id = p_file_id for update;
  if previous_file.id is null then raise exception 'File not found'; end if;
  if not (
    public.can_manage_learning_circle(previous_file.circle_id)
    or (
      previous_file.uploaded_by = auth.uid()
      and public.has_learning_circle_permission(previous_file.circle_id, 'post_announcements')
    )
  ) then raise exception 'Not allowed to remove this file' using errcode = '42501'; end if;

  update public.learning_circle_files
  set status = 'removed', removed_by = auth.uid(), removed_at = now()
  where id = p_file_id;

  perform public.record_platform_audit(
    previous_file.circle_id, 'circle.file_removed', 'learning_circle_file', p_file_id::text,
    to_jsonb(previous_file), jsonb_build_object('status', 'removed')
  );
  return previous_file.storage_path;
end;
$$;

-- Extend profile visibility to canonical learning-circle relationships.
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
      where actor.id = auth.uid() and actor.is_active = true and (
        actor.role = 'admin'
        or (
          actor.role = 'teacher' and target.role in ('student', 'teacher') and target.is_active = true
          and exists (
            select 1
            from public.learning_circle_staff actor_staff
            where actor_staff.teacher_id = actor.id and actor_staff.status = 'active'
              and (
                (target.role = 'teacher' and exists (
                  select 1 from public.learning_circle_staff target_staff
                  where target_staff.circle_id = actor_staff.circle_id
                    and target_staff.teacher_id = target.id and target_staff.status = 'active'
                ))
                or
                (target.role = 'student' and exists (
                  select 1 from public.learning_circle_memberships target_member
                  where target_member.circle_id = actor_staff.circle_id
                    and target_member.student_id = target.id
                    and target_member.status in ('active', 'transfer_pending')
                ))
              )
          )
        )
        or (
          actor.role = 'student' and target.role = 'teacher' and target.is_active = true
          and exists (
            select 1
            from public.learning_circle_memberships actor_member
            join public.learning_circle_staff target_staff on target_staff.circle_id = actor_member.circle_id
            where actor_member.student_id = actor.id
              and actor_member.status in ('active', 'transfer_pending')
              and target_staff.teacher_id = target.id and target_staff.status = 'active'
          )
        )
        or (
          actor.role = 'parent' and target.role = 'student'
          and exists (
            select 1 from public.parent_student ps
            where ps.parent_id = actor.id and ps.student_id = target.id
          )
        )
      )
    );
$$;

alter table public.learning_circle_posts enable row level security;
alter table public.learning_circle_post_replies enable row level security;
alter table public.learning_circle_files enable row level security;

drop policy if exists "Participants view circle posts" on public.learning_circle_posts;
create policy "Participants view circle posts"
  on public.learning_circle_posts for select to authenticated
  using (
    public.can_access_learning_circle(circle_id)
    and (status = 'published' or public.has_learning_circle_permission(circle_id, 'manage_discussions'))
  );

drop policy if exists "Participants view circle replies" on public.learning_circle_post_replies;
create policy "Participants view circle replies"
  on public.learning_circle_post_replies for select to authenticated
  using (
    exists (
      select 1 from public.learning_circle_posts p
      where p.id = post_id and public.can_access_learning_circle(p.circle_id)
        and (p.status = 'published' or public.has_learning_circle_permission(p.circle_id, 'manage_discussions'))
    )
    and (
      learning_circle_post_replies.status = 'published'
      or exists (
        select 1 from public.learning_circle_posts p
        where p.id = post_id and public.has_learning_circle_permission(p.circle_id, 'manage_discussions')
      )
    )
  );

drop policy if exists "Participants view circle files" on public.learning_circle_files;
create policy "Participants view circle files"
  on public.learning_circle_files for select to authenticated
  using (
    public.can_access_learning_circle(circle_id)
    and (status = 'active' or public.can_manage_learning_circle(circle_id))
  );

revoke all on public.learning_circle_posts from anon, authenticated;
revoke all on public.learning_circle_post_replies from anon, authenticated;
revoke all on public.learning_circle_files from anon, authenticated;
grant select on public.learning_circle_posts to authenticated;
grant select on public.learning_circle_post_replies to authenticated;
grant select on public.learning_circle_files to authenticated;

insert into storage.buckets (id, name, public, file_size_limit, allowed_mime_types)
values (
  'circle-files', 'circle-files', false, 20971520,
  array[
    'application/pdf',
    'application/msword',
    'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
    'application/vnd.ms-excel',
    'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
    'application/vnd.ms-powerpoint',
    'application/vnd.openxmlformats-officedocument.presentationml.presentation',
    'image/jpeg', 'image/png', 'image/webp', 'text/plain',
    'audio/mpeg', 'audio/mp4', 'audio/ogg', 'audio/webm'
  ]
)
on conflict (id) do update set
  public = excluded.public,
  file_size_limit = excluded.file_size_limit,
  allowed_mime_types = excluded.allowed_mime_types;

drop policy if exists "Circle participants read circle files" on storage.objects;
create policy "Circle participants read circle files"
  on storage.objects for select to authenticated
  using (
    bucket_id = 'circle-files'
    and public.can_access_learning_circle(public.learning_circle_id_from_storage_path(name))
  );

drop policy if exists "Authorized staff upload circle files" on storage.objects;
create policy "Authorized staff upload circle files"
  on storage.objects for insert to authenticated
  with check (
    bucket_id = 'circle-files'
    and (storage.foldername(name))[2] = auth.uid()::text
    and public.has_learning_circle_permission(
      public.learning_circle_id_from_storage_path(name), 'post_announcements'
    )
  );

drop policy if exists "Authorized staff remove circle files" on storage.objects;
create policy "Authorized staff remove circle files"
  on storage.objects for delete to authenticated
  using (
    bucket_id = 'circle-files'
    and (
      public.can_manage_learning_circle(public.learning_circle_id_from_storage_path(name))
      or (
        (storage.foldername(name))[2] = auth.uid()::text
        and public.has_learning_circle_permission(
          public.learning_circle_id_from_storage_path(name), 'post_announcements'
        )
      )
    )
  );

revoke all on function public.learning_circle_id_from_storage_path(text) from public;
revoke all on function public.get_learning_circle_permissions(uuid) from public;
revoke all on function public.list_my_learning_circles() from public;
revoke all on function public.get_learning_circle_workspace(uuid) from public;
revoke all on function public.create_learning_circle_post(uuid, text, text, text, text, boolean, boolean) from public;
revoke all on function public.moderate_learning_circle_post(uuid, text) from public;
revoke all on function public.reply_to_learning_circle_post(uuid, text) from public;
revoke all on function public.remove_learning_circle_reply(uuid) from public;
revoke all on function public.update_learning_circle_workspace_settings(uuid, boolean, boolean) from public;
revoke all on function public.register_learning_circle_file(uuid, text, text, text, text, text, bigint, uuid) from public;
revoke all on function public.remove_learning_circle_file(uuid) from public;

grant execute on function public.get_learning_circle_permissions(uuid) to authenticated;
grant execute on function public.list_my_learning_circles() to authenticated;
grant execute on function public.get_learning_circle_workspace(uuid) to authenticated;
grant execute on function public.create_learning_circle_post(uuid, text, text, text, text, boolean, boolean) to authenticated;
grant execute on function public.moderate_learning_circle_post(uuid, text) to authenticated;
grant execute on function public.reply_to_learning_circle_post(uuid, text) to authenticated;
grant execute on function public.remove_learning_circle_reply(uuid) to authenticated;
grant execute on function public.update_learning_circle_workspace_settings(uuid, boolean, boolean) to authenticated;
grant execute on function public.register_learning_circle_file(uuid, text, text, text, text, text, bigint, uuid) to authenticated;
grant execute on function public.remove_learning_circle_file(uuid) to authenticated;
