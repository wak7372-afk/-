# Web Push notifications

The implementation keeps message and post content inside the platform. Phone
notifications use generic text and open the authenticated page when tapped.

## Required deployment

1. Apply `0031_web_push_notifications.sql` to the production database.
2. Generate one VAPID key pair and keep the private key out of Git.
3. Configure these Supabase Edge Function secrets:
   - `VAPID_PUBLIC_KEY`
   - `VAPID_PRIVATE_KEY`
   - `VAPID_SUBJECT` such as `mailto:admin@example.com`
   - `PUSH_CRON_SECRET` with a long random value
   - `APP_ORIGIN=https://thatkail.vercel.app`
4. Deploy the `push-notifications` Edge Function with JWT verification enabled.
5. Store `push_cron_secret` and `push_anon_key` in Supabase Vault. Migration
   `0031` installs a Supabase Cron job that invokes the Edge Function every five
   minutes. A notification is queued once per subscription and a sent delivery
   is never claimed again.

Never place the scheduler secret in client JavaScript, Vercel public variables,
or Git. The anonymous key is public by design, but Vault keeps the scheduler
configuration in one protected place.

## Delivery behavior

- Daily Quran reminders use each student's selected Muscat time and are deduplicated per day.
- Direct messages and circle posts create in-app notifications and queued Web Push deliveries.
- Invalid subscriptions are disabled after a `404` or `410` push response.
- Failed deliveries use bounded exponential retry and stale claims are recoverable after 15 minutes.
