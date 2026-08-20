import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import test from 'node:test';

const root = path.resolve(import.meta.dirname, '..');
const migration = [
  '0017_quran_report_operations.sql',
  '0021_quran_report_visibility_and_review.sql',
  '0022_quran_student_plan_adjustments.sql',
  '0023_quran_approved_report_management.sql',
  '0024_quran_student_accounting_analytics.sql',
  '0030_quran_plan_shift_requests.sql',
].map(file => fs.readFileSync(path.join(root, 'supabase/migrations', file), 'utf8')).join('\n');

test('student completion is server-side, scored, and blocked by older overdue reports', () => {
  assert.match(migration, /function public\.complete_quran_report_assignment\(p_assignment_id uuid\)/);
  assert.match(migration, /completed_at_value < assignment_record\.starts_at/);
  assert.match(migration, /blocker\.effective_due_at < completed_at_value/);
  assert.match(migration, /blocker\.report_date < assignment_record\.report_date/);
  assert.match(migration, /quran_report_points_at\(/);
  assert.match(migration, /quran_report_completion_band\(/);
});

test('completion bands implement early, middle, late-on-time, and late states', () => {
  assert.match(migration, /then 'late'/);
  assert.match(migration, /then 'early'/);
  assert.match(migration, /then 'middle'/);
  assert.match(migration, /else 'late_on_time'/);
});

test('teacher accounting uses the effective deadline and exposes operational daily states', () => {
  assert.match(migration, /assignment\.effective_due_at > assignment\.original_due_at as deadline_extended/);
  assert.match(migration, /when report_count = 0 then 'no_reports'/);
  assert.match(migration, /when overdue_today_count > 0 then 'overdue'/);
  assert.match(migration, /when pending_count > 0 and completed_count > 0 then 'partial'/);
  assert.match(migration, /when late_completion_count > 0 then 'completed_late'/);
  assert.match(migration, /'attention_students'/);
});

test('student history exposes 7, 30, and 90 day analytics with progress and audit events', () => {
  assert.match(migration, /from \(values \(7\), \(30\), \(90\)\) period\(period_days\)/);
  assert.match(migration, /as completion_rate/);
  assert.match(migration, /as on_time_rate/);
  assert.match(migration, /'latest_progress'/);
  assert.match(migration, /'recent_events'/);
  assert.match(migration, /'rescheduled', 'skipped', 'report_updated', 'report_cancelled'/);
});

test('extension requests support multiple reports and a 72-hour maximum', () => {
  assert.match(migration, /p_assignment_ids uuid\[\]/);
  assert.match(migration, /not between 1 and 4320/);
  assert.match(migration, /quran_extension_one_pending_per_assignment_idx/);
  assert.match(migration, /jsonb_array_elements\(p_decisions\)/);
  assert.match(migration, /action_value = 'approve'/);
  assert.match(migration, /action_value = 'reject'/);
});

test('approved extension starts after the current deadline or decision time', () => {
  assert.match(migration, /base_value := greatest\(assignment_record\.effective_due_at, now\(\)\)/);
  assert.match(migration, /base_value \+ make_interval\(mins => minutes_value\)/);
  assert.match(migration, /base_value \+ interval '72 hours'/);
});

test('student-requested plan shifts are reviewed and applied by the lead teacher', () => {
  assert.match(migration, /create table if not exists public\.quran_plan_shift_requests/);
  assert.match(migration, /quran_plan_shift_one_pending_idx/);
  assert.match(migration, /function public\.request_quran_plan_shift\(/);
  assert.match(migration, /function public\.get_quran_plan_shift_queue\(/);
  assert.match(migration, /function public\.decide_quran_plan_shift_request\(/);
  assert.match(migration, /public\.adjust_quran_student_plan\(/);
  assert.match(migration, /Only the lead teacher or administrator may decide Quran plan shift requests/);
});

test('teacher review and exemption require delegated review permission', () => {
  assert.match(migration, /has_learning_circle_permission\(p_circle_id, 'review_submissions'\)/);
  assert.match(migration, /function public\.exempt_quran_report_assignment/);
  assert.match(migration, /status = 'exempted'/);
  assert.match(migration, /quran_reports\.assignment_exempted/);
});

test('all report operations revoke public access and grant authenticated execution only', () => {
  const functions = [
    'get_my_quran_reports(date, date)',
    'complete_quran_report_assignment(uuid)',
    'request_quran_report_extension(uuid[], integer, text)',
    'get_quran_teacher_console(uuid, date)',
    'get_quran_student_history(uuid, uuid, integer, integer)',
    'get_quran_extension_queue(uuid, text)',
    'decide_quran_report_extension(uuid, jsonb)',
    'exempt_quran_report_assignment(uuid, text)',
    'get_my_quran_report_overview()',
    'get_quran_approved_report_plan(uuid, date, date)',
    'adjust_quran_student_plan(uuid, uuid, text, date, date, integer, text, boolean)',
    'get_quran_report_management_details(uuid)',
    'manage_quran_approved_report(uuid, text, date, text, integer, text, text, boolean)',
    'request_quran_plan_shift(date, text)',
    'get_my_quran_plan_shift_requests()',
    'get_quran_plan_shift_queue(uuid, text)',
    'decide_quran_plan_shift_request(uuid, text, date, text)',
  ];
  for (const signature of functions) {
    assert.ok(
      migration.includes(`revoke all on function public.${signature} from public;`)
      || migration.includes(`revoke all on function public.${signature} from public, anon, authenticated;`),
    );
    assert.ok(
      migration.includes(`grant execute on function public.${signature} to authenticated;`)
      || migration.includes(`grant execute on function public.${signature} to authenticated, service_role;`),
    );
  }
});

test('only administrators and lead teachers can adjust an individual Quran plan', () => {
  assert.match(migration, /function public\.can_manage_quran_student_plan\(p_circle_id uuid\)/);
  assert.match(migration, /s\.staff_role = 'lead'/);
  assert.match(migration, /Only the lead teacher or administrator may adjust/);
});

test('student plan adjustment supports preview, shifting, advancing, and immutable audit events', () => {
  assert.match(migration, /function public\.adjust_quran_student_plan\(/);
  assert.match(migration, /action_value not in \('shift', 'advance'\)/);
  assert.match(migration, /if p_dry_run then/);
  assert.match(migration, /'can_apply', conflict_count = 0 and pending_extension_count = 0/);
  assert.match(migration, /'rescheduled'/);
  assert.match(migration, /'skipped'/);
  assert.match(migration, /quran_reports\.student_plan_adjusted/);
});

test('plan changes preserve completed work and block conflicts and pending extensions', () => {
  assert.match(migration, /a\.status = 'pending'/);
  assert.match(migration, /pg_advisory_xact_lock/);
  assert.match(migration, /existing\.status in \('pending', 'completed', 'exempted'\)/);
  assert.match(migration, /Quran plan adjustment conflicts with existing student reports/);
  assert.match(migration, /Quran plan adjustment has pending extension requests/);
});

test('teacher history retains skipped reports while student-active views remain unchanged', () => {
  assert.match(migration, /a\.status in \('pending', 'completed', 'exempted', 'replaced'\)/);
  assert.match(migration, /history_row\.report_date desc/);
});

test('students can discover future plans and teachers can review approved reports', () => {
  assert.match(migration, /function public\.get_my_quran_report_overview\(\)/);
  assert.match(migration, /'focus_date'/);
  assert.match(migration, /min\(report_date\) filter \(where status = 'pending' and report_date > today_value\)/);
  assert.match(migration, /function public\.get_quran_approved_report_plan\(/);
  assert.match(migration, /can_review_quran_reports\(p_circle_id\)/);
  assert.match(migration, /assigned_count/);
});

test('approved Quran reports support protected preview, edit, and cancellation', () => {
  assert.match(migration, /function public\.get_quran_report_management_details\(p_report_id uuid\)/);
  assert.match(migration, /function public\.manage_quran_approved_report\(/);
  assert.match(migration, /action_value not in \('edit', 'cancel'\)/);
  assert.match(migration, /'has_changes', has_changes/);
  assert.match(migration, /if p_dry_run then return result/);
  assert.match(migration, /Only the lead teacher or administrator may manage/);
});

test('approved report edits preserve historical assignments and version their successor', () => {
  assert.match(migration, /add column if not exists root_report_id uuid/);
  assert.match(migration, /add column if not exists supersedes_report_id uuid/);
  assert.match(migration, /split_required := action_value = 'edit' and historical_count > 0/);
  assert.match(migration, /where report_id = report_record\.id and status = 'pending'/);
  assert.match(migration, /root_report_id, supersedes_report_id/);
  assert.match(migration, /insert into public\.quran_report_versions/);
  assert.match(migration, /'report_updated'/);
});

test('approved report management blocks conflicts and pending extensions', () => {
  assert.match(migration, /existing\.status in \('pending', 'completed', 'exempted'\)/);
  assert.match(migration, /pending_extension_count/);
  assert.match(migration, /Approved Quran report edit conflicts with student plans/);
  assert.match(migration, /Approved Quran report has pending extension requests/);
});

test('report assignment ownership and scoring remain immutable during controlled rescheduling', () => {
  assert.match(migration, /ownership and scoring fields are immutable/);
  assert.match(migration, /report_record\.task_type <> new\.task_type/);
  assert.match(migration, /report_record\.max_points <> new\.max_points/);
  assert.match(migration, /set report_id = successor_id/);
});

test('approved report changes are audited and notify affected students', () => {
  assert.match(migration, /quran_reports\.approved_report_edited/);
  assert.match(migration, /quran_reports\.approved_report_cancelled/);
  assert.match(migration, /'تحديث تقرير قرآن'/);
  assert.match(migration, /'إلغاء تقرير قرآن'/);
});
