import { getApp, initializeApp } from "https://www.gstatic.com/firebasejs/10.12.2/firebase-app.js";
import { getAuth } from "https://www.gstatic.com/firebasejs/10.12.2/firebase-auth.js";
import { getMessaging, getToken, isSupported, onMessage } from "https://www.gstatic.com/firebasejs/10.12.2/firebase-messaging.js";

const firebaseConfig = {
  apiKey: "AIzaSyAD6rm7RPOObiSw3Pz0wsQJZNaxr0O0TRQ",
  authDomain: "planetdrugstore-peripher-d24c0.firebaseapp.com",
  projectId: "planetdrugstore-peripher-d24c0",
  storageBucket: "planetdrugstore-peripher-d24c0.firebasestorage.app",
  messagingSenderId: "115454971026",
  appId: "1:115454971026:web:0357eaa6bfb171e86cea4b"
};

const app = initializeApp(firebaseConfig, "schedule-push");
const sessionKey = "pdEmployeeSession";

window.pdWakePushDelivery = async () => {
  try {
    const response = await fetch("/push-config.json", { cache: "no-store" });
    if (!response.ok) return;
    const config = await response.json();
    if (!config.enabled || !config.workerUrl) return;
    await fetch(`${config.workerUrl.replace(/\/$/, "")}/wake`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: "{}"
    });
  } catch (error) {
    console.warn("Immediate push wake failed:", error);
  }
};

function readEmployeeSession() {
  try {
    const raw = sessionStorage.getItem(sessionKey) || localStorage.getItem(sessionKey);
    const session = raw ? JSON.parse(raw) : null;
    const staffId = String(session?.staffId || "").trim().toLowerCase();
    return staffId ? { staffId } : null;
  } catch {
    return null;
  }
}

async function readHeadSession() {
  const auth = getAuth(getApp());
  await auth.authStateReady();
  const email = String(auth.currentUser?.email || "").trim().toLowerCase();
  const rolesByEmail = {
    "pharmacistdepart@planetdrugstore.ph": "pharmacist",
    "billingdepart@planetdrugstore.ph": "billing",
    "informationdepart@planetdrugstore.ph": "information",
    "adminstockreq@planetdrugstore.ph": "stock"
  };
  const headRole = rolesByEmail[email];
  return headRole ? { headRole } : null;
}

function pushStorageKeys(session) {
  return session.headRole
    ? { owner: `pdPushHeadRole_${session.headRole}`, token: `pdPushHeadToken_${session.headRole}` }
    : { owner: "pdPushStaffId", token: "pdPushToken" };
}

function pushRecipient(session) {
  return session.headRole
    ? { headRole: session.headRole }
    : { staffId: session.staffId };
}

async function refreshPushSubscription(config, session, storageKeys, recipientId) {
  if (!isValidVapidKey(config.vapidKey) || Notification.permission !== "granted") return;
  const registration = await navigator.serviceWorker.register("/firebase-messaging-sw.js", { scope: "/" });
  await navigator.serviceWorker.ready;
  const token = await getToken(getMessaging(app), {
    vapidKey: config.vapidKey,
    serviceWorkerRegistration: registration
  });
  if (!token) return;

  const previousToken = localStorage.getItem(storageKeys.token);
  const response = await fetch(`${config.workerUrl.replace(/\/$/, "")}/subscribe`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ ...pushRecipient(session), token })
  });
  if (!response.ok) throw new Error(`Push registration failed (${response.status}).`);

  if (previousToken && previousToken !== token) {
    await fetch(`${config.workerUrl.replace(/\/$/, "")}/subscribe`, {
      method: "DELETE",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ ...pushRecipient(session), token: previousToken })
    });
  }
  localStorage.setItem(storageKeys.token, token);
  localStorage.setItem(storageKeys.owner, recipientId);
}

function showSetupHint() {
  const headerButton = document.getElementById("pushToggleButton");
  if (!headerButton) return;
  const isIOS = /iPad|iPhone|iPod/.test(navigator.userAgent) ||
    (navigator.platform === "MacIntel" && navigator.maxTouchPoints > 1);
  const hint = isIOS
    ? "On iPhone/iPad: add this page to the Home Screen (iOS 16.4+) and allow notifications"
    : "Use Chrome Android + HTTPS + Allow notifications";
  headerButton.title = hint;
  headerButton.setAttribute("aria-label", hint);
}

function isValidVapidKey(value) {
  if (typeof value !== "string") return false;
  const trimmed = value.trim();
  return trimmed.length >= 87 && trimmed.length <= 88 && /^[A-Za-z0-9_-]+$/.test(trimmed);
}

function addPushControl(panel, config, session) {
  const control = document.createElement("button");
  control.type = "button";
  control.className = "push-notification-control";
  const headerButton = document.getElementById("pushToggleButton");
  const storageKeys = pushStorageKeys(session);
  const recipientId = session.headRole ? `head:${session.headRole}` : session.staffId;
  let enabled = localStorage.getItem(storageKeys.owner) === recipientId
    && Boolean(localStorage.getItem(storageKeys.token));
  const updateLabel = () => {
    const label = !config.enabled
      ? "Phone notifications not configured"
      : (enabled ? "Turn off phone notifications" : "Enable phone notifications");
    control.textContent = label;
    if (headerButton) headerButton.textContent = label;
  };

  const setStatus = (message) => {
    if (!message) return;
    control.textContent = message;
    if (headerButton) headerButton.textContent = message;
  };

  updateLabel();
  control.disabled = !config.enabled;
  if (headerButton) headerButton.disabled = !config.enabled;
  control.setAttribute("aria-live", "polite");
  if (panel && !session.headRole) {
    panel.prepend(control);
  } else if (headerButton) {
    headerButton.style.display = "inline-flex";
  }

  const handleToggle = async () => {
    const messaging = getMessaging(app);
    if (enabled) {
      control.disabled = true;
      if (headerButton) headerButton.disabled = true;
      control.textContent = "Turning off phone notifications...";
      try {
        const token = localStorage.getItem(storageKeys.token);
        const response = await fetch(`${config.workerUrl.replace(/\/$/, "")}/subscribe`, {
          method: "DELETE",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ ...pushRecipient(session), token })
        });
        if (!response.ok) throw new Error(`Push removal failed (${response.status}).`);
        localStorage.removeItem(storageKeys.token);
        localStorage.removeItem(storageKeys.owner);
        enabled = false;
        updateLabel();
      } catch (error) {
        console.error("Could not turn off phone notifications:", error);
        setStatus(`Could not turn off notifications: ${error?.message || String(error)}`);
      } finally {
        control.disabled = false;
        if (headerButton) headerButton.disabled = !config.enabled;
      }
      return;
    }

    if (Notification.permission === "denied") {
      setStatus("Use Chrome Android + HTTPS + Allow notifications");
      showSetupHint();
      return;
    }

    if (Notification.permission === "default") {
      let permission;
      try { permission = await Notification.requestPermission(); } catch { permission = "denied"; }
      if (permission !== "granted") {
        setStatus("Use Chrome Android + HTTPS + Allow notifications");
        showSetupHint();
        return;
      }
    }

    if (!isValidVapidKey(config.vapidKey)) {
      setStatus("Push is misconfigured: invalid web push key. Update the VAPID key in /push-config.json.");
      showSetupHint();
      return;
    }

    control.disabled = true;
    if (headerButton) headerButton.disabled = true;
    control.textContent = "Setting up phone notifications...";
    if (headerButton) headerButton.textContent = control.textContent;
    let phase = "service worker registration";
    try {
      const registration = await navigator.serviceWorker.register("/firebase-messaging-sw.js", { scope: "/" });
      await navigator.serviceWorker.ready;
      phase = "Firebase push token creation";
      const token = await getToken(messaging, {
        vapidKey: config.vapidKey,
        serviceWorkerRegistration: registration
      });
      if (!token) throw new Error("This browser did not return a push token.");

      phase = "saving device subscription";
      const response = await fetch(`${config.workerUrl.replace(/\/$/, "")}/subscribe`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ ...pushRecipient(session), token })
      });
      if (!response.ok) throw new Error(`Push registration failed (${response.status}).`);
      localStorage.setItem(storageKeys.token, token);
      localStorage.setItem(storageKeys.owner, recipientId);
      enabled = true;
      updateLabel();
    } catch (error) {
      console.error("Could not enable phone notifications:", error);
      const detail = error?.message || String(error || "unknown error");
      const message = detail.toLowerCase().includes("applicationserverkey") || detail.toLowerCase().includes("vapid")
        ? "Push is misconfigured: invalid web push key. Update the VAPID key in /push-config.json."
        : `Setup failed during ${phase} (permission: ${Notification.permission}, site: ${location.origin}): ${detail.slice(0, 100)}`;
      setStatus(message);
      showSetupHint();
    } finally {
      control.disabled = false;
      if (headerButton) headerButton.disabled = !config.enabled;
    }
  };

  if (headerButton) headerButton.addEventListener("click", handleToggle);
  control.addEventListener("click", handleToggle);
  if (enabled && Notification.permission === "granted") {
    refreshPushSubscription(config, session, storageKeys, recipientId).catch(error => {
      console.warn("Could not refresh the phone notification subscription:", error);
    });
  }
}

async function initializePushControl() {
  const panel = document.getElementById("notifPanel");
  const headerButton = document.getElementById("pushToggleButton");
  const session = headerButton?.dataset.pushHead === "true"
    ? await readHeadSession()
    : readEmployeeSession();
  if (!session || !("serviceWorker" in navigator) || !("Notification" in window)) return;
  if (headerButton) headerButton.style.display = "inline-flex";

  const style = document.createElement("style");
  style.textContent = ".push-notification-control{display:block;width:calc(100% - 24px);margin:10px 12px;padding:9px 12px;border:1px solid #18794e;border-radius:3px;background:#eaf5ee;color:#145c3a;font:inherit;font-size:13px;font-weight:600;line-height:1.35;text-align:left;cursor:pointer}.push-notification-control:disabled{cursor:default;opacity:.7}.push-toggle-button{display:inline-flex;align-items:center;justify-content:center;border:1px solid #18794e;border-radius:999px;padding:9px 14px;background:#eaf5ee;color:#145c3a;font:inherit;font-size:12px;font-weight:700;line-height:1.2;cursor:pointer}.push-toggle-button:disabled{cursor:default;opacity:.7}";
  document.head.append(style);

  let config;
  try {
    const response = await fetch("/push-config.json", { cache: "no-store" });
    config = await response.json();
  } catch (error) {
    console.error("Could not load push configuration:", error);
    return;
  }

  if (!config.enabled || !config.workerUrl || !config.vapidKey) config.enabled = false;
  const messaging = getMessaging(app);
  onMessage(messaging, payload => {
    const data = payload.data || {};
    const isEventReminder = data.eventReminder === "1";
    const isPharmacistNote = data.notificationType === "pharmacistNote";
    const isStockDayNotification = String(data.notificationType || "").startsWith("stockDay");
    if (isEventReminder) {
      window.dispatchEvent(new CustomEvent("pd-event-reminder", { detail: data }));
    }
    navigator.serviceWorker.ready.then(registration => registration.showNotification(data.title || "Event today", {
      body: data.body || "You have an event site today.",
      icon: "/assets/images/logo-transparent.png",
      badge: "/assets/images/logo-transparent.png",
      tag: data.notificationId || (isEventReminder ? "event-reminder" : "schedule-update"),
      requireInteraction: true,
      vibrate: isEventReminder ? [180, 100, 180, 100, 360] : [180, 100, 180],
      actions: [
        { action: "view-site", title: isPharmacistNote ? "View notes" : isStockDayNotification ? "View page" : "View site" },
        { action: "close", title: "Close" }
      ],
      data: {
        url: data.url || "/47fto0gim6",
        cardId: data.cardId || "",
        date: data.date || "",
        region: data.region || "",
        eventReminder: true,
        reminderKey: data.reminderKey || "",
        reminderActionToken: data.reminderActionToken || ""
      }
    })).catch(error => console.warn("Could not show event reminder notification:", error));
  });
  addPushControl(panel, config, session);
  if (headerButton) {
    headerButton.disabled = !config.enabled;
    if (!config.enabled) headerButton.textContent = "Phone notifications not configured";
    showSetupHint();
  }
}

if (await isSupported()) initializePushControl();