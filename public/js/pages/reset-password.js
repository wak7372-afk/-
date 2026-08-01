import { supabase } from '../lib/supabase-client.js';

let recoveryUsername = '';

function showStatus(message, type = 'info') {
  const element = document.getElementById('reset-status');
  const styles = {
    info: 'border-sky-200 bg-sky-50 text-sky-800',
    success: 'border-emerald-200 bg-emerald-50 text-emerald-800',
    error: 'border-red-200 bg-red-50 text-red-700',
  };
  element.className = `mt-5 rounded-xl border px-4 py-3 text-xs leading-6 ${styles[type] || styles.info}`;
  element.textContent = message;
}

function getFunctionError(error, data, fallback) {
  return data?.error || error?.message || fallback;
}

async function requestOtp(event) {
  event.preventDefault();
  const form = document.getElementById('recovery-request-form');
  if (!form.reportValidity()) return;

  recoveryUsername = document.getElementById('recovery-username').value.trim().toLowerCase();
  const button = document.getElementById('request-otp-button');
  button.disabled = true;
  button.textContent = 'جاري إرسال الرمز...';

  try {
    const { data, error } = await supabase.functions.invoke('account-recovery', {
      body: { action: 'request', username: recoveryUsername },
    });
    if (error || data?.error) throw new Error(getFunctionError(error, data, 'تعذر إرسال رمز التحقق.'));

    document.getElementById('recovery-request-form').classList.add('hidden');
    document.getElementById('otp-recovery-form').classList.remove('hidden');
    document.getElementById('otp-destination').textContent = data.maskedEmail
      ? `تم إرسال الرمز إلى ${data.maskedEmail}. صلاحية الرمز 10 دقائق.`
      : 'تم إرسال الرمز إلى البريد المرتبط بالحساب. صلاحية الرمز 10 دقائق.';
    showStatus('تحقق من بريدك الإلكتروني وأدخل الرمز المكون من ستة أرقام.', 'success');
    document.getElementById('recovery-otp').focus();
  } catch (error) {
    showStatus(error.message || 'تعذر إرسال رمز التحقق.', 'error');
  } finally {
    button.disabled = false;
    button.textContent = 'إرسال رمز التحقق';
  }
}

async function verifyOtp(event) {
  event.preventDefault();
  const form = document.getElementById('otp-recovery-form');
  if (!form.reportValidity()) return;

  const code = document.getElementById('recovery-otp').value.trim();
  const password = document.getElementById('reset-new-password').value;
  const confirmation = document.getElementById('reset-confirm-password').value;
  if (password !== confirmation) {
    showStatus('كلمتا المرور غير متطابقتين.', 'error');
    return;
  }

  const button = document.getElementById('verify-otp-button');
  button.disabled = true;
  button.textContent = 'جاري التحقق...';

  try {
    const { data, error } = await supabase.functions.invoke('account-recovery', {
      body: { action: 'verify', username: recoveryUsername, code, password },
    });
    if (error || data?.error) throw new Error(getFunctionError(error, data, 'تعذر تحديث كلمة المرور.'));

    showStatus('تم تحديث كلمة المرور بنجاح. يمكنك تسجيل الدخول الآن.', 'success');
    document.getElementById('otp-recovery-form').classList.add('hidden');
    window.setTimeout(() => window.location.replace('./index.html'), 1400);
  } catch (error) {
    showStatus(error.message || 'تعذر تحديث كلمة المرور.', 'error');
  } finally {
    button.disabled = false;
    button.textContent = 'تأكيد الرمز وتحديث كلمة المرور';
  }
}

async function resendOtp() {
  const form = document.getElementById('recovery-request-form');
  document.getElementById('recovery-username').value = recoveryUsername;
  document.getElementById('otp-recovery-form').classList.add('hidden');
  form.classList.remove('hidden');
  await requestOtp({ preventDefault() {} });
}

document.addEventListener('DOMContentLoaded', () => {
  document.getElementById('recovery-request-form').addEventListener('submit', requestOtp);
  document.getElementById('otp-recovery-form').addEventListener('submit', verifyOtp);
  document.getElementById('resend-otp-button').addEventListener('click', resendOtp);
});
