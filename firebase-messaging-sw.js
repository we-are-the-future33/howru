// Firebase Cloud Messaging Service Worker
// 이 파일은 반드시 사이트 루트(/firebase-messaging-sw.js)에 위치해야 합니다.
// Firebase SDK가 이 정확한 경로를 자동으로 찾습니다.

importScripts('https://www.gstatic.com/firebasejs/10.12.0/firebase-app-compat.js');
importScripts('https://www.gstatic.com/firebasejs/10.12.0/firebase-messaging-compat.js');

// howru-app Firebase 프로젝트 설정 (index.html과 동일)
firebase.initializeApp({
  apiKey: "AIzaSyC-XivAxixT0h_iFEJk8iwBCPuiFX3GcJM",
  authDomain: "howru-app.firebaseapp.com",
  projectId: "howru-app",
  storageBucket: "howru-app.firebasestorage.app",
  messagingSenderId: "128308942213",
  appId: "1:128308942213:web:75cba5923ee9762ad060ec"
});

const messaging = firebase.messaging();

// 백그라운드에서 푸시 메시지 수신 (앱이 닫혀 있거나 다른 탭일 때)
messaging.onBackgroundMessage((payload) => {
  console.log('[SW] 백그라운드 메시지 수신:', payload);

  const title = payload.notification?.title || 'howru';
  const options = {
    body: payload.notification?.body || '오늘의 기분을 기록해보세요',
    icon: '/icon-192.png',
    badge: '/icon-192.png',
    tag: 'howru-daily',  // 같은 tag면 새 알림이 이전 것을 덮어씀 (스팸 방지)
    requireInteraction: false,
    data: payload.data || {},
  };

  return self.registration.showNotification(title, options);
});

// 알림 클릭 시 howru 앱으로 이동
self.addEventListener('notificationclick', (event) => {
  event.notification.close();

  // 이미 howru 탭이 열려 있으면 거기로 포커스, 없으면 새로 열기
  event.waitUntil(
    clients.matchAll({ type: 'window', includeUncontrolled: true }).then((clientList) => {
      for (const client of clientList) {
        if (client.url.includes(self.location.host) && 'focus' in client) {
          return client.focus();
        }
      }
      if (clients.openWindow) {
        return clients.openWindow('/');
      }
    })
  );
});
