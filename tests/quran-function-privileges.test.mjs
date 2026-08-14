import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import test from 'node:test';

const root = path.resolve(import.meta.dirname, '..');
const migration = [
  '0019_quran_function_privilege_hardening.sql',
  '0020_resilient_quran_report_import_archive.sql',
  '0021_quran_report_visibility_and_review.sql',
  '0024_quran_student_accounting_analytics.sql',
].map(file => fs.readFileSync(path.join(root, 'supabase/migrations', file), 'utf8')).join('\n');

test('Quran report functions explicitly revoke anonymous execution', () => {
  const functions = [
    'stage_quran_report_import(uuid, text, bigint, text, jsonb, text, uuid[], text, jsonb)',
    'attach_quran_report_import_file(uuid, text)',
    'get_my_quran_reports(date, date)',
    'complete_quran_report_assignment(uuid)',
    'request_quran_report_extension(uuid[], integer, text)',
    'get_quran_teacher_console(uuid, date)',
    'decide_quran_report_extension(uuid, jsonb)',
    'exempt_quran_report_assignment(uuid, text)',
    'publish_quran_daily_summaries(date, uuid)',
    'get_my_quran_report_overview()',
    'get_quran_approved_report_plan(uuid, date, date)',
  ];

  for (const signature of functions) {
    assert.ok(
      migration.includes(`revoke all on function public.${signature} from public, anon, authenticated;`),
      `${signature} must revoke anonymous execution`,
    );
  }
});

test('only authenticated server operations regain execution access', () => {
  assert.match(migration, /alter default privileges for role postgres in schema public[\s\S]*revoke execute on functions from public, anon, authenticated/);
  assert.match(migration, /grant execute on function public\.get_my_quran_reports\(date, date\) to authenticated, service_role/);
  assert.match(migration, /grant execute on function public\.publish_quran_daily_summaries\(date, uuid\) to authenticated, service_role/);
  assert.match(migration, /grant execute on function public\.get_my_quran_report_overview\(\) to authenticated, service_role/);
  assert.match(migration, /grant execute on function public\.get_quran_approved_report_plan\(uuid, date, date\) to authenticated, service_role/);
  assert.doesNotMatch(migration, /grant execute on function public\.[^;]+ to anon/);
});

test('internal trigger and summary helpers are not re-granted to clients', () => {
  const internalFunctions = [
    'touch_quran_report_record()',
    'protect_quran_report_history()',
    'validate_quran_report_assignment()',
    'prevent_quran_daily_summary_run_changes()',
    'get_quran_daily_summary_snapshot(uuid, date, timestamptz)',
    'quran_daily_summary_group_text(text, text, jsonb)',
  ];

  for (const signature of internalFunctions) {
    assert.ok(migration.includes(`revoke all on function public.${signature} from public, anon, authenticated;`));
    assert.ok(!migration.includes(`grant execute on function public.${signature}`));
  }
});
