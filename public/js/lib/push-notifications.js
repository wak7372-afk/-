import { supabase } from './supabase-client.js';
import { isLocalPreviewMode } from './auth.js';

const PREVIEW_KEY = 'zat-khail-notification-preferences';

export function pushSupport() {
  const supported = 'serviceWorker' in navigator && 'PushManager' in window && 'Notification' in window;
  return {
    supported,
    permission: supported ? Notification.permission : 'unsupported',
    standalone: window.matchMedia?.('(display-mode: standalone)').matches || window.navigator.standalone === true,
  };
}

export async function loadNotificationPreferences(userId) {
  const defaults = defaultPreferences(userId);
  if (isLocalPreviewMode()) {
    try { return { ...defaults, ...JSON.parse(localStorage.getItem(PREVIEW_KEY) || '{}') }; } catch { return defaults; }
  }
  const { data, error } = await supabase.from('notification_preferences').select('*').eq('user_id', userId).maybeSingle();
  if (error) throw error;
  return { ...defaults, ...(data || {}) };
}

export async function saveNotificationPreferences(preferences) {
  const clean = {
    user_id: preferences.user_id,
    push_enabled: Boolean(preferences.push_enabled),
    report_reminders: Boolean(preferences.report_reminders),
    direct_messages: Boolean(preferences.direct_messages),
    circle_updates: Boolean(preferences.circle_updates),
    daily_report_time: normalizeTime(preferences.daily_report_time),
    timezone: 'Asia/Muscat',
  };
  if (isLocalPreviewMode()) {
    localStorage.setItem(PREVIEW_KEY, JSON.stringify(clean));
    return clean;
  }
  const { data, error } = await supabase.from('notification_preferences').upsert(clean, { onConflict: 'user_id' }).select().single();
  if (error) throw error;
  return data;
}

export async function enablePushNotifications(userId) {
  const support = pushSupport();
  if (!support.supported) throw new Error('هذا المتصفح لا يدعم إشعارات الهاتف.');
  const permission = await Notification.requestPermission();
  if (permission !== 'granted') throw new Error('لم يتم السماح بالإشعارات من إعدادات المتصفح.');

  if (isLocalPreviewMode()) {
    const preferences = await saveNotificationPreferences({ ...defaultPreferences(userId), push_enabled: true });
    return { preferences, subscription: null };
  }

  const { data: config, error: configError } = await supabase.functions.invoke('push-notifications', { body: { action: 'config' } });
  if (configError || !config?.publicKey) throw new Error('خدمة إشعارات الهاتف غير مهيأة بعد.');

  const registration = await navigator.serviceWorker.register('/service-worker.js');
  await navigator.serviceWorker.ready;
  let subscription = await registration.pushManager.getSubscription();
  if (!subscription) {
    subscription = await registration.pushManager.subscribe({
      userVisibleOnly: true,
      applicationServerKey: urlBase64ToUint8Array(config.publicKey),
    });
  }
  const serialized = subscription.toJSON();
  const { error: subscriptionError } = await supabase.from('push_subscriptions').upsert({
    user_id: userId,
    endpoint: serialized.endpoint,
    p256dh: serialized.keys?.p256dh,
    auth_secret: serialized.keys?.auth,
    user_agent: navigator.userAgent.slice(0, 500),
    disabled_at: null,
    last_used_at: new Date().toISOString(),
  }, { onConflict: 'endpoint' });
  if (subscriptionError) throw subscriptionError;

  const current = await loadNotificationPreferences(userId);
  const preferences = await saveNotificationPreferences({ ...current, push_enabled: true });
  return { preferences, subscription };
}

export async function disablePushNotifications(userId) {
  if (!pushSupport().supported) return saveNotificationPreferences({ ...defaultPreferences(userId), push_enabled: false });
  const registration = await navigator.serviceWorker.getRegistration('/');
  const subscription = await registration?.pushManager.getSubscription();
  if (!isLocalPreviewMode() && subscription?.endpoint) {
    const { error } = await supabase.from('push_subscriptions')
      .update({ disabled_at: new Date().toISOString() })
      .eq('user_id', userId)
      .eq('endpoint', subscription.endpoint);
    if (error) throw error;
  }
  if (subscription) await subscription.unsubscribe();
  const current = await loadNotificationPreferences(userId);
  return saveNotificationPreferences({ ...current, push_enabled: false });
}

function defaultPreferences(userId) {
  return {
    user_id: userId,
    push_enabled: false,
    report_reminders: true,
    direct_messages: true,
    circle_updates: true,
    daily_report_time: '08:00',
    timezone: 'Asia/Muscat',
  };
}

function normalizeTime(value) {
  return /^([01]\d|2[0-3]):[0-5]\d$/.test(String(value || '')) ? String(value) : '08:00';
}

function urlBase64ToUint8Array(value) {
  const padding = '='.repeat((4 - (value.length % 4)) % 4);
  const base64 = (value + padding).replace(/-/g, '+').replace(/_/g, '/');
  const raw = atob(base64);
  return Uint8Array.from([...raw].map(character => character.charCodeAt(0)));
}
