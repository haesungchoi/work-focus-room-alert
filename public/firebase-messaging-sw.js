// PWA의 메인 서비스워커. 앱 셸 캐싱(오프라인 설치 가능하게) 담당.
const SHELL_CACHE = 'focus-room-shell-v7';
const SHELL_FILES = [
  '/',
  '/manifest.json',
  '/js/assign.js',
  '/js/firebase-config.js',
  '/js/app.js',
  '/icons/icon-192.png',
  '/icons/icon-512.png',
];

self.addEventListener('install', (event) => {
  event.waitUntil(caches.open(SHELL_CACHE).then((cache) => cache.addAll(SHELL_FILES)));
  self.skipWaiting();
});

self.addEventListener('activate', (event) => {
  event.waitUntil(
    caches.keys().then((keys) => Promise.all(keys.filter((k) => k !== SHELL_CACHE).map((k) => caches.delete(k))))
  );
  self.clients.claim();
});

// 캐시 우선(cache-first) 방식이었을 때는 assign.js/app.js를 배포해도 브라우저가 이미 설치된
// 서비스워커의 예전 캐시를 계속 서빙해, SHELL_CACHE 버전을 수동으로 올리지 않는 한 로직 수정이
// 영원히 반영되지 않는 문제가 있었다(실제로 배정 알고리즘을 여러 차례 고쳐 배포해도 화면은 계속
// 예전 결과를 보여준 원인). 네트워크 우선(network-first)으로 바꿔 매 배포가 즉시 반영되게 하고,
// 오프라인일 때만 캐시로 폴백한다.
self.addEventListener('fetch', (event) => {
  if (event.request.method !== 'GET' || new URL(event.request.url).origin !== self.location.origin) return;
  event.respondWith(
    fetch(event.request)
      .then((res) => {
        const copy = res.clone();
        caches.open(SHELL_CACHE).then((cache) => cache.put(event.request, copy));
        return res;
      })
      .catch(() => caches.match(event.request))
  );
});
