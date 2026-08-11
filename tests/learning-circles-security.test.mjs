import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import test from 'node:test';

const root = path.resolve(import.meta.dirname, '..');
const migration = fs.readFileSync(
  path.join(root, 'supabase/migrations/0012_learning_circles_security.sql'),
  'utf8',
);
const adminOperationsMigration = fs.readFileSync(
  path.join(root, 'supabase/migrations/0013_learning_circle_admin_operations.sql'),
  'utf8',
);

test('learning circle helpers are security definer and bypass recursive RLS safely', () => {
  for (const functionName of [
    'is_learning_circle_staff',
    'is_learning_circle_member',
    'can_access_learning_circle',
    'can_manage_learning_circle',
    'has_learning_circle_permission',
  ]) {
    const start = migration.indexOf(`function public.${functionName}`);
    assert.notEqual(start, -1, `${functionName} must exist`);
    const source = migration.slice(start, start + 900);
    assert.match(source, /security definer/i);
    assert.match(source, /set row_security = off/i);
  }
});

test('authenticated users receive read-only table grants and write through RPCs', () => {
  const domainTables = [
    'learning_circles',
    'learning_circle_subjects',
    'learning_circle_staff',
    'learning_circle_memberships',
    'learning_circle_transfer_requests',
    'learning_circle_settings',
    'platform_audit_events',
  ];
  for (const table of domainTables) {
    assert.match(migration, new RegExp(`revoke all on public\\.${table} from authenticated`, 'i'));
    assert.match(migration, new RegExp(`grant select on public\\.${table} to authenticated`, 'i'));
  }
  assert.doesNotMatch(migration, /grant\s+(?:insert|update|delete|all).*learning_circle.*to authenticated/i);
});

test('server operations enforce admin, lead, and delegated assistant boundaries', () => {
  assert.match(migration, /Only an active administrator may create learning circles/);
  assert.match(migration, /Only an active administrator may assign circle staff/);
  assert.match(migration, /Only the lead teacher or administrator may set assistant permissions/);
  assert.match(migration, /Only the lead teacher or administrator may add students/);
  assert.match(migration, /Only an active administrator may decide Quran transfers/);
  assert.match(migration, /has_learning_circle_permission\(p_circle_id, 'manage_meet_link'\)/);
});

test('administrator circle operations update details and end memberships through audited RPCs', () => {
  assert.match(adminOperationsMigration, /grant select on public\.subjects to authenticated/i);
  assert.match(adminOperationsMigration, /create or replace function public\.update_learning_circle_details\(/i);
  assert.match(adminOperationsMigration, /create or replace function public\.end_learning_circle_membership\(/i);
  assert.match(adminOperationsMigration, /circle\.details_updated/i);
  assert.match(adminOperationsMigration, /circle\.student_removed/i);
  assert.match(adminOperationsMigration, /grant execute on function public\.update_learning_circle_details/i);
  assert.match(adminOperationsMigration, /grant execute on function public\.end_learning_circle_membership/i);
});

test('audit events are immutable and sensitive RPCs record events', () => {
  assert.match(migration, /before update or delete on public\.platform_audit_events/i);
  assert.match(migration, /Platform audit events are immutable/);
  const calls = migration.match(/perform public\.record_platform_audit/g) || [];
  assert.ok(calls.length >= 6, 'sensitive operations should record audit events');
  assert.match(migration, /revoke all on function public\.record_platform_audit[\s\S]*from public/i);
});
