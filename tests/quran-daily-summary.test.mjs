import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import test from 'node:test';

const root = path.resolve(import.meta.dirname, '..');
const migration = fs.readFileSync(path.join(root, 'supabase/migrations/0018_quran_daily_summaries.sql'), 'utf8');
const volatilityFix = fs.readFileSync(path.join(root, 'supabase/migrations/0026_quran_summary_function_volatility.sql'), 'utf8');

test('daily summary classifies all approved operational states', () => {
  assert.match(migration, /when has_expired_pending then 'incomplete'/);
  assert.match(migration, /when has_future_pending then 'extended'/);
  assert.match(migration, /when completed_count = 0 and exempted_count > 0 then 'exempted'/);
  assert.match(migration, /when has_late_completion then 'late'/);
  assert.match(migration, /else 'on_time'/);
});

test('daily summary compares completion against each effective deadline', () => {
  assert.match(migration, /assignment\.effective_due_at <= p_as_of/);
  assert.match(migration, /assignment\.effective_due_at > p_as_of/);
  assert.match(migration, /assignment\.completed_at > assignment\.effective_due_at/);
});

test('daily summary posts are idempotent and keep an immutable run ledger', () => {
  assert.match(migration, /primary key \(circle_id, summary_date\)/);
  assert.match(migration, /quran-daily-summary:%s/);
  assert.match(migration, /on conflict \(circle_id, system_key\).*do nothing/s);
  assert.match(migration, /Quran daily summary runs are immutable/);
});

test('manual publication is administrator-only and public execution is revoked', () => {
  assert.match(migration, /auth\.uid\(\) is not null and not public\.is_admin\(\)/);
  assert.match(migration, /current Quran summary may only be published after 23:00 Asia\/Muscat/);
  assert.match(migration, /revoke all on function public\.publish_quran_daily_summaries\(date, uuid\) from public/);
  assert.match(migration, /grant execute on function public\.publish_quran_daily_summaries\(date, uuid\) to authenticated, service_role/);
});

test('the cron job runs at 23:05 Asia Muscat using 19:05 UTC', () => {
  assert.match(migration, /quran-daily-summary-muscat-2305/);
  assert.match(migration, /'5 19 \* \* \*'/);
  assert.match(migration, /time zone 'Asia\/Muscat'/);
  assert.match(migration, /select public\.publish_quran_daily_summaries\(\);/);
});

test('daily summary text formatter uses safe function volatility', () => {
  assert.match(
    volatilityFix,
    /alter function public\.quran_daily_summary_group_text\(text, text, jsonb\) stable;/,
  );
});
