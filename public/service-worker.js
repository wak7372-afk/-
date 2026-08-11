const CACHE_NAME = 'zat-khail-v9';
const ASSETS = [
  '/',
  '/index.html',
  '/register.html',
  '/pending-approval.html',
  '/circles.html',
  '/circle.html',
  '/admin/dashboard.html',
  '/teacher/tasks.html',
  '/teacher/ai-assistant.html',
  '/student/dashboard.html',
  '/student/reports.html',
  '/css/style.css',
  '/css/admin.css',
  '/css/tasks.css',
  '/css/student-dashboard.css',
  '/css/circles.css',
  '/css/quran-reports.css',
  '/js/lib/quran-report-excel.js',
  '/js/pages/quran-report-manager.js',
  '/js/pages/quran-report-importer.js',
  '/js/pages/student-reports.js',
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
  const data = event.data ? event.data.json() : { title: 'إشعار جديد', body: 'لديك إشعار جديد في مركز ذات خيل لتعليم القرآن الكريم وعلومه' };
  event.waitUntil(
    self.registration.showNotification(data.title, {
      body: data.body,
      icon: '/assets/icons/icon-192.png',
      badge: '/assets/icons/icon-192.png'
    })
  );
});
