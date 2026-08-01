create table if not exists public.admin_audit_logs (
  id uuid primary key default gen_random_uuid(),
  actor_id uuid not null default auth.uid() references public.users(id) on delete restrict,
  action text not null check (char_length(action) between 1 and 160),
  target_user_id uuid references public.users(id) on delete set null,
  metadata jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default now()
);

create index if not exists admin_audit_logs_created_at_idx
  on public.admin_audit_logs (created_at desc);

create index if not exists admin_audit_logs_target_user_idx
  on public.admin_audit_logs (target_user_id, created_at desc);

alter table public.admin_audit_logs enable row level security;
revoke all on public.admin_audit_logs from anon;
grant select, insert on public.admin_audit_logs to authenticated;

create policy "Admins read audit logs"
  on public.admin_audit_logs for select
  using (public.is_admin());

create policy "Admins create own audit logs"
  on public.admin_audit_logs for insert
  with check (public.is_admin() and actor_id = auth.uid());
