// 스토어매니저 - 최소 서비스워커
// 지금은 오프라인 캐싱 없이, "설치 가능한 앱"이 되기 위한 최소 조건만 채워요.
// 나중에 오프라인 지원이 필요해지면 여기에 캐시 로직을 추가하면 돼요.

self.addEventListener("install", (event) => {
  self.skipWaiting();
});

self.addEventListener("activate", (event) => {
  self.clients.claim();
});

self.addEventListener("fetch", (event) => {
  // 지금은 그냥 네트워크로 통과시켜요 (오프라인 캐싱 없음).
});
