import { supabase } from '../lib/supabase-client.js';
import { getUserProfile, logoutUser, redirectUserByRole } from '../lib/auth.js';
import { initI18n } from '../lib/i18n.js';

const statusBox = document.getElementById('pending-status');
const checkButton = document.getElementById('check-status-btn');
const resendButton = document.getElementById('resend-confirmation-btn');
const emailLabel = document.getElementById('pending-email');

function showStatus(message, type = 'info') {
  const styles = {
    info: 'border-sky-200 bg-sky-50 text-sky-800',
    success: 'border-emerald-200 bg-emerald-50 text-emerald-800',
    error: 'border-red-200 bg-red-50 text-red-700',
  };
  statusBox.className = `mx-auto mt-6 max-w-lg rounded-xl border px-4 py-3 text-xs leading-6 ${styles[type] || styles.info}`;
  statusBox.textContent = message;
}

function setBusy(button, busy, busyText, normalText) {
  button.disabled = busy;
  button.classList.toggle('cursor-not-allowed', busy);
  button.classList.toggle('opacity-60', busy);
  button.textContent = busy ? busyText : normalText;
}

async function checkAccountStatus({ announce = true } = {}) {
  setBusy(checkButton, true, 'جاري الفحص...', 'فحص حالة الحساب');

  try {
    const { data: { session }, error } = await supabase.auth.getSession();
    if (error) throw error;

    if (!session?.user) {
      const pendingEmail = localStorage.getItem('pending_registration_email') || '';
      if (pendingEmail) emailLabel.textContent = `البريد المسجل: ${pendingEmail}`;
      resendButton.classList.toggle('hidden', !pendingEmail);
      if (announce) showStatus('تحقق من رسالة تأكيد البريد، ثم سجل الدخول لفحص موافقة الإدارة.', 'info');
      return;
    }

    emailLabel.textContent = `البريد المسجل: ${session.user.email || ''}`;
    document.getElementById('step-email').className = 'rounded-2xl border border-emerald-200 bg-emerald-50 p-4';
    resendButton.classList.add('hidden');

    const profile = await getUserProfile(session.user.id);
    if (!profile) {
      showStatus('تعذر العثور على ملف طلبك. تواصل مع إدارة المركز.', 'error');
      return;
    }

    if (profile.is_active) {
      showStatus('تم تفعيل الحساب. يجري نقلك إلى لوحة التحكم...', 'success');
      window.setTimeout(() => redirectUserByRole(profile.role), 700);
      return;
    }

    if (announce) showStatus('البريد مؤكد، والطلب ما زال بانتظار موافقة الإدارة.', 'info');
  } catch (error) {
    console.error(error);
    showStatus('تعذر فحص الحالة الآن. تحقق من الاتصال ثم حاول مجدداً.', 'error');
  } finally {
    setBusy(checkButton, false, 'جاري الفحص...', 'فحص حالة الحساب');
  }
}

async function resendConfirmation() {
  const email = localStorage.getItem('pending_registration_email');
  if (!email) {
    showStatus('أعد التسجيل أو سجّل الدخول أولاً لتحديد البريد الإلكتروني.', 'error');
    return;
  }

  setBusy(resendButton, true, 'جاري الإرسال...', 'إعادة إرسال رسالة التأكيد');
  try {
    const { error } = await supabase.auth.resend({
      type: 'signup',
      email,
      options: {
        emailRedirectTo: `${window.location.origin}${window.location.pathname.replace(/pending-approval\.html$/, 'index.html')}`,
      },
    });
    if (error) throw error;
    showStatus('أُرسلت رسالة تأكيد جديدة. تحقق من صندوق الوارد والبريد غير المرغوب.', 'success');
  } catch (error) {
    showStatus(error.message || 'تعذر إعادة إرسال رسالة التأكيد.', 'error');
  } finally {
    setBusy(resendButton, false, 'جاري الإرسال...', 'إعادة إرسال رسالة التأكيد');
  }
}

async function initialize() {
  await initI18n();
  document.getElementById('logout-btn').addEventListener('click', logoutUser);
  checkButton.addEventListener('click', () => checkAccountStatus({ announce: true }));
  resendButton.addEventListener('click', resendConfirmation);
  await checkAccountStatus({ announce: false });
}

document.addEventListener('DOMContentLoaded', initialize);
