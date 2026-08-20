-- The formatter uses PostgreSQL formatting helpers that are STABLE, so the
-- wrapper must not promise IMMUTABLE behavior to the query planner.

alter function public.quran_daily_summary_group_text(text, text, jsonb) stable;

