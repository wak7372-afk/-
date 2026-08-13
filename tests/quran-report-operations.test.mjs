import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import test from 'node:test';

const root = path.resolve(import.meta.dirname, '..');
const migration = [
  '0017_quran_report_operations.sql',
  '0021_quran_report_visibility_and_review.sql',
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

test('students can discover future plans and teachers can review approved reports', () => {
  assert.match(migration, /function public\.get_my_quran_report_overview\(\)/);
  assert.match(migration, /'focus_date'/);
  assert.match(migration, /min\(report_date\) filter \(where status = 'pending' and report_date > today_value\)/);
  assert.match(migration, /function public\.get_quran_approved_report_plan\(/);
  assert.match(migration, /can_review_quran_reports\(p_circle_id\)/);
  assert.match(migration, /assigned_count/);
});
