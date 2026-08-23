import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const migration = fs.readFileSync(path.join(root, 'supabase/migrations/0031_web_push_notifications.sql'), 'utf8');
const edgeFunction = fs.readFileSync(path.join(root, 'supabase/functions/push-notifications/index.ts'), 'utf8');
const serviceWorker = fs.readFileSync(path.join(root, 'public/service-worker.js'), 'utf8');
const settingsHtml = fs.readFileSync(path.join(root, 'public/account-settings.html'), 'utf8');
const settingsScript = fs.readFileSync(path.join(root, 'public/js/pages/account-settings.js'), 'utf8');

test('push notification storage is private and user controlled', () => {
  assert.match(migration, /create table if not exists public\.notification_preferences/);
  assert.match(migration, /create table if not exists public\.push_subscriptions/);
  assert.match(migration, /create table if not exists public\.notification_deliveries/);
  assert.match(migration, /user_id = auth\.uid\(\)/);
  assert.match(migration, /revoke all on public\.notification_preferences, public\.push_subscriptions, public\.notification_deliveries/);
  assert.doesNotMatch(migration, /grant .*notification_deliveries to authenticated/i);
});

test('message and Quran reminder notifications are deduplicated and queued', () => {
  assert.match(migration, /notify_direct_message_receiver/);
  assert.match(migration, /quran_daily_reminder/);
  assert.match(migration, /quran-daily-reminder:/);
  assert.match(migration, /on conflict \(user_id, dedupe_key\)/);
  assert.match(migration, /for update skip locked/);
  assert.match(migration, /grant execute on function public\.claim_push_deliveries\(integer\) to service_role/);
});

test('push delivery scheduler reads protected Vault secrets every five minutes', () => {
  assert.match(migration, /create or replace function public\.dispatch_pending_push_notifications\(\)/);
  assert.match(migration, /from vault\.decrypted_secrets/);
  assert.match(migration, /push_cron_secret/);
  assert.match(migration, /push_anon_key/);
  assert.match(migration, /'\*\/5 \* \* \* \*'/);
  assert.doesNotMatch(migration, /Bearer eyJ/);
});

test('phone payloads do not expose stored message or post content', () => {
  assert.match(edgeFunction, /privatePushPayload/);
  assert.match(edgeFunction, /لديك رسالة جديدة|وصلتك رسالة جديدة/);
  assert.doesNotMatch(edgeFunction, /notification\.body/);
  assert.doesNotMatch(edgeFunction, /notification\.title/);
  assert.match(edgeFunction, /x-cron-secret/);
});

test('service worker displays and safely opens push destinations', () => {
  assert.match(serviceWorker, /self\.addEventListener\('push'/);
  assert.match(serviceWorker, /self\.addEventListener\('notificationclick'/);
  assert.match(serviceWorker, /requested\.origin === self\.location\.origin/);
});

test('account notification controls reference existing elements', () => {
  const ids = new Set([...settingsHtml.matchAll(/\sid="([^"]+)"/g)].map(match => match[1]));
  const references = [...settingsScript.matchAll(/getElementById\('([^']+)'\)/g)].map(match => match[1]);
  assert.deepEqual([...new Set(references.filter(id => !ids.has(id)))], []);
  assert.match(settingsHtml, /id="notify-report-reminders"/);
  assert.match(settingsHtml, /id="notify-direct-messages"/);
  assert.match(settingsHtml, /id="notify-circle-updates"/);
});
