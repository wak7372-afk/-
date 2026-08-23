import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import test from 'node:test';

const root = path.resolve(import.meta.dirname, '..');
const migration = fs.readFileSync(
  path.join(root, 'supabase/migrations/0014_learning_circle_workspace.sql'),
  'utf8',
);
const workspaceCss = fs.readFileSync(path.join(root, 'public/css/circles.css'), 'utf8');
const workspacePage = fs.readFileSync(path.join(root, 'public/circle.html'), 'utf8');
const workspaceScript = fs.readFileSync(path.join(root, 'public/js/pages/circle-workspace.js'), 'utf8');

test('circle workspace creates posts, replies, files, and a private bucket', () => {
  for (const table of [
    'learning_circle_posts',
    'learning_circle_post_replies',
    'learning_circle_files',
  ]) {
    assert.match(migration, new RegExp(`create table if not exists public\\.${table}`, 'i'));
    assert.match(migration, new RegExp(`alter table public\\.${table} enable row level security`, 'i'));
  }
  assert.match(migration, /'circle-files', 'circle-files', false, 20971520/i);
});

test('workspace tables remain read-only and writes use audited RPCs', () => {
  for (const table of [
    'learning_circle_posts',
    'learning_circle_post_replies',
    'learning_circle_files',
  ]) {
    assert.match(migration, new RegExp(`revoke all on public\\.${table} from anon, authenticated`, 'i'));
    assert.match(migration, new RegExp(`grant select on public\\.${table} to authenticated`, 'i'));
  }
  assert.doesNotMatch(migration, /grant\s+(?:insert|update|delete|all).*learning_circle_(?:posts|post_replies|files).*authenticated/i);
  assert.ok((migration.match(/perform public\.record_platform_audit/g) || []).length >= 7);
});

test('Quran student discussion settings are forced off server-side', () => {
  assert.match(migration, /circle_record\.circle_type = 'quran' then false else coalesce\(p_students_can_create_topics/i);
  assert.match(migration, /circle_record\.circle_type = 'quran' then false else coalesce\(p_students_can_reply/i);
  assert.match(migration, /if circle_record\.circle_type = 'quran' then effective_replies := false/i);
});

test('workspace permissions respect lead and delegated assistant flags', () => {
  assert.match(migration, /can_post_announcements.*staff_record\.can_post_announcements/is);
  assert.match(migration, /can_manage_meet_link.*staff_record\.can_manage_meet_link/is);
  assert.match(migration, /can_manage_discussions.*staff_record\.can_manage_discussions/is);
  assert.match(migration, /has_learning_circle_permission\(p_circle_id, 'post_announcements'\)/i);
  assert.match(migration, /has_learning_circle_permission\(p_circle_id, 'manage_discussions'\)/i);
});

test('circle storage paths bind uploads to both circle and authenticated uploader', () => {
  assert.match(migration, /learning_circle_id_from_storage_path\(p_storage_path\).*p_circle_id/is);
  assert.match(migration, /split_part\(p_storage_path, '\/', 2\) <> auth\.uid\(\)::text/i);
  assert.match(migration, /\(storage\.foldername\(name\)\)\[2\] = auth\.uid\(\)::text/i);
  assert.match(migration, /can_access_learning_circle\(public\.learning_circle_id_from_storage_path\(name\)\)/i);
});

test('circle workspace keeps hidden controls hidden and collapses safely on mobile', () => {
  assert.match(workspaceCss, /\.workspace-field\[hidden\][^{]*\{\s*display:\s*none/i);
  assert.match(workspaceCss, /@media\s*\(max-width:\s*760px\)[\s\S]*\.workspace-tabs\s*\{[^}]*position:\s*fixed/i);
  assert.match(workspaceCss, /@media\s*\(max-width:\s*760px\)[\s\S]*\.people-layout,[\s\S]*\.settings-layout\s*\{[^}]*grid-template-columns:\s*1fr/i);
  assert.match(workspaceCss, /@media\s*\(max-width:\s*760px\)[\s\S]*\.workspace-files-list\s*\{[^}]*grid-template-columns:\s*1fr/i);
  assert.match(workspaceCss, /\.circle-workspace-shell\s*\{[^}]*padding-bottom:\s*88px/i);
});

test('circle workspace follows direct and in-page tab hashes', () => {
  assert.match(workspacePage, /circle-workspace\.js\?v=17/);
  assert.match(workspaceScript, /window\.addEventListener\('hashchange'/);
  assert.match(workspaceScript, /requestedTab !== state\.activeTab/);
});
