const CACHE_NAME = 'zat-khail-v2';
const ASSETS = [
  '/',
  '/index.html',
  '/register.html',
  '/pending-approval.html',
  '/admin/dashboard.html',
  '/css/style.css',
  '/css/admin.css',
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
  event.respondWith(
    caches.match(event.request).then((response) => {
      return response || fetch(event.request);
    })
  );
});

self.addEventListener('push', (event) => {
  const data = event.data ? event.data.json() : { title: 'إشعار جديد', body: 'لديك إشعار جديد في منصة ذات خيل' };
  event.waitUntil(
    self.registration.showNotification(data.title, {
      body: data.body,
      icon: '/assets/icons/icon-192.png',
      badge: '/assets/icons/icon-192.png'
    })
  );
});
