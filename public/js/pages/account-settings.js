import { supabase } from '../lib/supabase-client.js';
import { getUserProfile, isLocalPreviewMode, redirectUserByRole, requireAuth } from '../lib/auth.js';
import {
  disablePushNotifications,
  enablePushNotifications,
  loadNotificationPreferences,
  pushSupport,
  saveNotificationPreferences,
} from '../lib/push-notifications.js';

let currentProfile = null;
let notificationPreferences = null;

function showStatus(message, type = 'info') {
  const element = document.getElementById('account-status');
  element.hidden = false;
  element.className = `account-message is-${type}`;
  element.textContent = message;
}

async function savePassword(event) {
  event.preventDefault();
  const form = document.getElementById('password-form');
  if (!form.reportValidity()) return;
  const password = document.getElementById('new-password').value;
  const confirmation = document.getElementById('confirm-password').value;
  if (password !== confirmation) {
    showStatus('كلمتا المرور غير متطابقتين.', 'error');
    return;
  }
  const button = document.getElementById('save-password-btn');
  setButtonBusy(button, true, 'جاري الحفظ...');
  try {
    const { error } = await supabase.auth.updateUser({ password });
    if (error) throw error;
    const { error: profileError } = await supabase.from('users').update({ must_change_password: false }).eq('id', currentProfile.id);
    if (profileError) throw profileError;
    currentProfile = await getUserProfile(currentProfile.id);
    showStatus('تم تحديث كلمة المرور بنجاح.', 'success');
    form.reset();
  } catch (error) {
    showStatus(error.message || 'تعذر تحديث كلمة المرور.', 'error');
  } finally {
    setButtonBusy(button, false, 'حفظ كلمة المرور');
  }
}

async function initializeNotifications() {
  const support = pushSupport();
  const deviceStatus = document.getElementById('notification-status');
  if (currentProfile.role !== 'student') {
    document.getElementById('report-reminder-option').hidden = true;
    document.getElementById('report-time-row').hidden = true;
  }
  if (!support.supported) {
    deviceStatus.classList.add('is-unsupported');
    setText('push-master-state', 'الإشعارات غير مدعومة');
    setText('push-support-note', 'استخدم Chrome أو Edge حديثاً، أو ثبّت الموقع كتطبيق على iPhone.');
    document.getElementById('notification-form').classList.add('is-disabled');
    return;
  }

  try {
    notificationPreferences = await loadNotificationPreferences(currentProfile.id);
    renderNotificationPreferences();
    document.getElementById('push-enable-btn').addEventListener('click', togglePushNotifications);
    document.getElementById('notification-form').addEventListener('submit', saveNotifications);
  } catch (error) {
    console.error('Unable to load notification preferences:', error);
    setText('push-master-state', 'الإعدادات السحابية غير جاهزة');
    setText('push-support-note', 'يلزم نشر تحديث قاعدة البيانات وخدمة الإرسال أولاً.');
    document.getElementById('notification-form').classList.add('is-disabled');
  }
}

function renderNotificationPreferences() {
  const support = pushSupport();
  const enabled = Boolean(notificationPreferences?.push_enabled && support.permission === 'granted');
  const deviceStatus = document.getElementById('notification-status');
  deviceStatus.classList.toggle('is-enabled', enabled);
  setText('push-master-state', enabled ? 'إشعارات الهاتف مفعلة' : support.permission === 'denied' ? 'الإشعارات محظورة من المتصفح' : 'إشعارات الهاتف غير مفعلة');
  setText('push-support-note', enabled ? 'سيصل التنبيه لهذا الجهاز وفق اختياراتك أدناه.' : support.permission === 'denied' ? 'اسمح بالإشعارات من إعدادات الموقع في المتصفح.' : 'فعّلها مرة واحدة ليتم ربط هذا الجهاز بحسابك.');
  document.getElementById('push-enable-btn').textContent = enabled ? 'إيقاف الإشعارات' : 'تفعيل على هذا الجهاز';
  document.getElementById('notify-report-reminders').checked = Boolean(notificationPreferences?.report_reminders);
  document.getElementById('notify-direct-messages').checked = Boolean(notificationPreferences?.direct_messages);
  document.getElementById('notify-circle-updates').checked = Boolean(notificationPreferences?.circle_updates);
  document.getElementById('notification-report-time').value = String(notificationPreferences?.daily_report_time || '08:00').slice(0, 5);
}

async function togglePushNotifications() {
  const button = document.getElementById('push-enable-btn');
  setButtonBusy(button, true, 'جاري التنفيذ...');
  try {
    const enabled = Boolean(notificationPreferences?.push_enabled && Notification.permission === 'granted');
    notificationPreferences = enabled
      ? await disablePushNotifications(currentProfile.id)
      : (await enablePushNotifications(currentProfile.id)).preferences;
    renderNotificationPreferences();
    showStatus(enabled ? 'تم إيقاف إشعارات الهاتف لحسابك.' : 'تم تفعيل إشعارات الهاتف بنجاح.', 'success');
  } catch (error) {
    console.error('Unable to toggle push notifications:', error);
    showStatus(error.message || 'تعذر تعديل إشعارات الهاتف.', 'error');
  } finally {
    button.disabled = false;
    if (notificationPreferences) renderNotificationPreferences();
  }
}

async function saveNotifications(event) {
  event.preventDefault();
  const button = document.getElementById('save-notifications-btn');
  setButtonBusy(button, true, 'جاري الحفظ...');
  try {
    notificationPreferences = await saveNotificationPreferences({
      ...notificationPreferences,
      user_id: currentProfile.id,
      report_reminders: document.getElementById('notify-report-reminders').checked,
      direct_messages: document.getElementById('notify-direct-messages').checked,
      circle_updates: document.getElementById('notify-circle-updates').checked,
      daily_report_time: document.getElementById('notification-report-time').value,
    });
    renderNotificationPreferences();
    showStatus('تم حفظ تفضيلات الإشعارات.', 'success');
  } catch (error) {
    console.error('Unable to save notification preferences:', error);
    showStatus(error.message || 'تعذر حفظ تفضيلات الإشعارات.', 'error');
  } finally {
    setButtonBusy(button, false, 'حفظ تفضيلات الإشعارات');
  }
}

function setButtonBusy(button, busy, label) {
  button.disabled = busy;
  button.textContent = label;
}

function setText(id, value) {
  const element = document.getElementById(id);
  if (element) element.textContent = String(value);
}

async function initialize() {
  const requestedRole = new URLSearchParams(window.location.search).get('role');
  const previewRoles = isLocalPreviewMode() && ['student', 'teacher', 'admin'].includes(requestedRole)
    ? [requestedRole]
    : undefined;
  const authData = await requireAuth(previewRoles);
  if (!authData) return;
  currentProfile = authData.profile;
  setText('account-summary', `الحساب: ${currentProfile.username} - ${currentProfile.full_name}`);
  document.getElementById('password-form').addEventListener('submit', savePassword);
  document.getElementById('back-btn').addEventListener('click', () => redirectUserByRole(currentProfile.role));
  await initializeNotifications();
  window.lucide?.createIcons({ attrs: { 'stroke-width': 1.8 } });
}

document.addEventListener('DOMContentLoaded', initialize);
