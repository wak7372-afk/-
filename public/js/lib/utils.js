export function registerServiceWorker() {
  const localHosts = new Set(['localhost', '127.0.0.1', '::1']);
  if (!('serviceWorker' in navigator) || localHosts.has(window.location.hostname)) return;

  window.addEventListener('load', () => {
    navigator.serviceWorker.register('/service-worker.js')
      .then((registration) => {
        if (registration?.scope) console.info('PWA Service Worker registered:', registration.scope);
      })
      .catch(err => console.error('PWA Service Worker registration failed:', err));
  });
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
  const iconWrap = document.createElement('span');
  const icon = document.createElement('i');
  const copy = document.createElement('div');
  const title = document.createElement('strong');
  const text = document.createElement('span');
  const closeButton = document.createElement('button');
  const meta = {
    error: { title: 'تعذر تنفيذ العملية', icon: 'circle-alert' },
    warning: { title: 'تنبيه', icon: 'triangle-alert' },
    success: { title: 'تمت العملية', icon: 'circle-check' },
    info: { title: 'معلومة', icon: 'info' },
  }[type] || { title: 'معلومة', icon: 'info' };

  toast.className = `app-alert app-alert-${type}`;
  toast.setAttribute('role', type === 'error' ? 'alert' : 'status');
  iconWrap.className = 'app-alert-icon';
  icon.setAttribute('data-lucide', meta.icon);
  title.textContent = meta.title;
  text.textContent = String(message);
  copy.className = 'app-alert-copy';
  closeButton.type = 'button';
  closeButton.className = 'app-alert-close';
  closeButton.setAttribute('aria-label', 'إغلاق الرسالة');
  closeButton.textContent = '×';
  closeButton.addEventListener('click', () => toast.remove());
  iconWrap.append(icon);
  copy.append(title, text);
  toast.append(iconWrap, copy, closeButton);

  container.appendChild(toast);
  if (window.lucide?.createIcons) window.lucide.createIcons({ nodes: [toast] });
  setTimeout(() => toast.remove(), type === 'error' ? 8000 : 5000);
}

function createToastContainer() {
  const div = document.createElement('div');
  div.id = 'toast-container';
  div.className = 'app-alert-stack';
  div.setAttribute('aria-live', 'polite');
  document.body.appendChild(div);
  return div;
}
