import { loginUser, routeExistingSession } from '../lib/auth.js?v=2';
import { initI18n, setLanguage } from '../lib/i18n.js';
import { registerServiceWorker } from '../lib/utils.js';

const elements = {};

function cacheElements() {
  elements.loginForm = document.getElementById('login-form');
  elements.loginUsername = document.getElementById('login-username');
  elements.loginPassword = document.getElementById('login-password');
  elements.loginSubmit = document.getElementById('login-submit');
  elements.status = document.getElementById('auth-status');
}

function showStatus(message, type = 'info') {
  const styles = {
    info: 'border-sky-200 bg-sky-50 text-sky-800',
    error: 'border-red-200 bg-red-50 text-red-700',
  };
  elements.status.className = 'mb-5 rounded-xl border px-4 py-3 text-xs leading-6 ' + (styles[type] || styles.info);
  elements.status.textContent = message;
}

function setButtonBusy(busy) {
  elements.loginSubmit.disabled = busy;
  elements.loginSubmit.classList.toggle('opacity-60', busy);
  elements.loginSubmit.classList.toggle('cursor-not-allowed', busy);
  elements.loginSubmit.textContent = busy ? 'جاري التحقق...' : 'تسجيل الدخول';
}

async function handlePasswordLogin(event) {
  event.preventDefault();
  if (!elements.loginForm.reportValidity()) return;
  setButtonBusy(true);
  showStatus('جاري التحقق من بيانات الحساب...', 'info');
  try {
    await loginUser(elements.loginUsername.value, elements.loginPassword.value);
  } catch (error) {
    const rawMessage = error.message || '';
    const message = /اسم المستخدم|كلمة المرور|بيانات الحساب/.test(rawMessage)
      ? 'اسم المستخدم أو كلمة المرور غير صحيحة.'
      : rawMessage || 'تعذر تسجيل الدخول.';
    showStatus(message, 'error');
    if (/اسم المستخدم|كلمة المرور/.test(message)) {
      elements.loginPassword.value = '';
      elements.loginPassword.focus();
    }
    setButtonBusy(false);
  }
}

function showQueryMessage() {
  const params = new URLSearchParams(window.location.search);
  const reason = params.get('reason');
  const error = params.get('error');
  if (reason === 'login-required') showStatus('يجب تسجيل الدخول للوصول إلى الصفحة المطلوبة.');
  if (error === 'profile-missing') showStatus('ملف الحساب غير مكتمل. تواصل مع إدارة المركز.', 'error');
  if (error === 'profile-load') showStatus('تعذر تحميل ملف الحساب. تحقق من الاتصال ثم حاول مجدداً.', 'error');
  if (error === 'invalid-role') showStatus('صلاحية الحساب غير معروفة. تواصل مع إدارة المركز.', 'error');
}

async function initialize() {
  cacheElements();
  await initI18n();
  registerServiceWorker();
  showQueryMessage();
  elements.loginForm.addEventListener('submit', handlePasswordLogin);
  document.getElementById('toggle-password').addEventListener('click', event => {
    const isPassword = elements.loginPassword.type === 'password';
    elements.loginPassword.type = isPassword ? 'text' : 'password';
    event.currentTarget.textContent = isPassword ? 'إخفاء' : 'إظهار';
  });
  document.getElementById('language-toggle').addEventListener('click', async event => {
    const nextLanguage = document.documentElement.lang === 'ar' ? 'en' : 'ar';
    await setLanguage(nextLanguage);
    event.currentTarget.textContent = nextLanguage === 'ar' ? 'EN' : 'عربي';
  });
  try {
    await routeExistingSession();
  } catch (error) {
    console.error('Session routing failed:', error);
  }
}

document.addEventListener('DOMContentLoaded', initialize);
