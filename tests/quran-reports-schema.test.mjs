import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import test from 'node:test';

const root = path.resolve(import.meta.dirname, '..');
const core = fs.readFileSync(
  path.join(root, 'supabase/migrations/0015_quran_reports_core.sql'),
  'utf8',
);
const security = fs.readFileSync(
  path.join(root, 'supabase/migrations/0016_quran_reports_security.sql'),
  'utf8',
);

const quranTables = [
  'quran_report_import_batches',
  'quran_report_import_recipients',
  'quran_report_import_rows',
  'quran_reports',
  'quran_report_assignments',
  'quran_report_versions',
  'quran_report_assignment_events',
  'quran_report_extension_requests',
  'quran_report_extension_items',
  'quran_daily_summaries',
];

test('Quran report schema is additive and preserves legacy assignments', () => {
  for (const table of quranTables) {
    assert.match(core, new RegExp(`create table if not exists public\\.${table}`, 'i'));
  }
  assert.doesNotMatch(core, /drop table/i);
  assert.doesNotMatch(core, /truncate\s+public\./i);
  assert.doesNotMatch(core, /delete\s+from\s+public\./i);
  assert.doesNotMatch(core, /alter table public\.(?:daily_assignments|assignment_submissions)/i);
});

test('daily Quran reports use one Muscat window and fixed 4-3-3 points', () => {
  assert.match(core, /quran_report_start_time time not null default '00:00'/i);
  assert.match(core, /quran_report_due_time time not null default '23:00'/i);
  assert.match(core, /quran_daily_summary_time time not null default '23:05'/i);
  assert.match(core, /when 'hifz' then 4\.00 else 3\.00/i);
  assert.match(core, /function public\.quran_report_points_at/i);
  assert.match(core, /round\([\s\S]*p_max_points[\s\S]*p_due_at - p_at[\s\S]*2\s*\)/i);
});

test('active assignment uniqueness prevents silent student-plan conflicts', () => {
  assert.match(core, /quran_report_one_active_assignment_idx/i);
  assert.match(core, /student_id, report_date, task_type/i);
  assert.match(core, /where status in \('pending', 'completed', 'exempted'\)/i);
  assert.match(security, /The import conflicts with existing student plans/i);
  assert.match(security, /Completed or exempted reports cannot be replaced/i);
  assert.match(security, /p_conflict_strategy not in \('reject', 'replace', 'skip'\)/i);
});

test('Excel staging snapshots active recipients and approves atomically', () => {
  assert.match(security, /function public\.stage_quran_report_import/i);
  assert.match(security, /m\.status = 'active'/i);
  assert.match(security, /recipient_count::bigint \* jsonb_array_length\(p_rows\)::bigint > 250000/i);
  assert.match(security, /function public\.get_quran_report_import_preview/i);
  assert.match(security, /function public\.approve_quran_report_import/i);
  assert.match(security, /function public\.cancel_quran_report_import/i);
  assert.match(security, /The import contains validation errors/i);
  assert.match(security, /quran_reports\.import_staged/i);
  assert.match(security, /quran_reports\.import_approved/i);
});

test('original Excel files use a private, actor-bound storage bucket', () => {
  assert.match(security, /'quran-report-imports',[\s\S]*false,[\s\S]*10485760/i);
  assert.match(security, /Quran report managers upload own import files/i);
  assert.match(security, /split_part\(name, '\/', 2\) = auth\.uid\(\)::text/i);
  assert.match(security, /object\.owner_id = auth\.uid\(\)::text/i);
});

test('Quran report tables are RLS protected and direct writes remain revoked', () => {
  for (const table of quranTables) {
    assert.match(core, new RegExp(`alter table public\\.${table} enable row level security`, 'i'));
    assert.match(core, new RegExp(`revoke all on public\\.${table} from anon, authenticated`, 'i'));
    assert.match(security, new RegExp(`grant select on public\\.${table} to authenticated`, 'i'));
  }
  assert.doesNotMatch(security, /grant\s+(?:insert|update|delete|all)\s+on\s+public\.quran_/i);
});

test('versions and assignment events are immutable', () => {
  assert.match(core, /Quran report history is immutable/i);
  assert.match(core, /before update or delete on public\.quran_report_versions/i);
  assert.match(core, /before update or delete on public\.quran_report_assignment_events/i);
});
