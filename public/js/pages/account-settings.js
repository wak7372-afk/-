import { supabase } from '../lib/supabase-client.js';
import { getUserProfile, redirectUserByRole, requireAuth } from '../lib/auth.js';

let currentProfile = null;

function showStatus(message, type = 'info') {
  const element = document.getElementById('account-status');
  const styles = {
    info: 'border-sky-200 bg-sky-50 text-sky-800',
    success: 'border-emerald-200 bg-emerald-50 text-emerald-800',
    error: 'border-red-200 bg-red-50 text-red-700',
  };
  element.className = 'mt-5 rounded-xl border px-4 py-3 text-xs leading-6 ' + (styles[type] || styles.info);
  element.textContent = message;
}

async function refreshGoogleStatus() {
  const { data, error } = await supabase.auth.getUserIdentities();
  if (error) return;
  const linked = data.identities?.some(identity => identity.provider === 'google');
  const message = document.getElementById('google-status');
  const button = document.getElementById('link-google-btn');
  if (linked) {
    message.textContent = 'حساب Google مرتبط ويمكن استخدامه للتحقق عند استعادة كلمة المرور.';
    button.classList.add('hidden');
  }
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
  button.disabled = true;
  button.textContent = 'جاري الحفظ...';
  try {
    const { error } = await supabase.auth.updateUser({ password });
    if (error) throw error;
    const { error: profileError } = await supabase.from('users').update({ must_change_password: false }).eq('id', currentProfile.id);
    if (profileError) throw profileError;
    currentProfile = await getUserProfile(currentProfile.id);
    showStatus('تم تحديث كلمة المرور بنجاح.', 'success');
    button.textContent = 'تم الحفظ';
  } catch (error) {
    showStatus(error.message || 'تعذر تحديث كلمة المرور.', 'error');
    button.disabled = false;
    button.textContent = 'حفظ كلمة المرور';
  }
}

async function linkGoogle() {
  const button = document.getElementById('link-google-btn');
  button.disabled = true;
  button.textContent = 'جاري فتح Google...';
  const { error } = await supabase.auth.linkIdentity({
    provider: 'google',
    options: { redirectTo: window.location.origin + window.location.pathname },
  });
  if (error) {
    showStatus(error.message || 'تعذر بدء ربط حساب Google.', 'error');
    button.disabled = false;
    button.textContent = 'ربط حساب Google';
  }
}

async function initialize() {
  const authData = await requireAuth();
  if (!authData) return;
  currentProfile = authData.profile;
  document.getElementById('account-summary').textContent = 'الحساب: ' + currentProfile.username + ' - ' + currentProfile.full_name;
  await refreshGoogleStatus();
  document.getElementById('password-form').addEventListener('submit', savePassword);
  document.getElementById('link-google-btn').addEventListener('click', linkGoogle);
  document.getElementById('back-btn').addEventListener('click', () => redirectUserByRole(currentProfile.role));
}

document.addEventListener('DOMContentLoaded', initialize);
