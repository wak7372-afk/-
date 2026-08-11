import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import test from 'node:test';

const root = path.resolve(import.meta.dirname, '..');
const migration = fs.readFileSync(
  path.join(root, 'supabase/migrations/0011_learning_circles_core.sql'),
  'utf8',
);

test('learning circle migration preserves legacy tables and backfills them', () => {
  assert.match(migration, /create table if not exists public\.learning_circles/i);
  assert.match(migration, /from public\.halaqat h/i);
  assert.match(migration, /from public\.classrooms c/i);
  assert.doesNotMatch(migration, /drop table\s+(?:if exists\s+)?public\.(?:halaqat|classrooms)/i);
  assert.doesNotMatch(migration, /truncate\s+public\./i);
  assert.doesNotMatch(migration, /delete\s+from\s+public\.(?:halaqat|classrooms)/i);
});

test('learning circle model enforces staff and Quran membership invariants', () => {
  assert.match(migration, /learning_circle_one_active_lead_idx/i);
  assert.match(migration, /learning_circle_active_staff_idx/i);
  assert.match(migration, /learning_circle_one_active_quran_student_idx/i);
  assert.match(migration, /where circle_type = 'quran' and status = 'active'/i);
  assert.match(migration, /sync_learning_circle_membership/i);
  assert.match(migration, /new\.circle_type := resolved_circle_type/i);
});

test('new domain tables enable RLS before they are used by pages', () => {
  const tables = [
    'learning_circles',
    'learning_circle_subjects',
    'learning_circle_staff',
    'learning_circle_memberships',
    'learning_circle_transfer_requests',
    'learning_circle_settings',
    'platform_audit_events',
  ];

  for (const table of tables) {
    assert.match(migration, new RegExp(`alter table public\\.${table} enable row level security`, 'i'));
    assert.match(migration, new RegExp(`revoke all on public\\.${table} from anon`, 'i'));
  }
});
