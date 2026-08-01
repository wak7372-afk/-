let currentLang = localStorage.getItem('app_lang') || 'ar';
let translations = {};

export async function initI18n() {
  await loadLanguage(currentLang);
}

export async function setLanguage(lang) {
  return loadLanguage(lang);
}

export async function loadLanguage(lang) {
  currentLang = lang;
  localStorage.setItem('app_lang', lang);
  try {
    const isSubdir = window.location.pathname.includes('/admin/') || 
                     window.location.pathname.includes('/teacher/') || 
                     window.location.pathname.includes('/student/') || 
                     window.location.pathname.includes('/parent/');
    const basePath = isSubdir ? '../locales/' : './locales/';
    const res = await fetch(`${basePath}${lang}.json`);
    translations = await res.json();
  } catch (e) {
    console.error('Failed to load locale:', lang, e);
  }
  applyTranslations();
}

export function t(key) {
  return translations[key] || key;
}

export function applyTranslations() {
  document.documentElement.lang = currentLang;
  document.documentElement.dir = currentLang === 'ar' ? 'rtl' : 'ltr';

  document.querySelectorAll('[data-i18n]').forEach((el) => {
    const key = el.getAttribute('data-i18n');
    if (translations[key]) {
      el.textContent = translations[key];
    }
  });

  document.querySelectorAll('[data-i18n-placeholder]').forEach((el) => {
    const key = el.getAttribute('data-i18n-placeholder');
    if (translations[key]) {
      el.placeholder = translations[key];
    }
  });
}

export function getCurrentLang() {
  return currentLang;
}
