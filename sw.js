// 스토어매니저 - 서비스워커
// 1) 설치 가능한 앱이 되기 위한 최소 조건 (기존)
// 2) 푸시 알림 수신 및 표시 (신규)

self.addEventListener("install", (event) => {
  self.skipWaiting();
});

self.addEventListener("activate", (event) => {
  self.clients.claim();
});

self.addEventListener("fetch", (event) => {
  // 지금은 그냥 네트워크로 통과시켜요 (오프라인 캐싱 없음).
});

// ---------- 푸시 알림 ----------
self.addEventListener("push", (event) => {
  let data = {};
  try{ data = event.data ? event.data.json() : {}; }catch(e){ data = { title: "스토어매니저", body: event.data ? event.data.text() : "" }; }

  const title = data.title || "스토어매니저";
  const options = {
    body: data.body || "",
    icon: "/icons/icon-192.png",
    badge: "/icons/icon-192.png",
    data: { url: data.url || "/" },
    tag: data.tag || undefined,
    renotify: !!data.tag
  };

  event.waitUntil(self.registration.showNotification(title, options));
});

self.addEventListener("notificationclick", (event) => {
  event.notification.close();
  let url;
  try{url=new URL(event.notification.data?.url||"/",self.location.origin);if(url.origin!==self.location.origin)url=new URL("/",self.location.origin);}catch(e){url=new URL("/",self.location.origin);}
  event.waitUntil((async()=>{
    const clientsArr=await self.clients.matchAll({type:"window",includeUncontrolled:true});
    for(const client of clientsArr){
      if(new URL(client.url).origin===self.location.origin&&"focus" in client){
        try{const navigated=await client.navigate(url.href);if(navigated)return navigated.focus();}catch(e){}
      }
    }
    if(self.clients.openWindow)return self.clients.openWindow(url.href);
  })());
});
