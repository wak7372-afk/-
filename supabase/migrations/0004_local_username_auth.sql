-- Local-account authentication: usernames are the public login identifier.
-- The existing email column remains an internal Supabase Auth identifier.

alter table public.users
  add column if not exists username text,
  add column if not exists must_change_password boolean not null default false;

update public.users
set username = case
  when role = 'admin' then 'warith'
  else lower(
    regexp_replace(split_part(email, '@', 1), '[^a-z0-9._-]+', '-', 'g')
  ) || '-' || left(replace(id::text, '-', ''), 6)
end
where username is null or btrim(username) = '';

alter table public.users
  alter column username set not null;

create unique index if not exists users_username_lower_uidx
  on public.users ((lower(username)));

create or replace function public.handle_new_auth_user()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
declare
  requested_role public.user_role;
  metadata_role text;
  requested_username text;
begin
  metadata_role := coalesce(new.raw_user_meta_data ->> 'requested_role', 'student');
  requested_role := case
    when metadata_role = 'parent' then 'parent'::public.user_role
    else 'student'::public.user_role
  end;

  requested_username := lower(
    regexp_replace(
      coalesce(
        nullif(trim(new.raw_user_meta_data ->> 'username'), ''),
        split_part(new.email, '@', 1)
      ),
      '[^a-z0-9._-]+',
      '-',
      'g'
    )
  );

  if requested_username !~ '^[a-z0-9][a-z0-9._-]{2,31}$' then
    requested_username := 'user-' || left(replace(new.id::text, '-', ''), 10);
  end if;

  insert into public.users (
    id,
    full_name,
    email,
    username,
    phone,
    role,
    is_active,
    family_link_code,
    updated_at
  ) values (
    new.id,
    coalesce(nullif(trim(new.raw_user_meta_data ->> 'full_name'), ''), requested_username),
    lower(new.email),
    requested_username,
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

create or replace function public.protect_user_privileged_fields()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
begin
  if auth.uid() = old.id and not public.is_admin() then
    new.username := old.username;
    new.role := old.role;
    new.is_active := old.is_active;
    new.email := old.email;
  end if;

  new.updated_at := now();
  return new;
end;
$$;
