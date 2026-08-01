export function registerServiceWorker() {
  if ('serviceWorker' in navigator) {
    window.addEventListener('load', () => {
      navigator.serviceWorker.register('/service-worker.js')
        .then(reg => console.log('PWA Service Worker registered:', reg.scope))
        .catch(err => console.error('PWA Service Worker registration failed:', err));
    });
  }
}

export function formatDate(dateString) {
  if (!dateString) return '';
  const date = new Date(dateString);
  return date.toLocaleDateString('ar-EG', {
    weekday: 'long',
    year: 'numeric',
    month: 'short',
    day: 'numeric'
  });
}

export function escapeHtml(value = '') {
  return String(value)
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;')
    .replaceAll("'", '&#039;');
}

export function getSafeExternalUrl(value) {
  if (!value) return '';
  try {
    const url = new URL(String(value), window.location.origin);
    const sameOrigin = url.origin === window.location.origin;
    if (sameOrigin || url.protocol === 'https:') return url.href;
  } catch (_) {
    return '';
  }
  return '';
}

export function showToast(message, type = 'info') {
  const container = document.getElementById('toast-container') || createToastContainer();
  const toast = document.createElement('div');
  const text = document.createElement('span');
  const closeButton = document.createElement('button');
  const bgClass = type === 'error' ? 'bg-red-600' : type === 'success' ? 'bg-emerald-700' : 'bg-amber-600';

  toast.className = `${bgClass} text-white px-5 py-3 rounded-lg shadow-xl mb-3 flex items-center justify-between text-sm font-medium animate-fade-in transition-all`;
  text.textContent = String(message);
  closeButton.type = 'button';
  closeButton.className = 'mr-3 hover:opacity-80';
  closeButton.setAttribute('aria-label', 'إغلاق الرسالة');
  closeButton.textContent = '×';
  closeButton.addEventListener('click', () => toast.remove());
  toast.append(text, closeButton);

  container.appendChild(toast);
  setTimeout(() => toast.remove(), 4000);
}

function createToastContainer() {
  const div = document.createElement('div');
  div.id = 'toast-container';
  div.className = 'fixed bottom-5 left-5 z-50 flex flex-col max-w-sm w-full';
  document.body.appendChild(div);
  return div;
}
