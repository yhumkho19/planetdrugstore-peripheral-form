importScripts("https://www.gstatic.com/firebasejs/10.12.2/firebase-app-compat.js");
importScripts("https://www.gstatic.com/firebasejs/10.12.2/firebase-messaging-compat.js");

self.addEventListener("install", event => event.waitUntil(self.skipWaiting()));
self.addEventListener("activate", event => event.waitUntil(self.clients.claim()));

firebase.initializeApp({
  apiKey: "AIzaSyAD6rm7RPOObiSw3Pz0wsQJZNaxr0O0TRQ",
  authDomain: "planetdrugstore-peripher-d24c0.firebaseapp.com",
  projectId: "planetdrugstore-peripher-d24c0",
  storageBucket: "planetdrugstore-peripher-d24c0.firebasestorage.app",
  messagingSenderId: "115454971026",
  appId: "1:115454971026:web:0357eaa6bfb171e86cea4b"
});

const messaging = firebase.messaging();

messaging.onBackgroundMessage(async payload => {
  const data = payload.data || {};
  const isEventReminder = data.eventReminder === "1";
  const isPharmacistNote = data.notificationType === "pharmacistNote";
  const isSiteSwapRequest = data.notificationType === "siteSwapRequest";
  const isStockRequestRemoved = data.notificationType === "stockRequestRemoved";
  const isStockDayNotification = String(data.notificationType || "").startsWith("stockDay")
    || isStockRequestRemoved
    || data.notificationType === "stockRequestUnblocked";
  const hasContactAdmin = Boolean(data.contactAdminUrl);
  const viewAction = { action: "view-site", title: isSiteSwapRequest ? "Review swap" : isPharmacistNote ? "View notes" : isStockDayNotification ? "View Stock Request" : "View site" };
  const closeAction = { action: "close", title: "Close" };
  const contactAction = { action: "contact-admin", title: "Contact Admin" };
  const actions = hasContactAdmin
    ? (Notification.maxActions >= 3 ? [viewAction, closeAction, contactAction] : [contactAction, closeAction])
    : [viewAction, closeAction];
  if (isEventReminder) {
    const clients = await self.clients.matchAll({ type: "window", includeUncontrolled: true });
    clients.forEach(client => client.postMessage({ type: "event-reminder", data }));
  }
  return self.registration.showNotification(data.title || "Schedule update", {
    body: data.body || "Open the app to review the details.",
    icon: "/assets/images/logo-transparent.png",
    badge: "/assets/images/logo-transparent.png",
    tag: data.notificationId || "schedule-update",
    requireInteraction: true,
    silent: false,
    renotify: true,
    vibrate: isEventReminder ? [180, 100, 180, 100, 360] : [180, 100, 180],
    actions,
    data: {
      url: data.url || "/47fto0gim6",
      cardId: data.cardId || "",
      date: data.date || "",
      region: data.region || "",
      eventReminder: isEventReminder,
      reminderKey: data.reminderKey || "",
      reminderActionToken: data.reminderActionToken || "",
      contactAdminUrl: data.contactAdminUrl || ""
    }
  });
});

self.addEventListener("notificationclick", event => {
  event.notification.close();
  if (event.action === "close") return;
  if (event.action === "contact-admin") {
    const contactUrl = event.notification.data?.contactAdminUrl;
    if (contactUrl) event.waitUntil(self.clients.openWindow(contactUrl));
    return;
  }
  if (["snooze", "dismiss"].includes(event.action)) {
    event.waitUntil((async () => {
      const configResponse = await fetch("/push-config.json", { cache: "no-store" });
      if (!configResponse.ok) return;
      const config = await configResponse.json();
      if (!config.workerUrl) return;
      await fetch(`${config.workerUrl.replace(/\/$/, "")}/reminder-action`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          reminderKey: event.notification.data?.reminderKey || "",
          actionToken: event.notification.data?.reminderActionToken || "",
          action: event.action
        })
      });
    })());
    return;
  }
  const targetUrl = new URL(event.notification.data?.url || "/47fto0gim6", self.location.origin).href;
  if (new URL(targetUrl).origin !== self.location.origin) {
    event.waitUntil(self.clients.openWindow(targetUrl));
    return;
  }
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