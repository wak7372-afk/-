-- Remove Supabase's default anonymous EXECUTE grants from the Quran report surface.

alter default privileges for role postgres in schema public
  revoke execute on functions from public, anon, authenticated;

revoke all on function public.touch_quran_report_record() from public, anon, authenticated;
revoke all on function public.protect_quran_report_history() from public, anon, authenticated;
revoke all on function public.validate_quran_report_assignment() from public, anon, authenticated;

revoke all on function public.can_manage_quran_reports(uuid) from public, anon, authenticated;
revoke all on function public.can_view_quran_report(uuid) from public, anon, authenticated;
revoke all on function public.can_view_quran_assignment(uuid) from public, anon, authenticated;
revoke all on function public.quran_report_local_timestamp(date, time, text) from public, anon, authenticated;
revoke all on function public.quran_report_points_at(numeric, timestamptz, timestamptz, timestamptz) from public, anon, authenticated;
revoke all on function public.stage_quran_report_import(uuid, text, bigint, text, jsonb, text, uuid[], text, jsonb) from public, anon, authenticated;
revoke all on function public.get_quran_report_import_preview(uuid) from public, anon, authenticated;
revoke all on function public.approve_quran_report_import(uuid, text) from public, anon, authenticated;
revoke all on function public.cancel_quran_report_import(uuid) from public, anon, authenticated;

grant execute on function public.can_manage_quran_reports(uuid) to authenticated, service_role;
grant execute on function public.can_view_quran_report(uuid) to authenticated, service_role;
grant execute on function public.can_view_quran_assignment(uuid) to authenticated, service_role;
grant execute on function public.quran_report_local_timestamp(date, time, text) to authenticated, service_role;
grant execute on function public.quran_report_points_at(numeric, timestamptz, timestamptz, timestamptz) to authenticated, service_role;
grant execute on function public.stage_quran_report_import(uuid, text, bigint, text, jsonb, text, uuid[], text, jsonb) to authenticated, service_role;
grant execute on function public.get_quran_report_import_preview(uuid) to authenticated, service_role;
grant execute on function public.approve_quran_report_import(uuid, text) to authenticated, service_role;
grant execute on function public.cancel_quran_report_import(uuid) to authenticated, service_role;

revoke all on function public.can_review_quran_reports(uuid) from public, anon, authenticated;
revoke all on function public.quran_report_completion_band(timestamptz, timestamptz, timestamptz) from public, anon, authenticated;
revoke all on function public.get_my_quran_reports(date, date) from public, anon, authenticated;
revoke all on function public.complete_quran_report_assignment(uuid) from public, anon, authenticated;
revoke all on function public.request_quran_report_extension(uuid[], integer, text) from public, anon, authenticated;
revoke all on function public.get_quran_teacher_console(uuid, date) from public, anon, authenticated;
revoke all on function public.get_quran_student_history(uuid, uuid, integer, integer) from public, anon, authenticated;
revoke all on function public.get_quran_extension_queue(uuid, text) from public, anon, authenticated;
revoke all on function public.decide_quran_report_extension(uuid, jsonb) from public, anon, authenticated;
revoke all on function public.exempt_quran_report_assignment(uuid, text) from public, anon, authenticated;

grant execute on function public.can_review_quran_reports(uuid) to authenticated, service_role;
grant execute on function public.quran_report_completion_band(timestamptz, timestamptz, timestamptz) to authenticated, service_role;
grant execute on function public.get_my_quran_reports(date, date) to authenticated, service_role;
grant execute on function public.complete_quran_report_assignment(uuid) to authenticated, service_role;
grant execute on function public.request_quran_report_extension(uuid[], integer, text) to authenticated, service_role;
grant execute on function public.get_quran_teacher_console(uuid, date) to authenticated, service_role;
grant execute on function public.get_quran_student_history(uuid, uuid, integer, integer) to authenticated, service_role;
grant execute on function public.get_quran_extension_queue(uuid, text) to authenticated, service_role;
grant execute on function public.decide_quran_report_extension(uuid, jsonb) to authenticated, service_role;
grant execute on function public.exempt_quran_report_assignment(uuid, text) to authenticated, service_role;

revoke all on function public.prevent_quran_daily_summary_run_changes() from public, anon, authenticated;
revoke all on function public.get_quran_daily_summary_snapshot(uuid, date, timestamptz) from public, anon, authenticated;
revoke all on function public.quran_daily_summary_group_text(text, text, jsonb) from public, anon, authenticated;
revoke all on function public.publish_quran_daily_summaries(date, uuid) from public, anon, authenticated;

grant execute on function public.publish_quran_daily_summaries(date, uuid) to authenticated, service_role;
