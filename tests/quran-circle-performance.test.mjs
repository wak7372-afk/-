import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const migration = fs.readFileSync(path.join(root, 'supabase/migrations/0029_quran_circle_performance.sql'), 'utf8');

test('Quran circle performance compares equivalent time windows', () => {
  assert.match(migration, /\('today', 'current', as_of_date, as_of_date\)/);
  assert.match(migration, /\('week', 'previous', as_of_date - 13, as_of_date - 7\)/);
  assert.match(migration, /\('month', 'previous', as_of_date - 59, as_of_date - 30\)/);
  assert.match(migration, /completion_rate_delta/);
  assert.match(migration, /on_time_rate_delta/);
});

test('Quran circle performance treats a report as a complete student-day', () => {
  assert.match(migration, /count\(\*\) filter \(where status = 'pending'\) = 0[\s\S]*as is_complete/);
  assert.match(migration, /count\(day\.student_id\) filter \(where day\.is_complete\)/);
  assert.match(migration, /daily_chart/);
  assert.match(migration, /task_distribution/);
});

test('Quran circle performance includes actionable student progress', () => {
  assert.match(migration, /'latest_progress'/);
  assert.match(migration, /'overdue_count'/);
  assert.match(migration, /'completion_rate_7'/);
  assert.match(migration, /'previous_completion_rate_7'/);
  assert.match(migration, /'completion_rate_30'/);
  assert.match(migration, /from all_assignments assignment[\s\S]*assignment\.status = 'completed'/);
  assert.match(migration, /can_review_quran_reports\(p_circle_id\)/);
  assert.match(migration, /revoke all on function public\.get_quran_circle_performance/);
});
