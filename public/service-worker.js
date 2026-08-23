const CACHE_NAME = 'zat-khail-v39';
const ASSETS = [
  '/',
  '/favicon.ico',
  '/manifest.json',
  '/assets/brand/zat-khail-emblem.png',
  '/assets/brand/zat-khail-logo-banner.jpg',
  '/assets/icons/favicon-32.png',
  '/assets/icons/apple-touch-icon.png',
  '/assets/icons/icon-192.png',
  '/assets/icons/icon-512.png',
  '/assets/icons/icon-maskable-512.png',
  '/index.html',
  '/register.html',
  '/account-settings.html',
  '/pending-approval.html',
  '/circles.html',
  '/circle.html',
  '/admin/dashboard.html',
  '/teacher/tasks.html',
  '/teacher/students.html',
  '/teacher/ai-assistant.html',
  '/student/dashboard.html',
  '/student/reports.html',
  '/css/style.css',
  '/css/calm-ui.css',
  '/css/chat.css',
  '/css/account-settings.css',
  '/css/admin.css',
  '/css/tasks.css',
  '/css/student-dashboard.css',
  '/css/circles.css',
  '/css/circle-dashboard.css',
  '/css/quran-reports.css',
  '/css/design-system.css',
  '/css/teacher-workspace.css',
  '/css/teacher-command-center.css',
  '/css/teacher-students.css',
  '/js/lib/teacher-shell.js',
  '/js/lib/teacher-student-analytics.js',
  '/js/lib/push-notifications.js',
  '/js/lib/quran-report-excel.js',
  '/js/pages/quran-report-manager.js',
  '/js/pages/quran-report-importer.js',
  '/js/pages/student-reports.js',
  '/js/pages/teacher-students.js',
  '/js/pages/account-settings.js',
  '/js/vendor/xlsx.full.min.js',
  '/locales/ar.json',
  '/locales/en.json'
];

self.addEventListener('install', (event) => {
  event.waitUntil(
    caches.open(CACHE_NAME).then((cache) => cache.addAll(ASSETS))
  );
  self.skipWaiting();
});

self.addEventListener('activate', (event) => {
  event.waitUntil(
    caches.keys().then((keys) => Promise.all(
      keys.filter((key) => key !== CACHE_NAME).map((key) => caches.delete(key))
    ))
  );
  self.clients.claim();
});

self.addEventListener('fetch', (event) => {
  if (event.request.method !== 'GET') return;

  const requestUrl = new URL(event.request.url);
  if (requestUrl.origin !== self.location.origin) return;

  event.respondWith(
    fetch(event.request)
      .then((response) => {
        if (response.ok) {
          const copy = response.clone();
          caches.open(CACHE_NAME).then((cache) => cache.put(event.request, copy));
        }
        return response;
      })
      .catch(() => caches.match(event.request))
  );
});

self.addEventListener('push', (event) => {
  let data = { title: 'إشعار جديد', body: 'لديك إشعار جديد في مركز ذات خيل لتعليم القرآن الكريم وعلومه', url: '/' };
  try {
    if (event.data) data = { ...data, ...event.data.json() };
  } catch (_) {
    // Keep the privacy-safe generic notification when a payload is malformed.
  }
  event.waitUntil(
    self.registration.showNotification(data.title, {
      body: data.body,
      icon: '/assets/icons/icon-192.png',
      badge: '/assets/icons/favicon-32.png',
      tag: data.type || 'zat-khail-notification',
      renotify: true,
      data: { url: data.url || '/' }
    })
  );
});

self.addEventListener('notificationclick', (event) => {
  event.notification.close();
  let destination = new URL('/', self.location.origin);
  try {
    const requested = new URL(event.notification.data?.url || '/', self.location.origin);
    if (requested.origin === self.location.origin) destination = requested;
  } catch (_) {
    destination = new URL('/', self.location.origin);
  }

  event.waitUntil(
    clients.matchAll({ type: 'window', includeUncontrolled: true }).then(async windows => {
      const existing = windows.find(client => new URL(client.url).origin === self.location.origin);
      if (existing) {
        await existing.navigate(destination.href);
        return existing.focus();
      }
      return clients.openWindow(destination.href);
    })
  );
});
