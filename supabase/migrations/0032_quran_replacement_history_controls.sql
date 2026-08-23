-- Let teachers decide whether superseded pending Quran assignments remain visible
-- in history or are removed from the operational student record.

create or replace function public.approve_quran_report_import_with_history(
  p_batch_id uuid,
  p_conflict_strategy text default 'reject',
  p_replaced_history_action text default 'keep'
)
returns jsonb
language plpgsql
security definer
set search_path = pg_catalog, public
set row_security = off
as $$
declare
  result jsonb;
  stale_assignment_ids uuid[] := '{}'::uuid[];
  stale_report_ids uuid[] := '{}'::uuid[];
  deleted_history_count integer := 0;
  batch_circle_id uuid;
begin
  if p_replaced_history_action not in ('keep', 'delete') then
    raise exception 'Invalid replaced history action';
  end if;
  if p_conflict_strategy <> 'replace' and p_replaced_history_action = 'delete' then
    raise exception 'Deleting replaced history requires the replace conflict strategy';
  end if;

  select circle_id into batch_circle_id
  from public.quran_report_import_batches
  where id = p_batch_id;

  result := public.approve_quran_report_import(p_batch_id, p_conflict_strategy);

  if p_conflict_strategy = 'replace' and p_replaced_history_action = 'delete' then
    with recursive replacement_chain as (
      select previous.id, previous.report_id, previous.replaced_by_assignment_id
      from public.quran_report_assignments previous
      join public.quran_report_assignments current_assignment
        on current_assignment.id = previous.replaced_by_assignment_id
      join public.quran_reports current_report
        on current_report.id = current_assignment.report_id
      where previous.status = 'replaced'
        and current_report.import_batch_id = p_batch_id

      union

      select previous.id, previous.report_id, previous.replaced_by_assignment_id
      from public.quran_report_assignments previous
      join replacement_chain newer on newer.id = previous.replaced_by_assignment_id
      where previous.status = 'replaced'
    )
    select
      coalesce(array_agg(distinct id), '{}'::uuid[]),
      coalesce(array_agg(distinct report_id), '{}'::uuid[])
    into stale_assignment_ids, stale_report_ids
    from replacement_chain;

    deleted_history_count := cardinality(stale_assignment_ids);
    if deleted_history_count > 0 then
      delete from public.quran_report_extension_items
      where assignment_id = any(stale_assignment_ids);

      delete from public.quran_report_extension_requests request
      where request.circle_id = batch_circle_id
        and not exists (
          select 1 from public.quran_report_extension_items item
          where item.request_id = request.id
        );

      update public.quran_report_assignments
      set replaced_by_assignment_id = null
      where id = any(stale_assignment_ids);

      perform pg_catalog.set_config('app.allow_hard_delete', 'on', true);
      delete from public.quran_report_assignments
      where id = any(stale_assignment_ids)
        and status = 'replaced';

      delete from public.quran_reports report
      where report.id = any(stale_report_ids)
        and not exists (
          select 1 from public.quran_report_assignments assignment
          where assignment.report_id = report.id
        );

      perform public.record_platform_audit(
        batch_circle_id,
        'quran_reports.replaced_history_deleted',
        'quran_report_import_batch',
        p_batch_id::text,
        null,
        jsonb_build_object('deleted_assignment_count', deleted_history_count),
        jsonb_build_object('conflict_strategy', p_conflict_strategy)
      );
    end if;
  end if;

  return result || jsonb_build_object(
    'history_action', p_replaced_history_action,
    'deleted_history_count', deleted_history_count
  );
end;
$$;

revoke all on function public.approve_quran_report_import_with_history(uuid, text, text)
  from public, anon, authenticated;
grant execute on function public.approve_quran_report_import_with_history(uuid, text, text)
  to authenticated, service_role;
