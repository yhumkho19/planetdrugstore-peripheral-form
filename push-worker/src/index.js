const personalTypes = new Set([
  "removed",
  "branchChanged",
  "dateChanged",
  "eventUpdated",
  "missionChanged",
  "eventDeleted",
  "siteRemoved",
  "siteAutoDeleted",
  "eventCancelled",
  "eventReinstated",
  "slotAssigned",
  "siteMoved"
]);

let cachedAccessToken;

export function shouldNotify(subscription, notification) {
  if (notification.visibleToEmployees === false) return false;

  const staffId = String(subscription.staffId || "").trim().toLowerCase();
  if (!staffId) return false;

  if (notification.type === "eventsDeployed") {
    const assigned = Array.isArray(notification.assignedStaffIds)
      ? notification.assignedStaffIds.map(id => String(id || "").trim().toLowerCase())
      : [];
    return !assigned.includes(staffId);
  }

  return personalTypes.has(notification.type)
    && String(notification.staffId || "").trim().toLowerCase() === staffId;
}

function firestoreValue(value) {
  if (!value || typeof value !== "object") return undefined;
  if ("stringValue" in value) return value.stringValue;
  if ("booleanValue" in value) return value.booleanValue;
  if ("integerValue" in value) return Number(value.integerValue);
  if ("doubleValue" in value) return value.doubleValue;
  if ("timestampValue" in value) return value.timestampValue;
  if ("arrayValue" in value) return (value.arrayValue.values || []).map(firestoreValue);
  if ("nullValue" in value) return null;
  return undefined;
}

function decodeDocument(document) {
  const fields = {};
  for (const [key, value] of Object.entries(document.fields || {})) {
    fields[key] = firestoreValue(value);
  }
  const path = String(document.name || "").split("/");
  return { id: path[path.length - 1], ...fields };
}

function base64Url(bytes) {
  let binary = "";
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/g, "");
}

function encodeJson(value) {
  return base64Url(new TextEncoder().encode(JSON.stringify(value)));
}

function pemToBytes(pem) {
  const encoded = pem.replace(/-----BEGIN PRIVATE KEY-----|-----END PRIVATE KEY-----|\s/g, "");
  const binary = atob(encoded);
  return Uint8Array.from(binary, character => character.charCodeAt(0));
}

async function getAccessToken(env) {
  if (cachedAccessToken && cachedAccessToken.expiresAt > Date.now() + 60000) {
    return cachedAccessToken.value;
  }

  const now = Math.floor(Date.now() / 1000);
  const unsigned = `${encodeJson({ alg: "RS256", typ: "JWT" })}.${encodeJson({
    iss: env.FIREBASE_CLIENT_EMAIL,
    scope: "https://www.googleapis.com/auth/firebase.messaging",
    aud: "https://oauth2.googleapis.com/token",
    iat: now,
    exp: now + 3600
  })}`;
  const key = await crypto.subtle.importKey(
    "pkcs8",
    pemToBytes(env.FIREBASE_PRIVATE_KEY),
    { name: "RSASSA-PKCS1-v1_5", hash: "SHA-256" },
    false,
    ["sign"]
  );
  const signature = await crypto.subtle.sign("RSASSA-PKCS1-v1_5", key, new TextEncoder().encode(unsigned));
  const assertion = `${unsigned}.${base64Url(new Uint8Array(signature))}`;
  const response = await fetch("https://oauth2.googleapis.com/token", {
    method: "POST",
    headers: { "content-type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      grant_type: "urn:ietf:params:oauth:grant-type:jwt-bearer",
      assertion
    })
  });
  if (!response.ok) throw new Error(`Google token request failed (${response.status})`);
  const token = await response.json();
  cachedAccessToken = { value: token.access_token, expiresAt: Date.now() + token.expires_in * 1000 };
  return cachedAccessToken.value;
}

export function notificationText(notification) {
  if (!notification || typeof notification !== "object") {
    return { title: "Schedule update", body: "Your schedule has changed. Open the app to review the details." };
  }

  const location = String(notification.location || "").trim();
  const date = String(notification.date || "").trim();
  const time = String(notification.time || "").trim();
  const role = String(notification.role || "").trim();
  const whenText = [date, time].filter(Boolean).join(" • ");
  const locationText = location ? ` at ${location}` : "";
  const roleText = role ? ` for ${role}` : "";

  switch (notification.type) {
    case "eventsDeployed":
      return { title: "New schedule posted", body: "New pharmacy events are available. Open the schedule to review." };
    case "slotAssigned":
      if (notification.list === "relievers") {
        return {
          title: "You were assigned as Store Reliever",
          body: `You'll be covering ${location || "the store"}${whenText ? ` on ${whenText}` : ""}.`
        };
      }
      return {
        title: "You were assigned to an event slot",
        body: `You were added to this event${roleText}${locationText}${whenText ? ` on ${whenText}` : ""}. Open the schedule to review the details.`
      };
    case "siteMoved":
      return {
        title: notification.list === "relievers" ? "You were assigned as Store Reliever" : "You were moved to a new site",
        body: notification.list === "relievers"
          ? `You'll be covering ${location || "the store"}${whenText ? ` on ${whenText}` : ""}.`
          : `Your assignment was updated${locationText}${whenText ? ` on ${whenText}` : ""}.`
      };
    case "removed":
      return { title: "You were removed from this slot", body: "You are now free to pick another schedule slot." };
    case "branchChanged":
      return { title: "Your event branch changed", body: "Your previous assignment was cleared. Open the schedule to choose another slot." };
    case "dateChanged":
      return {
        title: "The date for your event changed",
        body: notification.oldDate && notification.newDate
          ? `This event moved from ${notification.oldDate} to ${notification.newDate}${location ? ` at ${location}` : ""}.`
          : `This event date was updated${locationText}.`
      };
    case "eventUpdated":
      return { title: "Your event was updated", body: "The event details changed. Open the schedule to review the updated assignment." };
    case "missionChanged":
      return { title: "Your event type changed", body: "Your assignment was updated by the event team. Open the schedule to review the details." };
    case "eventDeleted":
      return { title: "An event was deleted", body: "This assignment was removed. Open the schedule to view other open slots." };
    case "siteRemoved":
      return { title: "A site was removed", body: "This event assignment was removed. Open the schedule to review the updated list." };
    case "siteAutoDeleted":
      return { title: "Your site was removed", body: "This site was deleted from the schedule. Open the schedule to review available options." };
    case "eventCancelled":
      return { title: "An event was cancelled", body: "This assignment was cancelled. Open the schedule to review the latest updates." };
    case "eventReinstated":
      return { title: "An event is back on", body: "The event team reinstated this event. Open the schedule to review the details." };
    default:
      return { title: "Schedule update", body: "Your schedule has changed. Open the app to review the details." };
  }
}

async function sendPush(env, subscription, notification) {
  const sentKey = `sent-device:${notification.id}:${(await subscriptionKey(subscription.token)).slice(4)}`;
  if (await env.PUSH_SUBSCRIPTIONS.get(sentKey)) return true;

  const accessToken = await getAccessToken(env);
  const text = notificationText(notification);
  const response = await fetch(
    `https://fcm.googleapis.com/v1/projects/${env.FIREBASE_PROJECT_ID}/messages:send`,
    {
      method: "POST",
      headers: {
        authorization: `Bearer ${accessToken}`,
        "content-type": "application/json"
      },
      body: JSON.stringify({
        message: {
          token: subscription.token,
          data: {
            title: text.title,
            body: text.body,
            url: env.APP_URL,
            notificationId: notification.id
          }
        }
      })
    }
  );

  if (response.ok) {
    await env.PUSH_SUBSCRIPTIONS.put(sentKey, "1", { expirationTtl: 604800 });
    return true;
  }
  const error = await response.text();
  if (error.includes("UNREGISTERED")) {
    await env.PUSH_SUBSCRIPTIONS.delete(subscription.key);
    await env.PUSH_SUBSCRIPTIONS.put(sentKey, "1", { expirationTtl: 604800 });
    return true;
  }
  console.error("FCM send failed", response.status, error);
  return false;
}

async function loadSubscriptions(env) {
  const subscriptions = [];
  let cursor;
  do {
    const page = await env.PUSH_SUBSCRIPTIONS.list({ prefix: "sub:", cursor });
    for (const item of page.keys) {
      const value = await env.PUSH_SUBSCRIPTIONS.get(item.name, "json");
      if (value) subscriptions.push({ ...value, key: item.name });
    }
    cursor = page.list_complete ? undefined : page.cursor;
  } while (cursor);
  return subscriptions;
}

async function readNewNotifications(env) {
  let cursor = await env.PUSH_SUBSCRIPTIONS.get("scan-cursor");
  if (!cursor) cursor = new Date(Date.now() - 120000).toISOString();
  const overlap = new Date(Date.parse(cursor) - 1000).toISOString();
  const url = `https://firestore.googleapis.com/v1/projects/${env.FIREBASE_PROJECT_ID}/databases/(default)/documents:runQuery?key=${encodeURIComponent(env.FIREBASE_API_KEY)}`;
  const response = await fetch(url, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      structuredQuery: {
        from: [{ collectionId: "emergencyNotifications" }],
        where: {
          fieldFilter: {
            field: { fieldPath: "createdAt" },
            op: "GREATER_THAN_OR_EQUAL",
            value: { timestampValue: overlap }
          }
        },
        orderBy: [{ field: { fieldPath: "createdAt" }, direction: "ASCENDING" }],
        limit: 500
      }
    })
  });
  if (!response.ok) throw new Error(`Firestore query failed (${response.status})`);
  const rows = await response.json();
  return rows.filter(row => row.document).map(row => decodeDocument(row.document));
}

async function deliverNewNotifications(env) {
  const subscriptions = await loadSubscriptions(env);
  const notifications = await readNewNotifications(env);
  let newestTimestamp = await env.PUSH_SUBSCRIPTIONS.get("scan-cursor");
  let allComplete = true;

  for (const notification of notifications) {
    const createdAt = notification.createdAt;
    if (!createdAt) continue;
    if (await env.PUSH_SUBSCRIPTIONS.get(`sent:${notification.id}`)) continue;

    const targets = subscriptions.filter(subscription => shouldNotify(subscription, notification));
    let complete = true;
    for (const subscription of targets) {
      if (!(await sendPush(env, subscription, notification))) complete = false;
    }
    if (!complete) {
      allComplete = false;
      continue;
    }

    await env.PUSH_SUBSCRIPTIONS.put(`sent:${notification.id}`, "1", { expirationTtl: 604800 });
    if (!newestTimestamp || Date.parse(createdAt) > Date.parse(newestTimestamp)) newestTimestamp = createdAt;
  }

  if (allComplete && newestTimestamp) await env.PUSH_SUBSCRIPTIONS.put("scan-cursor", newestTimestamp);
}

function corsHeaders(env, origin) {
  return {
    "access-control-allow-origin": origin === env.APP_ORIGIN ? origin : "null",
    "access-control-allow-methods": "POST, DELETE, OPTIONS",
    "access-control-allow-headers": "content-type",
    "access-control-max-age": "86400",
    vary: "Origin"
  };
}

async function subscriptionKey(token) {
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(token));
  return `sub:${base64Url(new Uint8Array(digest))}`;
}

async function handleSubscription(request, env) {
  const origin = request.headers.get("Origin") || "";
  const headers = corsHeaders(env, origin);
  if (origin !== env.APP_ORIGIN) return new Response("Forbidden", { status: 403, headers });
  if (request.method === "OPTIONS") return new Response(null, { headers });
  if (request.method !== "POST" && request.method !== "DELETE") {
    return new Response("Method not allowed", { status: 405, headers });
  }

  let body;
  try { body = await request.json(); } catch { return new Response("Invalid JSON", { status: 400, headers }); }
  const staffId = String(body.staffId || "").trim().toLowerCase();
  const token = String(body.token || "").trim();
  if (!staffId || staffId.length > 100 || token.length < 20 || token.length > 8192) {
    return new Response("Invalid subscription", { status: 400, headers });
  }

  const key = await subscriptionKey(token);
  if (request.method === "DELETE") {
    const existing = await env.PUSH_SUBSCRIPTIONS.get(key, "json");
    if (existing && existing.staffId === staffId) await env.PUSH_SUBSCRIPTIONS.delete(key);
  } else {
    await env.PUSH_SUBSCRIPTIONS.put(key, JSON.stringify({ staffId, token }));
  }
  return new Response(JSON.stringify({ ok: true }), {
    headers: { ...headers, "content-type": "application/json" }
  });
}

export default {
  async fetch(request, env) {
    const url = new URL(request.url);
    if (url.pathname !== "/subscribe") return new Response("Not found", { status: 404 });
    return handleSubscription(request, env);
  },
  async scheduled(_event, env, context) {
    context.waitUntil(deliverNewNotifications(env));
  }
};