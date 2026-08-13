-- Keep conflict checks and approval available when source-file archival is unavailable.

create or replace function public.attach_quran_report_import_file(
  p_batch_id uuid,
  p_storage_path text
)
returns void
language plpgsql
security definer
set search_path = pg_catalog, public
set row_security = off
as $$
declare
  batch_record public.quran_report_import_batches%rowtype;
begin
  select * into batch_record
  from public.quran_report_import_batches
  where id = p_batch_id
  for update;

  if batch_record.id is null then
    raise exception 'Quran report import batch not found';
  end if;
  if not public.can_manage_quran_reports(batch_record.circle_id) then
    raise exception 'Not allowed to archive this Quran report import' using errcode = '42501';
  end if;
  if batch_record.status <> 'staged' then
    raise exception 'Only staged Quran report imports may receive an archive file';
  end if;
  if public.learning_circle_id_from_storage_path(p_storage_path) is distinct from batch_record.circle_id
     or split_part(p_storage_path, '/', 2) <> auth.uid()::text
     or not exists (
       select 1
       from storage.objects object
       where object.bucket_id = 'quran-report-imports'
         and object.name = p_storage_path
         and object.owner_id = auth.uid()::text
     ) then
    raise exception 'The stored Excel file does not belong to this actor and Quran circle' using errcode = '42501';
  end if;

  update public.quran_report_import_batches
  set storage_path = p_storage_path,
      metadata = coalesce(metadata, '{}'::jsonb) || jsonb_build_object('source_file_archived', true)
  where id = p_batch_id;

  perform public.record_platform_audit(
    batch_record.circle_id,
    'quran_reports.import_file_archived',
    'quran_report_import_batch',
    p_batch_id::text,
    null,
    jsonb_build_object('storage_path', p_storage_path)
  );
end;
$$;

revoke all on function public.attach_quran_report_import_file(uuid, text) from public, anon, authenticated;
grant execute on function public.attach_quran_report_import_file(uuid, text) to authenticated, service_role;
