-- Password recovery codes are short-lived and never stored in plain text.
create table if not exists public.password_recovery_codes (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references public.users(id) on delete cascade,
  code_hash text not null,
  attempts smallint not null default 0 check (attempts between 0 and 5),
  expires_at timestamptz not null,
  consumed_at timestamptz,
  created_at timestamptz not null default now()
);

create index if not exists password_recovery_codes_lookup_idx
  on public.password_recovery_codes (user_id, created_at desc)
  where consumed_at is null;

alter table public.password_recovery_codes enable row level security;
revoke all on public.password_recovery_codes from anon, authenticated;

revoke all on function public.is_admin() from public;
grant execute on function public.is_admin() to authenticated;
revoke all on function public.current_user_role() from public;
grant execute on function public.current_user_role() to authenticated;
