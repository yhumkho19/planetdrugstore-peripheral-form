importScripts("https://www.gstatic.com/firebasejs/10.12.2/firebase-app-compat.js");
importScripts("https://www.gstatic.com/firebasejs/10.12.2/firebase-messaging-compat.js");

firebase.initializeApp({
  apiKey: "AIzaSyAD6rm7RPOObiSw3Pz0wsQJZNaxr0O0TRQ",
  authDomain: "planetdrugstore-peripher-d24c0.firebaseapp.com",
  projectId: "planetdrugstore-peripher-d24c0",
  storageBucket: "planetdrugstore-peripher-d24c0.firebasestorage.app",
  messagingSenderId: "115454971026",
  appId: "1:115454971026:web:0357eaa6bfb171e86cea4b"
});

const messaging = firebase.messaging();

messaging.onBackgroundMessage(payload => {
  const data = payload.data || {};
  return self.registration.showNotification(data.title || "Schedule update", {
    body: data.body || "Open the app to review the details.",
    icon: "/assets/images/logo-transparent.png",
    badge: "/assets/images/logo-transparent.png",
    tag: data.notificationId || "schedule-update",
    actions: data.cardId ? [{ action: "view-site", title: "View site" }] : [],
    data: {
      url: data.url || "/47fto0gim6",
      cardId: data.cardId || "",
      date: data.date || "",
      region: data.region || ""
    }
  });
});

self.addEventListener("notificationclick", event => {
  event.notification.close();
  const targetUrl = new URL(event.notification.data?.url || "/47fto0gim6", self.location.origin).href;
  event.waitUntil((async () => {
    const clients = await self.clients.matchAll({ type: "window", includeUncontrolled: true });
    for (const client of clients) {
      if (client.url.startsWith(self.location.origin) && "focus" in client) {
        await client.focus();
        if ("navigate" in client) await client.navigate(targetUrl);
        return;
      }
    }
    await self.clients.openWindow(targetUrl);
  })());
});