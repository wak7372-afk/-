-- ========================================================
-- Secure administrator bootstrap
-- ========================================================
--
-- This migration intentionally does not create an Auth user. Production
-- credentials must never be stored in source control or SQL migrations.
-- Create the first user through Supabase Auth, then promote that exact UUID
-- by following ADMIN_BOOTSTRAP.md at the project root.

do $$
begin
  raise notice 'Administrator bootstrap skipped: create the Auth user securely, then promote its UUID.';
end $$;
