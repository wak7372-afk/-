import { createClient } from 'npm:@supabase/supabase-js@2';
import webpush from 'npm:web-push@3.6.7';

const supabaseUrl = Deno.env.get('SUPABASE_URL') ?? '';
const publishableKey = Deno.env.get('SUPABASE_ANON_KEY') ?? Deno.env.get('SUPABASE_PUBLISHABLE_KEY') ?? '';
const secretKey = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY') ?? Deno.env.get('SUPABASE_SECRET_KEY') ?? '';
const appOrigin = Deno.env.get('APP_ORIGIN') ?? 'https://thatkail.vercel.app';
const vapidPublicKey = Deno.env.get('VAPID_PUBLIC_KEY') ?? '';
const vapidPrivateKey = Deno.env.get('VAPID_PRIVATE_KEY') ?? '';
const vapidSubject = Deno.env.get('VAPID_SUBJECT') ?? 'mailto:admin@thatkail.vercel.app';
const cronSecret = Deno.env.get('PUSH_CRON_SECRET') ?? '';

const trustedOrigins = new Set([appOrigin, 'https://zat-khail.vercel.app', 'https://thatkail.vercel.app']);

function corsHeaders(request: Request) {
  const origin = request.headers.get('Origin') ?? '';
  const isLocal = /^http:\/\/(localhost|127\.0\.0\.1)(:\d+)?$/.test(origin);
  return {
    'Access-Control-Allow-Origin': trustedOrigins.has(origin) || isLocal ? origin : appOrigin,
    'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type, x-cron-secret',
    'Access-Control-Allow-Methods': 'POST, OPTIONS',
    'Vary': 'Origin',
  };
}

function json(request: Request, body: Record<string, unknown>, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { ...corsHeaders(request), 'Content-Type': 'application/json' },
  });
}

function configured() {
  return Boolean(supabaseUrl && publishableKey && secretKey && vapidPublicKey && vapidPrivateKey && cronSecret);
}

async function authenticatedUser(request: Request) {
  const authorization = request.headers.get('Authorization');
  if (!authorization) return null;
  const client = createClient(supabaseUrl, publishableKey, {
    global: { headers: { Authorization: authorization } },
    auth: { autoRefreshToken: false, persistSession: false },
  });
  const { data, error } = await client.auth.getUser();
  return error ? null : data.user;
}

function privatePushPayload(type: string | null, actionUrl: string | null) {
  if (type === 'direct_message') {
    return { title: 'رسالة جديدة', body: 'وصلتك رسالة جديدة داخل مركز ذات خيل.', type, url: actionUrl || '/' };
  }
  if (type === 'circle_post') {
    return { title: 'تحديث جديد في الحلقة', body: 'نُشر تحديث جديد في إحدى حلقاتك.', type, url: actionUrl || '/circles.html' };
  }
  if (type === 'quran_daily_reminder') {
    return { title: 'تذكير بتقرير القرآن', body: 'تقريرك اليومي ينتظر الإنجاز.', type, url: actionUrl || '/student/reports.html' };
  }
  return { title: 'إشعار جديد', body: 'لديك تحديث جديد داخل مركز ذات خيل.', type: type || 'system', url: actionUrl || '/' };
}

async function dispatchPushNotifications(request: Request) {
  if (!cronSecret || request.headers.get('x-cron-secret') !== cronSecret) {
    return json(request, { error: 'Invalid scheduler credentials' }, 401);
  }
  if (!configured()) return json(request, { error: 'Push configuration is incomplete' }, 503);

  webpush.setVapidDetails(vapidSubject, vapidPublicKey, vapidPrivateKey);
  const admin = createClient(supabaseUrl, secretKey, { auth: { autoRefreshToken: false, persistSession: false } });
  const { error: reminderError } = await admin.rpc('enqueue_due_quran_report_reminders');
  if (reminderError) console.error('Unable to enqueue report reminders:', reminderError);

  const { data: claimedIds, error: claimError } = await admin.rpc('claim_push_deliveries', { p_limit: 100 });
  if (claimError) return json(request, { error: claimError.message }, 500);
  if (!Array.isArray(claimedIds) || !claimedIds.length) {
    return json(request, { ok: true, sent: 0, failed: 0 });
  }

  const { data: deliveries, error: deliveryError } = await admin
    .from('notification_deliveries')
    .select('id, attempts, notification:notifications(type, action_url), subscription:push_subscriptions(id, endpoint, p256dh, auth_secret)')
    .in('id', claimedIds);
  if (deliveryError) return json(request, { error: deliveryError.message }, 500);

  let sent = 0;
  let failed = 0;
  for (const delivery of deliveries || []) {
    const notification = Array.isArray(delivery.notification) ? delivery.notification[0] : delivery.notification;
    const subscription = Array.isArray(delivery.subscription) ? delivery.subscription[0] : delivery.subscription;
    if (!notification || !subscription) {
      await markFailed(admin, delivery.id, delivery.attempts, 'Missing notification or subscription');
      failed += 1;
      continue;
    }
    try {
      await webpush.sendNotification({
        endpoint: subscription.endpoint,
        keys: { p256dh: subscription.p256dh, auth: subscription.auth_secret },
      }, JSON.stringify(privatePushPayload(notification.type, notification.action_url)), {
        TTL: notification.type === 'quran_daily_reminder' ? 21600 : 86400,
      });
      await admin.from('notification_deliveries').update({ status: 'sent', sent_at: new Date().toISOString(), claimed_at: null }).eq('id', delivery.id);
      await admin.from('push_subscriptions').update({ last_used_at: new Date().toISOString() }).eq('id', subscription.id);
      sent += 1;
    } catch (error) {
      const pushError = error as { statusCode?: number; message?: string };
      const statusCode = Number(pushError.statusCode || 0);
      if ([404, 410].includes(statusCode)) {
        await admin.from('push_subscriptions').update({ disabled_at: new Date().toISOString() }).eq('id', subscription.id);
      }
      await markFailed(admin, delivery.id, delivery.attempts, String(pushError.message || error));
      failed += 1;
    }
  }

  return json(request, { ok: true, sent, failed, reminderWarning: reminderError?.message || null });
}

async function markFailed(admin: ReturnType<typeof createClient>, deliveryId: string, attempts: number, message: string) {
  const retryMinutes = Math.min(60, 2 ** Math.min(Number(attempts || 1), 5));
  await admin.from('notification_deliveries').update({
    status: 'failed',
    next_attempt_at: new Date(Date.now() + retryMinutes * 60_000).toISOString(),
    claimed_at: null,
    error_message: message.slice(0, 500),
  }).eq('id', deliveryId);
}

Deno.serve(async request => {
  if (request.method === 'OPTIONS') return new Response('ok', { headers: corsHeaders(request) });
  if (request.method !== 'POST') return json(request, { error: 'Method not allowed' }, 405);

  let body: Record<string, unknown> = {};
  try { body = await request.json(); } catch { body = {}; }
  if (body.action === 'dispatch') return dispatchPushNotifications(request);

  if (!supabaseUrl || !publishableKey || !vapidPublicKey) {
    return json(request, { error: 'Push configuration is incomplete' }, 503);
  }
  const user = await authenticatedUser(request);
  if (!user) return json(request, { error: 'يجب تسجيل الدخول.' }, 401);

  return json(request, { enabled: true, publicKey: vapidPublicKey });
});
