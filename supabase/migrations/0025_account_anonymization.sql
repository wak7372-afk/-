alter table public.users
  add column if not exists deleted_at timestamptz,
  add column if not exists deleted_by uuid references public.users(id) on delete set null;

create index if not exists users_active_directory_idx
  on public.users (role, created_at desc)
  where deleted_at is null;

create or replace function public.admin_anonymize_user_account(
  p_target_id uuid,
  p_actor_id uuid
)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  actor_role public.user_role;
  target_role public.user_role;
  anonymous_username text;
  anonymous_email text;
begin
  select role into actor_role
  from public.users
  where id = p_actor_id and is_active = true and deleted_at is null;

  if actor_role is distinct from 'admin'::public.user_role then
    raise exception 'ADMIN_REQUIRED';
  end if;

  select role into target_role
  from public.users
  where id = p_target_id and deleted_at is null
  for update;

  if target_role is null then
    raise exception 'ACCOUNT_NOT_FOUND';
  end if;
  if target_role = 'admin'::public.user_role or p_target_id = p_actor_id then
    raise exception 'PROTECTED_ACCOUNT';
  end if;

  anonymous_username := 'deleted-' || left(replace(p_target_id::text, '-', ''), 20);
  anonymous_email := anonymous_username || '@deleted.zatkhail.invalid';

  update public.learning_circle_memberships
  set status = 'ended',
      ended_at = coalesce(ended_at, now()),
      ended_reason = 'تم حذف معلومات الحساب من المنصة',
      updated_at = now()
  where student_id = p_target_id and status <> 'ended';

  update public.learning_circle_staff
  set status = 'ended',
      ended_at = coalesce(ended_at, now()),
      updated_at = now()
  where teacher_id = p_target_id and status <> 'ended';

  update public.learning_circle_transfer_requests
  set status = 'cancelled',
      decided_by = p_actor_id,
      decided_at = now(),
      admin_notes = 'أُلغي الطلب بعد حذف معلومات الحساب'
  where student_id = p_target_id and status = 'pending';

  delete from public.parent_student
  where parent_id = p_target_id or student_id = p_target_id;

  update public.admin_audit_logs
  set metadata = metadata - 'username' - 'full_name' - 'phone' - 'email'
  where target_user_id = p_target_id;

  update public.users
  set full_name = 'حساب محذوف',
      email = anonymous_email,
      username = anonymous_username,
      phone = null,
      avatar_url = null,
      family_link_code = null,
      is_active = false,
      must_change_password = false,
      deleted_at = now(),
      deleted_by = p_actor_id,
      updated_at = now()
  where id = p_target_id;

  insert into public.admin_audit_logs (actor_id, target_user_id, action, metadata)
  values (
    p_actor_id,
    p_target_id,
    'account.personal_data_deleted',
    jsonb_build_object('target_id', p_target_id, 'mode', 'anonymized')
  );

  return jsonb_build_object(
    'success', true,
    'target_id', p_target_id,
    'anonymous_username', anonymous_username
  );
end;
$$;

revoke all on function public.admin_anonymize_user_account(uuid, uuid) from public, anon, authenticated;
grant execute on function public.admin_anonymize_user_account(uuid, uuid) to service_role;

